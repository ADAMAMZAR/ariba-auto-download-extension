// ============================================================
// constants.js — Single source of truth for all magic values
//
// Loaded in three contexts:
//   1. background/background.js (service worker) → via importScripts('../shared/constants.js')
//   2. notebooklm/notebooklm_kit.js (content script) → loaded first in manifest content_scripts
//   3. notebooklm/nlm_runner.js (MAIN world injection) → injected via files:[] before nlm_runner.js
//
// Uses var so values land on globalThis and are accessible across
// all script files loaded in the same context.
// ============================================================

// ── NotebookLM batchexecute RPC IDs ──────────────────────────────────
// ⚠️  MAINTENANCE: These IDs rotate without notice. If a feature starts
//     failing with a 400 error, open DevTools → Network → filter
//     "batchexecute" → manually perform the affected action → find the
//     new ID. Update ONLY the constant below — no other file needs to change.
var RPC_FETCH_SOURCES = 'rLM1Ne'; // fetchSources()       — list all sources in a notebook
var RPC_DELETE_SOURCE = 'tGMBJ';  // deleteSource()       — delete a single source
var RPC_RENAME_SOURCE = 'b7Wfje'; // renameSource()       — rename a single source
var RPC_SYNC_INSTRUCTIONS = 's0tc2d'; // updateSystemInstruction() / nlm_runner sync step
var RPC_REGISTER_FILES = 'o4cbdc'; // nlm_runner upload step — register file slots
var RPC_FETCH_LABELS = 'agX4Bc'; // fetchLabels()        — list all labels
var RPC_UPDATE_LABEL = 'le8sX';  // updateLabelAssignment() — add/remove label from source

// ── External URLs ─────────────────────────────────────────────────────
var NLM_API_BASE = 'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute';
var NLM_UPLOAD_BASE = 'https://notebooklm.google.com/upload/_/';

// System instructions are fetched from this GitHub Gist so they can be
// updated without releasing a new extension version.
var GIST_URL = 'https://gist.githubusercontent.com/adamamzar15/a52b9242d6f8663f38595e1921ed540e/raw/system-instruction';

// ── iLovePDF OCR API (disabled — uncomment to enable) ──────────────────────
// Used ONLY for PDFs where pdf.js extraction returns isScanned: true
// (garbled font encoding or empty text layer) to conserve API credits.
// var ILOVEPDF_PUBLIC_KEY = 'project_public_62aed7fd9f1c6bf24008417bfd924a40__JOik5a7bfd777119aaace8828465ab9aa8af';

// ── Extension behaviour ───────────────────────────────────────────────
// Root folder used for all downloads (matches the extension name shown in Chrome)
var DOWNLOAD_ROOT = 'GPO - Automatic Certificate Checker';

// Extension popup window dimensions (pixels)
var POPUP_WIDTH = 400;
var POPUP_HEIGHT = 520;

// Max files processed in parallel during a NotebookLM upload batch
var UPLOAD_BATCH_SIZE = 5;

// ── Remote error telemetry ────────────────────────────────────────────
// Google Apps Script Web App URL that receives error reports (see
// telemetry/apps_script.gs + telemetry/SETUP.md for how to deploy one).
// Leave blank to disable remote reporting — errors are still kept in the
// local ring buffer (chrome.storage.local key TELEMETRY_LOG_KEY) either way.
var TELEMETRY_ENDPOINT = 'https://script.google.com/a/macros/gamuda.com.my/s/AKfycby9k__kkKNqrdP2HoaIraPF0CFqzvns5odOGUOdk7tI9HdJUxr8898htQ6yA1bu4hiB/exec';

// Local ring-buffer settings (chrome.storage.local)
var TELEMETRY_LOG_KEY = 'debugLog';
var TELEMETRY_LOG_MAX = 50;
