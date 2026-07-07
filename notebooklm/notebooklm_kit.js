// ============================================================
// NotebookLM Kit — Content Script
// Bundled into the Ariba Auto Download Extension so users get
// both Ariba automation AND NotebookLM management tools in
// a single extension install.
//
// Activates automatically when visiting notebooklm.google.com
// — no Ariba session required.
// ============================================================

let authToken = '';
let sourceCheckTimer = null;

// Relays NotebookLM-side failures to background.js's telemetry ring buffer —
// otherwise these only ever reach whichever colleague's own DevTools console.
function reportNlmError(context, err) {
  chrome.runtime.sendMessage({
    action: 'reportError',
    source: 'notebooklm_kit.js',
    context,
    message: err?.message ?? String(err),
    stack: err?.stack,
    url: location.href,
  }).catch(() => { });
}

// Full source-list cache, keyed by notebookId: { sources: [{id,title}], timestamp }
// Populated by fetchSources() and reused by every modal (Manage/Rename/Label) so
// opening them back-to-back doesn't re-hit the Google RPC each time.
let sourceListCache = {};
const SOURCE_CACHE_TTL_MS = 30000; // safety net in case an invalidation event is ever missed

// Returns the source list for notebookId, using the cache when it's still fresh.
// Pass forceRefresh to bypass the cache (e.g. right after a mutation we can't
// otherwise detect).
async function getSources(notebookId, forceRefresh = false) {
  const cached = sourceListCache[notebookId];
  if (!forceRefresh && cached && (Date.now() - cached.timestamp) < SOURCE_CACHE_TTL_MS) {
    return cached.sources;
  }
  const sources = await fetchSources(notebookId);
  sourceListCache[notebookId] = { sources, timestamp: Date.now() };
  return sources;
}

function invalidateSourceCache(notebookId) {
  delete sourceListCache[notebookId];
}

// Tracks whether a mandatory sync is pending (gist changed since last sync)
let syncPending = false;

// Simple 32-bit hash to detect gist content changes between page loads
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

// Read the notebook title from the page heading.
// The actual NotebookLM DOM uses: span.title-label-inner (inside div.title > div.title-label)
function getNotebookTitle() {
  // Primary: exact selector from the live NotebookLM DOM
  const primary = document.querySelector('span.title-label-inner');
  if (primary && primary.innerText && primary.innerText.trim()) {
    return primary.innerText.trim();
  }

  // Fallback chain for any future DOM changes
  const fallbacks = [
    document.querySelector('.title-input'),          // the sibling <input> holds same value
    document.querySelector('[class*="title-label"]'), // any element with title-label in class
    document.querySelector('h1'),
  ];
  for (const el of fallbacks) {
    const text = el && (el.value || el.innerText || '').trim();
    if (text) return text;
  }
  return '';
}

// Returns true when the notebook title starts with "CQ Checker - "
function isCQCheckerNotebook() {
  return getNotebookTitle().startsWith('CQ Checker - ');
}

// Check gist for changes and update sync button state accordingly.
// Called once on page load (in notebooklm_kit only — NOT in nlm_runner).
async function checkGistForChanges() {
  const title = getNotebookTitle();
  const isCQ = isCQCheckerNotebook();
  console.log('[NLM Kit] checkGistForChanges — title:', title, '| isCQ:', isCQ);

  if (!isCQ) {
    console.log('[NLM Kit] Not a CQ Checker notebook, skipping gist check.');
    return;
  }

  try {
    console.log('[NLM Kit] Requesting background script to fetch gist:', GIST_URL);
    const text = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'fetchGistText' }, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (res && res.error) {
          reject(new Error(res.error));
        } else if (res && res.text) {
          resolve(res.text);
        } else {
          reject(new Error('Failed to fetch from URL (unknown error)'));
        }
      });
    });

    const hash = simpleHash(text);
    console.log('[NLM Kit] Gist fetched OK via background. Hash:', hash);

    // Use localStorage so the baseline survives new tabs and browser restarts
    const storageKey = `nlm_synced_gist_hash_${getNotebookId()}`;
    const lastHash = localStorage.getItem(storageKey);
    console.log('[NLM Kit] Stored hash:', lastHash);

    if (lastHash === null) {
      // Very first time — store the current hash as the baseline and don't block
      localStorage.setItem(storageKey, hash);
      console.log('[NLM Kit] First run — baseline hash stored:', hash);
    } else if (lastHash !== hash) {
      // Gist has changed since the user last synced — require sync first
      console.log('[NLM Kit] ⚠️ Gist changed! Old:', lastHash, '→ New:', hash, '| Setting syncPending = true');
      syncPending = true;
      updateSyncButtonState();
    } else {
      console.log('[NLM Kit] Gist unchanged. No action needed.');
    }
  } catch (e) {
    console.error('[NLM Kit] Error in checkGistForChanges:', e);
    reportNlmError('checkGistForChanges', e);
    // Network failure — don't block the user
  }
}

// Update the sync button's visual state (badge + tooltip) and
// enable/disable the other action buttons based on syncPending.
function updateSyncButtonState() {
  const syncBtn = document.getElementById('bulk-sync-btn');
  const badge = document.getElementById('nlm-sync-badge');

  if (!syncBtn) return;

  if (syncPending) {
    // Show pulsing red badge on the sync button
    if (!badge) {
      const dot = document.createElement('span');
      dot.id = 'nlm-sync-badge';
      dot.className = 'nlm-sync-badge';
      syncBtn.style.position = 'relative';
      syncBtn.appendChild(dot);
    }
    syncBtn.title = '⚠️ Instructions updated — click to sync before running';

    // Disable the other three action buttons until sync is done
    ['bulk-rename-btn', 'bulk-label-btn', 'bulk-delete-btn'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.disabled = true;
        btn.title = 'Please sync instructions first';
      }
    });
  } else {
    // Remove badge if present
    if (badge) badge.remove();
    syncBtn.title = 'Sync System Instructions';
    // Re-enable source buttons (let scheduleSourceCheck decide the final state)
    const notebookId = getNotebookId();
    if (notebookId) scheduleSourceCheck(notebookId);
  }
}

// Inject script to get tokens from the main page context
function injectTokenScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('notebooklm/nlm_inject.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

// Listen for events from the injected script
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data) return;

  if (event.data.type === 'NOTEBOOKLM_TOKEN_RESPONSE') {
    authToken = event.data.token;
  }

  if (event.data.type === 'NOTEBOOKLM_SOURCES_UPDATED') {
    const nbId = getNotebookId();
    if (nbId) {
      invalidateSourceCache(nbId); // Always invalidate — source list just changed
      scheduleSourceCheck(nbId);
    }
  }

  if (event.data.type === 'NOTEBOOKLM_SYNC_COMPLETE') {
    syncPending = false;
    updateSyncButtonState();
  }
});

// Function to get notebook ID from URL
function getNotebookId() {
  const match = window.location.pathname.match(/\/notebook\/([a-zA-Z0-9-]+)/);
  return match ? match[1] : null;
}

// Generate random reqid
function generateReqId() {
  return Math.floor(Math.random() * 90000) + 10000;
}

// Read dynamic WIZ build params from the page.
// The fallback values are the last known-good values — update them when
// they stop working (DevTools → Network → any batchexecute request → check bl= and f.sid=).
function getWizData() {
  const data = window.WIZ_global_data || {};
  return {
    bl: data.cfb2h || 'boq_labs-tailwind-frontend_20260518.10_p0',
    fSid: data.Fdrif || '-5077533628963748752',
    at: data.SNlM0e || authToken
  };
}

// Fetch all sources for the current notebook
async function fetchSources(notebookId) {
  // MAINTENANCE: If fetching sources fails (e.g. 400 error), the RPC ID 'rLM1Ne' may have rotated.
  // To fix: Open Network tab, refresh NotebookLM, look for 'batchexecute' and find the new ID.
  const wiz = getWizData();
  const url = `${NLM_API_BASE}?rpcids=${RPC_FETCH_SOURCES}&_reqid=${generateReqId()}&bl=${wiz.bl}&f.sid=${wiz.fSid}&hl=en&authuser=0&source-path=%2Fnotebook%2F${notebookId}&nlm_kit=true`;

  const envelope = [
    RPC_FETCH_SOURCES,
    JSON.stringify([notebookId, null, [2], null, 0]),
    null,
    'generic'
  ];

  const formData = new URLSearchParams();
  formData.set('f.req', JSON.stringify([[envelope]]));
  formData.set('at', authToken);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
    },
    body: formData.toString()
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch sources: ${response.statusText}`);
  }

  const text = await response.text();

  const sourceObjects = [];
  const seenIds = new Set();
  try {
    // batchexecute returns string starting with )]}' 
    const cleanText = text.replace(/^\)\]\}'\s*/, '');
    const lines = cleanText.split('\n');

    for (const line of lines) {
      if (line.includes('wrb.fr') && line.includes('rLM1Ne')) {
        let innerDataStr = null;

        try {
          // Standard batchexecute row: [ ["wrb.fr", "rLM1Ne", "[...]", "generic"] ]
          const parsedLine = JSON.parse(line);
          if (Array.isArray(parsedLine) && parsedLine.length > 0) {
            const inner = Array.isArray(parsedLine[0]) ? parsedLine[0] : parsedLine;
            if (inner[0] === 'wrb.fr' && inner[1] === 'rLM1Ne') {
              innerDataStr = inner[2];
            }
          }
        } catch (e) {
          // Fallback if line is malformed or chunked format differs
          const match = line.match(/\["wrb\.fr","rLM1Ne","(.*?)",/);
          if (match) {
            innerDataStr = JSON.parse('"' + match[1] + '"');
          }
        }

        if (innerDataStr) {
          const projectData = JSON.parse(innerDataStr);

          let data = projectData;
          if (Array.isArray(projectData[0])) {
            data = projectData[0];
          }

          if (Array.isArray(data[1])) {
            for (const sourceData of data[1]) {
              if (!Array.isArray(sourceData)) continue;

              let sourceId = null;
              if (Array.isArray(sourceData[0]) && sourceData[0].length > 0) {
                sourceId = sourceData[0][0];
                if (Array.isArray(sourceId)) sourceId = sourceId[0]; // Handles [[[\"uuid\"]]]
              } else if (typeof sourceData[0] === 'string') {
                sourceId = sourceData[0];
              }

              if (!sourceId || typeof sourceId !== 'string') continue;
              if (!sourceId.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)) continue;
              if (sourceId === notebookId) continue;

              const title = typeof sourceData[1] === 'string' ? sourceData[1] : 'Untitled';

              if (!seenIds.has(sourceId)) {
                seenIds.add(sourceId);
                sourceObjects.push({ id: sourceId, title });
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('Failed to cleanly parse sources, falling back to regex...', err);
  }

  return sourceObjects;
}

// Delete a single source
async function deleteSource(notebookId, sourceId) {
  // MAINTENANCE: If deletion fails, the RPC ID 'tGMBJ' may have rotated.
  // To fix: Open Network tab, manually delete a source, and find the new ID in 'batchexecute'.
  const wiz = getWizData();
  const url = `${NLM_API_BASE}?rpcids=${RPC_DELETE_SOURCE}&_reqid=${generateReqId()}&bl=${wiz.bl}&f.sid=${wiz.fSid}&hl=en&authuser=0&source-path=%2Fnotebook%2F${notebookId}`;

  const formattedIds = [[[sourceId]], [2]];

  const envelope = [
    RPC_DELETE_SOURCE,
    JSON.stringify(formattedIds),
    null,
    'generic'
  ];

  const formData = new URLSearchParams();
  formData.set('f.req', JSON.stringify([[envelope]]));
  formData.set('at', authToken);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
    },
    body: formData.toString()
  });

  if (!response.ok) {
    throw new Error(`Failed to delete source ${sourceId}`);
  }
}

// Deletes `ids` in parallel chunks, reporting progress after each chunk via
// onProgress(done, total). Uses allSettled (not Promise.all) so one failing
// source doesn't abort the chunks after it — every id gets attempted, and we
// come back with exactly which ones succeeded vs failed.
async function deleteSourcesWithProgress(notebookId, ids, onProgress) {
  const chunkSize = 8;
  const succeeded = [];
  const failed = [];

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const results = await Promise.allSettled(chunk.map(id => deleteSource(notebookId, id)));
    results.forEach((result, idx) => {
      (result.status === 'fulfilled' ? succeeded : failed).push(chunk[idx]);
    });
    onProgress(succeeded.length + failed.length, ids.length);
  }

  return { succeeded, failed };
}

// Rename a single source
async function renameSource(notebookId, sourceId, newTitle) {
  // MAINTENANCE: If renaming fails, the RPC ID 'b7Wfje' may have rotated.
  // To fix: Open Network tab, manually rename a source, and find the new ID in 'batchexecute'.
  const wiz = getWizData();
  const url = `${NLM_API_BASE}?rpcids=${RPC_RENAME_SOURCE}&_reqid=${generateReqId()}&bl=${wiz.bl}&f.sid=${wiz.fSid}&hl=en&authuser=0&source-path=%2Fnotebook%2F${notebookId}`;

  const payload = [null, [sourceId], [[[newTitle]]]];

  const envelope = [
    RPC_RENAME_SOURCE,
    JSON.stringify(payload),
    null,
    'generic'
  ];

  const formData = new URLSearchParams();
  formData.set('f.req', JSON.stringify([[envelope]]));
  formData.set('at', authToken);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
    },
    body: formData.toString()
  });

  if (!response.ok) {
    throw new Error(`Failed to rename source ${sourceId}`);
  }
}

// Update system instruction
async function updateSystemInstruction(notebookId, newInstruction) {
  // MAINTENANCE: If syncing instructions fails, the RPC ID 's0tc2d' may have rotated.
  // To fix: Open Network tab, manually update system instructions, and find the new ID.
  const wiz = getWizData();
  const url = `${NLM_API_BASE}?rpcids=${RPC_SYNC_INSTRUCTIONS}&_reqid=${generateReqId()}&bl=${wiz.bl}&f.sid=${wiz.fSid}&hl=en&authuser=0&source-path=%2Fnotebook%2F${notebookId}`;

  const payload = [
    notebookId,
    [
      [
        null, null, null, null, null, null, null,
        [
          [2, newInstruction],
          []
        ]
      ]
    ],
    [
      2, null, null,
      [
        1, null, null, null, null, null, null, null, null, null, [1]
      ]
    ]
  ];

  const envelope = [
    RPC_SYNC_INSTRUCTIONS,
    JSON.stringify(payload),
    null,
    'generic'
  ];

  const formData = new URLSearchParams();
  formData.set('f.req', JSON.stringify([[envelope]]));
  formData.set('at', authToken);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
    },
    body: formData.toString()
  });

  if (!response.ok) {
    throw new Error(`Failed to update system instructions`);
  }
}

// ── Modal factory ────────────────────────────────────────────────────────
// Creates a standard NLM modal and appends it to the page.
// Returns { overlay, modal, body, footer } for the caller to populate.
//
// @param {string} title — heading shown in the modal header
// @param {string} [loadingText] — placeholder shown while data loads
// @returns {{ overlay: HTMLElement, modal: HTMLElement, body: HTMLElement, footer: HTMLElement }}
function createModal(title, loadingText = 'Gathering sources...') {
  // Remove existing modal if any
  const existing = document.querySelector('.nlm-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'nlm-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'nlm-modal';

  const header = document.createElement('div');
  header.className = 'nlm-modal-header';
  header.innerHTML = `
    <h2>${title}</h2>
    <button class="nlm-close-btn" aria-label="Close" title="Close">&times;</button>
  `;
  header.querySelector('.nlm-close-btn').onclick = () => overlay.remove();

  const body = document.createElement('div');
  body.className = 'nlm-modal-body';
  body.innerHTML = `
    <div class="nlm-loading">
      <div class="nlm-spinner"></div>
      <div>${loadingText}</div>
    </div>
  `;

  const footer = document.createElement('div');
  footer.className = 'nlm-modal-footer';

  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  return { overlay, modal, body, footer };
}

// Create Modal UI
async function openManageModal() {
  const notebookId = getNotebookId();
  if (!notebookId) {
    alert('Please open a specific notebook first.');
    return;
  }

  if (!authToken) {
    alert('Failed to get authentication token. Please refresh the page and try again.');
    return;
  }

  const { overlay, modal, body, footer } = createModal('Manage Sources');

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'nlm-btn nlm-btn-secondary';
  cancelBtn.innerText = 'Cancel';
  cancelBtn.onclick = () => overlay.remove();

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'nlm-btn nlm-btn-danger';
  deleteBtn.innerText = 'Delete';
  deleteBtn.disabled = true;

  footer.appendChild(cancelBtn);
  footer.appendChild(deleteBtn);

  // Fetch sources (reuses the cache when fresh)
  try {
    const sources = await getSources(notebookId);

    if (sources.length === 0) {
      body.innerHTML = '<p>No sources found in this notebook.</p>';
      return;
    }

    body.innerHTML = '';

    // Search Bar
    const searchContainer = document.createElement('div');
    searchContainer.className = 'nlm-search-container';

    const searchIcon = document.createElement('div');
    searchIcon.className = 'nlm-search-icon';
    searchIcon.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"></circle>
        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
      </svg>
    `;

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search sources by name...';
    searchInput.className = 'nlm-search-input';

    searchContainer.appendChild(searchIcon);
    searchContainer.appendChild(searchInput);
    body.appendChild(searchContainer);

    const controls = document.createElement('div');
    controls.className = 'nlm-controls';
    body.appendChild(controls);

    const list = document.createElement('div');
    list.className = 'nlm-source-list';

    const checkboxesData = [];

    // Search Filter Logic
    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      const items = list.querySelectorAll('.nlm-source-item');
      items.forEach(item => {
        if (item.dataset.title.includes(query)) {
          item.style.display = 'flex';
        } else {
          item.style.display = 'none';
        }
      });
    });

    sources.forEach(source => {
      const item = document.createElement('div');
      item.className = 'nlm-source-item';
      item.dataset.title = source.title.toLowerCase();

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `source-${source.id}`;
      cb.value = source.id;

      const label = document.createElement('label');
      label.htmlFor = `source-${source.id}`;
      label.innerText = source.title;

      cb.onchange = () => {
        updateDeleteButton();
      };

      item.appendChild(cb);
      item.appendChild(label);
      list.appendChild(item);
      checkboxesData.push({ cb, originalTitle: source.title });
    });

    body.appendChild(list);

    const updateDeleteButton = () => {
      const selectedCount = checkboxesData.filter(c => c.cb.checked).length;
      deleteBtn.disabled = selectedCount === 0;
      deleteBtn.innerText = selectedCount > 0 ? `Delete (${selectedCount})` : 'Delete';
    };

    addSmartSelectionControls(
      controls,
      () => list.querySelectorAll('.nlm-source-item'),
      () => checkboxesData,
      updateDeleteButton
    );

    // Handle Delete
    deleteBtn.onclick = async () => {
      const selectedIds = checkboxesData.filter(c => c.cb.checked).map(c => c.cb.value);
      if (selectedIds.length === 0) return;

      const confirmOverlay = document.createElement('div');
      confirmOverlay.className = 'nlm-confirm-overlay';
      confirmOverlay.innerHTML = `
        <div class="nlm-confirm-dialog">
          <h3>Confirm Deletion</h3>
          <p>Are you sure you want to permanently delete ${selectedIds.length} source(s)? This cannot be undone.</p>
          <div class="nlm-confirm-actions">
            <button class="nlm-btn nlm-btn-secondary" id="nlm-cancel-delete">Cancel</button>
            <button class="nlm-btn nlm-btn-danger" id="nlm-confirm-delete">Delete</button>
          </div>
        </div>
      `;
      modal.appendChild(confirmOverlay);

      document.getElementById('nlm-cancel-delete').onclick = () => {
        confirmOverlay.remove();
      };

      document.getElementById('nlm-confirm-delete').onclick = async () => {
        confirmOverlay.remove();
        await runDelete(selectedIds);
      };
    }; // End of deleteBtn.onclick

    // Maps a source id back to its title, for reporting failures by name
    // instead of an opaque UUID.
    const idToTitle = new Map(sources.map(s => [s.id, s.title]));

    // Runs the delete for `ids`, driving a visible progress bar the whole
    // time, and ending on a success / partial-failure (with retry) / full
    // failure state depending on what actually happened.
    async function runDelete(ids) {
      deleteBtn.disabled = true;
      cancelBtn.disabled = true;
      Array.from(controls.querySelectorAll('button')).forEach(b => b.disabled = true);
      footer.style.display = 'none';

      body.innerHTML = `
        <div class="nlm-progress-state">
          <div class="nlm-spinner"></div>
          <p class="nlm-progress-text">Deleting 0 of ${ids.length} source(s)…</p>
          <div class="nlm-progress-bar-track">
            <div class="nlm-progress-bar-fill" style="width: 0%"></div>
          </div>
        </div>
      `;
      const progressText = body.querySelector('.nlm-progress-text');
      const progressFill = body.querySelector('.nlm-progress-bar-fill');

      const { succeeded, failed } = await deleteSourcesWithProgress(notebookId, ids, (done, total) => {
        progressText.textContent = `Deleting ${done} of ${total} source(s)…`;
        progressFill.style.width = `${Math.round((done / total) * 100)}%`;
      });

      body.style.borderBottom = 'none';
      body.style.paddingBottom = '0px';

      if (succeeded.length > 0) {
        // Even on a partial failure, some deletions went through — invalidate
        // so the next open reflects reality instead of showing stale sources.
        invalidateSourceCache(notebookId);
        const remainingCount = sources.length - succeeded.length;
        updateKitButtonStates(remainingCount > 0);
      }

      if (failed.length === 0) {
        body.innerHTML = `
          <div class="nlm-success-state">
            <div class="nlm-success-icon">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </div>
            <h3>Success</h3>
            <p>Successfully deleted ${succeeded.length} source(s).</p>
          </div>
        `;
        setTimeout(() => overlay.remove(), 2000);
        return;
      }

      // Partial or total failure — tell the user exactly what didn't make it
      // through, and let them retry just the failed ones instead of redoing
      // the whole batch.
      const failedTitles = failed.map(id => idToTitle.get(id) || id);
      body.innerHTML = `
        <div class="nlm-success-state">
          <div class="nlm-success-icon" style="color: var(--nlm-danger); background: rgba(217, 48, 37, 0.1);">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </div>
          <h3>${succeeded.length > 0 ? 'Partially Deleted' : 'Delete Failed'}</h3>
          <p>
            ${succeeded.length > 0 ? `Deleted ${succeeded.length} of ${ids.length} source(s). ` : ''}
            ${failed.length} failed:
          </p>
          <ul class="nlm-failed-list">
            ${failedTitles.map(t => `<li>${t}</li>`).join('')}
          </ul>
        </div>
      `;

      footer.style.display = 'flex';
      footer.innerHTML = '';
      const closeBtn = document.createElement('button');
      closeBtn.className = 'nlm-btn nlm-btn-secondary';
      closeBtn.innerText = 'Close';
      closeBtn.onclick = () => overlay.remove();
      const retryBtn = document.createElement('button');
      retryBtn.className = 'nlm-btn nlm-btn-danger';
      retryBtn.innerText = `Retry ${failed.length} Failed`;
      retryBtn.onclick = () => runDelete(failed);
      footer.appendChild(closeBtn);
      footer.appendChild(retryBtn);
    }

  } catch (error) {
    console.error('Fetch error:', error);
    reportNlmError('bulkDeleteSources', error);
    body.innerHTML = `<p style="color: red;">Failed to load sources: ${error.message}</p>`;
  }
}

// Enables or disables the 3 source-dependent buttons (delete, rename, label).
// The sync button is always enabled — it works independently of sources.
function updateKitButtonStates(hasSource) {
  const deleteBtn = document.getElementById('bulk-delete-btn');
  const renameBtn = document.getElementById('bulk-rename-btn');
  const labelBtn = document.getElementById('bulk-label-btn');
  [deleteBtn, renameBtn, labelBtn].forEach(btn => {
    if (!btn) return;
    btn.disabled = !hasSource;
  });
}

// Debounced background check: fetches sources once and caches the result.
// Buttons are enabled/disabled based on whether sources exist.
function scheduleSourceCheck(notebookId) {
  if (sourceCheckTimer) clearTimeout(sourceCheckTimer);
  sourceCheckTimer = setTimeout(async () => {
    // Token may not be ready yet on first paint — retry after another 800ms
    if (!authToken) {
      scheduleSourceCheck(notebookId);
      return;
    }
    try {
      // Uses the cache when fresh, otherwise fetches — either way this also
      // warms sourceListCache so opening a modal right after is instant.
      const sources = await getSources(notebookId);
      updateKitButtonStates(sources.length > 0);
    } catch (e) {
      // On API error, enable buttons so user isn't blocked
      updateKitButtonStates(true);
    }
  }, 800);
}

// Create and inject the button
function injectButton() {
  const notebookId = getNotebookId();
  const existingContainer = document.getElementById('nlm-bulk-actions-container');

  if (!notebookId) {
    if (existingContainer) existingContainer.remove();
    return;
  }

  // Find an element containing exactly "Sources"
  const xpath = "//div[text()='Sources'] | //span[text()='Sources'] | //h2[text()='Sources'] | //h3[text()='Sources']";
  const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);

  let targetNode = null;
  for (let i = 0; i < result.snapshotLength; i++) {
    const node = result.snapshotItem(i);
    // Ensure element is visible
    if (node.offsetParent !== null) {
      targetNode = node;
      break;
    }
  }

  if (!targetNode) {
    if (existingContainer) existingContainer.remove();
    return;
  }

  // If the container exists, ensure it's still right next to our target node
  if (existingContainer) {
    if (existingContainer.previousElementSibling === targetNode) {
      // Container is in the right place — just refresh the sync button visibility
      const syncBtn = document.getElementById('bulk-sync-btn');
      if (syncBtn) syncBtn.style.display = isCQCheckerNotebook() ? '' : 'none';
      return;
    } else {
      existingContainer.remove(); // Re-inject it in the correct spot
    }
  }

  const container = document.createElement('div');
  container.id = 'nlm-bulk-actions-container';
  container.className = 'nlm-btn-inline';
  container.style.display = 'flex';
  container.style.gap = '4px';
  container.style.alignItems = 'center';

  // Pencil button (Rename)
  const renameBtn = document.createElement('button');
  renameBtn.id = 'bulk-rename-btn';
  renameBtn.title = 'Bulk Rename Sources';
  renameBtn.onclick = openRenameModal;
  renameBtn.className = 'nlm-action-btn rename-btn';
  renameBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#1a73e8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
    </svg>
  `;

  // Trash button (Delete)
  const deleteBtn = document.createElement('button');
  deleteBtn.id = 'bulk-delete-btn';
  deleteBtn.title = 'Manage / Bulk Delete Sources';
  deleteBtn.onclick = openManageModal;
  deleteBtn.className = 'nlm-action-btn delete-btn';
  deleteBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#d93025" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      <line x1="10" y1="11" x2="10" y2="17"></line>
      <line x1="14" y1="11" x2="14" y2="17"></line>
    </svg>
  `;

  // Sync toggle button — only shown for "CQ Checker - ..." notebooks
  const syncBtn = document.createElement('button');
  syncBtn.id = 'bulk-sync-btn';
  syncBtn.title = 'Sync System Instructions';
  syncBtn.onclick = syncInstructions;
  syncBtn.className = 'nlm-action-btn';
  syncBtn.style.display = isCQCheckerNotebook() ? '' : 'none';
  syncBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#1a73e8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 2v6h-6"></path>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
      <path d="M3 22v-6h6"></path>
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path>
    </svg>
  `;

  // Label toggle button
  const labelBtn = document.createElement('button');
  labelBtn.id = 'bulk-label-btn';
  labelBtn.title = 'Bulk Assign Label';
  labelBtn.onclick = openLabelModal;
  labelBtn.className = 'nlm-action-btn';
  labelBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#1a73e8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
      <line x1="7" y1="7" x2="7.01" y2="7"></line>
    </svg>
  `;

  container.appendChild(syncBtn);
  container.appendChild(labelBtn);
  container.appendChild(renameBtn);
  container.appendChild(deleteBtn);

  // Start source-dependent buttons as disabled until the background check confirms sources exist
  deleteBtn.disabled = true;
  renameBtn.disabled = true;
  labelBtn.disabled = true;

  targetNode.insertAdjacentElement('afterend', container);

  // Ensure parent aligns the text and the new icons cleanly
  if (targetNode.parentElement) {
    targetNode.parentElement.style.display = 'flex';
    targetNode.parentElement.style.alignItems = 'center';
  }

  // Kick off background source check to enable buttons if sources are present
  const nbId = getNotebookId();
  if (nbId) scheduleSourceCheck(nbId);

  // Apply any pending sync state to the newly injected buttons
  if (syncPending) updateSyncButtonState();
}

// Show a non-intrusive toast telling the user they must sync first.
function showSyncRequiredToast() {
  const existing = document.getElementById('nlm-sync-toast');
  if (existing) {
    // Re-trigger animation
    existing.classList.remove('nlm-toast-visible');
    void existing.offsetWidth; // force reflow
    existing.classList.add('nlm-toast-visible');
    clearTimeout(existing._hideTimer);
    existing._hideTimer = setTimeout(() => existing.remove(), 3500);
    return;
  }
  const toast = document.createElement('div');
  toast.id = 'nlm-sync-toast';
  toast.className = 'nlm-sync-toast';
  toast.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;flex-shrink:0">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
      <line x1="12" y1="9" x2="12" y2="13"></line>
      <line x1="12" y1="17" x2="12.01" y2="17"></line>
    </svg>
    Instructions updated — please <strong>sync</strong> before running.
  `;
  document.body.appendChild(toast);
  // Trigger animation on next frame
  requestAnimationFrame(() => toast.classList.add('nlm-toast-visible'));
  toast._hideTimer = setTimeout(() => toast.remove(), 3500);
}

// Initialize
injectTokenScript();
injectButton();

// Check gist for changes once the auth token is ready (max 3s wait)
// This is only performed in the notebooklm_kit content script context.
(async () => {
  // 1. Wait for the auth token (injected async), up to 5s
  for (let i = 0; i < 50 && !authToken; i++) {
    await new Promise(r => setTimeout(r, 100));
  }

  // 2. Wait for the notebook title element to be rendered by Angular, up to 5s
  //    Without this, isCQCheckerNotebook() races and always returns false.
  for (let i = 0; i < 50; i++) {
    const titleEl = document.querySelector('span.title-label-inner');
    if (titleEl && titleEl.innerText && titleEl.innerText.trim()) break;
    await new Promise(r => setTimeout(r, 100));
  }

  await checkGistForChanges();
})();

// Use MutationObserver to ensure the button stays on the page even if React re-renders
const observer = new MutationObserver(() => {
  injectButton();
});
observer.observe(document.body, { childList: true, subtree: true });

// Intercept submit button clicks and Enter-key presses when a sync is required.
// Uses the CAPTURING phase (true) so we fire before NotebookLM's own handlers.
document.addEventListener('click', (e) => {
  if (!syncPending) return;
  const btn = e.target.closest('button.submit-button, button[aria-label="Submit"], button[type="submit"]');
  if (btn) {
    e.stopImmediatePropagation();
    e.preventDefault();
    showSyncRequiredToast();
  }
}, true);

document.addEventListener('keydown', (e) => {
  if (!syncPending) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    const textarea = e.target.closest('textarea.query-box-input, textarea[aria-label="Query box"], textarea');
    if (textarea) {
      e.stopImmediatePropagation();
      e.preventDefault();
      showSyncRequiredToast();
    }
  }
}, true);

// Also intercept the form's own submit event as a final safety net
document.addEventListener('submit', (e) => {
  if (!syncPending) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  showSyncRequiredToast();
}, true);


// --- RENAME UI LOGIC ---
async function openRenameModal() {
  const notebookId = getNotebookId();
  if (!notebookId) {
    alert('Please open a specific notebook first.');
    return;
  }

  if (!authToken) {
    alert('Failed to get authentication token. Please refresh the page and try again.');
    return;
  }

  const { overlay, modal, body, footer } = createModal('Bulk Rename Sources');

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'nlm-btn nlm-btn-secondary';
  cancelBtn.innerText = 'Cancel';
  cancelBtn.onclick = () => overlay.remove();

  const renameBtn = document.createElement('button');
  renameBtn.className = 'nlm-btn nlm-btn-primary';
  renameBtn.innerText = 'Rename';
  renameBtn.disabled = true;

  footer.appendChild(cancelBtn);
  footer.appendChild(renameBtn);

  // Fetch sources (reuses the cache when fresh)
  try {
    const sources = await getSources(notebookId);

    if (sources.length === 0) {
      body.innerHTML = '<p>No sources found in this notebook.</p>';
      return;
    }

    body.innerHTML = '';

    // Prefix Input Section
    const prefixContainer = document.createElement('div');
    prefixContainer.style.marginBottom = '20px';
    prefixContainer.innerHTML = `
      <label style="display: block; font-size: 14px; font-weight: 500; margin-bottom: 8px;">Supplier Name (Prefix)</label>
      <input type="text" id="nlm-prefix-input" class="nlm-search-input" placeholder="e.g. Acme Corp" style="padding-left: 12px;">
    `;
    body.appendChild(prefixContainer);

    const prefixInput = prefixContainer.querySelector('#nlm-prefix-input');

    // Search Bar
    const searchContainer = document.createElement('div');
    searchContainer.className = 'nlm-search-container';
    searchContainer.innerHTML = `
      <div class="nlm-search-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
      </div>
      <input type="text" id="nlm-search-input" class="nlm-search-input" placeholder="Search sources...">
    `;
    body.appendChild(searchContainer);
    const searchInput = searchContainer.querySelector('#nlm-search-input');

    // Controls
    const controls = document.createElement('div');
    controls.className = 'nlm-controls';
    body.appendChild(controls);

    const list = document.createElement('div');
    list.className = 'nlm-source-list';

    const checkboxes = [];
    const previewSpans = [];

    // Create source items
    sources.forEach(source => {
      const item = document.createElement('div');
      item.className = 'nlm-source-item';
      item.dataset.title = source.title.toLowerCase();

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `rename-${source.id}`;
      cb.value = source.id;

      const label = document.createElement('label');
      label.htmlFor = `rename-${source.id}`;

      const originalNameSpan = document.createElement('span');
      originalNameSpan.innerText = source.title;

      const previewNameSpan = document.createElement('span');
      previewNameSpan.className = 'nlm-preview-name';
      previewNameSpan.innerText = `Preview: ${source.title}`;

      label.appendChild(originalNameSpan);
      label.appendChild(previewNameSpan);

      cb.onchange = () => {
        updateRenameButton();
      };

      item.appendChild(cb);
      item.appendChild(label);
      list.appendChild(item);
      checkboxes.push({ cb, originalTitle: source.title, previewSpan: previewNameSpan });
    });

    body.appendChild(list);

    const updatePreviews = () => {
      const prefix = prefixInput.value.trim();
      checkboxes.forEach(item => {
        const newName = prefix ? `${prefix} - ${item.originalTitle}` : item.originalTitle;
        item.previewSpan.innerText = `Preview: ${newName}`;
      });
    };

    const updateRenameButton = () => {
      const selectedCount = checkboxes.filter(c => c.cb.checked).length;
      renameBtn.disabled = selectedCount === 0;
      renameBtn.innerText = selectedCount > 0 ? `Rename (${selectedCount})` : 'Rename';
    };

    prefixInput.addEventListener('input', updatePreviews);

    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      const items = list.querySelectorAll('.nlm-source-item');
      items.forEach(item => {
        if (item.dataset.title.includes(query)) {
          item.style.display = 'flex';
        } else {
          item.style.display = 'none';
        }
      });
    });

    addSmartSelectionControls(
      controls,
      () => list.querySelectorAll('.nlm-source-item'),
      () => checkboxes,
      updateRenameButton
    );

    // Handle Rename Execution
    renameBtn.onclick = async () => {
      const selectedItems = checkboxes.filter(item => item.cb.checked);
      if (selectedItems.length === 0) return;

      const prefix = prefixInput.value.trim();

      renameBtn.disabled = true;
      cancelBtn.disabled = true;
      prefixInput.disabled = true;
      Array.from(controls.querySelectorAll('button')).forEach(b => b.disabled = true);

      try {
        const chunkSize = 5;
        for (let i = 0; i < selectedItems.length; i += chunkSize) {
          const chunk = selectedItems.slice(i, i + chunkSize);
          await Promise.all(chunk.map(item => {
            const newName = prefix ? `${prefix} - ${item.originalTitle}` : item.originalTitle;
            return renameSource(notebookId, item.cb.value, newName);
          }));
          renameBtn.innerText = `Renamed ${Math.min(i + chunkSize, selectedItems.length)} / ${selectedItems.length}`;
        }

        // Titles changed — invalidate so the next open picks up the new names.
        invalidateSourceCache(notebookId);

        // Show success state in modal
        body.innerHTML = `
          <div class="nlm-success-state">
            <div class="nlm-success-icon">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </div>
            <h3>Success</h3>
            <p>Successfully renamed ${selectedItems.length} source(s).</p>
          </div>
        `;

        footer.style.display = 'none';
        body.style.borderBottom = 'none';
        body.style.paddingBottom = '0px';

        setTimeout(() => {
          overlay.remove();
        }, 2000);

      } catch (err) {
        console.error('Rename error:', err);
        reportNlmError('renameSources', err);

        body.innerHTML = `
          <div class="nlm-success-state">
            <div class="nlm-success-icon" style="color: var(--nlm-danger); background: rgba(217, 48, 37, 0.1);">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </div>
            <h3>Error Renaming Sources</h3>
            <p>${err.message}</p>
          </div>
        `;

        footer.innerHTML = '';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'nlm-btn nlm-btn-secondary';
        closeBtn.innerText = 'Close';
        closeBtn.onclick = () => overlay.remove();
        footer.appendChild(closeBtn);
      }
    };

  } catch (error) {
    console.error('Fetch error:', error);
    reportNlmError('renameSourcesModal', error);
    body.innerHTML = `<p style="color: red;">Failed to load sources: ${error.message}</p>`;
  }
}

// --- SMART SELECTION HELPER ---
function addSmartSelectionControls(controlsContainer, getListItems, getCheckboxData, onSelectionChange) {
  const selectAllBtn = document.createElement('button');
  selectAllBtn.className = 'nlm-link-btn';
  selectAllBtn.innerText = 'Select All';

  const deselectAllBtn = document.createElement('button');
  deselectAllBtn.className = 'nlm-link-btn';
  deselectAllBtn.innerText = 'Deselect All';

  const selectNoPrefixBtn = document.createElement('button');
  selectNoPrefixBtn.className = 'nlm-link-btn';
  selectNoPrefixBtn.innerText = 'Select No Prefix';

  const selectDuplicatesBtn = document.createElement('button');
  selectDuplicatesBtn.className = 'nlm-link-btn';
  selectDuplicatesBtn.innerText = 'Select Duplicates';

  controlsContainer.appendChild(selectAllBtn);
  controlsContainer.appendChild(deselectAllBtn);
  controlsContainer.appendChild(selectNoPrefixBtn);
  controlsContainer.appendChild(selectDuplicatesBtn);

  selectAllBtn.onclick = () => {
    getListItems().forEach((item, index) => {
      if (item.style.display !== 'none') getCheckboxData()[index].cb.checked = true;
    });
    onSelectionChange();
  };

  deselectAllBtn.onclick = () => {
    getListItems().forEach((item, index) => {
      if (item.style.display !== 'none') getCheckboxData()[index].cb.checked = false;
    });
    onSelectionChange();
  };

  selectNoPrefixBtn.onclick = () => {
    getListItems().forEach((item, index) => {
      if (item.style.display !== 'none') {
        const title = getCheckboxData()[index].originalTitle;
        getCheckboxData()[index].cb.checked = !title.includes(' - ');
      }
    });
    onSelectionChange();
  };

  selectDuplicatesBtn.onclick = () => {
    const seen = new Set();
    getListItems().forEach((item, index) => {
      if (item.style.display !== 'none') {
        const title = getCheckboxData()[index].originalTitle.toLowerCase().trim();
        if (seen.has(title)) {
          getCheckboxData()[index].cb.checked = true;
        } else {
          seen.add(title);
          getCheckboxData()[index].cb.checked = false;
        }
      }
    });
    onSelectionChange();
    onSelectionChange();
  };
}

// --- SYNC INSTRUCTIONS (ONE-CLICK) ---
async function syncInstructions() {
  const notebookId = getNotebookId();
  if (!notebookId) {
    alert('Please open a specific notebook first.');
    return;
  }

  if (!authToken) {
    alert('Failed to get authentication token. Please refresh the page and try again.');
    return;
  }

  const existingModal = document.querySelector('.nlm-modal-overlay');
  if (existingModal) existingModal.remove();

  const overlay = document.createElement('div');
  overlay.className = 'nlm-modal-overlay';
  overlay.innerHTML = `
    <div class="nlm-modal" style="text-align: center; padding: 32px;">
      <h3 style="margin: 0 0 16px 0; color: var(--nlm-text-primary);">Syncing Instructions...</h3>
      <p style="color: var(--nlm-text-secondary); margin: 0;" id="sync-status">Fetching latest instructions from server</p>
    </div>
  `;
  document.body.appendChild(overlay);
  const statusMsg = document.getElementById('sync-status');

  try {
    const text = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'fetchGistText' }, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (res && res.error) {
          reject(new Error(res.error));
        } else if (res && res.text) {
          resolve(res.text);
        } else {
          reject(new Error('Failed to fetch from URL (unknown error)'));
        }
      });
    });

    statusMsg.innerText = 'Updating Notebook...';
    await updateSystemInstruction(notebookId, text);

    // Store the new hash so we know the user is up to date
    const hash = simpleHash(text);
    localStorage.setItem(`nlm_synced_gist_hash_${notebookId}`, hash);
    console.log('[NLM Kit] Sync complete. New hash stored in localStorage:', hash);

    // Clear the mandatory-sync gate and re-enable other buttons
    syncPending = false;
    updateSyncButtonState();

    statusMsg.innerText = 'Success! Instructions updated.';
    statusMsg.style.color = '#0f9d58';

    setTimeout(() => {
      overlay.remove();
    }, 1500);

  } catch (err) {
    console.error(err);
    reportNlmError('syncSystemInstructions', err);
    statusMsg.innerText = `Error: ${err.message}`;
    statusMsg.style.color = '#d93025';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'nlm-btn-secondary';
    closeBtn.innerText = 'Close';
    closeBtn.style.marginTop = '16px';
    closeBtn.onclick = () => overlay.remove();
    overlay.firstElementChild.appendChild(closeBtn);
  }
}

// --- LABELLING LOGIC ---
async function fetchLabels(notebookId) {
  const wiz = getWizData();
  const url = `${NLM_API_BASE}?rpcids=${RPC_FETCH_LABELS}&_reqid=${generateReqId()}&bl=${wiz.bl}&f.sid=${wiz.fSid}&hl=en&authuser=0&source-path=%2Fnotebook%2F${notebookId}`;

  const envelope = [
    RPC_FETCH_LABELS,
    JSON.stringify([[2], notebookId, null, null, []]),
    null,
    'generic'
  ];

  const formData = new URLSearchParams();
  formData.set('f.req', JSON.stringify([[envelope]]));
  formData.set('at', authToken);

  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: formData.toString() });
  if (!response.ok) throw new Error('Failed to fetch labels');

  const text = await response.text();
  const labelObjects = [];
  const sourceToLabelMap = {};

  // We must fetch sources first to know which UUIDs are Source IDs vs Label IDs
  const sources = await getSources(notebookId);
  const sourceIds = new Set(sources.map(s => s.id));

  try {
    const cleanText = text.replace(/^\)\]\}'\s*/, '');
    const lines = cleanText.split('\n');

    for (const line of lines) {
      if (line.includes('wrb.fr') && line.includes('agX4Bc')) {
        let innerDataStr = null;
        try {
          const parsedLine = JSON.parse(line);
          if (Array.isArray(parsedLine) && parsedLine.length > 0) {
            const inner = Array.isArray(parsedLine[0]) ? parsedLine[0] : parsedLine;
            if (inner[0] === 'wrb.fr' && inner[1] === 'agX4Bc') {
              innerDataStr = inner[2];
            }
          }
        } catch (e) {
          const match = line.match(/\["wrb\.fr","agX4Bc","(.*?)",/);
          if (match) innerDataStr = JSON.parse('"' + match[1] + '"');
        }

        if (innerDataStr) {
          const labelData = JSON.parse(innerDataStr);
          console.log("NotebookLM Extension: RAW Label API Data:", labelData);

          function recursiveFind(arr) {
            if (!Array.isArray(arr)) return;

            let id = null;
            let name = null;

            // Check elements in the array
            for (let i = 0; i < arr.length; i++) {
              let item = arr[i];
              let potentialId = null;

              if (typeof item === 'string' && item.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)) {
                potentialId = item;
              } else if (Array.isArray(item) && typeof item[0] === 'string' && item[0].match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)) {
                potentialId = item[0];
              }

              if (potentialId && potentialId !== notebookId && !sourceIds.has(potentialId)) {
                id = potentialId;
                // Find nearest string that is not a UUID
                for (let j = 0; j < arr.length; j++) {
                  if (typeof arr[j] === 'string' && arr[j] !== id && arr[j].trim() !== '' && !arr[j].match(/^[a-f0-9]{8}-/)) {
                    name = arr[j];
                    break;
                  }
                }
                break;
              }
            }

            if (id && name) {
              if (!labelObjects.find(l => l.id === id)) {
                labelObjects.push({ id, name });
              }
              // If we found a label, scan this entire sub-array for source IDs to build the mapping
              function extractSourceIds(subArr) {
                if (!Array.isArray(subArr)) return;
                for (let item of subArr) {
                  if (typeof item === 'string' && sourceIds.has(item)) {
                    if (!sourceToLabelMap[item]) sourceToLabelMap[item] = [];
                    if (!sourceToLabelMap[item].includes(id)) sourceToLabelMap[item].push(id);
                  } else if (Array.isArray(item)) {
                    extractSourceIds(item);
                  }
                }
              }
              extractSourceIds(arr);
            }

            for (const item of arr) {
              recursiveFind(item);
            }
          }

          recursiveFind(labelData);
          console.log("NotebookLM Extension: Parsed Labels:", labelObjects);
          console.log("NotebookLM Extension: Source to Label Map:", sourceToLabelMap);
        }
      }
    }
  } catch (err) {
    console.warn('Failed to parse labels', err);
  }

  return { labels: labelObjects, sourceToLabelMap, sources };
}

async function updateLabelAssignment(notebookId, sourceId, labelId, action) {
  const wiz = getWizData();
  const url = `${NLM_API_BASE}?rpcids=${RPC_UPDATE_LABEL}&source-path=%2Fnotebook%2F${notebookId}&bl=${wiz.bl}&f.sid=${wiz.fSid}&hl=en-GB&_reqid=${generateReqId()}&rt=c`;

  // Google's internal array format for le8sX:
  // Add: [[ null, AddedSources ]]
  // Remove: [[ null, null, RemovedSources ]]
  let actionPayload;
  if (action === 'add') {
    actionPayload = [null, [[sourceId]]];
  } else {
    actionPayload = [null, null, [[sourceId]]];
  }

  const payload = [[2], notebookId, labelId, [actionPayload]];

  const envelope = [
    RPC_UPDATE_LABEL,
    JSON.stringify(payload),
    null,
    'generic'
  ];

  const formData = new URLSearchParams();
  formData.set('f.req', JSON.stringify([[envelope]]));
  formData.set('at', authToken);

  console.log(`NotebookLM Extension: ${action === 'add' ? 'Adding' : 'Removing'} Source ${sourceId} for Label ${labelId}`);

  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: formData.toString() });
  if (!response.ok) {
    throw new Error(`HTTP Error: ${response.status}`);
  }

  const text = await response.text();
  console.log(`NotebookLM Extension: Assign Response for ${sourceId}:`, text);
}

async function openLabelModal() {
  const notebookId = getNotebookId();
  if (!notebookId) { alert('Please open a specific notebook first.'); return; }
  if (!authToken) { alert('Failed to get authentication token. Please refresh the page and try again.'); return; }

  const { overlay, modal, body, footer } = createModal('Bulk Assign Label', 'Gathering sources and labels...');
  // Label modal needs extra width for its two-column layout
  modal.style.maxWidth = '900px';
  modal.style.width = '90vw';

  try {
    const { labels, sourceToLabelMap, sources } = await fetchLabels(notebookId);

    if (sources.length === 0) {
      body.innerHTML = '<p>No sources found in this notebook.</p>';
      return;
    }

    body.innerHTML = '';

    // Create Flex Container
    const mainContent = document.createElement('div');
    mainContent.style.display = 'flex';
    mainContent.style.gap = '20px';
    mainContent.style.height = '400px';

    // --- LEFT COLUMN: SOURCES ---
    const leftCol = document.createElement('div');
    leftCol.style.flex = '3';
    leftCol.style.display = 'flex';
    leftCol.style.flexDirection = 'column';
    leftCol.style.borderRight = '1px solid var(--nlm-border)';
    leftCol.style.paddingRight = '20px';

    const sourceHeader = document.createElement('div');
    sourceHeader.style.fontWeight = '500';
    sourceHeader.style.marginBottom = '10px';
    sourceHeader.innerText = '1. Select Sources';
    leftCol.appendChild(sourceHeader);

    const searchContainer = document.createElement('div');
    searchContainer.className = 'nlm-search-container';
    searchContainer.innerHTML = `
      <div class="nlm-search-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
      </div>
      <input type="text" id="nlm-search-input" class="nlm-search-input" placeholder="Search sources...">
    `;
    leftCol.appendChild(searchContainer);
    const searchInput = searchContainer.querySelector('#nlm-search-input');

    const controls = document.createElement('div');
    controls.className = 'nlm-controls';
    leftCol.appendChild(controls);

    const sourceList = document.createElement('div');
    sourceList.className = 'nlm-source-list';
    sourceList.style.flex = '1';
    sourceList.style.overflowY = 'auto';

    const sourceCheckboxesData = [];

    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      const items = sourceList.querySelectorAll('.nlm-source-item');
      items.forEach(item => {
        if (item.dataset.title.includes(query)) item.style.display = 'flex';
        else item.style.display = 'none';
      });
    });

    sources.forEach(source => {
      const item = document.createElement('div');
      item.className = 'nlm-source-item';
      item.dataset.title = source.title.toLowerCase();

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `source-${source.id}`;
      cb.value = source.id;

      const labelEl = document.createElement('label');
      labelEl.htmlFor = `source-${source.id}`;

      const updateLabelText = () => {
        const existingLabelIds = sourceToLabelMap[source.id] || [];
        const existingLabelNames = existingLabelIds.map(lid => labels.find(l => l.id === lid)?.name).filter(Boolean);
        labelEl.innerText = source.title + (existingLabelNames.length > 0 ? ` (In: ${existingLabelNames.join(', ')})` : '');
      };
      updateLabelText();

      cb.onchange = () => updateButtons();

      item.appendChild(cb);
      item.appendChild(labelEl);
      sourceList.appendChild(item);
      sourceCheckboxesData.push({ cb, originalTitle: source.title, updateLabelText });
    });

    leftCol.appendChild(sourceList);
    mainContent.appendChild(leftCol);

    // --- RIGHT COLUMN: LABELS ---
    const rightCol = document.createElement('div');
    rightCol.style.flex = '2';
    rightCol.style.display = 'flex';
    rightCol.style.flexDirection = 'column';

    const labelHeader = document.createElement('div');
    labelHeader.style.fontWeight = '500';
    labelHeader.style.marginBottom = '10px';
    labelHeader.innerText = '2. Select Labels';
    rightCol.appendChild(labelHeader);

    const labelList = document.createElement('div');
    labelList.className = 'nlm-source-list';
    labelList.style.flex = '1';
    labelList.style.overflowY = 'auto';

    const labelCheckboxesData = [];
    labels.forEach(labelObj => {
      const item = document.createElement('div');
      item.className = 'nlm-source-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `dest-label-${labelObj.id}`;
      cb.value = labelObj.id;

      const labelEl = document.createElement('label');
      labelEl.htmlFor = `dest-label-${labelObj.id}`;
      labelEl.innerText = labelObj.name;

      cb.onchange = () => updateButtons();

      item.appendChild(cb);
      item.appendChild(labelEl);
      labelList.appendChild(item);
      labelCheckboxesData.push({ cb });
    });

    rightCol.appendChild(labelList);
    mainContent.appendChild(rightCol);

    body.appendChild(mainContent);

    // --- FOOTER BUTTONS ---
    footer.innerHTML = '';

    const statusText = document.createElement('div');
    statusText.style.flex = '1';
    statusText.style.textAlign = 'left';
    statusText.style.color = '#666';
    statusText.style.fontSize = '13px';
    statusText.style.fontWeight = '500';

    const removeBtn = document.createElement('button');
    removeBtn.className = 'nlm-btn nlm-btn-danger';
    removeBtn.style.marginRight = '8px';

    const assignBtn2 = document.createElement('button');
    assignBtn2.className = 'nlm-btn nlm-btn-primary';
    assignBtn2.style.marginRight = '8px';

    const doneBtn = document.createElement('button');
    doneBtn.className = 'nlm-btn nlm-btn-secondary';
    doneBtn.innerText = 'Done & Reload';
    doneBtn.onclick = () => window.location.reload();

    footer.appendChild(statusText);
    footer.appendChild(removeBtn);
    footer.appendChild(assignBtn2);
    footer.appendChild(doneBtn);

    const updateButtons = () => {
      const selectedSources = sourceCheckboxesData.filter(c => c.cb.checked).length;
      const selectedLabels = labelCheckboxesData.filter(c => c.cb.checked).length;
      const enabled = selectedSources > 0 && selectedLabels > 0;

      assignBtn2.disabled = !enabled;
      removeBtn.disabled = !enabled;

      assignBtn2.innerText = enabled ? `Add to ${selectedLabels} Label(s)` : 'Add to Labels';
      removeBtn.innerText = enabled ? `Remove from ${selectedLabels} Label(s)` : 'Remove from Labels';
    };

    addSmartSelectionControls(controls, () => sourceList.querySelectorAll('.nlm-source-item'), () => sourceCheckboxesData, updateButtons);
    updateButtons();

    const executeAction = async (action) => {
      const selectedSourceIds = sourceCheckboxesData.filter(c => c.cb.checked).map(c => c.cb.value);
      const selectedLabelIds = labelCheckboxesData.filter(c => c.cb.checked).map(c => c.cb.value);

      assignBtn2.disabled = true;
      removeBtn.disabled = true;
      doneBtn.disabled = true;
      statusText.innerText = `${action === 'add' ? 'Assigning' : 'Removing'} sources...`;
      statusText.style.color = '#666';

      let successCount = 0;

      for (const labelId of selectedLabelIds) {
        for (const sourceId of selectedSourceIds) {
          try {
            await updateLabelAssignment(notebookId, sourceId, labelId, action);

            if (!sourceToLabelMap[sourceId]) sourceToLabelMap[sourceId] = [];
            if (action === 'add') {
              if (!sourceToLabelMap[sourceId].includes(labelId)) sourceToLabelMap[sourceId].push(labelId);
            } else {
              sourceToLabelMap[sourceId] = sourceToLabelMap[sourceId].filter(id => id !== labelId);
            }

            const sourceData = sourceCheckboxesData.find(c => c.cb.value === sourceId);
            if (sourceData) sourceData.updateLabelText();

            successCount++;
          } catch (e) {
            console.error(e);
            reportNlmError('labelAssignment', e);
          }
        }
      }

      statusText.innerText = `Success! Processed ${successCount} operation(s).`;
      statusText.style.color = 'var(--nlm-primary)';

      sourceCheckboxesData.forEach(c => c.cb.checked = false);

      updateButtons();
      doneBtn.disabled = false;
    };

    assignBtn2.onclick = () => executeAction('add');
    removeBtn.onclick = () => executeAction('remove');

  } catch (error) {
    console.error('Fetch error:', error);
    reportNlmError('labelModal', error);
    body.innerHTML = `<p style="color: red;">Failed to load data: ${error.message}</p>`;
  }
}
