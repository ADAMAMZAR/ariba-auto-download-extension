// ============================================================
// constants.js — Single source of truth for all magic values
//
// Loaded in four contexts:
//   1. background/background.js (service worker) → via importScripts('../shared/constants.js')
//   2. notebooklm/notebooklm_kit.js (content script) → loaded first in manifest content_scripts
//   3. notebooklm/nlm_runner.js (MAIN world injection) → injected via files:[] before nlm_runner.js
//   4. content/content.js (Ariba tabs) → injected via scripting.executeScript files:[] in panel.js
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
//
// ⚠️  IMPORTANT: Always use GIST_API_URL for fetching content.
//     The raw URL (gist.githubusercontent.com) is CDN-cached and heavily
//     rate-limited. The Gist API always returns the latest revision with
//     no CDN layer and a much higher rate limit (60 req/hr unauthenticated).
var GIST_ID = '36c4a4e9da603de3c1bedfe76caf59f3';
var GIST_FILE = 'system_instruction';
var GIST_API_URL = `https://api.github.com/gists/${GIST_ID}`;

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
var TELEMETRY_ENDPOINT = 'https://script.google.com/a/macros/gamuda.com.my/s/AKfycbzIHR1S1_sYuS5RnFviPwflUa2uqd5UrLm9IL64g_NvjoKWtUAmC87-qinkUHuigMjj/exec';

// Local ring-buffer settings (chrome.storage.local)
var TELEMETRY_LOG_KEY = 'debugLog';
var TELEMETRY_LOG_MAX = 50;

// ── Supplier name sanitisation ────────────────────────────────────────────
// Applied in both content.js (supplier element / page title text) and
// background.js (cleanName). Centralised here so both contexts use identical
// rules and can never silently drift apart.
//
// Each entry is [RegExp, replacement]. Applied in order via Array.reduce
// in sanitiseSupplierName() (content.js) and cleanName() (background.js).
//
// ⚠️  NOTE: Quotes are stripped entirely (→ '') rather than replaced with
//     a dash, because a dash between every letter of "O'Brien" looks wrong
//     on disk. The PTY LTD negative-lookahead rule prevents swallowing a
//     trailing dot that is actually part of a file extension.
var SUPPLIER_CLEAN_RULES = [
  [/["']/g, ''],    // strip quotes entirely
  [/PTY LIMITED/gi, 'P/L'],
  [/PTY LTD\.(?!pdf|docx?|xlsx?|txt|jpe?g|png)/gi, 'P/L'], // PTY LTD. not before an extension
  [/PTY LTD/gi, 'P/L'],
  [/The trustee of\s+/gi, 'TOF '],
  [/The trustee for\s+/gi, 'TOF '],
  [/[\/\\?%*:|<>]/g, '-'],   // illegal filesystem chars → dash
  [/\.+$/, ''],    // Windows: no trailing periods
];
