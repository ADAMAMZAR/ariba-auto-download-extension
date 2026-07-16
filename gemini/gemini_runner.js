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

  // ── No element interception needed for Paste method ──
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

  // ── Step 2: Inject Files directly via Clipboard Paste ──
  sendStatus('Attaching files via direct Paste simulation...');
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

    editor.focus();
    
    // Dispatch a highly synthetic paste event directly onto the editor
    // ProseMirror (Gemini's editor) listens for this and natively uploads the files!
    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt
    });
    
    editor.dispatchEvent(pasteEvent);
    
    sendStatus('Files pasted successfully! Upload in progress...');
    await wait(2000); // Wait for UI to register the pasted files
  } catch (err) {
    sendStatus('Failed to load files into Gemini: ' + err.message, true, true);
    return;
  }

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

  // Wait for the upload sequence to start (Send button becomes disabled)
  sendStatus('Waiting for file upload to initialize...');
  
  // We need to find the send button first so we can monitor its state
  const findSendButton = () => {
    const isStopBtn = (el) => {
      if (!el) return false;
      if (el.classList && el.classList.contains('stop')) return true;
      if (el.closest && el.closest('.stop')) return true;
      const label = (el.getAttribute('aria-label') || el.title || el.textContent || '').toLowerCase();
      return label.includes('stop');
    };

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
      if (btn && !isStopBtn(btn)) return btn;
    }
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (isStopBtn(btn)) continue;
      const label = (btn.getAttribute('aria-label') || btn.title || btn.textContent || '').toLowerCase();
      if (label.includes('send') || label.includes('submit') || label.includes('run')) return btn;
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

  // Poll every 100ms until the send button is disabled (indicating upload has begun)
  for (let i = 0; i < 50; i++) { 
    const btn = findSendButton();
    if (btn && !isButtonEnabled(btn)) break;
    await wait(100);
  }

  // ── Step 6: Wait for the upload to complete and submit ──────────────
  // In a background tab, the UI framework (Angular/React) may suspend rendering,
  // meaning the Send button never visually updates to "enabled" until focused.
  // To bypass this, we aggressively attempt to submit every 2 seconds until
  // we detect that generation has started (Stop button appears).

  sendStatus('Waiting for upload to finish and submitting prompt in background...');

  let sendButton = null;
  const maxWaitMs = 90000; // 90 seconds timeout
  const intervalMs = 2000; // 2s (background tabs throttle to 1s anyway)
  let elapsedMs = 0;
  let generationStarted = false;

  while (elapsedMs < maxWaitMs) {
    sendButton = findSendButton();
    
    if (sendButton) {
      // Force remove disabled attributes so native click events aren't blocked by the browser
      sendButton.removeAttribute('disabled');
      sendButton.removeAttribute('aria-disabled');
      sendButton.classList.remove('lm-disabled');
      
      // Dispatch a click on the button
      sendButton.click();
    }
    
    if (editor) {
      // Also dispatch Enter on the editor as a fallback
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13
      }));
    }

    // Check if it successfully sent (Stop button appeared)
    const stopBtn = document.querySelector('button[aria-label="Stop response"], gem-icon-button.stop, gem-icon-button.send-button.stop');
    
    if (stopBtn) {
      generationStarted = true;
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

  if (generationStarted) {
    sendStatus('Prompt submitted successfully! Waiting for response generation to complete...');

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
