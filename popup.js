document.addEventListener('DOMContentLoaded', () => {
  const downloadBtn = document.getElementById('download-btn');
  const statusEl = document.getElementById('status');
  const connectCheckbox = document.getElementById('connect-notebooklm');
  const notebooklmContainer = document.getElementById('notebooklm-container');
  const notebooklmUrlInput = document.getElementById('notebooklm-url');

  // Toggle NotebookLM URL section
  connectCheckbox.addEventListener('change', () => {
    notebooklmContainer.style.display = connectCheckbox.checked ? 'flex' : 'none';
  });

  downloadBtn.addEventListener('click', async () => {
    statusEl.textContent = 'Extracting...';
    statusEl.style.color = '#333';
    downloadBtn.disabled = true;

    const connectToNotebooklm = connectCheckbox.checked;
    const notebooklmUrl = notebooklmUrlInput.value.trim();

    if (connectToNotebooklm && !notebooklmUrl) {
      statusEl.textContent = 'Please enter the NotebookLM URL.';
      statusEl.style.color = '#d93025';
      downloadBtn.disabled = false;
      return;
    }

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('No active tab');

      await chrome.storage.session.set({
        notebooklmConfig: { connectToNotebooklm, notebooklmUrl }
      });

      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['html2canvas.min.js', 'content.js']
      });

      setTimeout(() => {
        if (statusEl.textContent === 'Extracting...') {
          statusEl.textContent = 'No Ariba elements found.';
          statusEl.style.color = '#d93025';
          downloadBtn.disabled = false;
        }
      }, 5000);

    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
      statusEl.style.color = '#d93025';
      downloadBtn.disabled = false;
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'status') {
      statusEl.textContent = message.text;
      statusEl.style.color = message.error ? '#d93025' : '#137333';
      if (message.done || message.error) downloadBtn.disabled = false;
    }
  });
});
