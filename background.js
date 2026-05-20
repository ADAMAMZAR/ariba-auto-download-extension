// Open standalone panel window when extension icon is clicked
chrome.action.onClicked.addListener(() => {
  chrome.windows.create({
    url: chrome.runtime.getURL('panel.html'),
    type: 'popup',
    width: 400,
    height: 520,
    focused: true
  });
});

// -----------------------------------------------------------------------
// Full-page screenshot via Chrome DevTools Protocol (debugger API)
// Mirrors exactly how DevTools "Capture full size screenshot" works:
//   expand viewport → screenshot → restore viewport
// -----------------------------------------------------------------------
async function captureFullPageScreenshot(tabId, supplierName) {
  const target = { tabId };

  try {
    notifyPanel('Attaching debugger for screenshot...');

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

    notifyPanel(`Capturing full page (${fullW}×${fullH}px)...`);

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
      notifyPanel('Screenshot capture returned no data.', true);
      return;
    }

    // 8. Save as PNG into the supplier folder
    const dataUrl = 'data:image/png;base64,' + screenshotResult.data;
    const filename = `${supplierName}/${supplierName} - screenshot.png`;

    chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, () => {
      if (chrome.runtime.lastError) {
        notifyPanel('Screenshot save failed: ' + chrome.runtime.lastError.message, true);
      } else {
        notifyPanel(`Screenshot saved → ${filename}`, false, false);
      }
    });

  } catch (err) {
    // Always detach on error to release the tab
    chrome.debugger.detach(target, () => { });
    notifyPanel('Screenshot error: ' + err.message, true);
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------
function notifyPanel(text, error = false, done = false) {
  chrome.runtime.sendMessage({ type: 'status', text, error, done }).catch(() => { });
}

function cleanName(n) { return n.replace(/[\/\\?%*:|"<>]/g, '-'); }

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
    notifyPanel('Downloads complete!', false, true);
    return;
  }

  // Fetch the latest system instructions from Gist
  notifyPanel('Fetching latest system instructions...');
  let gistText = '';
  try {
    const gistResponse = await fetch('https://gist.githubusercontent.com/ADAMAMZAR/36c4a4e9da603de3c1bedfe76caf59f3/raw/gistfile1.txt');
    if (gistResponse.ok) {
      gistText = await gistResponse.text();
    } else {
      console.warn('[Ariba Ext] Failed to fetch gist text. Status:', gistResponse.status);
    }
  } catch (err) {
    console.error('[Ariba Ext] Error fetching gist:', err);
  }

  notifyPanel('Opening NotebookLM...');
  const tab = await chrome.tabs.create({ url: state.config.notebooklmUrl });

  // Wait for the page to fully load, then inject the checkbox and sync script
  chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
    if (tabId !== tab.id || info.status !== 'complete') return;

    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async (instructionText) => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const generateReqId = () => Math.floor(Math.random() * 90000) + 10000;

        const getNotebookId = () => {
          const match = window.location.pathname.match(/\/notebook\/([a-zA-Z0-9-]+)/);
          return match ? match[1] : null;
        };

        const notebookId = getNotebookId();
        if (notebookId && instructionText) {
          const syncKey = `synced_${notebookId}`;
          if (!sessionStorage.getItem(syncKey)) {
            console.log('[Ariba Ext] Direct system instruction sync started...');
            const authToken = window.WIZ_global_data?.SNlM0e;
            
            if (authToken) {
              try {
                const url = `https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?rpcids=s0tc2d&_reqid=${generateReqId()}&bl=boq_labs-tailwind-frontend_20260512.10_p0&f.sid=-7121977511756781186&hl=en&authuser=0&source-path=%2Fnotebook%2F${notebookId}`;

                const payload = [
                  notebookId,
                  [
                    [
                      null, null, null, null, null, null, null,
                      [
                        [2, instructionText], // '2' sets to custom mode
                        []
                      ]
                    ]
                  ],
                  [
                    2, null, null,
                    [
                      1, null, null, null, null, null, null, null, null, null, [1]
                    ]
                  ]
                ];

                const envelope = [
                  's0tc2d',
                  JSON.stringify(payload),
                  null,
                  'generic'
                ];

                const formData = new URLSearchParams();
                formData.set('f.req', JSON.stringify([[envelope]]));
                formData.set('at', authToken);

                const response = await fetch(url, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
                  },
                  body: formData.toString()
                });

                if (response.ok) {
                  console.log('[Ariba Ext] System instructions successfully synced to custom!');
                  sessionStorage.setItem(syncKey, 'true');
                  window.location.reload();
                  return 'reloaded';
                } else {
                  console.error('[Ariba Ext] Failed to update system instructions:', response.statusText);
                }
              } catch (err) {
                console.error('[Ariba Ext] Error updating system instructions:', err);
              }
            } else {
              console.error('[Ariba Ext] Auth token not found in WIZ_global_data.');
            }
          }
        }

        // Poll for the checkbox — Angular/Material may take a moment to render
        let nativeInput = null;
        for (let i = 0; i < 40; i++) {          // up to 10 seconds
          nativeInput = document.querySelector('#mat-mdc-checkbox-0-input');
          if (nativeInput) break;
          await wait(250);
        }

        if (!nativeInput) {
          console.error('[Ariba Ext] Checkbox #mat-mdc-checkbox-0-input not found.');
          return 'done';
        }

        const isChecked = nativeInput.checked;
        console.log('[Ariba Ext] Checkbox state:', isChecked);

        if (isChecked) {
          // Already checked → click once
          nativeInput.click();
          console.log('[Ariba Ext] Was checked — clicked once.');
        } else {
          // Unchecked → click twice with buffer so Angular registers each change
          nativeInput.click();
          console.log('[Ariba Ext] Was unchecked — first click done. Waiting...');
          await wait(600);
          nativeInput.click();
          console.log('[Ariba Ext] Second click done.');
        }

        return 'done';
      },
      args: [gistText]
    }, (results) => {
      if (chrome.runtime.lastError) {
        console.error('Sync/Checkbox script error: ' + chrome.runtime.lastError.message);
        chrome.tabs.onUpdated.removeListener(listener);
        return;
      }
      const result = results?.[0]?.result;
      if (result === 'done') {
        chrome.tabs.onUpdated.removeListener(listener);
      }
    });

    notifyPanel('NotebookLM opened and system instructions synced!', false, true);
  });
}

// -----------------------------------------------------------------------
// Message handler
// -----------------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {

    if (request.action === 'downloadFiles') {
      const s = cleanName(request.supplierName || 'Ariba');
      const tabId = sender.tab?.id;

      // Queue all document downloads
      for (const file of (request.files || [])) {
        chrome.downloads.download({
          url: file.url,
          filename: `${s}/${s} - ${cleanName(file.filename)}`,
          saveAs: false
        });
      }

      notifyPanel(`Queued ${(request.files || []).length} file(s). Taking full-page screenshot...`);

      // Capture full-page screenshot AFTER kicking off downloads
      if (tabId) {
        await captureFullPageScreenshot(tabId, s);
      } else {
        notifyPanel('Could not determine Ariba tab for screenshot.', true);
      }

      const { notebooklmConfig } = await chrome.storage.session.get('notebooklmConfig');
      const state = await getState(s);
      state.config = notebooklmConfig || null;
      state.filesDone = true;
      await setState(s, state);
      await maybeOpenNotebookLM(s);
    }

  })();
  return true;
});