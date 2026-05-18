(async function () {
  function sendStatus(text, error = false, done = false) {
    chrome.runtime.sendMessage({ type: 'status', text, error, done });
  }

  // Only run in the relevant Ariba frame
  const expansionButtons = document.querySelectorAll('.material-icons.expansion-button');
  const supplierElement = document.querySelector('.supplier-name');
  const fileAnchors = document.querySelectorAll('.file-name-container a.file-name');
  if (expansionButtons.length === 0 && !supplierElement && fileAnchors.length === 0) return;

  sendStatus('Found Ariba content. Processing...');

  // Read config — gracefully handle iframe storage restrictions
  let notebooklmConfig = null;
  try {
    const r = await chrome.storage.session.get('notebooklmConfig');
    notebooklmConfig = r.notebooklmConfig || null;
  } catch (e) {
    console.warn('[Ariba Ext] Session storage unavailable in this frame:', e.message);
  }

  let supplierName = 'Unknown Supplier';
  if (supplierElement) {
    supplierName = supplierElement.textContent.trim().replace(/[\/\\?%*:|"<>]/g, '-');
  }

  // Step 1: Expand all sections
  if (expansionButtons.length > 0) {
    sendStatus(`Expanding ${expansionButtons.length} section(s)...`);
    for (const btn of expansionButtons) {
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      btn.style.outline = '3px solid red';
      btn.style.backgroundColor = 'yellow';
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
        btn.dispatchEvent(new MouseEvent(type, { view: window, bubbles: true, cancelable: true, buttons: 1 }));
      });
      try { btn.click(); } catch (e) {}
      try { if (btn.parentElement) btn.parentElement.click(); } catch (e) {}
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Step 2: Wait for file links
  sendStatus('Waiting for documents to load...');
  let finalAnchors = [];
  for (let i = 0; i < 30; i++) {
    finalAnchors = document.querySelectorAll('.file-name-container a.file-name');
    if (finalAnchors.length > 0) break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (finalAnchors.length === 0) {
    sendStatus('No documents found after expansion.', true, true);
    return;
  }

  sendStatus(`Found ${finalAnchors.length} document(s). Downloading...`);
  const files = [];
  finalAnchors.forEach(a => {
    a.style.outline = '2px solid green';
    files.push({ url: a.href, filename: a.getAttribute('download') || a.textContent.trim() || 'document.pdf' });
  });

  // Step 3: Send to background for disk download
  chrome.runtime.sendMessage({ action: 'downloadFiles', supplierName, files, notebooklmConfig });

  // Step 4: Screenshot (always notify background when done, even on failure)
  sendStatus('Capturing screenshot...');
  let screenshotDataUrl = null;
  try {
    await new Promise(r => setTimeout(r, 1500));
    if (typeof html2canvas !== 'undefined') {
      const canvas = await html2canvas(document.body, {
        useCORS: true, allowTaint: true,
        scale: window.devicePixelRatio > 1 ? 1 : window.devicePixelRatio,
        scrollY: -window.scrollY
      });
      screenshotDataUrl = canvas.toDataURL('image/jpeg', 0.85);
    }
  } catch (e) {
    console.warn('[Ariba Ext] Screenshot failed:', e.message);
  }

  // Always notify background — this is what triggers the NotebookLM flow
  chrome.runtime.sendMessage({
    action: 'downloadScreenshot',
    supplierName,
    dataUrl: screenshotDataUrl, // may be null if screenshot failed
    notebooklmConfig
  });

  sendStatus(screenshotDataUrl ? 'Screenshot captured!' : 'Files downloaded (screenshot skipped).');
})();
