// Load shared constants (RPC IDs, URLs, behaviour values) before anything else
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
    await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(target, 'Page.enable', {}, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    // 3. Get full page dimensions
    const metrics = await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics', {}, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result);
      });
    });

    const { width, height } = metrics.cssContentSize || metrics.contentSize;
    const fullW = Math.ceil(width);
    const fullH = Math.ceil(height);

    notifyAribaTab(tabId, `Capturing full page (${fullW}×${fullH}px)...`);

    // 4. Expand the viewport to the full page size (this is the key step —
    //    without this, captureBeyondViewport tiles the same viewport repeatedly)
    await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
        width: fullW,
        height: fullH,
        deviceScaleFactor: 1,
        mobile: false
      }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    // Let the layout reflow settle after resize
    await new Promise(r => setTimeout(r, 300));

    // 5. Capture — viewport is now the full page, so no clip needed
    const screenshotResult = await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false
      }, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result);
      });
    });

    // 6. Restore original viewport
    await new Promise(resolve => {
      chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride', {}, () => resolve());
    });

    // 7. Detach debugger
    await new Promise(resolve => {
      chrome.debugger.detach(target, () => resolve());
    });

    if (!screenshotResult?.data) {
      notifyAribaTab(tabId, 'Screenshot capture returned no data.', true);
      return null;
    }

    // 8. Save as PNG into the supplier folder inside the extension root folder
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
    chrome.debugger.detach(target, () => { });
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

function cleanName(n) { return n.replace(/[\/\\?%*:|"<>]/g, '-'); }

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
                }).catch(() => {});
              }
            });
          }
        }
      });
    } catch (e) {
      // Failed to inject message bridge
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
      } catch (e) {}
    }

    if (request.action === 'downloadFiles') {
      const s = cleanName(request.supplierName || 'Ariba');
      const tabId = sender.tab?.id;

      // Queue local downloads and fetch them in memory for NotebookLM
      const filesForNotebook = [];
      for (const file of (request.files || [])) {
        chrome.downloads.download({
          url: file.url,
          filename: `${DOWNLOAD_ROOT}/${s}/${s} - ${cleanName(file.filename)}`,
          saveAs: false
        });

        try {
          const resp = await fetch(file.url);
          if (resp.ok) {
            const blob = await resp.blob();
            const dataUrl = await blobToDataUrl(blob);
            filesForNotebook.push({
              filename: `${s} - ${cleanName(file.filename)}`,
              dataUrl: dataUrl,
              mimeType: blob.type
            });
          } else {
            notifyAribaTab(tabId, `Failed to fetch file: ${file.filename}`, true);
          }
        } catch (err) {
          notifyAribaTab(tabId, `Error fetching file: ${file.filename}`, true);
        }
      }

      notifyAribaTab(tabId, `Queued ${(request.files || []).length} file(s). Taking full-page screenshot...`);

      // Capture full-page screenshot AFTER kicking off downloads
      let screenshotDataUrl = null;
      if (tabId) {
        screenshotDataUrl = await captureFullPageScreenshot(tabId, s);
      } else {
        notifyAribaTab(tabId, 'Could not determine Ariba tab for screenshot.', true);
      }

      if (screenshotDataUrl) {
        filesForNotebook.push({
          filename: `${s} - screenshot.png`,
          dataUrl: screenshotDataUrl,
          mimeType: 'image/png'
        });
      }

      const { notebooklmConfig } = await chrome.storage.session.get('notebooklmConfig');
      const state = await getState(s);
      state.config = notebooklmConfig || null;
      state.filesDone = true;
      state.filesForNotebook = filesForNotebook;
      state.aribaTabId = tabId;
      await setState(s, state);
      await maybeOpenNotebookLM(s);
    }

  })();
  return true;
});
