(async function () {

  // ── Re-entrant guard — prevent double-execution if injected twice ─────
  if (window.__aribaAutomationRunning) {
    console.warn('[Ariba Ext] Automation already in progress, skipping duplicate injection.');
    return;
  }
  window.__aribaAutomationRunning = true;

  // ── Localization Dictionaries for Ariba UI Language & Theme Customizations ──
  const DESCRIPTION_LABELS = [
    'description',
    'keterangan', 'penerangan', // Malay
    'descripción',               // Spanish
    'description',               // French
    'beschreibung',              // German
    'descrizione',               // Italian
    '描述', '说明'                // Chinese
  ];

  const CERTIFICATE_TYPE_LABELS = [
    'certificate type',
    'jenis sijil',               // Malay
    'tipo de certificado',       // Spanish
    'type de certificat',        // French
    'zertifikatstyp',            // German
    '证书类型', '證書類型'          // Chinese
  ];

  const CERTIFICATE_PREFIX_REGEXES = [
    /^[0-9.]+\s+/,
    /^certificate of\s+/i,
    /^sijil\s+/i,
    /^certificado de\s+/i,
    /^certificat de\s+/i,
    /^zertifikat für\s+/i
  ];

  // ── Supplier name sanitiser ───────────────────────────────────────────
  // Reads SUPPLIER_CLEAN_RULES from shared/constants.js (injected before this
  // script by panel.js) so the logic is identical to cleanName() in background.js.
  function sanitiseSupplierName(raw) {
    return SUPPLIER_CLEAN_RULES
      .reduce((s, [re, rep]) => s.replace(re, rep), raw)
      .trim();
  }

  // ── Loading Overlay ───────────────────────────────────────────────────
  function showOverlay() {
    let overlay = document.getElementById('ariba-loading-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ariba-loading-overlay';
      overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        background: rgba(0, 0, 0, 0.6); z-index: 999998;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        color: white; font-family: sans-serif; font-size: 20px; font-weight: 500;
        backdrop-filter: blur(2px);
      `;
      
      const spinner = document.createElement('div');
      spinner.style.cssText = `
        border: 4px solid rgba(255, 255, 255, 0.3); border-top: 4px solid white;
        border-radius: 50%; width: 48px; height: 48px;
        animation: ariba-spin 1s linear infinite; margin-bottom: 20px;
      `;
      
      const style = document.createElement('style');
      style.textContent = '@keyframes ariba-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
      document.head.appendChild(style);

      const text = document.createElement('div');
      text.id = 'ariba-loading-text';
      text.textContent = 'Processing... Please wait.';

      overlay.appendChild(spinner);
      overlay.appendChild(text);
      document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
  }

  function hideOverlay() {
    const overlay = document.getElementById('ariba-loading-overlay');
    if (overlay) overlay.style.display = 'none';
  }

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

  // ── Only run in the relevant Ariba frame ──────────────────────────────
  // Select expand buttons using standard, fuzzy, and language-independent selectors
  const allButtons = Array.from(document.querySelectorAll(
    '[aria-label="expand"], [aria-label="collapse"], ' +
    '[aria-label*="expand" i], [aria-label*="collapse" i], ' +
    '[aria-expanded="false"], .expansion-button, .w-node-expand'
  ));

  // ── Supplier name: multi-strategy lookup ─────────────────────────────
  // Strategy 1: strict ID/aria lookups (Newer Angular UI) or legacy class
  let supplierElement = document.querySelector(
    '#supplier-name, [aria-label^="Supplier name " i], .supplier-name'
  );

  // Strategy 1.5: Task View layout (sm-key-value pairs)
  if (!supplierElement) {
    const keyNodes = Array.from(document.querySelectorAll('.key-value-container .key.line'));
    for (const keyNode of keyNodes) {
      if (keyNode.textContent.trim().toLowerCase() === 'supplier') {
        const container = keyNode.closest('.key-value-container');
        if (container) {
          const valNode = container.querySelector('.link.line, .value.line');
          if (valNode && valNode.textContent.trim()) {
            supplierElement = valNode;
            break;
          }
        }
      }
    }
  }

  // Strategy 2: Angular Ariba UI — common heading / breadcrumb selectors
  if (!supplierElement) {
    const candidates = [
      '.supplier-header .name',
      '.entity-name',
      '[class*="supplier"][class*="name"]',
      '.header-title',
      '.page-title',
      'h1',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) {
        const txt = el.textContent.trim();
        // Ignore generic tab names that might match loose selectors
        if (txt && txt.toLowerCase() !== 'supplier management') {
          supplierElement = el;
          break;
        }
      }
    }
  }

  // Strategy 3: parent frame walk (works only when same-origin)
  if (!supplierElement) {
    try {
      let currWindow = window;
      while (currWindow !== window.top) {
        currWindow = currWindow.parent;
        const el = currWindow.document.querySelector('.supplier-name') || currWindow.document.getElementById('supplier-name');
        if (el) {
          supplierElement = el;
          break;
        }
      }
    } catch (e) {
      console.warn('[Ariba Ext] Cannot access parent frame for supplier name:', e);
    }
  }

  const allAnchors = Array.from(document.querySelectorAll('.file-name-container a.file-name'));


  console.log('[Ariba Ext] Initial check:', {
    allButtons: allButtons.length,
    supplierElement: !!supplierElement,
    allAnchors: allAnchors.length
  });

  if (allButtons.length === 0 && !supplierElement && allAnchors.length === 0) {
    window.__aribaAutomationRunning = false;
    return;
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
        const o = document.getElementById('ariba-loading-overlay');
        if (o) o.style.display = 'none';
      }
      if (message.action === 'showToasts') {
        const c = document.getElementById('ariba-toast-container');
        if (c) c.style.visibility = '';
        const o = document.getElementById('ariba-loading-overlay');
        if (o) o.style.display = 'flex';
      }
      if (message.action === 'hideOverlay') {
        hideOverlay();
      }
      if (message.action === 'stopAutomation') {
        window.__aribaStop = true;
        hideOverlay();
        showToast('Stopping...', false);
      }
    });
  }

  // ── Scope detection ───────────────────────────────────────────────
  // If the page has .content-2, only target that (updated questionnaire).
  // Otherwise fall back to downloading everything.
  //
  // ── HIGHLIGHT DETECTION (commented out — preserved for future use) ────
  // Previously the extension also detected amendment scenarios via the
  // .highlight-container.highlight class, which triggered two extra modes:
  //   • 'highlight+content-2' — inside BOTH highlight AND content-2
  //   • 'highlight-only'      — inside highlight container only
  // To re-enable, uncomment the block below and remove the simplified logic.
  //
  // const highlightContainer = document.querySelector(
  //   '.view-mode-content-container.highlight-container.highlight'
  // );
  // if (highlightContainer) {
  //   const content2InHighlight = highlightContainer.querySelector('.content-2, [content2]');
  //   if (content2InHighlight) {
  //     scopeLabel  = 'highlight+content-2';
  //     scopeFilter = el =>
  //       el.closest('.view-mode-content-container.highlight-container.highlight') &&
  //       el.closest('.content-2, [content2]');
  //   } else {
  //     scopeLabel  = 'highlight-only';
  //     scopeFilter = el =>
  //       el.closest('.view-mode-content-container.highlight-container.highlight');
  //   }
  // } else { ... see content-2 / all logic below ... }
  // ─────────────────────────────────────────────────────────────────────

  let scopeLabel = 'all';
  let scopeFilter = null; // null → use all elements

  const content2Container = document.querySelector('.content-2, [content2]');
  if (content2Container) {
    // Two questionnaires present: only download from the updated one (content-2)
    scopeLabel = 'content-2-only';
    scopeFilter = el => el.closest('.content-2, [content2]');
  }
  // else: single questionnaire → scopeFilter stays null → all buttons

  console.log('[Ariba Ext] Scope mode:', scopeLabel);


  let expansionButtons = scopeFilter ? allButtons.filter(scopeFilter) : allButtons;

  console.log('[Ariba Ext] Scoped elements:', {
    expansionButtons: expansionButtons.length
  });

  // Hoisted above the try so the catch block (and error reports) can
  // include which supplier was being processed when something failed.
  let supplierName = 'Unknown Supplier';
  let rawSupplierName = 'Unknown Supplier';
  if (supplierElement) {
    rawSupplierName = supplierElement.textContent.trim();
    supplierName = sanitiseSupplierName(rawSupplierName);

    // Cache the supplier name in chrome.storage so other frames can read it (e.g. cross-origin iframes)
    chrome.storage.local.set({ lastSupplierName: supplierName, lastRawSupplierName: rawSupplierName }).catch(err => {
      console.warn('[Ariba Ext] Failed to write supplier name to storage:', err);
    });
  }

  // If this frame couldn't find the supplier name locally, try to fetch it from shared storage.
  // Poll briefly (up to ~500ms) to let the main-frame injection finish writing it first
  // — there is a race where the iframe reaches this point before the outer frame's
  // chrome.storage.local.set() completes.
  if (supplierName === 'Unknown Supplier' || !supplierName) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const stored = await chrome.storage.local.get(['lastSupplierName', 'lastRawSupplierName']);
        if (stored.lastSupplierName) {
          supplierName = stored.lastSupplierName;
          rawSupplierName = stored.lastRawSupplierName || stored.lastSupplierName;
          console.log('[Ariba Ext] Retrieved supplier name from storage (attempt', attempt + 1, '):', supplierName);
          break;
        }
      } catch (err) {
        console.warn('[Ariba Ext] Failed to read supplier name from storage:', err);
      }
      await new Promise(r => setTimeout(r, 100)); // wait 100ms between polls
    }
  }

  // Strategy 4: parse the page <title> — Ariba always puts the supplier/event name there.
  // Use this only as a last resort; titles vary in format across Ariba versions.
  if (supplierName === 'Unknown Supplier' || !supplierName || supplierName.toLowerCase() === 'supplier management') {
    const pageTitle = document.title.trim();
    if (pageTitle && pageTitle !== 'Ariba' && pageTitle !== '') {
      // Ariba titles are often like "Supplier Name | Ariba" or "Event - Supplier Name"
      const titleParts = pageTitle.split(/[|\-–]/); // split on |, -, or em-dash
      const candidate = titleParts[0].trim();
      if (candidate && candidate.toLowerCase() !== 'ariba' && candidate.toLowerCase() !== 'supplier management') {
        rawSupplierName = candidate;
        supplierName = sanitiseSupplierName(candidate);
        console.log('[Ariba Ext] Supplier name derived from page title:', supplierName);
      }
    }
  }

  // Final fallback safeguard: if we STILL have 'Supplier Management', revert to Unknown
  if (supplierName.toLowerCase() === 'supplier management') {
    supplierName = 'Unknown Supplier';
  }

  // If this frame has no questionnaire components (expand buttons or anchors), it is a metadata helper frame.
  // We return early to avoid unnecessary processing, waiting, or displaying warning toasts.
  if (allButtons.length === 0 && allAnchors.length === 0) {
    console.log('[Ariba Ext] Helper frame finished caching supplier name. Returning early.');
    window.__aribaAutomationRunning = false;
    return;
  }

  try {
    showOverlay();
    showToast('Found Ariba content. Processing...');

    let workspaceTitle = 'Questionnaire';
    const titleElement = document.getElementById('workspace-title');
    if (titleElement) {
      workspaceTitle = titleElement.textContent.trim();
    }

    // Step 1: Expand all sections
    // Helper: returns true if a button is already expanded (i.e. clicking it would COLLAPSE content).
    // We must never click a button that is in this state.
    function isAlreadyExpanded(btn) {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      const iconText = btn.textContent.trim().toLowerCase();
      // aria-label="collapse" → already open
      if (label === 'collapse') return true;
      // Material icon text "remove" = minus = already expanded
      if (iconText === 'remove') return true;
      // Any button whose aria-label starts with "toggle" and the icon says expand_less
      if (label.startsWith('toggle') && iconText === 'expand_less') return true;
      return false;
    }

    if (expansionButtons.length > 0) {
      showToast(`Expanding ${expansionButtons.length} section(s)...`);
      for (const btn of expansionButtons) {
        if (window.__aribaStop) throw new Error('Stopped by user.');
        // Re-check state at click time — the DOM may have changed since we queried
        if (isAlreadyExpanded(btn)) {
          console.log('[Ariba Ext] Skipping already-expanded button:', btn.getAttribute('aria-label'));
          continue;
        }
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
          btn.dispatchEvent(new MouseEvent(type, { view: window, bubbles: true, cancelable: true, buttons: 1 }));
        });
        try { btn.click(); } catch (e) { }
        // NOTE: parentElement.click() is intentionally NOT called here.
        // Clicking the parent container could accidentally collapse a section
        // that was already expanded before the automation ran.
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

    // Step 2.5: Extract QA text from expanded sections
    showToast('Extracting Q&A data...');
    const extractedQAData = [];
    const processedContainers = new Set();

    // Use a fresh query because the original buttons might have been destroyed/replaced by Angular
    const currentExpansionButtons = Array.from(document.querySelectorAll(
      '.expansion-button, [aria-label="collapse"], [aria-label="expand"], ' +
      '[aria-label*="expand" i], [aria-label*="collapse" i], [aria-expanded]'
    ));
    console.log('[Ariba Ext] Found', currentExpansionButtons.length, 'expansion buttons for text extraction.');

    for (const btn of currentExpansionButtons) {
      let mainContainer = btn.closest('[flexlayout="row"]');
      if (!mainContainer) {
        mainContainer = btn.closest('.smq-item-container') || btn.closest('.renderer-container');
      }

      if (!mainContainer || processedContainers.has(mainContainer)) continue;
      processedContainers.add(mainContainer);

      const qaBlock = { sectionLabel: '', questionLabel: '', answers: [], attachedFile: '' };

      const sectionContainer = mainContainer.closest('.smq-section-item-container');
      if (sectionContainer) {
        const sectionLabelSpan = sectionContainer.querySelector('.view-mode-header .label-span');
        if (sectionLabelSpan) {
          qaBlock.sectionLabel = sectionLabelSpan.textContent.replace(/\s+/g, ' ').trim();
        }
      }

      const labelSpan = mainContainer.querySelector('.label-span');
      if (labelSpan) qaBlock.questionLabel = labelSpan.textContent.replace(/\s+/g, ' ').trim();

      let contentBlock = mainContainer.querySelector('.content-2, [content2]');
      if (!contentBlock || !contentBlock.querySelector('.row-container')) {
        contentBlock = mainContainer.querySelector('.content-1, [content1]') || mainContainer;
      }

      const rows = contentBlock.querySelectorAll('.row-container');
      rows.forEach(row => {
        const rowLabelEl = row.querySelector('.row-label');
        const rowContentEl = row.querySelector('.row-content');
        if (rowLabelEl && rowContentEl) {
          const l = rowLabelEl.textContent.trim();
          const c = rowContentEl.textContent.trim();

          // Skip description rows regardless of active language
          if (DESCRIPTION_LABELS.includes(l.toLowerCase())) return;

          if (l) {
            qaBlock.answers.push({ label: l, value: c });
          }
        }
      });

      // Find certificate type key in a language-resilient way
      const certTypeAnswer = qaBlock.answers.find(a =>
        CERTIFICATE_TYPE_LABELS.includes(a.label.toLowerCase())
      );
      if (certTypeAnswer && !certTypeAnswer.value) {
        let derivedType = qaBlock.questionLabel;
        for (const rx of CERTIFICATE_PREFIX_REGEXES) {
          derivedType = derivedType.replace(rx, '');
        }
        derivedType = derivedType.replace(/\([^)]+\)/g, '');
        derivedType = derivedType.split('-')[0];
        certTypeAnswer.value = derivedType.trim();
      }

      const fileAnchor = contentBlock.querySelector('.file-name-container a.file-name');
      if (fileAnchor) {
        qaBlock.attachedFile = fileAnchor.getAttribute('download') || fileAnchor.textContent.trim();
      }

      if (qaBlock.questionLabel || qaBlock.answers.length > 0 || qaBlock.attachedFile) {
        extractedQAData.push(qaBlock);
      }
    }

    console.log('[Ariba Ext] Extracted QA Data:', extractedQAData);

    // Double check storage one final time in case the helper frame saved it while we were expanding sections
    if (supplierName === 'Unknown Supplier' || !supplierName) {
      try {
        const stored = await chrome.storage.local.get(['lastSupplierName', 'lastRawSupplierName']);
        if (stored.lastSupplierName) {
          supplierName = stored.lastSupplierName;
          rawSupplierName = stored.lastRawSupplierName || stored.lastSupplierName;
          console.log('[Ariba Ext] Final check retrieved supplier name from storage:', supplierName);
        }
      } catch (err) {
        console.warn('[Ariba Ext] Failed to read supplier name from storage on final check:', err);
      }
    }

    // Step 3: Send to background for disk download
    chrome.runtime.sendMessage({ action: 'downloadFiles', supplierName, rawSupplierName, workspaceTitle, files, extractedQAData });
    showToast('Files sent for download. Processing...');
  } catch (err) {
    hideOverlay();
    if (err.message !== 'Stopped by user.') {
      showToast('Error: ' + err.message, true);
      console.error('[Ariba Ext] Error running automation:', err);
      chrome.runtime.sendMessage({
        action: 'reportError',
        source: 'content.js',
        message: err.message,
        stack: err.stack,
        url: location.href,
        supplier: rawSupplierName,
      }).catch(() => { });
    }
  } finally {
    window.__aribaStop = false;
    window.__aribaAutomationRunning = false;
  }
})();
