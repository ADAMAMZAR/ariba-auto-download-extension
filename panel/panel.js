document.addEventListener('DOMContentLoaded', () => {
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
    if (r.notebooklmUrl) notebooklmUrlInput.value = r.notebooklmUrl;
    if (typeof r.connectToNotebooklm === 'boolean') {
      connectCheckbox.checked = r.connectToNotebooklm;
    }
    if (typeof r.deleteAfterUpload === 'boolean') {
      deleteAfterUploadCheckbox.checked = r.deleteAfterUpload;
    }
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

      // Inject toast CSS before the script so classes are available on first call
      await chrome.scripting.insertCSS({
        target: { tabId: aribaTab.id, allFrames: true },
        files: ['content/content.css']
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
