// ============================================================
// nlm_runner.js — NotebookLM Automation Runner
// Injected into the MAIN world of a NotebookLM tab by background.js.
//
// Args are passed via window.__aribaRunnerArgs (set by a tiny isolated-
// world shim just before this file is injected) and cleaned up on entry.
//
// Steps performed:
//   0. Sync system instructions via WIZ RPC (s0tc2d)
//   1. Toggle the "Select All" checkbox to uncheck all sources
//   1.5 Close the Drive upload modal if open
//   2. Register + upload files via WIZ RPC (o4cbdc) and Scotty upload
//   3. Type "Run" into the query box and click Submit
// ============================================================

(async () => {
  // ── Read and clean up args ────────────────────────────────────────────
  const { instructionText, filesToUpload } = window.__aribaRunnerArgs || {};
  delete window.__aribaRunnerArgs;

  // ── Helpers ──────────────────────────────────────────────────────────

  /** Relay a status message to the panel via the isolated-world message bridge. */
  const sendStatus = (text, error = false, done = false) => {
    window.postMessage({
      source: 'ariba-notebooklm-injected',
      text,
      error,
      done
    }, '*');
  };

  const wait = ms => new Promise(r => setTimeout(r, ms));
  const generateReqId = () => Math.floor(Math.random() * 90000) + 10000;

  const getNotebookId = () => {
    const match = window.location.pathname.match(/\/notebook\/([a-zA-Z0-9-]+)/);
    return match ? match[1] : null;
  };

  /**
   * Read dynamic WIZ build params from the page.
   * The fallback values are the last known-good values — update them when
   * they stop working (open DevTools → Network → batchexecute requests).
   */
  const getWizData = () => {
    const data = window.WIZ_global_data || {};
    return {
      bl:   data.cfb2h  || 'boq_labs-tailwind-frontend_20260518.10_p0',
      fSid: data.Fdrif  || '-5077533628963748752',
      at:   data.SNlM0e
    };
  };

  const notebookId = getNotebookId();

  // ── Step 0: Sync system instructions ─────────────────────────────────
  // MAINTENANCE: If this fails (400 error), the RPC ID 's0tc2d' may have rotated.
  // Fix: DevTools → Network → filter "batchexecute" → manually update instructions → find new ID.
  if (notebookId && instructionText) {
    const syncKey = `synced_${notebookId}`;
    if (!sessionStorage.getItem(syncKey)) {
      sendStatus('Syncing system instructions to NotebookLM...');
      const authToken = window.WIZ_global_data?.SNlM0e;

      if (authToken) {
        try {
          const url = `${NLM_API_BASE}?rpcids=${RPC_SYNC_INSTRUCTIONS}&_reqid=${generateReqId()}&bl=boq_labs-tailwind-frontend_20260512.10_p0&f.sid=-7121977511756781186&hl=en&authuser=0&source-path=%2Fnotebook%2F${notebookId}`;

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

          const envelope = [RPC_SYNC_INSTRUCTIONS, JSON.stringify(payload), null, 'generic'];
          const formData = new URLSearchParams();
          formData.set('f.req', JSON.stringify([[envelope]]));
          formData.set('at', authToken);

          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: formData.toString()
          });

          if (response.ok) {
            sendStatus('System instructions synced successfully.');
            sessionStorage.setItem(syncKey, 'true');
          } else {
            sendStatus('Failed to sync system instructions: ' + response.statusText, true);
          }
        } catch (err) {
          sendStatus('Error syncing system instructions: ' + err.message, true);
        }
      } else {
        sendStatus('Auth token not found for syncing.', true);
      }
    }
  }

  // ── Step 1: Toggle "Select All" checkbox BEFORE uploading ─────────────
  let nativeInput = null;
  for (let i = 0; i < 40; i++) { // up to 10 seconds
    nativeInput = document.querySelector('#mat-mdc-checkbox-0-input');
    if (nativeInput) break;

    // If the query box or upload modal close button is already visible the page
    // has finished loading — no point waiting further for the checkbox.
    const queryBox = document.querySelector('textarea.query-box-input') || document.querySelector('textarea[aria-label="Query box"]');
    const closeBtn = document.querySelector('button[aria-label="Close"].close-button');
    if (queryBox || closeBtn) {
      await wait(500); // small buffer for Angular to finish rendering
      nativeInput = document.querySelector('#mat-mdc-checkbox-0-input');
      break;
    }

    await wait(250);
  }

  if (!nativeInput) {
    sendStatus('Select All checkbox not found, skipping toggle...');
  } else {
    const isChecked = nativeInput.checked;

    if (isChecked) {
      nativeInput.click(); // Was checked — one click unchecks it
    } else {
      nativeInput.click(); // Was unchecked — click once to check...
      await wait(600);
      nativeInput.click(); // ...then click again to uncheck
    }

    await wait(1500);
    sendStatus('Unchecked Select All button.');
  }

  // ── Step 1.5: Close the Drive upload modal if open ────────────────────
  const closeBtn = document.querySelector('button[aria-label="Close"].close-button');
  if (closeBtn) {
    closeBtn.click();
    sendStatus('Closed NotebookLM Drive upload modal.');
    await wait(500);
  }

  // ── Step 2: Register + upload files via WIZ RPC (o4cbdc) and Scotty ──
  // MAINTENANCE: If registration fails (400), the RPC ID 'o4cbdc' may have rotated.
  // Fix: DevTools → Network → filter "batchexecute" → manually add a source → find new ID.
  if (notebookId && filesToUpload && filesToUpload.length > 0) {
    const uploadKey = `uploaded_${notebookId}`;
    if (!sessionStorage.getItem(uploadKey)) {
      sessionStorage.setItem(uploadKey, 'true');
      sendStatus(`Registering ${filesToUpload.length} documents in NotebookLM...`);

      try {
        const wiz = getWizData();
        if (!wiz.at) {
          sendStatus('Auth token not found for file registration.', true);
        } else {
          // Build file list — PNGs use type code 13, all others use default
          const fileItems = filesToUpload.map(f =>
            f.filename.toLowerCase().endsWith('.png') ? [f.filename, 13] : [f.filename]
          );

          const payload = [
            fileItems,
            notebookId,
            [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]]]
          ];

          const envelope = [RPC_REGISTER_FILES, JSON.stringify(payload), null, 'generic'];
          const formData = new URLSearchParams();
          formData.set('f.req', JSON.stringify([[envelope]]));
          formData.set('at', wiz.at);

          const reqId = generateReqId();
          const url = `${NLM_API_BASE}?rpcids=${RPC_REGISTER_FILES}&_reqid=${reqId}&bl=${wiz.bl}&f.sid=${wiz.fSid}&hl=en&authuser=0&source-path=%2Fnotebook%2F${notebookId}`;

          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: formData.toString()
          });

          if (!response.ok) {
            throw new Error(`${RPC_REGISTER_FILES} request failed with status: ${response.status}`);
          }

          // Parse the source ID map from the batchexecute response
          const responseText = await response.text();
          let parsedInner = null;
          try {
            const rpcMarker = `"${RPC_REGISTER_FILES}"`;
            const markerIdx = responseText.indexOf(rpcMarker);
            if (markerIdx === -1) throw new Error(`${RPC_REGISTER_FILES} marker not found in response text.`);

            const afterMarker = responseText.indexOf('"', markerIdx + rpcMarker.length + 1);
            if (afterMarker === -1) throw new Error(`Could not find opening quote of ${RPC_REGISTER_FILES} inner JSON string.`);

            let innerJsonStr = '';
            let i = afterMarker + 1;
            while (i < responseText.length) {
              const ch = responseText[i];
              if (ch === '\\') { innerJsonStr += responseText[i + 1]; i += 2; }
              else if (ch === '"') { break; }
              else { innerJsonStr += ch; i++; }
            }
            parsedInner = JSON.parse(innerJsonStr);
          } catch (parseErr) {
            throw new Error(`Failed to parse ${RPC_REGISTER_FILES} inner JSON: ` + parseErr.message);
          }

          // Build filename → sourceId lookup
          const responseFiles = parsedInner[0] || [];
          const sourceIdMap = {};
          for (const item of responseFiles) {
            const sourceId = item[0]?.[0];
            const filename = item[1];
            if (sourceId && filename) sourceIdMap[filename.trim()] = sourceId;
          }

          const findSourceIdForFile = (localFilename) => {
            const localClean = localFilename.trim().toLowerCase();
            for (const [filename, sourceId] of Object.entries(sourceIdMap)) {
              if (filename.trim().toLowerCase() === localClean) return sourceId;
            }
            // Fuzzy fallback: substring match
            for (const [filename, sourceId] of Object.entries(sourceIdMap)) {
              if (filename.toLowerCase().includes(localClean) || localClean.includes(filename.toLowerCase())) {
                return sourceId;
              }
            }
            return null;
          };

          sendStatus(`Uploading ${filesToUpload.length} documents...`);

          const batchSize = UPLOAD_BATCH_SIZE;
          for (let i = 0; i < filesToUpload.length; i += batchSize) {
            const chunkFiles = filesToUpload.slice(i, i + batchSize);

            await Promise.all(chunkFiles.map(async (file) => {
              const sourceId = findSourceIdForFile(file.filename);
              if (!sourceId) {
                sendStatus(`Skipping ${file.filename} (ID not found)`, true);
                return;
              }

              try {
                // Fetch the data URL as a Blob for upload
                const res = await fetch(file.dataUrl);
                const blob = await res.blob();

                // Start a Scotty resumable upload session
                const initUrl = `${NLM_UPLOAD_BASE}?authuser=0&source_id=${encodeURIComponent(sourceId)}`;
                const initRes = await fetch(initUrl, {
                  method: 'POST',
                  headers: {
                    'X-Goog-Upload-Protocol': 'resumable',
                    'X-Goog-Upload-Command': 'start',
                    'X-Goog-Upload-Header-Content-Length': blob.size.toString(),
                    'X-Goog-Upload-Header-Content-Type': file.mimeType,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({ PROJECT_ID: notebookId, SOURCE_NAME: file.filename, SOURCE_ID: sourceId })
                });

                if (!initRes.ok) {
                  const errBody = await initRes.text().catch(() => '');
                  throw new Error(`Failed to start upload session: ${initRes.status} ${initRes.statusText} — ${errBody.slice(0, 200)}`);
                }

                const uploadSessionUrl = initRes.headers.get('X-Goog-Upload-URL');
                if (!uploadSessionUrl) {
                  throw new Error('X-Goog-Upload-URL header not found in session start response.');
                }

                // Upload the file bytes in a single PUT
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
                  sendStatus(`Uploaded ${file.filename} successfully.`);
                } else {
                  const uploadErrBody = await uploadRes.text().catch(() => '');
                  sendStatus(`Failed to upload ${file.filename}: ${uploadRes.status}`, true);
                }
              } catch (err) {
                sendStatus(`Error uploading ${file.filename}: ${err.message}`, true);
              }
            }));
          }

          sendStatus('All files uploaded successfully.');

          // Poll until NotebookLM finishes processing (spinners / "processing..." text gone)
          sendStatus('Waiting for NotebookLM to finish processing all documents...');
          const maxWaitMs = 120000; // 2 minutes max
          const intervalMs = 1000;
          let elapsedMs = 0;

          const isVisible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

          while (elapsedMs < maxWaitMs) {
            const potentialLoaders = Array.from(document.querySelectorAll(
              'mat-progress-spinner, mat-spinner, mat-progress-bar, .loading, .spinner, [role="progressbar"]'
            ));
            const visibleLoaders = potentialLoaders.filter(isVisible);

            const visibleLoadingText = Array.from(document.querySelectorAll('*')).filter(el => {
              if (el.children.length > 0 || !isVisible(el)) return false;
              const text = (el.textContent || '').trim().toLowerCase();
              return text.includes('uploading...') || text.includes('processing...');
            });

            if (visibleLoaders.length === 0 && visibleLoadingText.length === 0) {
              sendStatus('NotebookLM finished processing all documents.');
              break;
            }

            await wait(intervalMs);
            elapsedMs += intervalMs;
          }

          // Small buffer for the UI to settle before next step
          await wait(2000);
        }
      } catch (err) {
        sendStatus('API upload failed: ' + err.message, true);
      }
    }
  }

  // ── Step 3: Type "Run" into the query box and click Submit ────────────
  let queryTextarea = null;
  for (let i = 0; i < 40; i++) { // up to 10 seconds
    queryTextarea = document.querySelector('textarea.query-box-input') || document.querySelector('textarea[aria-label="Query box"]');
    if (queryTextarea) break;
    await wait(250);
  }

  if (queryTextarea) {
    sendStatus('Typing "Run" prompt...');
    queryTextarea.value = 'Run';
    queryTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    queryTextarea.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(500);

    const submitBtn = document.querySelector('button.submit-button') || document.querySelector('button[aria-label="Submit"]');
    if (submitBtn) {
      submitBtn.click();
      sendStatus('Submitted prompt! Process complete.', false, true);
    } else {
      sendStatus('Submit button not found in NotebookLM.', true);
    }
  } else {
    sendStatus('Query box textarea not found in NotebookLM.', true);
  }

  return 'done';
})();
