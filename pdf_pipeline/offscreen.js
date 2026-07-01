/**
 * offscreen.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs inside the hidden Offscreen Document (a real page context with DOM).
 * Receives EXTRACT_PDF_TEXT messages from the service worker, extracts text
 * using pdf.js, applies the cleaning pipeline, and sends the result back.
 *
 * pdf.min.js (UMD build) is loaded BEFORE this script via offscreen.html,
 * so `window.pdfjsLib` is available as a global here.
 */

// ─── pdf.js setup ────────────────────────────────────────────────────────────
// Point the worker at the bundled worker file so pdf.js can parse off the
// main thread without us needing to create a Worker manually.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  chrome.runtime.getURL('pdf_pipeline/pdf.worker.min.js');

// ─── Cleaning pipeline (same 5 steps as pdf_text_extractor.py) ───────────────

function _normalizeUnicodeWhitespace(text) {
  return text.replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, ' ');
}

function _collapseHorizontalWhitespace(text) {
  return text.replace(/[ \t]+/g, ' ');
}

function _fixTrackingCodeZeros(text) {
  text = text.replaceAll('MOTNO', 'MOTN0');
  text = text.replaceAll('WBA1O', 'WBA10');
  text = text.replace(/\b(MOT[A-Z]{0,3})O\b/g,   (_, p) => p + '0');
  text = text.replace(/\b(WBA\d+)O\b/g,            (_, p) => p + '0');
  text = text.replace(/\b([A-Z]{2,5}\d{2,})O\b/g, (_, p) => p + '0');
  text = text.replace(/(\d+)O(\d+)/g, (_, a, b)  => a + '0' + b);
  return text;
}

const _LEGAL_SUFFIX_RE = new RegExp(
  '([\\w&\',\\.\\- ]+?)\\n[ \\t]*' +
  '((?:PTY\\.?\\s+LTD\\.?)|(?:SDN\\.?\\s+BHD\\.?)|(?:PTE\\.?\\s+LTD\\.?)' +
  '|LTD\\.?|INC\\.?|LLC\\.?|CORP\\.?|PLC\\.?|GmbH|B\\.V\\.|S\\.A\\.|S\\.L\\.)' +
  '(?=\\s*\\n|\\s*$)',
  'gim'
);

function _reconstituteLegalSuffixes(text) {
  let prev;
  do { prev = text; text = text.replace(_LEGAL_SUFFIX_RE, '$1 $2'); }
  while (text !== prev);
  return text;
}

function _normalizeLineBreaks(text) {
  return text.replace(/\n+/g, '\n');
}

function cleanExtractedText(raw) {
  let t = _normalizeUnicodeWhitespace(raw);
  t = _collapseHorizontalWhitespace(t);
  t = _fixTrackingCodeZeros(t);
  t = _reconstituteLegalSuffixes(t);
  t = _normalizeLineBreaks(t);
  return t.trim();
}

// ─── Core extraction ──────────────────────────────────────────────────────────

async function extractText(uint8Array) {
  let pdf;
  try {
    const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
    pdf = await loadingTask.promise;
  } catch (err) {
    if (err.name === 'PasswordException') {
      return { text: '', isScanned: false, isPasswordProtected: true };
    }
    throw err;
  }
  
  const rawPages = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    try {
      const page    = await pdf.getPage(pageNum);
      const content = await page.getTextContent();

      // Sort items top-to-bottom, left-to-right
      const sorted = [...content.items].sort((a, b) => {
        const dy = b.transform[5] - a.transform[5];
        if (Math.abs(dy) > 5) return dy;
        return a.transform[4] - b.transform[4];
      });

      // Group into lines by y-position proximity
      const lines = [];
      let currentLine = [], lastY = null;
      for (const item of sorted) {
        const y = item.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > 5) {
          if (currentLine.length) lines.push(currentLine.join(' '));
          currentLine = [];
        }
        if (item.str.trim()) currentLine.push(item.str.trim());
        lastY = y;
      }
      if (currentLine.length) lines.push(currentLine.join(' '));
      rawPages.push(lines.join('\n'));
    } catch (pageErr) {
      console.warn(`[Offscreen] Page ${pageNum} failed:`, pageErr?.message);
      rawPages.push('');
    }
  }

  const raw = rawPages.join('\n\n');
  if (!raw.trim()) return { text: '', isScanned: true };

  // ── Garbled-text guard 1: U+FFFD replacement characters ─────────────────
  // Some PDFs have fonts with no /ToUnicode map, so pdf.js emits U+FFFD
  // instead of real text.  >30 % replacement chars = unusable.
  const replacementCount = (raw.match(/\ufffd/g) || []).length;
  const replacementRatio = replacementCount / Math.max(raw.length, 1);
  if (replacementRatio > 0.3) {
    console.warn(
      `[Offscreen] Font encoding failure (U+FFFD) — ` +
      `${(replacementRatio * 100).toFixed(1)}% replacement chars. ` +
      `Flagging as isScanned.`
    );
    return { text: '', isScanned: true };
  }

  // ── Garbled-text guard 2: wrong-encoding symbol soup ─────────────────────
  // A different failure mode: the font has a custom /Encoding vector that maps
  // every glyph to the WRONG Unicode character (e.g. letters → punctuation).
  // pdf.js decodes without errors, but the output is almost entirely symbols
  // like `!  "#! !$!$  #  %  &  '  ()` with almost no real letters.
  // Legitimate insurance/workcover PDFs must be >15 % alphabetic characters.
  const nonWsChars = raw.replace(/\s/g, '');
  if (nonWsChars.length > 50) {
    const letterCount = (nonWsChars.match(/[a-zA-Z]/g) || []).length;
    const letterRatio = letterCount / nonWsChars.length;
    if (letterRatio < 0.15) {
      console.warn(
        `[Offscreen] Wrong font encoding detected — only ` +
        `${(letterRatio * 100).toFixed(1)}% alphabetic chars (expected >15%). ` +
        `Flagging as isScanned.`
      );
      return { text: '', isScanned: true };
    }
  }
  
  const cleaned = cleanExtractedText(raw);
  
  // Hybrid PDF Heuristic: If the average text per page is less than 500 characters,
  // we assume the document is primarily a scanned image (with only a digital letterhead/footer)
  if (cleaned.length < (500 * pdf.numPages)) {
    return { text: cleaned, isScanned: true };
  }
  
  return { text: cleaned, isScanned: false };
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'EXTRACT_PDF_TEXT') return false;

  // Reconstruct Uint8Array from the base64 string sent by the service worker
  const binary  = atob(msg.base64);
  const uint8   = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) uint8[i] = binary.charCodeAt(i);

  extractText(uint8)
    .then(({ text, isScanned, isPasswordProtected }) => sendResponse({ success: true, text, isScanned, isPasswordProtected }))
    .catch(err => sendResponse({ success: false, error: err?.message ?? String(err) }));

  return true; // keep message channel open for async response
});
