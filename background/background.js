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
                format: 'png',
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
}

function notifyPanel(text, error = false, done = false) {
  chrome.runtime.sendMessage({ type: 'status', text, error, done }).catch(() => { });
}

function cleanName(n) {
  return n
    .replace(/["']/g, '')              // Strip quotes completely instead of making them dashes
    .replace(/PTY LIMITED/gi, 'P/L')
    .replace(/PTY LTD\.?/gi, 'P/L')
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
  let gistText = '';
  try {
    // Append a timestamp to bypass GitHub's 5-minute CDN cache on raw Gist URLs.
    // cache: 'no-store' also prevents the browser's own HTTP cache from interfering.
    const gistResponse = await fetch(`${GIST_URL}?t=${Date.now()}`, { cache: 'no-store' });
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
    chrome.tabs.sendMessage(_activeAribaTabId, { action: 'stopAutomation' }).catch(() => { });
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
          const tabId = sender.tab?.id;

          // Check NotebookLM config FIRST — skip all fetch() work if NLM is disabled
          const { notebooklmConfig } = await chrome.storage.session.get('notebooklmConfig');
          const nlmEnabled = notebooklmConfig?.connectToNotebooklm === true;

          // ── Process files sequentially: Fetch → Extract Name → Disk + NLM ──
          const files = request.files || [];
          const diskDownloadIds = [];
          const filesForNotebook = [];
          const usedFilenames = new Set(); // Track filenames to guarantee uniqueness

          for (let idx = 0; idx < files.length; idx++) {
            if (stopSignal.aborted) throw new Error('Stopped by user.');
            const file = files[idx];
            let realFilename = file.filename.replace(/["']/g, '').trim();
            let mimeType = '';
            let dataUrl = null;

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

              const blob = await resp.blob();
              mimeType = blob.type || resp.headers.get('Content-Type') || '';

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

              // ── PDF → TXT conversion ─────────────────────────────────────
              const isPdf = mimeType.includes('pdf') ||
                realFilename.toLowerCase().endsWith('.pdf');

              if (isPdf && typeof extractTextFromPdfBuffer === 'function') {
                notifyAribaTab(tabId, `Extracting text from "${realFilename}"...`);
                try {
                  const arrayBuf = await blob.arrayBuffer();
                  const { text, isScanned, isPasswordProtected } = await extractTextFromPdfBuffer(arrayBuf);

                  if (isPasswordProtected) {
                    notifyAribaTab(tabId, `Skipped uploading "${realFilename}" to NotebookLM (password protected).`, true);
                    notifyPanel(`Skipped NotebookLM upload for "${realFilename}" (password protected).`, true);
                  } else if (!isScanned) {
                    // ── Scanned OK: save .txt to disk + send .txt to NLM ────
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
                    // ── Scanned image: no text layer — fall back to PDF ──────
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
              continue; // Skip this file and move to the next
            }

            // ── Save to disk using the CORRECTED filename ──
            await new Promise((resolve) => {
              const destFilename = `${DOWNLOAD_ROOT}/${s}/${s} - ${cleanName(realFilename)}`;
              chrome.downloads.download({ url: file.url, filename: destFilename, saveAs: false }, (downloadId) => {
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
          }

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

                const imgDataUrl = `data:image/png;base64,${base64Png}`;
                const imgFilename = `${s} - Screenshot.png`;
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
        // Clear any stale session state so the next run starts clean
        if (supplierKey) clearState(supplierKey).catch(() => { });
      } finally {
        clearTimeout(timeoutHandle);
        clearStopSignal();
      }
    }

  })();
  return true;
});
