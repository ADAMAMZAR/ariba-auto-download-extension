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

  // Set initial display based on checkbox state
  notebooklmContainer.style.display = connectCheckbox.checked ? 'flex' : 'none';

  connectCheckbox.addEventListener('change', () => {
    notebooklmContainer.style.display = connectCheckbox.checked ? 'flex' : 'none';
  });

  downloadBtn.addEventListener('click', async () => {
    logEntries.innerHTML = '';
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
      const aribaTabs = await chrome.tabs.query({ url: '*://*.ariba.com/*' });
      if (!aribaTabs.length) {
        addLog('No Ariba tab found. Please open the Ariba supplier page first.', 'error');
        downloadBtn.disabled = false;
        return;
      }

      const aribaTab = aribaTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
      addLog(`Found Ariba tab: ${aribaTab.title || aribaTab.url}`, 'info');

      await chrome.storage.session.set({
        notebooklmConfig: { connectToNotebooklm, notebooklmUrl }
      });

      chrome.scripting.executeScript({
        target: { tabId: aribaTab.id, allFrames: true },
        files: ['content.js']
      });

    } catch (err) {
      addLog('Error: ' + err.message, 'error');
      downloadBtn.disabled = false;
    }
  });


  // Listen for status messages from content / background
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
