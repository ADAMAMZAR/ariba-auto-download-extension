// Open standalone panel window when extension icon is clicked
chrome.action.onClicked.addListener(() => {
  chrome.windows.create({
    url: chrome.runtime.getURL('panel.html'),
    type: 'popup',
    width: 400,
    height: 520,
    focused: true
  });
});

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------
function notifyPanel(text, error = false, done = false) {
  chrome.runtime.sendMessage({ type: 'status', text, error, done }).catch(() => {});
}

function cleanName(n) { return n.replace(/[\/\\?%*:|"<>]/g, '-'); }

function arrayBufferToBase64(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function guessMime(name) {
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (name.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

// -----------------------------------------------------------------------
// Persistent state via chrome.storage.session (survives service worker sleep)
// -----------------------------------------------------------------------
async function getState(supplier) {
  const key = `pending_${supplier}`;
  const r = await chrome.storage.session.get(key);
  return r[key] || { files: [], screenshotDone: false, filesDone: false, screenshotDataUrl: null, config: null };
}

async function setState(supplier, data) {
  await chrome.storage.session.set({ [`pending_${supplier}`]: data });
}

async function clearState(supplier) {
  await chrome.storage.session.remove(`pending_${supplier}`);
}

// -----------------------------------------------------------------------
// Trigger NotebookLM once both files + screenshot messages are received
// -----------------------------------------------------------------------
async function maybeUploadToNotebookLM(supplier) {
  const state = await getState(supplier);
  if (!state.filesDone || !state.screenshotDone) return;

  await clearState(supplier);

  if (!state.config?.connectToNotebooklm) {
    notifyPanel('Downloads complete!', false, true);
    return;
  }

  notifyPanel('Re-fetching files for NotebookLM...');

  const payloads = [];
  for (const file of state.files) {
    try {
      const resp = await fetch(file.url, { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const base64 = arrayBufferToBase64(await resp.arrayBuffer());
      const mime = resp.headers.get('content-type') || guessMime(file.filename);
      payloads.push({ name: file.filename, base64, mime });
    } catch (e) {
      console.warn('Could not fetch:', file.filename, e.message);
    }
  }

  // Include screenshot if captured
  if (state.screenshotDataUrl) {
    payloads.push({
      name: `${supplier} - screenshot.jpg`,
      base64: state.screenshotDataUrl.split(',')[1],
      mime: 'image/jpeg'
    });
  }

  if (!payloads.length) {
    notifyPanel('No files could be fetched for NotebookLM.', true, true);
    return;
  }

  await chrome.storage.session.set({ notebooklmPayload: payloads });
  notifyPanel(`Opening NotebookLM with ${payloads.length} file(s)...`);

  const tab = await chrome.tabs.create({ url: state.config.notebooklmUrl });

  chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
    if (tabId !== tab.id || info.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(listener);
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['notebooklm_uploader.js'] }, () => {
      if (chrome.runtime.lastError) {
        notifyPanel('Failed to inject uploader: ' + chrome.runtime.lastError.message, true, true);
      }
    });
  });
}

// -----------------------------------------------------------------------
// Message handler
// -----------------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    if (request.action === 'downloadFiles') {
      const s = cleanName(request.supplierName || 'Ariba');
      for (const file of (request.files || [])) {
        const clean = cleanName(file.filename);
        chrome.downloads.download({ url: file.url, filename: `${s}/${s} - ${clean}`, saveAs: false });
      }
      // Read config directly from session storage — content.js runs in an iframe
      // and cannot access chrome.storage.session, so we never rely on request.notebooklmConfig
      const { notebooklmConfig } = await chrome.storage.session.get('notebooklmConfig');
      const state = await getState(s);
      state.files = (request.files || []).map(f => ({ url: f.url, filename: cleanName(f.filename) }));
      state.config = notebooklmConfig || null;
      state.filesDone = true;
      await setState(s, state);
      await maybeUploadToNotebookLM(s);
    }

    if (request.action === 'downloadScreenshot') {
      const s = cleanName(request.supplierName || 'Ariba');
      if (request.dataUrl) {
        chrome.downloads.download({ url: request.dataUrl, filename: `${s}/${s} - screenshot.jpg`, saveAs: false });
      }
      // Same fix — read config from session storage directly
      const { notebooklmConfig } = await chrome.storage.session.get('notebooklmConfig');
      const state = await getState(s);
      state.screenshotDataUrl = request.dataUrl || null;
      state.screenshotDone = true;
      if (!state.config) state.config = notebooklmConfig || null;
      await setState(s, state);
      await maybeUploadToNotebookLM(s);
    }
  })();
  return true; // keep message channel open for async
});
