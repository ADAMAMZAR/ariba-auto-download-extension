/**
 * pdf_extractor.js  (service-worker side)
 * ─────────────────────────────────────────────────────────────────────────────
 * Loaded into the MV3 service worker via importScripts().
 * Does NOT use pdf.js directly — service workers have no DOM and cannot spawn
 * nested Workers, so pdf.js cannot run here.
 *
 * Instead this module manages a hidden Offscreen Document (Chrome 109+) and
 * delegates all PDF parsing to it via chrome.runtime.sendMessage.
 *
 * Public API (same surface as before — no changes needed in background.js):
 *   extractTextFromPdfBuffer(arrayBuffer) → Promise<{ text, isScanned }>
 *   textToDataUrl(text)                   → string
 */

// ─── Offscreen document lifecycle ────────────────────────────────────────────

const OFFSCREEN_URL = 'pdf_pipeline/offscreen.html';

// Concurrent callers (multiple PDFs extracted in parallel) must not race to
// create the offscreen document — Chrome allows only one per extension, and
// a second createDocument() call while one is in flight throws. All callers
// share this single in-flight promise instead of each doing their own
// check-then-create.
let _offscreenReadyPromise = null;

async function _ensureOffscreenDocument() {
  if (typeof chrome.offscreen === 'undefined') {
    throw new Error('This browser version does not support the Chrome Offscreen API (requires Chrome 109+).');
  }
  if (_offscreenReadyPromise) return _offscreenReadyPromise;

  _offscreenReadyPromise = (async () => {
    // Check whether the offscreen document is already open
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    if (existing.length > 0) return;

    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_URL),
      reasons: ['BLOBS'],
      justification: 'PDF text extraction with pdf.js (requires DOM and Worker API)'
    });
  })();

  try {
    await _offscreenReadyPromise;
  } catch (err) {
    _offscreenReadyPromise = null; // don't cache a failed attempt — allow retry
    throw err;
  }
}

// ─── Base64 helper (reuses same chunked approach as background.js) ────────────

function _arrayBufferToBase64(buffer) {
  const bytes  = new Uint8Array(buffer);
  const chunk  = 8192;
  let   binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract and clean text from a PDF ArrayBuffer.
 * Delegates to the Offscreen Document for actual pdf.js parsing.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<{ text: string, isScanned: boolean }>}
 */
async function extractTextFromPdfBuffer(arrayBuffer) {
  try {
    await _ensureOffscreenDocument();

    const base64 = _arrayBufferToBase64(arrayBuffer);

    const result = await chrome.runtime.sendMessage({
      type: 'EXTRACT_PDF_TEXT',
      base64
    });

    if (!result?.success) {
      throw new Error(result?.error ?? 'Unknown offscreen extraction error');
    }

    return { text: result.text, isScanned: result.isScanned, isPasswordProtected: result.isPasswordProtected };

  } catch (err) {
    console.error('[PDF Extractor] Offscreen extraction failed:', err?.message ?? err);
    return {
      text: `[VISUAL_EXTRACTION_BLOCKED]\n\nReason: ${err?.message ?? err}`,
      isScanned: true
    };
  }
}

/**
 * Encode a plain-text string as a data URL for chrome.downloads.download().
 *
 * @param {string} text
 * @returns {string}  data:text/plain;charset=utf-8;base64,…
 */
function textToDataUrl(text) {
  const bytes = new TextEncoder().encode(text);
  const chunk = 8192;
  let binary  = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return 'data:text/plain;charset=utf-8;base64,' + btoa(binary);
}
