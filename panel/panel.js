document.addEventListener('DOMContentLoaded', () => {
  // Populate the version badge from the manifest — always accurate, no network call needed
  const versionEl = document.getElementById('ext-version');
  if (versionEl) versionEl.textContent = 'v' + chrome.runtime.getManifest().version;

  const downloadBtn = document.getElementById('download-btn');
  const stopBtn     = document.getElementById('stop-btn');
  const connectCheckbox = document.getElementById('connect-auto-upload');
  const targetGeminiRadio = document.getElementById('target-gemini');
  const targetNlmRadio = document.getElementById('target-nlm');
  const nlmUrlGroup = document.getElementById('nlm-url-group');
  const nlmUrlInput = document.getElementById('nlm-notebook-url');
  const deleteAfterUploadCheckbox = document.getElementById('delete-after-upload');
  const uploadSettingsContainer = document.getElementById('upload-settings-container');
  const logEntries = document.getElementById('log-entries');

  function addLog(text, type = 'info') {
    const el = document.createElement('div');
    el.className = `log-entry log-${type}`;
    const time = new Date().toLocaleTimeString();
    el.textContent = `[${time}] ${text}`;
    logEntries.appendChild(el);
    logEntries.scrollTop = logEntries.scrollHeight;
  }

  /** Toggle running state: disable/enable Download btn, show/hide Stop btn. */
  function setRunning(isRunning) {
    downloadBtn.disabled = isRunning;
    stopBtn.style.display = isRunning ? 'block' : 'none';
    if (!isRunning) stopBtn.disabled = false;
  }

  // ── Restore user prefs from local storage (persists across browser restarts) ──
  chrome.storage.local.get([
    'connectAutoUpload', 
    'uploadTarget', 
    'nlmNotebookUrl', 
    'deleteAfterUpload'
  ], r => {
    // Default connection setting to true on first run (matching HTML initial state)
    connectCheckbox.checked = typeof r.connectAutoUpload === 'boolean' ? r.connectAutoUpload : true;
    
    const target = r.uploadTarget || 'gemini';
    if (target === 'nlm') {
      targetNlmRadio.checked = true;
    } else {
      targetGeminiRadio.checked = true;
    }

    nlmUrlInput.value = r.nlmNotebookUrl || '';
    
    // Default delete setting to false on first run
    deleteAfterUploadCheckbox.checked = typeof r.deleteAfterUpload === 'boolean' ? r.deleteAfterUpload : false;
    
    updateUiVisibility();
  });

  function updateUiVisibility() {
    const autoUpload = connectCheckbox.checked;
    uploadSettingsContainer.style.display = autoUpload ? 'block' : 'none';
    
    if (autoUpload) {
      nlmUrlGroup.style.display = targetNlmRadio.checked ? 'block' : 'none';
    }
  }

  connectCheckbox.addEventListener('change', () => {
    updateUiVisibility();
    chrome.storage.local.set({ connectAutoUpload: connectCheckbox.checked });
  });

  const onTargetChange = () => {
    updateUiVisibility();
    const target = targetNlmRadio.checked ? 'nlm' : 'gemini';
    chrome.storage.local.set({ uploadTarget: target });
  };
  targetGeminiRadio.addEventListener('change', onTargetChange);
  targetNlmRadio.addEventListener('change', onTargetChange);

  nlmUrlInput.addEventListener('input', () => {
    chrome.storage.local.set({ nlmNotebookUrl: nlmUrlInput.value.trim() });
  });

  deleteAfterUploadCheckbox.addEventListener('change', () => {
    chrome.storage.local.set({ deleteAfterUpload: deleteAfterUploadCheckbox.checked });
  });

  const clearCacheBtn = document.getElementById('clear-cache-btn');
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', async () => {
      clearCacheBtn.disabled = true;
      try {
        const keys = await chrome.storage.local.get(null);
        const keysToRemove = Object.keys(keys).filter(key => 
          key.startsWith('pdfTextCache_') || key.startsWith('processed_hashes_')
        );
        if (keysToRemove.length > 0) {
          await chrome.storage.local.remove(keysToRemove);
          addLog(`Successfully cleared ${keysToRemove.length} cached PDF text and hash entries.`, 'info');
        } else {
          addLog('No cached PDF text or deduplication entries found.', 'info');
        }
      } catch (err) {
        addLog(`Failed to clear cache: ${err.message}`, 'error');
      } finally {
        clearCacheBtn.disabled = false;
      }
    });
  }

  downloadBtn.addEventListener('click', async () => {
    logEntries.innerHTML = '';
    setRunning(true);
    addLog('Starting extraction...', 'info');

    // API Compatibility Check
    if (typeof chrome.offscreen === 'undefined') {
      addLog('Error: Your browser does not support the Chrome Offscreen API (requires Chrome 109+). Please update your browser.', 'error');
      setRunning(false);
      return;
    }

    const connectAutoUpload = connectCheckbox.checked;
    const uploadTarget = targetNlmRadio.checked ? 'nlm' : 'gemini';
    const nlmUrl = nlmUrlInput.value.trim();

    try {
      const aribaTabs = await chrome.tabs.query({ url: '*://*.ariba.com/*' });
      if (!aribaTabs.length) {
        addLog('No Ariba tab found. Please open the Ariba supplier page first.', 'error');
        setRunning(false);
        return;
      }

      const aribaTab = aribaTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
      addLog(`Found Ariba tab: ${aribaTab.title || aribaTab.url}`, 'info');

      // Store ephemeral per-run config in session storage (cleared on browser restart)
      addLog('Saving config to session storage...', 'info');
      await chrome.storage.session.set({
        uploadConfig: { 
          connectAutoUpload, 
          uploadTarget, 
          geminiUrl: GEMINI_GEM_URL, 
          nlmUrl, 
          deleteAfterUpload: deleteAfterUploadCheckbox.checked 
        }
      });
      addLog('Config saved successfully.', 'info');

      // Clear any cached supplier name from a previous run to avoid stale data
      addLog('Clearing cached supplier details...', 'info');
      await chrome.storage.local.remove(['lastSupplierName', 'lastRawSupplierName']);

      // Inject toast CSS before the script so classes are available on first call
      addLog('Injecting toast stylesheet...', 'info');
      await chrome.scripting.insertCSS({
        target: { tabId: aribaTab.id, allFrames: true },
        files: ['content/content.css']
      });
      addLog('Toast stylesheet injected.', 'info');

      // ── Pre-injection state reset ─────────────────────────────────────────
      // Always reset execution flags before each injection run.
      addLog('Resetting page automation state...', 'info');
      const currentVersion = chrome.runtime.getManifest().version;
      await chrome.scripting.executeScript({
        target: { tabId: aribaTab.id, allFrames: true },
        func: (version) => {
          if (window.__aribaContentVersion && window.__aribaContentVersion !== version) {
            console.log(`[Ariba Ext] Version changed (${window.__aribaContentVersion} → ${version}). Resetting content script state.`);
          }
          // Always clear state so every button click starts fresh
          window.__aribaAutomationRunning = false;
          window.__aribaStop = false;
          window.__aribaContentVersion = version;
        },
        args: [currentVersion]
      });
      addLog('Page automation state reset completed.', 'info');

      // shared/constants.js must be injected first so sanitiseSupplierName()
      // in content.js has access to SUPPLIER_CLEAN_RULES at runtime.
      addLog('Injecting main automation scripts...', 'info');
      await chrome.scripting.executeScript({
        target: { tabId: aribaTab.id, allFrames: true },
        files: ['shared/constants.js', 'content/content.js']
      });
      addLog('Automation scripts successfully injected into page.', 'info');

    } catch (err) {
      addLog('Error: ' + err.message, 'error');
      chrome.runtime.sendMessage({
        action: 'reportError',
        source: 'panel.js',
        context: 'downloadBtn click',
        message: err.message,
        stack: err.stack,
      }).catch(() => { });
      setRunning(false);
    }
  });

  // Stop button — sends cancellation signal to background
  stopBtn.addEventListener('click', () => {
    addLog('Stop requested by user.', 'info');
    chrome.runtime.sendMessage({ action: 'stopAutomation' });
    stopBtn.disabled = true;
  });

  // Report a problem — packages recent activity + an optional note and
  // sends it off so issues can be diagnosed without needing screen-share
  // access to whoever hit the bug.
  const reportProblemBtn = document.getElementById('report-problem-btn');
  const reportSupplierInput = document.getElementById('report-supplier');
  const reportNoteInput = document.getElementById('report-note');
  reportProblemBtn.addEventListener('click', async () => {
    const note = reportNoteInput.value.trim();
    const supplier = reportSupplierInput.value.trim();

    reportProblemBtn.disabled = true;
    const originalText = reportProblemBtn.textContent;
    reportProblemBtn.textContent = 'Sending...';

    try {
      const result = await chrome.runtime.sendMessage({ action: 'reportProblem', note, supplier });
      if (result?.ok) {
        addLog('Problem report sent. Thanks!', 'done');
        reportNoteInput.value = '';
      } else {
        addLog('Report saved locally (send failed: ' + (result?.error || 'unknown error') + ').', 'error');
      }
    } catch (err) {
      addLog('Failed to send report: ' + err.message, 'error');
    } finally {
      reportProblemBtn.disabled = false;
      reportProblemBtn.textContent = originalText;
    }
  });


  const networkLogBox = document.getElementById('network-log-box');
  if (networkLogBox) {
    networkLogBox.addEventListener('click', () => {
      if (networkLogBox.value.trim().length > 0) {
        networkLogBox.select();
        document.execCommand('copy');
        addLog('Copied network log to clipboard!', 'info');
      }
    });
  }

  // Listen for status messages from content / background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'status') {
      const type = message.error ? 'error' : (message.done ? 'done' : 'info');
      addLog(message.text, type);
      if (message.done || message.error) {
        setRunning(false);
      }
    } else if (message.action === 'logNetworkData') {
      if (networkLogBox) {
        networkLogBox.value += `\n=== NEW NETWORK REQUEST ===\n${message.logData}\n`;
        networkLogBox.scrollTop = networkLogBox.scrollHeight;
      }
    }
  });
});
