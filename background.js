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
      return null;
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

    return dataUrl;

  } catch (err) {
    // Always detach on error to release the tab
    chrome.debugger.detach(target, () => { });
    notifyPanel('Screenshot error: ' + err.message, true);
    return null;
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------
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
  const filesForNotebook = state.filesForNotebook || [];

  // Wait for the page to fully load, then inject the checkbox and sync script
  chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
    if (tabId !== tab.id || info.status !== 'complete') return;

    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async (instructionText, filesToUpload) => {
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

        // ── Step 1: Toggle the checkbox BEFORE uploading ──────────────────
        // Poll for the checkbox — Angular/Material may take a moment to render
        let nativeInput = null;
        for (let i = 0; i < 40; i++) {          // up to 10 seconds
          nativeInput = document.querySelector('#mat-mdc-checkbox-0-input');
          if (nativeInput) break;
          await wait(250);
        }

        if (!nativeInput) {
          console.error('[Ariba Ext] Checkbox #mat-mdc-checkbox-0-input not found. Continuing with upload anyway.');
        } else {
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

          // Let Angular settle after checkbox state change before uploading
          await wait(1500);
          console.log('[Ariba Ext] Checkbox toggle done. Proceeding with file upload...');
        }

        // ── Step 1.5: Close the upload modal if it is open ────────────────
        // NotebookLM sometimes shows an upload-from-drive modal on load;
        // close it so it doesn't block the source panel.
        const closeBtn = document.querySelector('button[aria-label="Close"].close-button');
        if (closeBtn) {
          closeBtn.click();
          console.log('[Ariba Ext] Closed upload modal.');
          await wait(500);
        } else {
          console.log('[Ariba Ext] No upload modal found, continuing...');
        }

        // ── Step 2: Upload session files to NotebookLM via WIZ RPC and Scotty ──
        if (notebookId && filesToUpload && filesToUpload.length > 0) {
          const uploadKey = `uploaded_${notebookId}`;
          if (!sessionStorage.getItem(uploadKey)) {
            console.log('[Ariba Ext] Registering and uploading files via API...', filesToUpload.length);

            try {
              const getWizData = () => {
                const data = window.WIZ_global_data || {};
                return {
                  bl: data.cfb2h || 'boq_labs-tailwind-frontend_20260518.10_p0',
                  fSid: data.Fdrif || '-5077533628963748752',
                  at: data.SNlM0e
                };
              };

              const wiz = getWizData();
              if (!wiz.at) {
                console.error('[Ariba Ext] Auth token (at) not found in WIZ_global_data.');
              } else {
                const fileItems = filesToUpload.map(f => {
                  if (f.filename.toLowerCase().endsWith('.png')) {
                    return [f.filename, 13];
                  } else {
                    return [f.filename];
                  }
                });

                const payload = [
                  fileItems,
                  notebookId,
                  [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]]]
                ];

                const envelope = [
                  'o4cbdc',
                  JSON.stringify(payload),
                  null,
                  'generic'
                ];

                const formData = new URLSearchParams();
                formData.set('f.req', JSON.stringify([[envelope]]));
                formData.set('at', wiz.at);

                const reqId = generateReqId();
                const url = `https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?rpcids=o4cbdc&_reqid=${reqId}&bl=${wiz.bl}&f.sid=${wiz.fSid}&hl=en&authuser=0&source-path=%2Fnotebook%2F${notebookId}`;

                const response = await fetch(url, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
                  },
                  body: formData.toString()
                });

                if (!response.ok) {
                  throw new Error(`o4cbdc request failed with status: ${response.status}`);
                }

                const responseText = await response.text();

                // Log raw response to help debug format issues
                console.log('[Ariba Ext] FULL raw o4cbdc response:', responseText);

                // The batchexecute response contains:  ["wrb.fr","o4cbdc","<escaped_json>", ...]
                // We locate the "o4cbdc" marker and extract the next JSON string that follows
                let parsedInner = null;
                try {
                  // Find the index of the o4cbdc marker
                  const markerIdx = responseText.indexOf('"o4cbdc"');
                  if (markerIdx === -1) {
                    throw new Error('o4cbdc marker not found in response text.');
                  }
                  // After `"o4cbdc","` there is the escaped JSON string. Find the start of that string.
                  const afterMarker = responseText.indexOf('"', markerIdx + '"o4cbdc"'.length + 1); // skip comma
                  if (afterMarker === -1) {
                    throw new Error('Could not find opening quote of o4cbdc inner JSON string.');
                  }
                  // Walk forward to find the end of this JSON string (unescaped closing quote)
                  let innerJsonStr = '';
                  let i = afterMarker + 1;
                  while (i < responseText.length) {
                    const ch = responseText[i];
                    if (ch === '\\') {
                      innerJsonStr += responseText[i + 1];
                      i += 2;
                    } else if (ch === '"') {
                      break;
                    } else {
                      innerJsonStr += ch;
                      i++;
                    }
                  }
                  console.log('[Ariba Ext] Extracted inner JSON string (first 200 chars):', innerJsonStr.slice(0, 200));
                  parsedInner = JSON.parse(innerJsonStr);
                } catch (parseErr) {
                  throw new Error('Failed to parse o4cbdc inner JSON: ' + parseErr.message);
                }


                // Map response filenames to their corresponding source IDs
                const responseFiles = parsedInner[0] || [];
                const sourceIdMap = {};
                for (const item of responseFiles) {
                  const sourceId = item[0]?.[0];
                  const filename = item[1];
                  if (sourceId && filename) {
                    sourceIdMap[filename.trim()] = sourceId;
                  }
                }

                console.log('[Ariba Ext] Extracted Source ID Map:', sourceIdMap);

                // Helper to match filesToUpload to source IDs case-insensitively and with substrings
                const findSourceIdForFile = (localFilename) => {
                  const localClean = localFilename.trim().toLowerCase();
                  for (const [filename, sourceId] of Object.entries(sourceIdMap)) {
                    if (filename.trim().toLowerCase() === localClean) {
                      return sourceId;
                    }
                  }
                  for (const [filename, sourceId] of Object.entries(sourceIdMap)) {
                    if (filename.toLowerCase().includes(localClean) || localClean.includes(filename.toLowerCase())) {
                      return sourceId;
                    }
                  }
                  return null;
                };

                console.log(`[Ariba Ext] Starting batch uploads for ${filesToUpload.length} files...`);

                const batchSize = 5;
                for (let i = 0; i < filesToUpload.length; i += batchSize) {
                  const chunkFiles = filesToUpload.slice(i, i + batchSize);

                  await Promise.all(chunkFiles.map(async (file) => {
                    const sourceId = findSourceIdForFile(file.filename);
                    if (!sourceId) {
                      console.warn(`[Ariba Ext] Could not find sourceId for file: ${file.filename}. Skipping upload.`);
                      return;
                    }

                    try {
                      console.log(`[Ariba Ext] Fetching local blob for ${file.filename}...`);
                      const res = await fetch(file.dataUrl);
                      const blob = await res.blob();

                      console.log(`[Ariba Ext] Initiating Scotty upload session for ${file.filename} (sourceId: ${sourceId})...`);
                      // URL uses only source_id as query param (confirmed from real network trace)
                      const initUrl = `https://notebooklm.google.com/upload/_/?authuser=0&source_id=${encodeURIComponent(sourceId)}`;
                      const initRes = await fetch(initUrl, {
                        method: 'POST',
                        headers: {
                          'X-Goog-Upload-Protocol': 'resumable',
                          'X-Goog-Upload-Command': 'start',
                          'X-Goog-Upload-Header-Content-Length': blob.size.toString(),
                          'X-Goog-Upload-Header-Content-Type': file.mimeType,
                          'Content-Type': 'application/json'
                        },
                        // Exact body format confirmed from NotebookLM network trace
                        body: JSON.stringify({
                          PROJECT_ID: notebookId,
                          SOURCE_NAME: file.filename,
                          SOURCE_ID: sourceId
                        })
                      });

                      // Log all response headers for debugging
                      const initHeaders = {};
                      initRes.headers.forEach((v, k) => { initHeaders[k] = v; });
                      console.log(`[Ariba Ext] Initiation response status: ${initRes.status}`, initHeaders);

                      if (!initRes.ok) {
                        const errBody = await initRes.text().catch(() => '');
                        throw new Error(`Failed to start upload session: ${initRes.status} ${initRes.statusText} — ${errBody.slice(0, 200)}`);
                      }

                      const uploadSessionUrl = initRes.headers.get('X-Goog-Upload-URL');
                      if (!uploadSessionUrl) {
                        throw new Error('X-Goog-Upload-URL header not found in session start response. Headers: ' + JSON.stringify(initHeaders));
                      }

                      console.log(`[Ariba Ext] Uploading bytes of ${file.filename} to session URL...`);
                      const uploadRes = await fetch(uploadSessionUrl, {
                        method: 'PUT',
                        headers: {
                          'X-Goog-Upload-Command': 'upload, finalize',
                          'X-Goog-Upload-Offset': '0',
                          'Content-Type': file.mimeType,
                          'Content-Length': blob.size.toString()
                        },
                        body: blob
                      });

                      if (uploadRes.ok) {
                        console.log(`[Ariba Ext] Uploaded successfully: ${file.filename}`);
                      } else {
                        const uploadErrBody = await uploadRes.text().catch(() => '');
                        console.error(`[Ariba Ext] Failed to upload ${file.filename}: ${uploadRes.status} — ${uploadErrBody.slice(0, 200)}`);
                      }
                    } catch (err) {
                      console.error(`[Ariba Ext] Error uploading ${file.filename}:`, err);
                    }
                  }));
                }

                sessionStorage.setItem(uploadKey, 'true');
                console.log('[Ariba Ext] All files uploaded via direct API.');
              }
            } catch (err) {
              console.error('[Ariba Ext] API upload failed:', err);
            }
          }
        }

        return 'done';
      },
      args: [gistText, filesForNotebook]
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

      // Queue local downloads and fetch them in memory for NotebookLM
      const filesForNotebook = [];
      for (const file of (request.files || [])) {
        chrome.downloads.download({
          url: file.url,
          filename: `${s}/${s} - ${cleanName(file.filename)}`,
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
            console.error('[Ariba Ext] Failed to fetch file for NotebookLM upload:', file.filename, resp.status);
          }
        } catch (err) {
          console.error('[Ariba Ext] Error fetching file for NotebookLM upload:', file.filename, err);
        }
      }

      notifyPanel(`Queued ${(request.files || []).length} file(s). Taking full-page screenshot...`);

      // Capture full-page screenshot AFTER kicking off downloads
      let screenshotDataUrl = null;
      if (tabId) {
        screenshotDataUrl = await captureFullPageScreenshot(tabId, s);
      } else {
        notifyPanel('Could not determine Ariba tab for screenshot.', true);
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
      await setState(s, state);
      await maybeOpenNotebookLM(s);
    }

  })();
  return true;
});