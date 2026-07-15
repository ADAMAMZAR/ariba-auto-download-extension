// ============================================================
// gemini_runner.js — Gemini Gems Automation Runner
// Injected into the MAIN world of a Gemini tab by background.js.
// ============================================================

(async () => {
  // ── Read and clean up args ────────────────────────────────────────────
  const { filesToUpload } = window.__aribaRunnerArgs || {};
  delete window.__aribaRunnerArgs;

  // ── Network Log Interceptor (Monkey-patch fetch) ───────────────────
  if (!window.__aribaFetchIntercepted) {
    window.__aribaFetchIntercepted = true;
    const originalFetch = window.fetch;
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input?.url || '');

      if (url.includes('BardChatUi/data/batchexecute')) {
        try {
          const urlObj = new URL(url, window.location.origin);
          const sid = urlObj.searchParams.get('f.sid');
          if (sid) window.__aribaWizSid = sid;
          const bl = urlObj.searchParams.get('bl');
          if (bl) window.__aribaWizBl = bl;

          // Sniff XSRF 'at' token from body if present
          if (init?.body) {
            let bodyText = '';
            if (typeof init.body === 'string') {
              bodyText = init.body;
            } else if (typeof init.body.toString === 'function') {
              bodyText = init.body.toString();
            }
            if (bodyText) {
              const params = new URLSearchParams(bodyText);
              const atValue = params.get('at');
              if (atValue) window.__aribaWizAt = atValue;
            }
          }
        } catch (e) {
          console.warn('[Ariba Ext] Failed to parse batchexecute URL:', e);
        }
      }

      const isUploadRequest = url.includes('clients6.google.com') ||
        url.includes('push.clients6.google.com') ||
        url.includes('BardChatUi/data/batchexecute');

      if (isUploadRequest) {
        try {
          const logData = {
            url,
            method: init?.method || 'GET',
            requestHeaders: init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {},
            requestBody: null,
            responseStatus: null,
            responseHeaders: {},
            responseBody: null
          };

          if (init?.body) {
            if (typeof init.body === 'string') {
              logData.requestBody = init.body;
            } else if (init.body instanceof Blob) {
              logData.requestBody = `[Blob: size=${init.body.size}, type=${init.body.type}]`;
            } else if (init.body instanceof ArrayBuffer) {
              logData.requestBody = `[ArrayBuffer: byteLength=${init.body.byteLength}]`;
            } else if (init.body instanceof FormData) {
              logData.requestBody = `[FormData]`;
            } else {
              logData.requestBody = `[Body: ${String(init.body)}]`;
            }
          }

          const response = await originalFetch.apply(this, arguments);
          const clonedResponse = response.clone();

          logData.responseStatus = response.status;
          logData.responseHeaders = Object.fromEntries(clonedResponse.headers.entries());

          try {
            logData.responseBody = await clonedResponse.text();
          } catch (e) {
            logData.responseBody = `[Failed to read response body: ${e.message}]`;
          }

          window.postMessage({
            source: 'ariba-gemini-injected',
            action: 'logNetworkData',
            logData: JSON.stringify(logData, null, 2)
          }, '*');

          return response;
        } catch (err) {
          window.postMessage({
            source: 'ariba-gemini-injected',
            action: 'logNetworkData',
            logData: JSON.stringify({ url, error: err.message }, null, 2)
          }, '*');
          throw err;
        }
      }

      return originalFetch.apply(this, arguments);
    };
  }

  // ── Intercept document.createElement('input') to capture dynamic file inputs ──
  if (!window.__aribaElementCreateIntercepted) {
    window.__aribaElementCreateIntercepted = true;
    const originalCreateElement = document.createElement;
    document.createElement = function (tagName, options) {
      const el = originalCreateElement.apply(this, arguments);
      if (tagName && tagName.toLowerCase() === 'input') {
        let typeVal = el.type;
        Object.defineProperty(el, 'type', {
          get() {
            return typeVal;
          },
          set(val) {
            typeVal = val;
            el.setAttribute('type', val);
            if (val === 'file') {
              console.log('[Ariba Ext] Captured dynamically created file input:', el);
              window.__aribaCapturedFileInput = el;

              el.addEventListener('click', (e) => {
                if (window.__aribaAutomatingUpload) {
                  console.log('[Ariba Ext] Intercepted upload click, preventing OS file dialog');
                  e.preventDefault();
                  e.stopPropagation();
                }
              }, { capture: true });
            }
          },
          configurable: true
        });
      }
      return el;
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /** Relay a status message to the panel via the isolated-world message bridge. */
  const sendStatus = (text, error = false, done = false) => {
    window.postMessage({
      source: 'ariba-gemini-injected',
      text,
      error,
      done
    }, '*');
  };

  /** Send a background action via the isolated-world message bridge. */
  const sendAction = (action) => {
    window.postMessage({
      source: 'ariba-gemini-injected',
      action
    }, '*');
  };

  const wait = ms => new Promise(r => setTimeout(r, ms));

  let supplierName = 'Supplier';

  if (!filesToUpload || filesToUpload.length === 0) {
    sendStatus('No files to upload for Gemini.', true, true);
    return;
  }

  sendStatus('Gemini automation runner started.');

  // ── Step 0: Check for shared Gem landing page ("Use Gem" / "Chat with this Gem") ──
  sendStatus('Checking for landing page or "Use Gem" button...');
  for (let i = 0; i < 20; i++) { // Poll for up to 5 seconds
    const buttons = Array.from(document.querySelectorAll('button'));
    const landingBtn = buttons.find(el => {
      const text = (el.textContent || '').trim().toLowerCase();
      return text.includes('chat with this gem') ||
        text.includes('use gem') ||
        text.includes('use this gem') ||
        text.includes('try this gem') ||
        text.includes('start chat') ||
        text.includes('chat with');
    });

    if (landingBtn) {
      sendStatus('Found landing button. Clicking to open the Gem chat...');
      landingBtn.click();
      await wait(2000); // Wait for transition and elements to load
      break;
    }
    await wait(250);
  }

  // ── Step 1: Wait for chat input editor to appear ─────────────────────
  sendStatus('Locating chat editor...');
  let editor = null;

  for (let i = 0; i < 80; i++) { // Wait up to 20 seconds
    editor = document.querySelector('div[contenteditable="true"]') || document.querySelector('[contenteditable="true"]');
    if (editor) break;
    await wait(250);
  }

  if (!editor) {
    sendStatus('Could not find Gemini editor input.', true, true);
    return;
  }

  // ── Step 2: Open upload menu and trigger file input creation ──────────
  sendStatus('Opening Upload & Tools menu...');
  const findUploadToolsButton = () => {
    let btn = document.querySelector('button[aria-label="Upload & tools"]') ||
      document.querySelector('button[aria-label*="Upload"]') ||
      document.querySelector('button[aria-label*="upload"]');
    if (btn) return btn;
    const plusIcon = document.querySelector('mat-icon[fonticon="plus"]') ||
      document.querySelector('mat-icon[data-mat-icon-name="plus"]');
    if (plusIcon) {
      let parent = plusIcon.parentElement;
      while (parent && parent !== document.body) {
        if (parent.tagName === 'BUTTON') return parent;
        parent = parent.parentElement;
      }
    }
    return null;
  };

  const uploadToolsBtn = findUploadToolsButton();
  if (uploadToolsBtn) {
    uploadToolsBtn.click();
    await wait(1000); // Wait for menu to open and render
  } else {
    sendStatus('Warning: Upload & tools button not found.');
  }

  // Set automating flag to prevent native file chooser dialog from opening
  window.__aribaAutomatingUpload = true;

  // Locate the Files uploader trigger button and click it to instantiate/trigger the input
  const findTriggerButton = () => {
    return document.querySelector('[data-test-id="local-images-files-uploader-button"]') ||
      document.querySelector('.hidden-local-file-image-selector-button') ||
      document.querySelector('[data-test-id="uploader-images-files-button-advanced"] button') ||
      document.querySelector('images-files-uploader button') ||
      Array.from(document.querySelectorAll('button, [role="menuitem"]')).find(el => {
        const txt = (el.textContent || '').trim().toLowerCase();
        return txt.includes('upload files') || txt === 'files';
      });
  };

  const triggerBtn = findTriggerButton();

  if (triggerBtn) {
    sendStatus('Triggering file input creation...');
    triggerBtn.click();
    await wait(1000);
  } else {
    sendStatus('Warning: Files trigger button not found.');
  }

  // ── Step 3: Retrieve the captured file input element ────────────────
  const fileInput = window.__aribaCapturedFileInput || document.querySelector('input[type="file"]');

  if (!fileInput) {
    sendStatus('Could not locate file upload input element.', true, true);
    window.__aribaAutomatingUpload = false;
    return;
  }

  sendStatus('Found file input. Loading files...');

  // ── Step 4: Convert data URLs to File objects and upload ─────────────
  try {
    const dt = new DataTransfer();
    for (const file of filesToUpload) {
      sendStatus(`Preparing: ${file.filename}...`);
      const res = await fetch(file.dataUrl);
      const blob = await res.blob();
      let mimeType = file.mimeType || blob.type;

      // Fallback MIME types
      if (!mimeType) {
        const ext = file.filename.split('.').pop().toLowerCase();
        if (ext === 'pdf') mimeType = 'application/pdf';
        else if (ext === 'png') mimeType = 'image/png';
        else if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
        else if (ext === 'txt') mimeType = 'text/plain';
        else mimeType = 'application/octet-stream';
      }

      const fileObj = new File([blob], file.filename, { type: mimeType });
      dt.items.add(fileObj);
    }

    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    sendStatus('Files attached successfully. Upload in progress...');
  } catch (err) {
    sendStatus('Failed to load files into Gemini: ' + err.message, true, true);
    window.__aribaAutomatingUpload = false;
    return;
  }

  // Restore normal click behavior for user
  window.__aribaAutomatingUpload = false;
  await wait(1000);

  // ── Step 5: Enter the prompt text ───────────────────────────────────
  sendStatus('Typing prompt...');
  try {
    editor.focus();
    // Extract supplier name from the QA file name if available
    const qaFile = filesToUpload.find(f => f.filename.includes('QA_Data'));
    if (qaFile) {
      const parts = qaFile.filename.split(' - QA_Data');
      if (parts.length > 0) {
        supplierName = parts[0].trim();
      }
    }

    const fileNames = filesToUpload.map(f => `"${f.filename}"`).join(', ');
    const promptText = `Analyze the following supplier documents: ${fileNames}. \n\n(CRITICAL: Do not output any internal reasoning or step-by-step logic. Output only the final formatted answer.)`;

    // Simulate keyboard text insertion to update internal state (ProseMirror)
    document.execCommand('insertText', false, promptText);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    sendStatus('Prompt entered successfully.');
  } catch (err) {
    sendStatus('Failed to write prompt: ' + err.message, true, true);
    return;
  }

  // Wait for the upload sequence to start and the Send button to become disabled during transfer
  sendStatus('Waiting 5 seconds for file upload to initialize...');
  await wait(5000);

  // ── Step 6: Wait for the upload to complete and submit ──────────────
  const findSendButton = () => {
    const selectors = [
      'gem-icon-button.send-button button',
      'button[aria-label="Send message"]',
      'gem-icon-button.send-button',
      'button.submit',
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button[aria-label*="Submit"]',
      'button[aria-label*="submit"]',
      'button[aria-label*="Run"]',
      'button[aria-label*="run"]'
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn) return btn;
    }
    // Fallback: search all buttons
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const label = (btn.getAttribute('aria-label') || btn.title || btn.textContent || '').toLowerCase();
      if (label.includes('send') || label.includes('submit') || label.includes('run')) {
        return btn;
      }
    }
    return null;
  };

  const isButtonEnabled = (btn) => {
    if (!btn) return false;
    if (btn.disabled) return false;
    if (btn.getAttribute('aria-disabled') === 'true') return false;
    if (btn.classList && btn.classList.contains('lm-disabled')) return false;
    return true;
  };

  sendStatus('Waiting for upload to finish...');

  let sendButton = null;
  const maxWaitMs = 90000; // 90 seconds timeout
  const intervalMs = 500;
  let elapsedMs = 0;

  while (elapsedMs < maxWaitMs) {
    sendButton = findSendButton();
    if (sendButton && isButtonEnabled(sendButton)) {
      break;
    }
    await wait(intervalMs);
    elapsedMs += intervalMs;
  }

  async function renameConversationRpc(supplier) {
    sendStatus('Renaming conversation via WIZ RPC (MUAZcd) to "Supplier Audit: ' + supplier + '"...');

    // 1. Wait for conversation ID to appear in the URL path segments
    let chatId = null;
    const maxUrlWait = 15000; // 15s max wait for redirect
    let urlElapsed = 0;

    const getChatId = () => {
      const parts = window.location.pathname.split('/');
      if (parts[1] === 'gem' && parts.length >= 4 && parts[3]) {
        return parts[3];
      }
      if (parts[1] === 'app' && parts.length >= 3 && parts[2]) {
        return parts[2];
      }
      return null;
    };

    while (urlElapsed < maxUrlWait) {
      chatId = getChatId();
      if (chatId) break;
      await wait(500);
      urlElapsed += 500;
    }

    if (!chatId) {
      sendStatus('Rename failed: Could not detect conversation ID from URL path.', true);
      return;
    }

    // 2. Retrieve the at (XSRF) token (sniffed first, fallback to WIZ_global_data)
    const atToken = window.__aribaWizAt || window.WIZ_global_data?.SNlM0e;
    if (!atToken) {
      sendStatus('Rename failed: XSRF security token (at) not found on page.', true);
      return;
    }

    // 3. Extract build info and session ID if available from intercepted requests or global variables
    const bl = window.__aribaWizBl || window.WIZ_global_data?.cfb2h || 'boq_assistant-bard-web-server_20260713.17_p0';
    const sid = window.__aribaWizSid || '';
    const sourcePath = window.location.pathname;

    // Generate random _reqid
    const reqId = Math.floor(Math.random() * 9000000) + 1000000;

    let rpcUrl = `https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MUAZcd&source-path=${encodeURIComponent(sourcePath)}&bl=${encodeURIComponent(bl)}&hl=en&_reqid=${reqId}&rt=c`;
    if (sid) {
      rpcUrl += `&f.sid=${encodeURIComponent(sid)}`;
    }

    // Construct the nested JSON request body matching the payload exactly
    const innerReq = JSON.stringify([
      null,
      [["title"]],
      [`c_${chatId}`, `Supplier Audit: ${supplier}`]
    ]);

    const outerReq = JSON.stringify([
      [
        [
          "MUAZcd",
          innerReq,
          null,
          "generic"
        ]
      ]
    ]);

    const bodyParams = new URLSearchParams();
    bodyParams.set('f.req', outerReq);
    bodyParams.set('at', atToken);

    try {
      const resp = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'X-Same-Domain': '1'
        },
        body: bodyParams.toString()
      });

      if (resp.ok) {
        const text = await resp.text();
        if (text.includes('XSrfCheckFailed')) {
          sendStatus('Rename failed: XSRF verification failed on Gemini server.', true);
          console.warn('[Ariba Ext] Rename rejected by server (XSrfCheckFailed):', text);
        } else if (text.includes('MUAZcd')) {
          sendStatus('Conversation successfully renamed to "Supplier Audit: ' + supplier + '".');
        } else {
          sendStatus('Rename failed. Response: ' + text.substring(0, 120), true);
          console.warn('[Ariba Ext] Rename rejected response:', text);
        }
        // Update local sidebar UI in real-time
        try {
          const activeLink = Array.from(document.querySelectorAll('a')).find(el => el.pathname === window.location.pathname);
          if (activeLink) {
            const walker = document.createTreeWalker(activeLink, NodeFilter.SHOW_TEXT);
            let node;
            while (node = walker.nextNode()) {
              const trimmed = node.nodeValue.trim();
              if (trimmed && trimmed.length > 2) {
                node.nodeValue = `Supplier Audit: ${supplier}`;
                break;
              }
            }
          }
        } catch (uiErr) {
          console.warn('[Ariba Ext] Failed to update sidebar UI text:', uiErr);
        }
      } else {
        sendStatus('Rename failed: WIZ RPC returned HTTP ' + resp.status, true);
        console.warn('[Ariba Ext] Rename RPC response failed:', resp.status, resp.statusText);
      }
    } catch (err) {
      sendStatus('Rename failed: ' + err.message, true);
      console.error('[Ariba Ext] Rename RPC fetch failed:', err);
    }
  }

  if (sendButton && isButtonEnabled(sendButton)) {
    sendStatus('Files uploaded completely. Sending prompt...');
    await wait(1000); // 1s visual buffer
    sendButton.click();

    sendStatus('Prompt submitted. Waiting for response generation to start...');

    // Wait for response generation to start (either stop button appears or send button is disabled)
    let generationStarted = false;
    for (let i = 0; i < 15; i++) { // wait up to 7.5 seconds
      const stopBtn = document.querySelector('button[aria-label="Stop response"], gem-icon-button.stop, gem-icon-button.send-button.stop');
      const sendBtn = findSendButton();
      if (stopBtn || (sendBtn && !isButtonEnabled(sendBtn))) {
        generationStarted = true;
        break;
      }
      await wait(500);
    }

    sendStatus('Waiting for response generation to complete...');

    // Wait for generation to finish (stop button disappears from the DOM)
    const maxGenWait = 90000; // 90s max wait for audit completion
    let genElapsed = 0;
    while (genElapsed < maxGenWait) {
      const stopBtn = document.querySelector('button[aria-label="Stop response"], gem-icon-button.stop, gem-icon-button.send-button.stop');
      if (!stopBtn) {
        break;
      }
      await wait(1000);
      genElapsed += 1000;
    }

    // Wait exactly 2 seconds after generation finishes to let backend naming settle
    sendStatus('Waiting 2 seconds for Gemini naming to settle...');
    await wait(2000);

    try {
      await renameConversationRpc(supplierName);
    } catch (e) {
      console.warn('[Ariba Ext] Error renaming conversation:', e);
    }

    sendStatus('Prompt submitted successfully! Process complete.', false, true);
    sendAction('gemini_upload_done');
  } else {
    sendStatus('Timed out waiting for files to finish uploading or send button to be enabled.', true, true);
  }
})();
