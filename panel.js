document.addEventListener('DOMContentLoaded', () => {
  const downloadBtn = document.getElementById('download-btn');
  const connectCheckbox = document.getElementById('connect-notebooklm');
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

  // Restore saved URL
  chrome.storage.local.get('notebooklmUrl', r => {
    if (r.notebooklmUrl) notebooklmUrlInput.value = r.notebooklmUrl;
  });
  notebooklmUrlInput.addEventListener('input', () => {
    chrome.storage.local.set({ notebooklmUrl: notebooklmUrlInput.value });
  });

  connectCheckbox.addEventListener('change', () => {
    notebooklmContainer.style.display = connectCheckbox.checked ? 'flex' : 'none';
  });

  downloadBtn.addEventListener('click', async () => {
    logEntries.innerHTML = ''; // clear log on new run
    downloadBtn.disabled = true;
    addLog('Starting extraction...', 'info');

    const connectToNotebooklm = connectCheckbox.checked;
    const notebooklmUrl = notebooklmUrlInput.value.trim();

    if (connectToNotebooklm && !notebooklmUrl) {
      addLog('Please enter the NotebookLM URL.', 'error');
      downloadBtn.disabled = false;
      return;
    }

    try {
      // Find specifically an Ariba tab by URL
      const aribaTabs = await chrome.tabs.query({ url: '*://*.ariba.com/*' });

      if (!aribaTabs.length) {
        addLog('No Ariba tab found. Please open the Ariba supplier page first, then try again.', 'error');
        downloadBtn.disabled = false;
        return;
      }

      // Use the most recently accessed Ariba tab
      const aribaTab = aribaTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
      addLog(`Found Ariba tab: ${aribaTab.title || aribaTab.url}`, 'info');


      await chrome.storage.session.set({
        notebooklmConfig: { connectToNotebooklm, notebooklmUrl }
      });

      chrome.scripting.executeScript({
        target: { tabId: aribaTab.id, allFrames: true },
        files: ['html2canvas.min.js', 'content.js']
      });

    } catch (err) {
      addLog('Error: ' + err.message, 'error');
      downloadBtn.disabled = false;
    }
  });

  // Listen for status messages from content/background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'status') {
      const type = message.error ? 'error' : (message.done ? 'done' : 'info');
      addLog(message.text, type);
      if (message.done || message.error) {
        downloadBtn.disabled = false;
      }
    }
  });
});
