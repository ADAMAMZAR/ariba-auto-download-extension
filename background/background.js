// Load shared logger first, then constants
importScripts('../shared/logger.js');
importScripts('../shared/constants.js');


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
// Full-page screenshot via Chrome DevTools Protocol (debugger API)
// Mirrors exactly how DevTools "Capture full size screenshot" works:
//   expand viewport → screenshot → restore viewport
// -----------------------------------------------------------------------

/** Promisified wrapper for chrome.debugger.sendCommand. */
function debuggerCmd(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

async function captureFullPageScreenshot(tabId, supplierName) {
  const target = { tabId };

  try {
    notifyAribaTab(tabId, 'Attaching debugger for screenshot...');

    // 1. Attach debugger
    await new Promise((resolve, reject) => {
      chrome.debugger.attach(target, '1.3', () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    // 2. Enable Page domain
    await debuggerCmd(target, 'Page.enable');

    // 3. Get full page dimensions
    const metrics = await debuggerCmd(target, 'Page.getLayoutMetrics');
    const { width, height } = metrics.cssContentSize || metrics.contentSize;
    const fullW = Math.ceil(width);
    const fullH = Math.ceil(height);

    notifyAribaTab(tabId, `Capturing full page (${fullW}×${fullH}px)...`);

    // 4. Expand the viewport to the full page size (this is the key step —
    //    without this, captureBeyondViewport tiles the same viewport repeatedly)
    await debuggerCmd(target, 'Emulation.setDeviceMetricsOverride', {
      width: fullW, height: fullH, deviceScaleFactor: 1, mobile: false
    });

    // Let the layout reflow settle after resize
    await new Promise(r => setTimeout(r, 300));

    // 5. Capture — viewport is now the full page, so no clip needed
    const screenshotResult = await debuggerCmd(target, 'Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false
    });

    // 6. Restore original viewport
    await debuggerCmd(target, 'Emulation.clearDeviceMetricsOverride');

    // 7. Detach debugger
    await new Promise(resolve => chrome.debugger.detach(target, () => resolve()));

    if (!screenshotResult?.data) {
      notifyAribaTab(tabId, 'Screenshot capture returned no data.', true);
      return null;
    }

    // 8. Save as PNG into the supplier folder
    const dataUrl = 'data:image/png;base64,' + screenshotResult.data;
    const filename = `${DOWNLOAD_ROOT}/${supplierName}/${supplierName} - screenshot.png`;

    chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, () => {
      if (chrome.runtime.lastError) {
        notifyAribaTab(tabId, 'Screenshot save failed: ' + chrome.runtime.lastError.message, true);
      } else {
        notifyAribaTab(tabId, `Screenshot saved → ${filename}`);
      }
    });

    return dataUrl;

  } catch (err) {
    // Always detach on error to release the tab
    chrome.debugger.detach(target, () => {});
    notifyAribaTab(tabId, 'Screenshot error: ' + err.message, true);
    return null;
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------
function notifyAribaTab(tabId, text, isError = false) {
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { action: 'showToast', text, isError }).catch(() => { });
  }
}

function notifyPanel(text, error = false, done = false) {
  chrome.runtime.sendMessage({ type: 'status', text, error, done }).catch(() => { });
}

function cleanName(n) {
  return n
    .replace(/[\/\\?%*:|"<>]/g, '-') // illegal filesystem characters
    .replace(/\.+$/, '')              // Windows: names cannot end with a period
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
// Open NotebookLM once downloads are done, then interact with the checkbox
// -----------------------------------------------------------------------
async function maybeOpenNotebookLM(supplier) {
  const state = await getState(supplier);
  if (!state.filesDone) return;
  await clearState(supplier);

  if (!state.config?.connectToNotebooklm) {
    notifyAribaTab(state.aribaTabId, 'Downloads complete!');
    notifyPanel('Downloads complete!', false, true);
    return;
  }

  // Fetch the latest system instructions from Gist
  notifyPanel('Fetching latest system instructions...');
  let gistText = '';
  try {
    const gistResponse = await fetch(GIST_URL);
    if (gistResponse.ok) {
      gistText = await gistResponse.text();
    } else {
      notifyPanel('Failed to fetch system instructions from Gist.', true);
    }
  } catch (err) {
    notifyPanel('Error fetching system instructions: ' + err.message, true);
    notifyAribaTab(state.aribaTabId, 'Error fetching system instructions: ' + err.message, true);
  }

  notifyPanel('Opening NotebookLM...');
  const tab = await chrome.tabs.create({ url: state.config.notebooklmUrl });
  const filesForNotebook = state.filesForNotebook || [];

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
                chrome.runtime.sendMessage({
                  type: 'status',
                  text: event.data.text,
                  error: event.data.error,
                  done: event.data.done
                }).catch(() => { });
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
        notifyPanel('Sync/Checkbox script error: ' + chrome.runtime.lastError.message, true);
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

function triggerStop() {
  // 1. Abort all in-flight fetches
  if (_stopController) {
    _stopController.abort();
    _stopController = null;
  }
  // 2. Tell the Ariba content script to stop its own loops
  if (_activeAribaTabId) {
    chrome.tabs.sendMessage(_activeAribaTabId, { action: 'stopAutomation' }).catch(() => {});
    _activeAribaTabId = null;
  }
}

function clearStopSignal() {
  _stopController = null;
  _activeAribaTabId = null;
}

// -----------------------------------------------------------------------
// Message handler
// -----------------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {

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
          const tabId = sender.tab?.id;

          // Check NotebookLM config FIRST — skip all fetch() work if NLM is disabled
          const { notebooklmConfig } = await chrome.storage.session.get('notebooklmConfig');
          const nlmEnabled = notebooklmConfig?.connectToNotebooklm === true;

          // ── Disk downloads (always) ──────────────────────────────────────
          const files = request.files || [];
          for (const file of files) {
            const destFilename = `${DOWNLOAD_ROOT}/${s}/${s} - ${cleanName(file.filename)}`;
            chrome.downloads.download({ url: file.url, filename: destFilename, saveAs: false },
              (downloadId) => {
                if (chrome.runtime.lastError || downloadId === undefined) {
                  notifyAribaTab(tabId, `Download failed to start: ${file.filename}`, true);
                  return;
                }
                // Watch for interruption / failure
                const onChanged = (delta) => {
                  if (delta.id !== downloadId) return;
                  if (delta.state?.current === 'interrupted') {
                    notifyAribaTab(tabId,
                      `Download interrupted: ${file.filename}` +
                      (delta.error?.current ? ` (${delta.error.current})` : ''), true);
                    chrome.downloads.onChanged.removeListener(onChanged);
                  } else if (delta.state?.current === 'complete') {
                    chrome.downloads.onChanged.removeListener(onChanged);
                  }
                };
                chrome.downloads.onChanged.addListener(onChanged);
                // Safety: remove listener after 5 minutes
                setTimeout(() => chrome.downloads.onChanged.removeListener(onChanged), 300_000);
              }
            );
          }

          // ── In-memory fetch for NotebookLM (only when NLM is enabled) ───
          const filesForNotebook = [];
          if (nlmEnabled) {
            for (let idx = 0; idx < files.length; idx++) {
              if (stopSignal.aborted) throw new Error('Stopped by user.');
              const file = files[idx];
              notifyAribaTab(tabId, `Fetching file ${idx + 1}/${files.length}: ${file.filename}...`);
              try {
                const resp = await fetchWithRetry(file.url, {
                  retries: 2,
                  timeoutMs: 30_000,
                  delayMs: 2000,
                  tabId,
                  filename: file.filename,
                  stopSignal
                });
                const blob = await resp.blob();
                const dataUrl = await blobToDataUrl(blob);
                filesForNotebook.push({
                  filename: `${s} - ${cleanName(file.filename)}`,
                  dataUrl,
                  mimeType: blob.type
                });
              } catch (err) {
                if (err.message === 'Stopped by user.') throw err; // propagate stop
                notifyAribaTab(tabId,
                  `Failed to fetch "${file.filename}" after retries: ${err.message}`, true);
              }
            }
          }

          if (stopSignal.aborted) throw new Error('Stopped by user.');

          notifyAribaTab(tabId,
            `Queued ${files.length} file(s) for download. Taking full-page screenshot...`);

          // Hide toasts so they don't appear in the screenshot
          if (tabId) chrome.tabs.sendMessage(tabId, { action: 'hideToasts' }).catch(() => {});

          let screenshotDataUrl = null;
          if (tabId) {
            screenshotDataUrl = await captureFullPageScreenshot(tabId, s);
          } else {
            notifyAribaTab(tabId, 'Could not determine Ariba tab for screenshot.', true);
          }

          // Restore toasts
          if (tabId) chrome.tabs.sendMessage(tabId, { action: 'showToasts' }).catch(() => {});

          if (screenshotDataUrl && nlmEnabled) {
            filesForNotebook.push({
              filename: `${s} - screenshot.png`,
              dataUrl: screenshotDataUrl,
              mimeType: 'image/png'
            });
          }

          const state = await getState(s);
          state.config = notebooklmConfig || null;
          state.filesDone = true;
          state.filesForNotebook = filesForNotebook;
          state.aribaTabId = tabId;
          await setState(s, state);
          await maybeOpenNotebookLM(s);

        })()]); // end Promise.race
      } catch (err) {
        // Covers timeout, stop-by-user, and unexpected throws
        const tabId = sender.tab?.id;
        if (tabId) chrome.tabs.sendMessage(tabId, { action: 'showToasts' }).catch(() => {});
        const isStopped = err.message === 'Stopped by user.';
        notifyAribaTab(tabId, isStopped ? 'Download stopped by user.' : 'Error: ' + err.message, true);
        notifyPanel(isStopped ? 'Stopped by user.' : 'Error: ' + err.message, true, true);
        // Clear any stale session state so the next run starts clean
        if (supplierKey) clearState(supplierKey).catch(() => {});
      } finally {
        clearTimeout(timeoutHandle);
        clearStopSignal();
      }
    }

  })();
  return true;
});
