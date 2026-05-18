(async function () {
  // All status messages are sent to the panel AND logged to the console of the NotebookLM tab
  function log(text, error = false, done = false) {
    console.log(`[Ariba Uploader] ${text}`);
    try { chrome.runtime.sendMessage({ type: 'status', text, error, done }); } catch (e) {}
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));

  // -----------------------------------------------------------------------
  // 1. Read file payloads from session storage
  // -----------------------------------------------------------------------
  log('Uploader injected. Reading file payloads from session storage...');
  
  let payload = null;
  try {
    const r = await chrome.storage.session.get('notebooklmPayload');
    payload = r.notebooklmPayload;
  } catch (e) {
    log('Could not read session storage: ' + e.message, true, true);
    return;
  }

  if (!payload?.length) {
    log('No payloads found in session storage. Nothing to upload.', true, true);
    return;
  }

  log(`Found ${payload.length} file(s) to upload.`);

  // -----------------------------------------------------------------------
  // 2. Reconstruct File objects from base64
  // -----------------------------------------------------------------------
  const files = payload.map(p => {
    const bin = atob(p.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: p.mime });
    return new File([blob], p.name, { type: p.mime });
  });

  log(`Reconstructed ${files.length} File object(s). Looking for upload button...`);

  // -----------------------------------------------------------------------
  // 3. Find and click the "Add source" button
  // -----------------------------------------------------------------------
  const addSourceBtn = await findElement(
    el => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      const text = el.textContent.trim().toLowerCase();
      return (tag === 'button' || role === 'button') &&
        (text.includes('add source') || label.includes('add source') || text === '+');
    },
    8000
  );

  if (!addSourceBtn) {
    log('Could not find "Add source" button. Check if NotebookLM page is fully loaded.', true, true);
    return;
  }

  log('Found "Add source" button. Clicking...');
  addSourceBtn.click();
  await wait(1500);

  // -----------------------------------------------------------------------
  // 4. Find and click the "Upload" option in the menu that appears
  // -----------------------------------------------------------------------
  const uploadMenuOption = await findElement(
    el => {
      const text = el.textContent.trim().toLowerCase();
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      return text.includes('upload') || label.includes('upload');
    },
    5000
  );

  if (uploadMenuOption) {
    log('Found "Upload" option. Clicking...');
    uploadMenuOption.click();
    await wait(1500);
  } else {
    log('No "Upload" submenu found — may open directly. Continuing...');
  }

  // -----------------------------------------------------------------------
  // 5. Find the file <input> and inject files via DataTransfer
  // -----------------------------------------------------------------------
  const fileInput = await waitForSelector('input[type="file"]', 8000);

  if (!fileInput) {
    log('Could not find file <input type="file"> on the page.', true, true);
    return;
  }

  log(`Found file input. Injecting ${files.length} file(s)...`);

  // DataTransfer API — works in Chrome for setting input.files programmatically
  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));
  fileInput.files = dt.files;

  // Dispatch events — both native and React-compatible
  fileInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  fileInput.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));

  await wait(500);

  // Verify files were set
  if (fileInput.files.length > 0) {
    log(`✓ ${fileInput.files.length} file(s) set on input. NotebookLM is processing the upload.`, false, true);
  } else {
    log('Files were set but the input is empty. The page may have reset it.', true, true);
  }

  chrome.storage.session.remove('notebooklmPayload');

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  // Wait for an element that matches a predicate function (with MutationObserver)
  function findElement(predicate, timeoutMs) {
    return new Promise(resolve => {
      // Check existing elements first
      const existing = [...document.querySelectorAll('*')].find(predicate);
      if (existing) return resolve(existing);

      const obs = new MutationObserver(() => {
        const found = [...document.querySelectorAll('*')].find(predicate);
        if (found) { obs.disconnect(); resolve(found); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
    });
  }

  // Wait for a CSS selector to appear
  function waitForSelector(selector, timeoutMs) {
    return new Promise(resolve => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const obs = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) { obs.disconnect(); resolve(found); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
    });
  }
})();
