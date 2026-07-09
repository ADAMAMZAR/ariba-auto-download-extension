document.addEventListener('DOMContentLoaded', () => {
  // Populate the version badge from the manifest — always accurate, no network call needed
  const versionEl = document.getElementById('ext-version');
  if (versionEl) versionEl.textContent = 'v' + chrome.runtime.getManifest().version;

  const downloadBtn = document.getElementById('download-btn');
  const stopBtn     = document.getElementById('stop-btn');
  const connectCheckbox = document.getElementById('connect-notebooklm');
  const deleteAfterUploadCheckbox = document.getElementById('delete-after-upload');
  const notebooklmContainer = document.getElementById('notebooklm-container');
  const notebooklmUrlInput = document.getElementById('notebooklm-url');
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
  // Both the URL field and the checkbox state are user preferences → chrome.storage.local.
  // Only ephemeral per-run state (notebooklmConfig) lives in chrome.storage.session.
  chrome.storage.local.get(['notebooklmUrl', 'connectToNotebooklm', 'deleteAfterUpload'], r => {
    notebooklmUrlInput.value = r.notebooklmUrl || '';
    
    // Default connection setting to true on first run (matching HTML initial state)
    connectCheckbox.checked = typeof r.connectToNotebooklm === 'boolean' ? r.connectToNotebooklm : true;
    
    // Default delete setting to false on first run
    deleteAfterUploadCheckbox.checked = typeof r.deleteAfterUpload === 'boolean' ? r.deleteAfterUpload : false;
    
    notebooklmContainer.style.display = connectCheckbox.checked ? 'flex' : 'none';
  });

  notebooklmUrlInput.addEventListener('input', () => {
    chrome.storage.local.set({ notebooklmUrl: notebooklmUrlInput.value });
  });

  connectCheckbox.addEventListener('change', () => {
    notebooklmContainer.style.display = connectCheckbox.checked ? 'flex' : 'none';
    chrome.storage.local.set({ connectToNotebooklm: connectCheckbox.checked });
  });

  deleteAfterUploadCheckbox.addEventListener('change', () => {
    chrome.storage.local.set({ deleteAfterUpload: deleteAfterUploadCheckbox.checked });
  });

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

    const connectToNotebooklm = connectCheckbox.checked;
    const notebooklmUrl = notebooklmUrlInput.value.trim();

    if (connectToNotebooklm && !notebooklmUrl) {
      addLog('Please enter the NotebookLM URL.', 'error');
      setRunning(false);
      return;
    }

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
      await chrome.storage.session.set({
        notebooklmConfig: { connectToNotebooklm, notebooklmUrl, deleteAfterUpload: deleteAfterUploadCheckbox.checked }
      });

      // Clear any cached supplier name from a previous run to avoid stale data
      await chrome.storage.local.remove(['lastSupplierName', 'lastRawSupplierName']);

      // Inject toast CSS before the script so classes are available on first call
      await chrome.scripting.insertCSS({
        target: { tabId: aribaTab.id, allFrames: true },
        files: ['content/content.css']
      });

      // ── Pre-injection state reset ─────────────────────────────────────────
      // Always reset execution flags before each injection run.
      // The Download button is disabled (setRunning) for the entire duration
      // of a run, so a concurrent double-injection cannot happen — resetting
      // here unconditionally is safe and ensures the re-entrant guard in
      // content.js never silently blocks a legitimate second run.
      // We also stamp the current version so content.js can detect stale
      // code left behind from a previous extension version on an open tab.
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
          window.hasAribaToastListener = false;
          window.__aribaContentVersion = version;
        },
        args: [currentVersion]
      });

      await chrome.scripting.executeScript({
        target: { tabId: aribaTab.id, allFrames: true },
        files: ['content/content.js']
      });

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


  // Listen for status messages from content / background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'status') {
      const type = message.error ? 'error' : (message.done ? 'done' : 'info');
      addLog(message.text, type);
      if (message.done || message.error) {
        setRunning(false);
      }
    }
  });
});
