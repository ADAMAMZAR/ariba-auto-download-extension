(async function () {

  // ── Re-entrant guard — prevent double-execution if injected twice ─────
  if (window.__aribaAutomationRunning) {
    console.warn('[Ariba Ext] Automation already in progress, skipping duplicate injection.');
    return;
  }
  window.__aribaAutomationRunning = true;

  // ── Toast notifications ───────────────────────────────────────────────
  // Styles live in content/content.css (injected via panel.js insertCSS).
  function showToast(text, isError = false) {
    let container = document.getElementById('ariba-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'ariba-toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'ariba-toast' + (isError ? ' ariba-toast--error' : '');
    toast.textContent = text;
    container.appendChild(toast);

    // Trigger CSS enter transition
    requestAnimationFrame(() => {
      toast.classList.add('ariba-toast--visible');
    });

    // Trigger CSS exit transition, then remove
    setTimeout(() => {
      toast.classList.remove('ariba-toast--visible');
      toast.classList.add('ariba-toast--exit');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ── Listen for toast messages from the background script ──────────────
  if (!window.hasAribaToastListener) {
    window.hasAribaToastListener = true;
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === 'showToast') {
        showToast(message.text, message.isError);
      }
    });
  }

  // ── Only run in the relevant Ariba frame ──────────────────────────────
  const allButtons = Array.from(document.querySelectorAll('[aria-label="expand"]'));
  const supplierElement = document.querySelector('.supplier-name');
  const allAnchors = Array.from(document.querySelectorAll('.file-name-container a.file-name'));

  console.log('[Ariba Ext] Initial check:', {
    allButtons: allButtons.length,
    supplierElement: !!supplierElement,
    allAnchors: allAnchors.length
  });

  if (allButtons.length === 0 && !supplierElement && allAnchors.length === 0) return;

  // Detect Case 1 and filter elements if content-2 container exists
  const hasCase1 = document.querySelector('.content-2, [content2]');
  console.log('[Ariba Ext] Case 1 detected (content-2):', !!hasCase1);

  let expansionButtons = allButtons;
  let fileAnchors = allAnchors;
  if (hasCase1) {
    expansionButtons = allButtons.filter(btn => btn.closest('.content-2, [content2]'));
    fileAnchors = allAnchors.filter(a => a.closest('.content-2, [content2]'));
    console.log('[Ariba Ext] Filtered elements for Case 1:', {
      expansionButtons: expansionButtons.length,
      fileAnchors: fileAnchors.length
    });
  }

  try {
    showToast('Found Ariba content. Processing...');

    let supplierName = 'Unknown Supplier';
    if (supplierElement) {
      supplierName = supplierElement.textContent.trim().replace(/[\/\\?%*:|"<>]/g, '-');
    }

    // Step 1: Expand all sections
    if (expansionButtons.length > 0) {
      showToast(`Expanding ${expansionButtons.length} section(s)...`);
      for (const btn of expansionButtons) {
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        btn.style.outline = '3px solid red';
        btn.style.backgroundColor = 'yellow';
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
          btn.dispatchEvent(new MouseEvent(type, { view: window, bubbles: true, cancelable: true, buttons: 1 }));
        });
        try { btn.click(); } catch (e) { }
        try { if (btn.parentElement) btn.parentElement.click(); } catch (e) { }
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Step 2: Wait for file links
    showToast('Waiting for documents to load...');
    let finalAnchors = [];
    for (let i = 0; i < 30; i++) {
      const currentAnchors = Array.from(document.querySelectorAll('.file-name-container a.file-name'));
      if (currentAnchors.length > 0) {
        if (hasCase1) {
          finalAnchors = currentAnchors.filter(a => a.closest('.content-2, [content2]'));
        } else {
          finalAnchors = currentAnchors;
        }
        console.log(`[Ariba Ext] Polling anchors: found ${currentAnchors.length} total, ${finalAnchors.length} in target scope.`);
        if (finalAnchors.length > 0) break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (finalAnchors.length === 0) {
      showToast('No documents found after expansion.', true);
      return;
    }

    showToast(`Found ${finalAnchors.length} document(s). Downloading...`);
    const files = [];
    finalAnchors.forEach(a => {
      a.style.outline = '2px solid green';
      files.push({ url: a.href, filename: a.getAttribute('download') || a.textContent.trim() || 'document.pdf' });
    });

    // Step 3: Send to background for disk download
    chrome.runtime.sendMessage({ action: 'downloadFiles', supplierName, files });
    showToast('Files sent for download. Processing...');
  } catch (err) {
    showToast('Error: ' + err.message, true);
    console.error('[Ariba Ext] Error running automation:', err);
  } finally {
    window.__aribaAutomationRunning = false;
  }
})();
