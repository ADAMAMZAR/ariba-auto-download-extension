// Load shared logger first, then constants
importScripts('../shared/logger.js');
importScripts('../shared/constants.js');
// PDF extraction bridge — manages the Offscreen Document that runs pdf.js
// (pdf.js itself cannot run in a service worker; it needs DOM + Worker access)
try {
  importScripts('../pdf_pipeline/pdf_extractor.js');
} catch (e) {
  console.warn('[Ariba Ext] pdf_extractor.js failed to load — PDF→TXT disabled:', e?.message ?? e);
}
// ─── Telemetry safety net ─────────────────────────────────────────────────────
// Catches anything that slips past every explicit try/catch below — a bug in
// code we haven't wrapped yet, a rejected promise nobody awaited, etc. Without
// this, those failures are invisible: MV3 service workers have no visible
// console for colleagues to check, so an uncaught error just silently kills
// whatever was running.
self.addEventListener('error', (event) => {
  reportEvent('fatal', {
    context: 'unhandled-error',
    message: event.message,
    stack: event.error?.stack,
  });
});

self.addEventListener('unhandledrejection', (event) => {
  reportEvent('fatal', {
    context: 'unhandled-rejection',
    message: event.reason?.message ?? String(event.reason),
    stack: event.reason?.stack,
  });
});

// ─── Gist fetch helper ───────────────────────────────────────────────────────
// Uses the GitHub Gist API instead of the raw CDN URL so we always get the
// latest revision with no CDN caching layer and a much higher rate limit
// (60 req/hr unauthenticated vs. the raw URL which is aggressively throttled).
//
// Returns the file text on success.
// Throws a descriptive Error on failure (non-2xx, network error, parse error).
async function fetchGistContent() {
  let response;
  try {
    response = await fetch(GIST_API_URL, {
      headers: { 'Accept': 'application/vnd.github+json' }
    });
  } catch (err) {
    throw new Error('Network error fetching system instructions: ' + (err.message || String(err)));
  }

  if (!response.ok) {
    // Include rate-limit reset time in the error when GitHub says 429/403
    const resetEpoch = response.headers.get('X-RateLimit-Reset');
    const resetInfo = resetEpoch
      ? ` (rate limit resets at ${new Date(Number(resetEpoch) * 1000).toLocaleTimeString()})`
      : '';
    throw new Error(`HTTP ${response.status}: ${response.statusText}${resetInfo}`);
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    throw new Error('Failed to parse Gist API response: ' + (err.message || String(err)));
  }

  const fileEntry = json?.files?.[GIST_FILE];
  if (!fileEntry) {
    throw new Error(`Gist file "${GIST_FILE}" not found in API response.`);
  }

  // The API inlines content for files ≤ 1 MB; for larger files it provides a
  // raw_url — follow it as a fallback so we never silently get empty text.
  if (fileEntry.content) {
    return fileEntry.content;
  }

  if (fileEntry.raw_url) {
    const rawRes = await fetch(fileEntry.raw_url);
    if (!rawRes.ok) throw new Error(`Failed to fetch raw Gist content: HTTP ${rawRes.status}`);
    return rawRes.text();
  }

  throw new Error('Gist API returned an entry with no content and no raw_url.');
}

// ─── Auto-Update ──────────────────────────────────────────────────────────────
// Chrome auto-updates extensions from the Web Store, but only applies the
// update when all extension tabs are closed or the browser restarts.
// Users who keep Chrome open all day can unknowingly run stale code for days.
//
// Fix: use chrome.alarms to wake the service worker every hour and actively
// call requestUpdateCheck().  When Chrome confirms an update is ready,
// onUpdateAvailable fires and we reload immediately.

const UPDATE_ALARM = 'gpo-auto-update-check';

// Register the hourly alarm once on install/startup.
// chrome.alarms.create is idempotent if the alarm already exists.
chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 60 });
  console.log('[Ariba Ext] Auto-update alarm registered (every 60 min).');

  if (details.reason === 'update') {
    console.log(`[Ariba Ext] Updated from ${details.previousVersion} → ${chrome.runtime.getManifest().version}. Clearing extension cache...`);

    // ── Clear chrome.storage.local cache keys ──────────────────────────────
    // We intentionally PRESERVE user settings:
    //   notebooklmUrl, connectToNotebooklm, deleteAfterUpload
    // Everything else is transient state that becomes stale after an update.
    try {
      await chrome.storage.local.remove([
        TELEMETRY_LOG_KEY,        // debug/telemetry ring buffer
        'lastSupplierName',       // last-run ephemeral state
        'lastRawSupplierName',
      ]);
      console.log('[Ariba Ext] chrome.storage.local cache cleared.');
    } catch (e) {
      console.warn('[Ariba Ext] Failed to clear local storage on update:', e?.message ?? e);
    }

    // ── Clear chrome.storage.session (all pending_* run state) ────────────
    try {
      await chrome.storage.session.clear();
      console.log('[Ariba Ext] chrome.storage.session cleared.');
    } catch (e) {
      console.warn('[Ariba Ext] Failed to clear session storage on update:', e?.message ?? e);
    }

    // ── Clear stale gist-hash entries from NotebookLM localStorage ────────
    // notebooklm_kit.js stores nlm_synced_gist_hash_<notebookId> in the
    // NotebookLM page's localStorage so it can detect when the system
    // instructions have changed. After an extension update those hashes are
    // stale, so we wipe them here — the next page load will re-fetch and
    // store a fresh baseline automatically.
    try {
      const tabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
      for (const tab of tabs) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const toRemove = Object.keys(localStorage).filter(k => k.startsWith('nlm_synced_gist_hash_'));
            toRemove.forEach(k => localStorage.removeItem(k));
            console.log('[Ariba Ext] Cleared stale gist-hash keys from NotebookLM localStorage:', toRemove);
          }
        }).catch(e => {
          console.warn('[Ariba Ext] Could not clear NotebookLM localStorage on tab', tab.id, ':', e?.message ?? e);
        });
      }
    } catch (e) {
      console.warn('[Ariba Ext] Failed to query NotebookLM tabs on update:', e?.message ?? e);
    }

    // ── Live re-inject NLM kit into open NotebookLM tabs ─────────────────
    // Instead of just asking the user to refresh, we push the new scripts
    // directly into already-open tabs so they pick up the update immediately.
    // Steps:
    //  1. Clear window.__nlmKitInjected so the new script's re-entry guard
    //     doesn't block re-execution.
    //  2. Inject the updated CSS (insertCSS is idempotent; duplicates are
    //     de-duped by the browser).
    //  3. Inject the updated JS — the guard at the top of notebooklm_kit.js
    //     now sets __nlmKitInjected = true again after running, and the
    //     floating widget replaces itself by id.
    try {
      const nlmTabs = await chrome.tabs.query({ url: '*://notebooklm.google.com/*' });
      const newVersion = chrome.runtime.getManifest().version;
      for (const tab of nlmTabs) {
        // Step 1: clear the re-entry guard so the new script body runs
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (version) => {
            window.__nlmKitInjected = false;
            console.log(`[Ariba Ext] Cleared NLM kit guard for live update to v${version}.`);
          },
          args: [newVersion]
        }).then(() => {
          // Step 2: inject updated CSS
          chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ['notebooklm/notebooklm_kit.css']
          }).catch(e => console.warn('[Ariba Ext] NLM CSS re-inject failed:', e?.message));

          // Step 3: inject updated JS (logger + constants + kit)
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['shared/logger.js', 'shared/constants.js', 'notebooklm/notebooklm_kit.js']
          }).catch(e => console.warn('[Ariba Ext] NLM JS re-inject failed:', e?.message));
        }).catch(e => {
          console.warn('[Ariba Ext] Could not clear NLM kit guard on tab', tab.id, ':', e?.message ?? e);
        });
      }
    } catch (e) {
      console.warn('[Ariba Ext] Failed to re-inject NLM kit on update:', e?.message ?? e);
    }

    // ── Notify open Ariba tabs to refresh ─────────────────────────────────
    // Ariba content.js is already inject-on-demand (runs only when the user
    // clicks Download), so a simple informational toast is enough here.
    try {
      const aribaTabs = await chrome.tabs.query({ url: '*://*.ariba.com/*' });
      const newVersion = chrome.runtime.getManifest().version;
      for (const tab of aribaTabs) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (version) => {
            let container = document.getElementById('ariba-toast-container');
            if (!container) {
              container = document.createElement('div');
              container.id = 'ariba-toast-container';
              container.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999999;display:flex;flex-direction:column;gap:8px;';
              document.body.appendChild(container);
            }
            const toast = document.createElement('div');
            toast.style.cssText = 'background:#1a73e8;color:#fff;padding:10px 16px;border-radius:8px;font-family:sans-serif;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.3);max-width:300px;line-height:1.4;';
            toast.textContent = `✅ Extension updated to v${version}. Click Download when ready — latest code will be loaded automatically.`;
            container.appendChild(toast);
            setTimeout(() => toast.remove(), 8000);
          },
          args: [newVersion]
        }).catch(e => {
          console.warn('[Ariba Ext] Could not inject update toast on Ariba tab', tab.id, ':', e?.message ?? e);
        });
      }
    } catch (e) {
      console.warn('[Ariba Ext] Failed to notify Ariba tabs on update:', e?.message ?? e);
    }

    console.log('[Ariba Ext] Extension cache cleared after update. User settings preserved.');

  }
});


chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 60 });
});

// Every hour: ask Chrome if a newer version is available in the Web Store.
// Also handles the one-shot RELOAD_ALARM scheduled by onUpdateAvailable.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RELOAD_ALARM) {
    // ── Pending-update reload ─────────────────────────────────────────────
    // This alarm was scheduled by onUpdateAvailable when a new version was
    // detected and no job was running.  We use an alarm instead of setTimeout
    // because MV3 service workers can be terminated at any moment — a
    // setTimeout callback would be silently dropped, but an alarm always
    // wakes the worker and fires reliably.
    console.log('[Ariba Ext] Reload alarm fired — applying pending extension update.');
    chrome.runtime.reload();
    return;
  }

  if (alarm.name !== UPDATE_ALARM) return;
  chrome.runtime.requestUpdateCheck((status) => {
    console.log(`[Ariba Ext] Update check → ${status}`);
    // 'update_available' means Chrome already downloaded the new version;
    // onUpdateAvailable will fire and we reload there.
    // 'no_update' / 'throttled' → nothing to do.
  });
});

// ── Update check on Ariba page load ───────────────────────────────────────────
// In addition to the hourly alarm, run a check whenever the user opens or
// navigates to an Ariba page.  This catches users who always keep the same
// browser session open and rarely trigger the alarm naturally.
//
// Debounced to at most once per minute to stay well inside Chrome's
// requestUpdateCheck throttle limit (roughly 1 call / 5 s).
let _lastAribaUpdateCheck = 0;
function triggerExtensionUpdateCheck(sourceLabel) {
  const now = Date.now();
  if (now - _lastAribaUpdateCheck < 60_000) return; // debounce: once per minute
  _lastAribaUpdateCheck = now;

  chrome.runtime.requestUpdateCheck((status) => {
    console.log(`[Ariba Ext] Update check (${sourceLabel}) → ${status}`);
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only fire when the Ariba page has fully loaded
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !tab.url.includes('.ariba.com')) return;

  triggerExtensionUpdateCheck('Ariba page load');
});

// When Chrome has a new version ready, decide whether to reload immediately
// or defer until the active job finishes.
//
// ⚠️  MV3 SERVICE WORKER RELIABILITY NOTE:
// setTimeout() is NOT reliable for deferred reloads in MV3 service workers.
// Chrome can terminate the idle service worker before the timer fires,
// silently dropping the callback — meaning chrome.runtime.reload() never runs.
// We use chrome.alarms instead, which persists across worker restarts.
//
// RELOAD_ALARM is a one-shot alarm that fires after ~5 seconds and calls
// chrome.runtime.reload() from the onAlarm listener (already set up above).
const RELOAD_ALARM = 'gpo-pending-reload';

chrome.runtime.onUpdateAvailable.addListener((details) => {
  const newVersion = details.version;

  // Check whether a download job is currently active.
  // We use chrome.storage.session as the source of truth because it survives
  // service-worker restarts (unlike in-memory variables).
  chrome.storage.session.get(['notebooklmConfig'], (result) => {
    // notebooklmConfig is set at the start of a run and cleared when idle.
    // If it exists, a job may be in progress — defer the reload.
    const jobIsActive = !!(result && result.notebooklmConfig);

    if (jobIsActive) {
      // ── A download is in progress — do NOT interrupt it ────────────────────
      console.log(`[Ariba Ext] Update v${newVersion} available — deferring (job in progress).`);
      notifyPanel(
        `⬆️ Extension update v${newVersion} is ready but will apply after your ` +
        `current download finishes (or on next browser restart).`,
        false,  // not an error
        false   // not done
      );
    } else {
      // ── Idle — safe to reload using a chrome.alarm (setTimeout is unreliable) ──
      console.log(`[Ariba Ext] Update v${newVersion} available — scheduling reload alarm in 5 s.`);
      notifyPanel(
        `⬆️ Extension update v${newVersion} detected! Reloading in 5 seconds — ` +
        `please reopen this panel afterwards.`,
        false,
        false
      );
      // Schedule a one-shot alarm 5 seconds from now.
      // The onAlarm listener below will call chrome.runtime.reload().
      chrome.alarms.create(RELOAD_ALARM, { delayInMinutes: 5 / 60 });
    }
  });
});



// Open standalone panel window when extension icon is clicked
chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('panel/panel.html') });
  if (tabs.length > 0) {
    const tab = tabs[0];
    try {
      chrome.windows.update(tab.windowId, { focused: true });
      chrome.tabs.update(tab.id, { active: true });
    } catch (e) {
      // If window focus failed (maybe window was closed but tab state not fully updated), open a new one
      chrome.windows.create({
        url: chrome.runtime.getURL('panel/panel.html'),
        type: 'popup',
        width: POPUP_WIDTH,
        height: POPUP_HEIGHT,
        focused: true
      });
    }
  } else {
    chrome.windows.create({
      url: chrome.runtime.getURL('panel/panel.html'),
      type: 'popup',
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT,
      focused: true
    });
  }
});

// -----------------------------------------------------------------------
// Full-page screenshot using chrome.debugger
// -----------------------------------------------------------------------
function captureFullPageScreenshot(tabId) {
  return new Promise((resolve, reject) => {
    const target = { tabId };

    // Check if already attached
    chrome.debugger.getTargets((targets) => {
      const isAttached = targets.some(t => t.tabId === tabId && t.attached);
      if (isAttached) {
        chrome.debugger.detach(target, attachAndCapture);
      } else {
        attachAndCapture();
      }
    });

    function attachAndCapture() {
      chrome.debugger.attach(target, '1.3', () => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }

        chrome.debugger.sendCommand(target, 'Page.enable', {}, () => {
          chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics', {}, (metrics) => {
            if (chrome.runtime.lastError) {
              chrome.debugger.detach(target);
              return reject(new Error(chrome.runtime.lastError.message));
            }

            const contentSize = metrics.cssContentSize || metrics.contentSize;
            if (!contentSize) {
              chrome.debugger.detach(target);
              return reject(new Error("Could not determine page size."));
            }

            const width = Math.ceil(contentSize.width);
            const height = Math.ceil(contentSize.height);
            const clip = { x: 0, y: 0, width, height, scale: 1 };

            setTimeout(() => {
              chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
                format: 'jpeg',
                quality: 60,
                clip: clip,
                captureBeyondViewport: true
              }, (result) => {
                chrome.debugger.detach(target);
                if (chrome.runtime.lastError) {
                  return reject(new Error(chrome.runtime.lastError.message));
                }
                resolve(result.data);
              });
            }, 300);
          });
        });
      });
    }
  });
}

// -----------------------------------------------------------------------
// Delete a downloaded file once it reaches 'complete' state.
// chrome.downloads.removeFile() only works after the download finishes.
// -----------------------------------------------------------------------
function waitForCompleteAndRemove(downloadId) {
  if (downloadId == null) return;

  // Check current state first — it may already be complete
  chrome.downloads.search({ id: downloadId }, (results) => {
    if (results?.[0]?.state === 'complete') {
      chrome.downloads.removeFile(downloadId, () => {
        if (chrome.runtime.lastError) {
          console.warn('[Ariba Ext] removeFile failed for', downloadId, chrome.runtime.lastError.message);
        }
      });
      return;
    }
    // Otherwise, wait for the onChanged event
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        chrome.downloads.removeFile(downloadId, () => {
          if (chrome.runtime.lastError) {
            console.warn('[Ariba Ext] removeFile failed for', downloadId, chrome.runtime.lastError.message);
          }
        });
      } else if (delta.state?.current === 'interrupted') {
        // Download failed — nothing to delete
        chrome.downloads.onChanged.removeListener(onChanged);
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    // Safety: stop listening after 10 minutes
    setTimeout(() => chrome.downloads.onChanged.removeListener(onChanged), 600_000);
  });
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------
function notifyAribaTab(tabId, text, isError = false) {
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { action: 'showToast', text, isError }).catch(() => { });
  }
  if (isError) reportEvent('error', { message: text, supplier: _currentReportSupplier });
}

function notifyPanel(text, error = false, done = false) {
  chrome.runtime.sendMessage({ type: 'status', text, error, done }).catch(() => { });
}

// -----------------------------------------------------------------------
// Remote error telemetry
//
// Manual repro across ~20 users on different machines/networks doesn't
// scale — this keeps a local ring buffer of recent events (for the
// "Report a problem" button in the popup) and, when TELEMETRY_ENDPOINT is
// configured, also fires each error at a remote sink automatically so
// failures surface without anyone needing to describe them.
// -----------------------------------------------------------------------
async function reportEvent(type, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    type, // 'error' | 'fatal' | 'manual-report'
    version: chrome.runtime.getManifest().version,
    ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
    ...details,
  };

  try {
    const { [TELEMETRY_LOG_KEY]: existing = [] } = await chrome.storage.local.get(TELEMETRY_LOG_KEY);
    const updated = [...existing, entry].slice(-TELEMETRY_LOG_MAX);
    await chrome.storage.local.set({ [TELEMETRY_LOG_KEY]: updated });
  } catch (e) {
    console.warn('[Ariba Ext] Failed to write local debug log:', e?.message ?? e);
  }

  if (type !== 'manual-report' && TELEMETRY_ENDPOINT) {
    // Fire-and-forget — never let a reporting failure affect the user-facing flow.
    fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight to Apps Script
      body: JSON.stringify(entry),
    }).catch((e) => console.warn('[Ariba Ext] Telemetry send failed:', e?.message ?? e));
  }

  return entry;
}

function cleanName(n) {
  return n
    .replace(/["']/g, '')              // Strip quotes completely instead of making them dashes
    .replace(/PTY LIMITED/gi, 'P/L')
    .replace(/PTY LTD\.(?!pdf|docx?|xlsx?|txt|jpe?g|png)/gi, 'P/L')
    .replace(/PTY LTD/gi, 'P/L')
    .replace(/The trustee of\s+/gi, 'TOF ')
    .replace(/The trustee for\s+/gi, 'TOF ')
    .replace(/[\/\\?%*:|<>]/g, '-')    // Replace illegal filesystem characters with dashes
    .replace(/\.+$/, '')               // Windows: names cannot end with a period
    .trim();                           // no leading/trailing spaces
}

function uint8ArrayToBase64(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  const chunk = 8192;
  for (let i = 0; i < len; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function blobToDataUrl(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const base64 = uint8ArrayToBase64(bytes);
  return `data:${blob.type};base64,${base64}`;
}

// Extension service workers don't support URL.createObjectURL, so disk-save
// has no choice but to go through blobToDataUrl's base64 data: URL. That's
// fine for one file at a time, but the DOWNLOAD_CONCURRENCY=4 worker pool
// would otherwise let up to 4 files hold their base64-inflated copy in
// memory simultaneously. This lock caps that to one file at a time — fetch
// and PDF extraction still run at full concurrency, only the memory-heavy
// encode+disk-save step is serialized.
let _diskSaveLock = Promise.resolve();
function withDiskSaveLock(fn) {
  const run = _diskSaveLock.then(fn, fn);
  _diskSaveLock = run.then(() => { }, () => { });
  return run;
}

// -----------------------------------------------------------------------
// Content hashing + cross-run PDF extraction cache
//
// Used to (a) skip byte-identical duplicate files within a single run — the
// same boilerplate cert commonly gets attached under different filenames —
// and (b) avoid re-parsing a PDF whose text we've already extracted in a
// previous run, since that recurring cert reappears often.
// -----------------------------------------------------------------------

async function hashArrayBuffer(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

const PDF_TEXT_CACHE_PREFIX = 'pdfTextCache_';

async function getCachedPdfText(hash) {
  try {
    const key = PDF_TEXT_CACHE_PREFIX + hash;
    const stored = await chrome.storage.local.get(key);
    return stored[key] ?? null;
  } catch (e) {
    return null; // a cache read failure should never break extraction
  }
}

async function setCachedPdfText(hash, record) {
  try {
    const key = PDF_TEXT_CACHE_PREFIX + hash;
    await chrome.storage.local.set({ [key]: record });
  } catch (e) {
    // Quota exceeded or similar — just skip caching this result.
    console.warn('[Ariba Ext] Failed to cache PDF extraction result:', e?.message ?? e);
  }
}

// -----------------------------------------------------------------------
// Fetch helpers — timeout + retry
// -----------------------------------------------------------------------

/** Fetch with an AbortController timeout. Optionally accepts an external stop signal. */
async function fetchWithTimeout(url, timeoutMs = 30000, stopSignal = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // If the external stop signal fires, abort this fetch immediately
  const onStop = () => controller.abort();
  if (stopSignal) stopSignal.addEventListener('abort', onStop, { once: true });

  try {
    return await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (stopSignal?.aborted) throw new Error('Stopped by user.');
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
    if (stopSignal) stopSignal.removeEventListener('abort', onStop);
  }
}

/**
 * Fetch with automatic retry on failure.
 * Reports each retry attempt via notifyAribaTab if tabId / filename are provided.
 * Respects stopSignal — throws immediately if stop is requested between retries.
 */
async function fetchWithRetry(url, { retries = 2, timeoutMs = 30000, delayMs = 2000, tabId = null, filename = '', stopSignal = null } = {}) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    if (stopSignal?.aborted) throw new Error('Stopped by user.');
    try {
      const resp = await fetchWithTimeout(url, timeoutMs, stopSignal);
      if (resp.ok) return resp;
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    } catch (err) {
      if (err.message === 'Stopped by user.' || attempt > retries) throw err;
      if (tabId) notifyAribaTab(tabId, `Retry ${attempt}/${retries} for "${filename}"...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// -----------------------------------------------------------------------
// Persistent state via chrome.storage.session
// -----------------------------------------------------------------------
async function getState(supplier) {
  const key = `pending_${supplier}`;
  const r = await chrome.storage.session.get(key);
  return r[key] || { filesDone: false, config: null };
}
async function setState(supplier, data) {
  await chrome.storage.session.set({ [`pending_${supplier}`]: data });
}
async function clearState(supplier) {
  await chrome.storage.session.remove(`pending_${supplier}`);
}

// -----------------------------------------------------------------------
// Delete all disk downloads for a completed supplier run.
// Called when nlm_runner.js signals that uploading is fully done.
// -----------------------------------------------------------------------
async function deleteSupplierDownloads(supplier) {
  const state = await getState(supplier);
  const ids = state.diskDownloadIds || [];
  if (ids.length === 0) return;
  notifyPanel(`Deleting ${ids.length} local file(s) from disk...`);
  for (const id of ids) {
    waitForCompleteAndRemove(id);
  }
  notifyPanel('Local files deleted.');
}

// -----------------------------------------------------------------------
// Open NotebookLM once downloads are done, then interact with the checkbox
// -----------------------------------------------------------------------
// filesForNotebook is passed directly (NOT via session storage) to avoid
// blowing the 10 MB chrome.storage.session quota with large base64 blobs.
async function maybeOpenNotebookLM(supplier, filesForNotebook = []) {
  const state = await getState(supplier);
  if (!state.filesDone) return;

  // Check if we should skip NotebookLM (either disabled, or no valid files to upload other than QA data)
  const hasOnlyQaFile = filesForNotebook.length === 1 && filesForNotebook[0].filename.endsWith('QA_Data.md');
  const skipNotebookLm = !state.config?.connectToNotebooklm || filesForNotebook.length === 0 || hasOnlyQaFile;

  if (skipNotebookLm) {
    // NLM disabled or nothing to upload — clear state now and we're done
    if (hasOnlyQaFile) {
      notifyPanel('Only QA Markdown available. Skipping NotebookLM upload.');
    }
    await clearState(supplier);
    notifyAribaTab(state.aribaTabId, 'Downloads complete!');
    notifyPanel('Downloads complete!', false, true);
    return;
  }

  // NLM enabled — keep state alive until nlm_upload_done fires so
  // diskDownloadIds are still readable for post-upload deletion.
  // Clear state now only when deleteAfterUpload is OFF (nothing to wait for).
  if (!state.config?.deleteAfterUpload) {
    await clearState(supplier);
  }

  // Note: filesForNotebook is received as a direct parameter, not from
  // session storage, to avoid the 10 MB session quota limit.
  notifyPanel('Fetching latest system instructions...');
  let gistText;
  try {
    gistText = await fetchGistContent();
  } catch (err) {
    const msg = 'Failed to fetch system instructions: ' + err.message;
    notifyPanel(msg, true, true); // done:true so panel re-enables the Download button
    notifyAribaTab(state.aribaTabId, msg, true);
    return; // ← stop completely; do NOT open NotebookLM with empty instructions
  }

  notifyPanel('Opening NotebookLM...');
  const tab = await chrome.tabs.create({ url: state.config.notebooklmUrl });


  // Wait for the page to fully load, then inject the checkbox and sync script
  // Guard: prevent the script from firing more than once if 'complete' triggers multiple times
  let fired = false;
  chrome.tabs.onUpdated.addListener(async function listener(tabId, info) {
    if (tabId !== tab.id || info.status !== 'complete') return;
    if (fired) return;
    fired = true;

    // 1. Inject message bridge in isolated world to relay messages from main world to the panel
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          if (!window.hasNotebookLMMsgBridge) {
            window.hasNotebookLMMsgBridge = true;
            window.addEventListener('message', (event) => {
              if (event.data && event.data.source === 'ariba-notebooklm-injected') {
                // Relay action messages (e.g. nlm_upload_done) directly to the background
                if (event.data.action) {
                  chrome.runtime.sendMessage({
                    action: event.data.action
                  }).catch(() => { });
                } else {
                  chrome.runtime.sendMessage({
                    type: 'status',
                    text: event.data.text,
                    error: event.data.error,
                    done: event.data.done
                  }).catch(() => { });
                }
              }
            });
          }
        }
      });
    } catch (e) {
      console.warn('[Ariba Ext] Failed to inject NLM message bridge:', e?.message ?? e);
    }

    // 2. Pass args to the runner script by writing them onto window in the MAIN world.
    //    This tiny shim is the only inline func — the real logic lives in nlm_runner.js.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: (instructionText, filesToUpload) => {
        window.__aribaRunnerArgs = { instructionText, filesToUpload };
      },
      args: [gistText, filesForNotebook]
    });

    // 3a. Inject constants.js into the MAIN world so nlm_runner.js can read the RPC IDs.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      files: ['shared/constants.js']
    });

    // 3b. Inject the runner as an external file — fully debuggable and lintable.
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      files: ['notebooklm/nlm_runner.js']
    }, (results) => {
      if (chrome.runtime.lastError) {
        notifyPanel('Sync/Checkbox script error: ' + chrome.runtime.lastError.message, true, true); // done:true so panel re-enables the Download button
        notifyAribaTab(state.aribaTabId, 'NotebookLM injection failed: ' + chrome.runtime.lastError.message, true);
        chrome.tabs.onUpdated.removeListener(listener);
        return;
      }
      // nlm_runner.js is an IIFE — results[0].result is not 'done', so we
      // remove the listener here unconditionally once the script has executed.
      chrome.tabs.onUpdated.removeListener(listener);
    });

    notifyPanel('NotebookLM opened and system instructions synced!', false, true);
  });
}

// -----------------------------------------------------------------------
// Stop signal — AbortController + stored Ariba tab ID
// -----------------------------------------------------------------------
let _stopController = null;   // AbortController for the active run
let _activeAribaTabId = null; // Ariba tab that initiated the run
let _currentReportSupplier = null; // supplier name of the active run, for error telemetry

function triggerStop() {
  // 1. Abort all in-flight fetches
  if (_stopController) {
    _stopController.abort();
    _stopController = null;
  }
  // 2. Tell the Ariba content script to stop its own loops
  if (_activeAribaTabId) {
    chrome.tabs.sendMessage(_activeAribaTabId, { action: 'stopAutomation' }).catch(() => { });
    _activeAribaTabId = null;
  }
}

function clearStopSignal() {
  _stopController = null;
  _activeAribaTabId = null;
  _currentReportSupplier = null;
}

// -----------------------------------------------------------------------
// Message handler
// -----------------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {

    if (request.action === 'fetchGistText') {
      try {
        const text = await fetchGistContent();
        sendResponse({ text });
      } catch (err) {
        sendResponse({ error: err.message || String(err) });
      }
      return;
    }

    if (request.type === 'status') {
      // Relay status updates to the toast on the Ariba tab
      try {
        const allData = await chrome.storage.session.get(null);
        for (const [key, val] of Object.entries(allData)) {
          if (key.startsWith('pending_') && val.aribaTabId) {
            notifyAribaTab(val.aribaTabId, request.text, request.error);
          }
        }
      } catch (e) {
        console.warn('[Ariba Ext] Session storage relay failed:', e?.message ?? e);
      }
    }

    if (request.action === 'stopAutomation') {
      triggerStop(); // aborts fetches + messages the Ariba tab directly
      return;
    }

    if (request.action === 'checkForExtensionUpdates') {
      triggerExtensionUpdateCheck('CQ Notebook');
      return;
    }

    // ── Errors relayed from content scripts (content.js, notebooklm_kit.js) ──
    // These run on the page itself and previously only reached whichever
    // colleague's own DevTools console via console.error.
    if (request.action === 'reportError') {
      await reportEvent('error', {
        source: request.source,
        context: request.context,
        message: request.message,
        stack: request.stack,
        pageUrl: request.url,
        supplier: request.supplier,
      });
      return;
    }

    // ── Manual "Report a problem" button in the popup ──────────────────────
    // Packages the local ring buffer (recent errors + activity) plus an
    // optional user note and force-sends it to TELEMETRY_ENDPOINT, even for
    // non-crashing weirdness that never hit a catch block.
    if (request.action === 'reportProblem') {
      try {
        const { [TELEMETRY_LOG_KEY]: recentEvents = [] } = await chrome.storage.local.get(TELEMETRY_LOG_KEY);
        const entry = await reportEvent('manual-report', {
          note: request.note || '',
          supplier: request.supplier || '',
          recentEvents,
        });
        if (!TELEMETRY_ENDPOINT) {
          sendResponse({ ok: false, error: 'Telemetry endpoint not configured — report saved locally only.' });
          return;
        }
        const resp = await fetch(TELEMETRY_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(entry),
        });
        sendResponse({ ok: resp.ok });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message ?? String(e) });
      }
      return;
    }

    // ── Triggered by nlm_runner.js after all files are uploaded and processed ──
    if (request.action === 'nlm_upload_done') {
      try {
        // Find the session entry with diskDownloadIds and deleteAfterUpload flag
        const allData = await chrome.storage.session.get(null);
        for (const [key, val] of Object.entries(allData)) {
          if (!key.startsWith('pending_')) continue;
          const supplier = val.supplierKey || key.replace('pending_', '');
          if (val.config?.deleteAfterUpload) {
            await deleteSupplierDownloads(supplier);
          }
          // Always clear state now that NLM is done
          await clearState(supplier);
        }
      } catch (e) {
        console.warn('[Ariba Ext] nlm_upload_done handler error:', e?.message ?? e);
      }
      return;
    }

    if (request.action === 'downloadFiles') {
      const AUTOMATION_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
      let timeoutHandle;
      let supplierKey = null; // hoisted so catch block can clear session state

      // Create a fresh AbortController for this run and store the Ariba tab ID
      // so triggerStop() can reach the content script directly.
      _stopController = new AbortController();
      _activeAribaTabId = sender.tab?.id ?? null;
      const stopSignal = _stopController.signal;

      // Overall timeout guard
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error('Automation timed out after 3 minutes. Please try again.'));
        }, AUTOMATION_TIMEOUT_MS);
      });

      // Stop signal as a promise leg in the race
      const stopPromise = new Promise((_, reject) => {
        stopSignal.addEventListener('abort', () => reject(new Error('Stopped by user.')), { once: true });
      });

      try {
        await Promise.race([timeoutPromise, stopPromise, (async () => {

          const s = cleanName(request.supplierName || 'Ariba');
          supplierKey = s; // expose to outer catch
          _currentReportSupplier = request.rawSupplierName || request.supplierName || s;
          const tabId = sender.tab?.id;

          // Check NotebookLM config FIRST — skip all fetch() work if NLM is disabled
          const { notebooklmConfig } = await chrome.storage.session.get('notebooklmConfig');
          const nlmEnabled = notebooklmConfig?.connectToNotebooklm === true;

          // ── Process files with bounded concurrency: Fetch → Extract → Disk + NLM ──
          // Files are independent, so several can be in flight at once instead of each
          // one's fetch + extraction + disk-save fully finishing before the next starts.
          // The dedup checks below (seenHashes / usedFilenames) are plain synchronous
          // JS with no `await` between check-and-set, so concurrent workers can't race
          // on them — JS never interleaves in the middle of a synchronous block.
          const DOWNLOAD_CONCURRENCY = 4;
          const files = request.files || [];
          const diskDownloadIds = [];
          const filesForNotebook = [];
          const usedFilenames = new Set(); // Track filenames to guarantee uniqueness
          const seenHashes = new Map(); // hash -> filename, to skip byte-identical duplicate files this run

          async function processFile(idx) {
            if (stopSignal.aborted) throw new Error('Stopped by user.');
            const file = files[idx];
            let realFilename = file.filename.replace(/["']/g, '').trim();
            let mimeType = '';
            let dataUrl = null;
            let blob = null;

            notifyAribaTab(tabId, `Fetching file ${idx + 1}/${files.length}: ${realFilename}...`);

            try {
              // We fetch the file to memory. This is required for NotebookLM, but also gives us
              // the true Content-Disposition and Content-Type to fix missing extensions.
              const resp = await fetchWithRetry(file.url, {
                retries: 2, timeoutMs: 30000, delayMs: 2000, tabId, filename: realFilename, stopSignal
              });

              // 1. Try to get the real filename from Content-Disposition
              const disp = resp.headers.get('Content-Disposition');
              if (disp) {
                // Try to match filename*=UTF-8''...
                const utf8Match = disp.match(/filename\*=UTF-8''([^;\n]*)/i);
                if (utf8Match && utf8Match[1]) {
                  try { realFilename = decodeURIComponent(utf8Match[1]); } catch (e) { realFilename = utf8Match[1]; }
                } else {
                  // Fallback to standard filename="..."
                  const match = disp.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
                  if (match && match[1]) {
                    let extracted = match[1].replace(/['"]/g, '').trim();
                    // Some servers illegally URL-encode the standard filename attribute
                    if (extracted.includes('%')) {
                      try { extracted = decodeURIComponent(extracted); } catch (e) { }
                    }
                    if (extracted) realFilename = extracted;
                  }
                }
              }

              blob = await resp.blob();
              mimeType = blob.type || resp.headers.get('Content-Type') || '';

              // 1b. Content-hash dedup: skip files that are byte-for-byte identical to
              // one already processed this run (Ariba sometimes serves the exact same
              // document under two different filenames/attachment slots).
              const arrayBuf = await blob.arrayBuffer();
              const fileHash = await hashArrayBuffer(arrayBuf);
              if (seenHashes.has(fileHash)) {
                notifyAribaTab(tabId,
                  `Skipped "${realFilename}" — identical to "${seenHashes.get(fileHash)}" (already processed).`);
                return;
              }
              seenHashes.set(fileHash, realFilename);

              // 2. Fallback: if filename STILL doesn't have an extension, guess from the mime type
              if (!realFilename.includes('.')) {
                if (mimeType.includes('pdf')) realFilename += '.pdf';
                else if (mimeType.includes('png')) realFilename += '.png';
                else if (mimeType.includes('jpeg') || mimeType.includes('jpg')) realFilename += '.jpg';
                else if (mimeType.includes('word') || mimeType.includes('document')) realFilename += '.docx';
                else if (mimeType.includes('excel') || mimeType.includes('sheet')) realFilename += '.xlsx';
                else if (mimeType.includes('text/plain')) realFilename += '.txt';
                else realFilename += '.pdf'; // safest fallback for Ariba documents
              }

              // 3. Deduplicate filenames: if Ariba provides multiple files with the EXACT same name,
              // Chrome downloads will silently append ' (1)' to the disk file, but NotebookLM would 
              // receive duplicate names and fail. We explicitly append ' (1)' to both here.
              let uniqueFilename = realFilename;
              let counter = 1;
              while (usedFilenames.has(uniqueFilename.toLowerCase())) {
                const lastDot = realFilename.lastIndexOf('.');
                if (lastDot !== -1) {
                  uniqueFilename = `${realFilename.substring(0, lastDot)} (${counter})${realFilename.substring(lastDot)}`;
                } else {
                  uniqueFilename = `${realFilename} (${counter})`;
                }
                counter++;
              }
              usedFilenames.add(uniqueFilename.toLowerCase());
              realFilename = uniqueFilename;

              // Bail before the (potentially slow) extraction/conversion work below —
              // with concurrent workers, a file can reach this point well after Stop
              // was clicked, since only the fetch itself observes stopSignal mid-flight.
              if (stopSignal.aborted) throw new Error('Stopped by user.');

              // ── PDF → TXT conversion ─────────────────────────────────────
              const isPdf = mimeType.includes('pdf') ||
                realFilename.toLowerCase().endsWith('.pdf');

              if (isPdf && typeof extractTextFromPdfBuffer === 'function') {
                notifyAribaTab(tabId, `Extracting text from "${realFilename}"...`);
                try {
                  // Reuse a prior run's extraction for this exact file if we've seen it
                  // before — skips re-parsing the PDF entirely.
                  const cachedExtraction = await getCachedPdfText(fileHash);
                  let text, isScanned, isPasswordProtected;
                  if (cachedExtraction) {
                    ({ text, isScanned, isPasswordProtected } = cachedExtraction);
                    notifyAribaTab(tabId, `Using cached extraction for "${realFilename}" (seen before).`);
                  } else {
                    ({ text, isScanned, isPasswordProtected } = await extractTextFromPdfBuffer(arrayBuf));
                  }

                  if (isPasswordProtected) {
                    notifyAribaTab(tabId, `Skipped uploading "${realFilename}" to NotebookLM (password protected).`, true);
                    notifyPanel(`Skipped NotebookLM upload for "${realFilename}" (password protected).`, true);
                  } else if (!isScanned) {
                    // ── Scanned OK: save .txt to disk + send .txt to NLM ────
                    if (!cachedExtraction) await setCachedPdfText(fileHash, { text, isScanned: false, isPasswordProtected: false });
                    const txtFilename = realFilename.replace(/\.pdf$/i, '.txt');
                    const txtDataUrl = textToDataUrl(text);

                    // Save .txt alongside original PDF on disk
                    const destTxtFilename = `${DOWNLOAD_ROOT}/${s}/${s} - ${cleanName(txtFilename)}`;
                    const txtDownloadId = await new Promise((resolve) => {
                      chrome.downloads.download(
                        { url: txtDataUrl, filename: destTxtFilename, saveAs: false },
                        (dlId) => {
                          if (chrome.runtime.lastError || dlId === undefined) {
                            notifyAribaTab(tabId, `TXT save failed for "${txtFilename}"`, true);
                            resolve(null);
                          } else {
                            notifyAribaTab(tabId, `Saved TXT → ${destTxtFilename}`);
                            resolve(dlId);
                          }
                        }
                      );
                    });
                    if (txtDownloadId != null) diskDownloadIds.push(txtDownloadId);

                    // Send .txt (not the PDF) to NotebookLM
                    if (nlmEnabled) {
                      filesForNotebook.push({
                        filename: `${s} - ${cleanName(txtFilename)}`,
                        dataUrl: txtDataUrl,
                        mimeType: 'text/plain'
                      });
                    }

                  } else {
                    // ── Scanned / garbled: no readable text layer — fall back to PDF ────
                    notifyAribaTab(tabId,
                      `"${realFilename}" has no text layer (scanned image). ` +
                      `Uploading original PDF to NotebookLM as fallback.`, true);
                    if (nlmEnabled) {
                      dataUrl = await blobToDataUrl(blob);
                      filesForNotebook.push({
                        filename: `${s} - ${cleanName(realFilename)}`,
                        dataUrl,
                        mimeType
                      });
                    }

                  }

                } catch (pdfErr) {
                  // Extraction failed unexpectedly — fall back to original PDF
                  notifyAribaTab(tabId,
                    `TXT extraction failed for "${realFilename}": ${pdfErr.message}. ` +
                    `Using original PDF.`, true);
                  if (nlmEnabled) {
                    dataUrl = await blobToDataUrl(blob);
                    filesForNotebook.push({
                      filename: `${s} - ${cleanName(realFilename)}`,
                      dataUrl,
                      mimeType
                    });
                  }
                }

              } else {
                // ── Non-PDF file: original behaviour unchanged ───────────────
                if (nlmEnabled) {
                  dataUrl = await blobToDataUrl(blob);
                  filesForNotebook.push({
                    filename: `${s} - ${cleanName(realFilename)}`,
                    dataUrl,
                    mimeType
                  });
                }
              }

            } catch (err) {
              if (err.message === 'Stopped by user.') throw err;
              notifyAribaTab(tabId, `Failed to fetch "${realFilename}" after retries: ${err.message}`, true);
              return; // Skip this file
            }

            // Bail before writing to disk if Stop was clicked while extraction was
            // still running — avoids one more file landing on disk after Stop.
            if (stopSignal.aborted) throw new Error('Stopped by user.');

            // ── Save to disk using the CORRECTED filename ──
            // Reuse the blob already fetched above instead of hitting file.url again —
            // avoids downloading every attachment twice (fetch() + chrome.downloads).
            // The base64 encode + download-kickoff runs inside withDiskSaveLock so
            // only one file's base64-inflated copy exists in memory at a time, even
            // though up to DOWNLOAD_CONCURRENCY files are fetching/extracting in
            // parallel. Guarded in its own try/catch so a failure here only skips
            // this one file instead of throwing out of processFile and aborting the
            // whole batch via firstFatalError.
            try {
              await withDiskSaveLock(async () => {
                const rawDataUrl = await blobToDataUrl(blob);
                await new Promise((resolve) => {
                  const destFilename = `${DOWNLOAD_ROOT}/${s}/${s} - ${cleanName(realFilename)}`;
                  chrome.downloads.download({ url: rawDataUrl, filename: destFilename, saveAs: false }, (downloadId) => {
                    if (chrome.runtime.lastError || downloadId === undefined) {
                      notifyAribaTab(tabId, `Disk download failed: ${realFilename}`, true);
                      resolve();
                      return;
                    }
                    diskDownloadIds.push(downloadId);
                    const onChanged = (delta) => {
                      if (delta.id !== downloadId) return;
                      if (delta.state?.current === 'interrupted' || delta.state?.current === 'complete') {
                        chrome.downloads.onChanged.removeListener(onChanged);
                      }
                    };
                    chrome.downloads.onChanged.addListener(onChanged);
                    setTimeout(() => chrome.downloads.onChanged.removeListener(onChanged), 300_000);
                    resolve();
                  });
                });
              });
            } catch (err) {
              notifyAribaTab(tabId, `Disk save failed for "${realFilename}": ${err.message}`, true);
              return; // Skip this file
            }
          }

          // Run processFile with bounded concurrency instead of one file at a time.
          let nextFileIdx = 0;
          let firstFatalError = null;
          async function fileWorker() {
            while (nextFileIdx < files.length) {
              if (firstFatalError) return;
              const idx = nextFileIdx++;
              try {
                await processFile(idx);
              } catch (err) {
                firstFatalError = firstFatalError || err;
                return;
              }
            }
          }
          await Promise.all(
            Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, files.length) }, fileWorker)
          );
          if (firstFatalError) throw firstFatalError;

          if (stopSignal.aborted) throw new Error('Stopped by user.');

          if (request.extractedQAData && request.extractedQAData.length > 0) {
            notifyAribaTab(tabId, 'Generating QA markdown document...');

            const originalSupplierName = request.rawSupplierName || request.supplierName || 'Ariba';
            const wTitle = request.workspaceTitle || 'Questionnaire';
            let qaText = `# ${wTitle}\n\n## Supplier: ${originalSupplierName}\n\n`;
            let currentSection = '';

            request.extractedQAData.forEach((qaBlock) => {
              if (qaBlock.sectionLabel && qaBlock.sectionLabel !== currentSection) {
                currentSection = qaBlock.sectionLabel;
                qaText += `## ${currentSection}\n\n`;
              }

              if (qaBlock.questionLabel) {
                qaText += `### ${qaBlock.questionLabel}\n\n`;
              }
              if (qaBlock.attachedFile) {
                qaText += `**Attached File:** \`${s} - ${qaBlock.attachedFile}\`\n\n`;
              }

              qaBlock.answers.forEach(ans => {
                qaText += `- **${ans.label}:** ${ans.value}\n`;
              });
              qaText += `\n---\n\n`;
            });

            const utf8Bytes = new TextEncoder().encode(qaText);
            const base64Text = uint8ArrayToBase64(utf8Bytes);
            const dataUrl = `data:text/markdown;base64,${base64Text}`;

            const qaFilename = `${s} - QA_Data.md`;

            if (nlmEnabled) {
              filesForNotebook.push({
                filename: qaFilename,
                dataUrl: dataUrl,
                mimeType: 'text/markdown'
              });
            }

            const destQaFilename = `${DOWNLOAD_ROOT}/${s}/${qaFilename}`;
            const qaDownloadId = await new Promise((resolve) => {
              chrome.downloads.download({ url: dataUrl, filename: destQaFilename, saveAs: false }, (downloadId) => {
                if (chrome.runtime.lastError || downloadId === undefined) {
                  notifyAribaTab(tabId, `Disk download failed for QA markdown document`, true);
                  resolve(null);
                } else {
                  notifyAribaTab(tabId, `Saved Q&A data → ${destQaFilename}`);
                  resolve(downloadId);
                }
              });
            });

            if (qaDownloadId != null) {
              diskDownloadIds.push(qaDownloadId);
            }

            // --- Capture Full Page Screenshot ---
            if (tabId) {
              notifyAribaTab(tabId, 'Taking full-page screenshot...');
              try {
                chrome.tabs.sendMessage(tabId, { action: 'hideToasts' }).catch(() => { });
                await new Promise(r => setTimeout(r, 150));

                const base64Png = await captureFullPageScreenshot(tabId);

                chrome.tabs.sendMessage(tabId, { action: 'showToasts' }).catch(() => { });

                const imgDataUrl = `data:image/jpeg;base64,${base64Png}`;
                const imgFilename = `${s} - Screenshot.jpeg`;
                const destImgFilename = `${DOWNLOAD_ROOT}/${s}/${imgFilename}`;

                const imgDownloadId = await new Promise((resolve) => {
                  chrome.downloads.download({ url: imgDataUrl, filename: destImgFilename, saveAs: false }, (downloadId) => {
                    if (chrome.runtime.lastError || downloadId === undefined) {
                      notifyAribaTab(tabId, `Disk download failed for screenshot`, true);
                      resolve(null);
                    } else {
                      notifyAribaTab(tabId, `Saved Screenshot → ${destImgFilename}`);
                      resolve(downloadId);
                    }
                  });
                });

                if (imgDownloadId != null) {
                  diskDownloadIds.push(imgDownloadId);
                }
              } catch (err) {
                console.warn('[Ariba Ext] Screenshot failed:', err);
                notifyAribaTab(tabId, `Screenshot failed: ${err.message}`, true);
                chrome.tabs.sendMessage(tabId, { action: 'showToasts' }).catch(() => { });
              }
            }
          }

          const state = await getState(s);
          state.config = notebooklmConfig || null;
          state.filesDone = true;
          // filesForNotebook is NOT stored in session to avoid quota overflow.
          // It is passed directly to maybeOpenNotebookLM as a parameter.
          state.aribaTabId = tabId;
          state.diskDownloadIds = diskDownloadIds;
          state.supplierKey = s;
          await setState(s, state);
          await maybeOpenNotebookLM(s, filesForNotebook);

        })()]); // end Promise.race
      } catch (err) {
        // Covers timeout, stop-by-user, and unexpected throws
        const tabId = sender.tab?.id;
        if (tabId) chrome.tabs.sendMessage(tabId, { action: 'showToasts' }).catch(() => { });
        const isStopped = err.message === 'Stopped by user.';
        notifyAribaTab(tabId, isStopped ? 'Download stopped by user.' : 'Error: ' + err.message, true);
        notifyPanel(isStopped ? 'Stopped by user.' : 'Error: ' + err.message, true, true);
        if (!isStopped) {
          // Awaited so the service worker isn't suspended mid-send (MV3 workers
          // can be torn down the instant Chrome thinks there's no pending work,
          // and an un-awaited fetch doesn't count as pending work to Chrome).
          await reportEvent('fatal', { message: err.message, stack: err.stack, supplier: supplierKey });
        }
        // Clear any stale session state so the next run starts clean
        if (supplierKey) clearState(supplierKey).catch(() => { });
      } finally {
        clearTimeout(timeoutHandle);
        clearStopSignal();
        // Clear the run config so onUpdateAvailable doesn't see a stale
        // 'notebooklmConfig' and wrongly treat it as an active job on the
        // next update check (e.g. if Chrome was closed mid-run last time).
        chrome.storage.session.remove('notebooklmConfig').catch(() => { });
      }
    }

  })();
  return true;
});

// ── Dynamic Content Script Injection ──────────────────────────────────────
// Bypasses Chrome's stubborn manifest cache by injecting the latest
// code programmatically every time a NotebookLM tab loads.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('notebooklm.google.com')) {
    
    // Inject CSS
    chrome.scripting.insertCSS({
      target: { tabId },
      files: ['notebooklm/notebooklm_kit.css']
    }).catch(err => {
      // Ignore errors for chrome:// tabs or disconnected tabs
      if (!err.message.includes('Cannot access contents of url')) {
        console.warn('[Ariba Ext] CSS inject failed:', err);
      }
    });

    // Inject JS
    chrome.scripting.executeScript({
      target: { tabId },
      files: [
        'shared/logger.js',
        'shared/constants.js',
        'notebooklm/notebooklm_kit.js'
      ]
    }).catch(err => {
      if (!err.message.includes('Cannot access contents of url')) {
        console.warn('[Ariba Ext] JS inject failed:', err);
      }
    });
  }
});
