(async function () {
  let loaderStatusEl = null;

  function updateLoaderStatus(text) {
    if (loaderStatusEl) {
      loaderStatusEl.textContent = text;
    }
  }

  // Toast container & logic
  function showToast(text, isError = false) {
    // Update loader if visible
    updateLoaderStatus(text);

    let container = document.getElementById('ariba-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'ariba-toast-container';
      container.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 999999;
        display: flex;
        flex-direction: column;
        gap: 10px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      `;
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.style.cssText = `
      background: ${isError ? '#ef4444' : '#1e293b'};
      color: #ffffff;
      padding: 12px 18px;
      border-radius: 8px;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
      font-size: 14px;
      font-weight: 500;
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      min-width: 250px;
      max-width: 350px;
      border-left: 4px solid ${isError ? '#f87171' : '#3b82f6'};
    `;
    toast.textContent = text;
    container.appendChild(toast);

    // Fade in
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    });

    // Fade out and remove
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  function showLoader() {
    if (document.getElementById('ariba-automation-loader')) return;

    const overlay = document.createElement('div');
    overlay.id = 'ariba-automation-loader';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(15, 23, 42, 0.65);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      z-index: 99999999;
      display: flex;
      justify-content: center;
      align-items: center;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #ffffff;
      transition: opacity 0.3s ease;
      pointer-events: all;
    `;

    const card = document.createElement('div');
    card.style.cssText = `
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.95) 0%, rgba(15, 23, 42, 0.98) 100%);
      padding: 40px 50px;
      border-radius: 20px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
      width: 420px;
      box-sizing: border-box;
      text-align: center;
      animation: ariba-fade-in 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    `;

    if (!document.getElementById('ariba-loader-styles')) {
      const style = document.createElement('style');
      style.id = 'ariba-loader-styles';
      style.textContent = `
        @keyframes ariba-fade-in {
          from { opacity: 0; transform: scale(0.95) translateY(10px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes ariba-spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes ariba-pulse {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
      `;
      document.head.appendChild(style);
    }

    const spinnerContainer = document.createElement('div');
    spinnerContainer.style.cssText = `
      position: relative;
      width: 70px;
      height: 70px;
    `;

    const outerSpinner = document.createElement('div');
    outerSpinner.style.cssText = `
      width: 100%;
      height: 100%;
      border: 4px solid rgba(99, 102, 241, 0.1);
      border-top: 4px solid #6366f1;
      border-right: 4px solid #a855f7;
      border-radius: 50%;
      animation: ariba-spin 1s linear infinite;
    `;

    const innerDot = document.createElement('div');
    innerDot.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 12px;
      height: 12px;
      background: #3b82f6;
      border-radius: 50%;
      animation: ariba-pulse 1.5s ease-in-out infinite;
    `;

    spinnerContainer.appendChild(outerSpinner);
    spinnerContainer.appendChild(innerDot);

    const title = document.createElement('div');
    title.textContent = 'Ariba Automation Active';
    title.style.cssText = `
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.02em;
      background: linear-gradient(to right, #e2e8f0, #ffffff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    `;

    loaderStatusEl = document.createElement('div');
    loaderStatusEl.textContent = 'Initializing extraction...';
    loaderStatusEl.style.cssText = `
      font-size: 14px;
      color: #94a3b8;
      line-height: 1.5;
      font-weight: 500;
      min-height: 42px;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    const warning = document.createElement('div');
    warning.textContent = 'Automation running. Do not click or close this tab.';
    warning.style.cssText = `
      font-size: 11px;
      color: rgba(239, 68, 68, 0.7);
      background: rgba(239, 68, 68, 0.08);
      padding: 6px 14px;
      border-radius: 20px;
      font-weight: 600;
      border: 1px solid rgba(239, 68, 68, 0.15);
      letter-spacing: 0.02em;
    `;

    card.appendChild(spinnerContainer);
    card.appendChild(title);
    card.appendChild(loaderStatusEl);
    card.appendChild(warning);
    overlay.appendChild(card);

    document.body.appendChild(overlay);
  }

  function hideLoader() {
    const el = document.getElementById('ariba-automation-loader');
    if (el) {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }
  }

  // Register listener for background script events (e.g. screenshot status)
  if (!window.hasAribaToastListener) {
    window.hasAribaToastListener = true;
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === 'showToast') {
        showToast(message.text, message.isError);
      } else if (message.action === 'hideLoader') {
        hideLoader();
      }
    });
  }

  // Only run in the relevant Ariba frame
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

  let sentToBackground = false;
  try {
    showLoader();
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
    sentToBackground = true;
    chrome.runtime.sendMessage({ action: 'downloadFiles', supplierName, files });
    showToast('Files sent for download. Processing...');
  } catch (err) {
    showToast('Error: ' + err.message, true);
    console.error('[Ariba Ext] Error running automation:', err);
  } finally {
    if (!sentToBackground) {
      // Keep loader visible briefly to showcase the error/no documents state
      await new Promise(r => setTimeout(r, 1500));
      hideLoader();
    }
  }
})();
