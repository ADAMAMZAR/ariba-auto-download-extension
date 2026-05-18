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

// -----------------------------------------------------------------------
// Persistent state via chrome.storage.session
// -----------------------------------------------------------------------
async function getState(supplier) {
  const key = `pending_${supplier}`;
  const r = await chrome.storage.session.get(key);
  return r[key] || { filesDone: false, config: null };
}
async function setState(supplier, data) {
  await chrome.storage.session.set({ [`pending_${supplier}`]: data });
}
async function clearState(supplier) {
  await chrome.storage.session.remove(`pending_${supplier}`);
}

// -----------------------------------------------------------------------
// Open NotebookLM once downloads are done, then interact with the checkbox
// -----------------------------------------------------------------------
async function maybeOpenNotebookLM(supplier) {
  const state = await getState(supplier);
  if (!state.filesDone) return;
  await clearState(supplier);

  if (!state.config?.connectToNotebooklm) {
    notifyPanel('Downloads complete!', false, true);
    return;
  }

  notifyPanel('Opening NotebookLM...');
  const tab = await chrome.tabs.create({ url: state.config.notebooklmUrl });

  // Wait for the page to fully load, then inject the checkbox script
  chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
    if (tabId !== tab.id || info.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(listener);

    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));

        // Poll for the checkbox — Angular/Material may take a moment to render
        let nativeInput = null;
        for (let i = 0; i < 40; i++) {          // up to 10 seconds
          nativeInput = document.querySelector('#mat-mdc-checkbox-0-input');
          if (nativeInput) break;
          await wait(250);
        }

        if (!nativeInput) {
          console.error('[Ariba Ext] Checkbox #mat-mdc-checkbox-0-input not found.');
          return;
        }

        const isChecked = nativeInput.checked;
        console.log('[Ariba Ext] Checkbox state:', isChecked);

        if (isChecked) {
          // Already checked → click once
          nativeInput.click();
          console.log('[Ariba Ext] Was checked — clicked once.');
        } else {
          // Unchecked → click twice with buffer so Angular registers each change
          nativeInput.click();
          console.log('[Ariba Ext] Was unchecked — first click done. Waiting...');
          await wait(600);
          nativeInput.click();
          console.log('[Ariba Ext] Second click done.');
        }
      }
    }, () => {
      if (chrome.runtime.lastError) {
        notifyPanel('Checkbox script error: ' + chrome.runtime.lastError.message, true);
      }
    });

    notifyPanel('NotebookLM opened. All done!', false, true);
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
        chrome.downloads.download({
          url: file.url,
          filename: `${s}/${s} - ${cleanName(file.filename)}`,
          saveAs: false
        });
      }
      const { notebooklmConfig } = await chrome.storage.session.get('notebooklmConfig');
      const state = await getState(s);
      state.config = notebooklmConfig || null;
      state.filesDone = true;
      await setState(s, state);
      await maybeOpenNotebookLM(s);
    }

  })();
  return true;
});
