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
      if (message.action === 'hideToasts') {
        const c = document.getElementById('ariba-toast-container');
        if (c) c.style.visibility = 'hidden';
      }
      if (message.action === 'showToasts') {
        const c = document.getElementById('ariba-toast-container');
        if (c) c.style.visibility = '';
      }
      if (message.action === 'stopAutomation') {
        window.__aribaStop = true;
        showToast('Stopping...', false);
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

  // ── Scope detection ───────────────────────────────────────────────
  // DOM structure when highlight present:
  //   .highlight-container.highlight  ← big parent
  //     ├── .content-1  (old questionnaire, ignore)
  //     └── .content-2  (updated questionnaire, use this)
  // DOM structure when no highlight (new user):
  //   .highlight-container  (no highlight class)
  //     ├── .content-1  (old, ignore)
  //     └── .content-2  (updated, use this)
  const highlightContainer = document.querySelector(
    '.view-mode-content-container.highlight-container.highlight'
  );

  let scopeLabel  = 'all';
  let scopeFilter = null; // null → use all elements

  if (highlightContainer) {
    // Existing user making an amendment.
    // content-2 is searched INSIDE the highlight container to avoid
    // matching content-2 from other (non-highlighted) sections on the page.
    const content2InHighlight = highlightContainer.querySelector('.content-2, [content2]');
    if (content2InHighlight) {
      // Amendment + two questionnaires: must be inside BOTH highlight AND content-2
      scopeLabel  = 'highlight+content-2';
      scopeFilter = el =>
        el.closest('.view-mode-content-container.highlight-container.highlight') &&
        el.closest('.content-2, [content2]');
    } else {
      // Amendment + one questionnaire: entire highlight container
      scopeLabel  = 'highlight-only';
      scopeFilter = el =>
        el.closest('.view-mode-content-container.highlight-container.highlight');
    }
  } else {
    // New user — no highlight class on any container.
    const content2Container = document.querySelector('.content-2, [content2]');
    if (content2Container) {
      // Two questionnaires: only download the updated one (content-2)
      scopeLabel  = 'content-2-only';
      scopeFilter = el => el.closest('.content-2, [content2]');
    }
    // else: single questionnaire → scopeFilter stays null → all buttons
  }

  console.log('[Ariba Ext] Scope mode:', scopeLabel, {
    highlightContainer: !!highlightContainer
  });

  let expansionButtons = scopeFilter ? allButtons.filter(scopeFilter) : allButtons;

  console.log('[Ariba Ext] Scoped elements:', {
    expansionButtons: expansionButtons.length
  });

  try {
    showToast('Found Ariba content. Processing...');

    let supplierName = 'Unknown Supplier';
    if (supplierElement) {
      supplierName = supplierElement.textContent.trim()
        .replace(/[\/\\?%*:|"<>]/g, '-') // illegal filesystem chars
        .replace(/\.+$/, '')              // Windows: no trailing periods
        .trim();
    }

    // Step 1: Expand all sections
    if (expansionButtons.length > 0) {
      showToast(`Expanding ${expansionButtons.length} section(s)...`);
      for (const btn of expansionButtons) {
        if (window.__aribaStop) throw new Error('Stopped by user.');
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      if (window.__aribaStop) throw new Error('Stopped by user.');
      const currentAnchors = Array.from(document.querySelectorAll('.file-name-container a.file-name'));
      if (currentAnchors.length > 0) {
        finalAnchors = scopeFilter
          ? currentAnchors.filter(scopeFilter)
          : currentAnchors;
        console.log(`[Ariba Ext] Polling anchors: found ${currentAnchors.length} total, ${finalAnchors.length} in scope (${scopeLabel}).`);
        if (finalAnchors.length > 0) break;
      }
      // Heartbeat toast every ~3 seconds so the user knows we are still working
      if (i > 0 && i % 6 === 0) {
        const remaining = Math.round(((30 - i) * 500) / 1000);
        showToast(`Still waiting for documents... (${remaining}s left)`);
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (finalAnchors.length === 0) {
      showToast(
        'No documents found. Try expanding sections manually and re-running the extension.',
        true
      );
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
    if (err.message !== 'Stopped by user.') {
      showToast('Error: ' + err.message, true);
      console.error('[Ariba Ext] Error running automation:', err);
    }
  } finally {
    window.__aribaStop = false;
    window.__aribaAutomationRunning = false;
  }
})();
