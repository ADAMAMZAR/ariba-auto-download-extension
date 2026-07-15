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

// ─── Global Error Relay ──────────────────────────────────────────────────────
window.addEventListener('error', (event) => {
  chrome.runtime.sendMessage({
    type: 'status',
    text: `[Offscreen Error] ${event.message} at ${event.filename}:${event.lineno}`,
    error: true
  }).catch(() => {});
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason?.stack || event.reason?.message || String(event.reason);
  chrome.runtime.sendMessage({
    type: 'status',
    text: `[Offscreen Unhandled Promise] ${reason}`,
    error: true
  }).catch(() => {});
});
// ─── requestAnimationFrame polyfill ──────────────────────────────────────────
// Chrome NEVER fires requestAnimationFrame callbacks in offscreen documents
// because they are invisible (no compositor frame). pdf.js uses rAF internally
// for canvas rendering, which causes page.render() to hang forever.
// Override with setTimeout(cb, 0) so rendering proceeds immediately.
window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);

// ─── pdf.js setup ────────────────────────────────────────────────────────────
// Point the worker at the bundled worker file so pdf.js can parse off the
// main thread without us needing to create a Worker manually.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  chrome.runtime.getURL('pdf_pipeline/pdf.worker.min.js');

// ─── Cleaning pipeline (5 deterministic steps) ────────────────────────────────

function _normalizeUnicodeWhitespace(text) {
  return text.replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, ' ');
}

function _collapseHorizontalWhitespace(text) {
  return text.replace(/[ \t]+/g, ' ');
}

function _fixTrackingCodeZeros(text) {
  text = text.replaceAll('MOTNO', 'MOTN0');
  text = text.replaceAll('WBA1O', 'WBA10');
  text = text.replace(/\b(MOT[A-Z]{0,3})O\b/g, (_, p) => p + '0');
  text = text.replace(/\b(WBA\d+)O\b/g, (_, p) => p + '0');
  text = text.replace(/\b([A-Z]{2,5}\d{2,})O\b/g, (_, p) => p + '0');
  text = text.replace(/(\d+)O(\d+)/g, (_, a, b) => a + '0' + b);
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

// ─── Tesseract Worker helper ─────────────────────────────────────────────────
let _tesseractWorker = null;
let _tesseractWorkerPromise = null; // prevents race when multiple files init concurrently
let currentOcrFilename = '';
let currentOcrPage = 1;
let totalOcrPages = 1;
let lastReportedPercent = -1;
let lastReportedStatus = '';

function _sendOcrStatus(text) {
  chrome.runtime.sendMessage({ type: 'status', text }).catch(() => {});
}

async function getTesseractWorker() {
  if (_tesseractWorker) return _tesseractWorker;
  // If another caller is already creating the worker, wait for that same promise
  if (_tesseractWorkerPromise) return _tesseractWorkerPromise;

  _sendOcrStatus('[OCR] Initializing Tesseract engine...');

  _tesseractWorkerPromise = Tesseract.createWorker('eng', 1, {
    workerPath: chrome.runtime.getURL('pdf_pipeline/worker.min.js'),
    corePath: chrome.runtime.getURL('pdf_pipeline/tesseract-core.wasm.js'),
    langPath: chrome.runtime.getURL('tessdata'),
    workerBlobURL: false,
    logger: m => {
      // Report initialization phases (loading core, loading language data, etc.)
      if (m.status !== lastReportedStatus && m.status !== 'recognizing text') {
        lastReportedStatus = m.status;
        _sendOcrStatus(`[OCR] ${m.status}...`);
      }
      // Report recognition progress at 10% increments
      if (m.status === 'recognizing text') {
        const percent = Math.round(m.progress * 100);
        if (percent !== lastReportedPercent && percent % 10 === 0) {
          lastReportedPercent = percent;
          const pageStr = totalOcrPages > 1 ? ` (Page ${currentOcrPage}/${totalOcrPages})` : '';
          _sendOcrStatus(`[OCR] ${currentOcrFilename}${pageStr}: ${percent}%`);
        }
      }
    }
  });

  try {
    _tesseractWorker = await _tesseractWorkerPromise;
    _sendOcrStatus('[OCR] Tesseract engine ready.');
    return _tesseractWorker;
  } catch (err) {
    _tesseractWorkerPromise = null; // allow retry on next call
    _sendOcrStatus(`[OCR] Engine init FAILED: ${err.message}`);
    throw err;
  }
}

// ─── Core extraction ──────────────────────────────────────────────────────────

// Extraction queue — serializes all PDF/image OCR work so only one
// page.render() + worker.recognize() runs at a time. Prevents pdf.js
// concurrent-render deadlocks in the offscreen document.
let _extractionQueue = Promise.resolve();

function queueExtraction(fn) {
  const p = _extractionQueue.then(fn, fn); // run even if previous failed
  _extractionQueue = p.catch(() => {}); // swallow so queue doesn't break
  return p;
}

async function extractText(uint8Array, filename) {
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
  
  currentOcrFilename = filename || 'PDF';
  totalOcrPages = pdf.numPages;

  const rawPages = [];
  const worker = await getTesseractWorker();

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    currentOcrPage = pageNum;
    lastReportedPercent = -1;
    try {
      _sendOcrStatus(`[OCR] ${filename}: Loading page ${pageNum}/${pdf.numPages}...`);
      const page = await pdf.getPage(pageNum);
      
      // Render page to canvas at scale 1.5 for good OCR accuracy with less memory
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const context = canvas.getContext('2d');
      
      _sendOcrStatus(`[OCR] ${filename}: Rendering page ${pageNum} (${canvas.width}x${canvas.height})...`);
      
      // Timeout wrapper — pdf.js render can deadlock in some extension contexts
      const renderPromise = page.render({ canvasContext: context, viewport }).promise;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('page.render() timed out after 60s')), 60000)
      );
      await Promise.race([renderPromise, timeoutPromise]);

      _sendOcrStatus(`[OCR] ${filename}: Render complete. Starting OCR on page ${pageNum}...`);
      const dataUrl = canvas.toDataURL('image/png');
      const result = await worker.recognize(dataUrl);
      const pageText = result.data.text.trim();
      rawPages.push(pageText);
      _sendOcrStatus(`[OCR] ${filename}: Page ${pageNum} done (${pageText.length} chars).`);
    } catch (pageErr) {
      console.warn(`[Offscreen] Page ${pageNum} failed:`, pageErr?.message);
      _sendOcrStatus(`[OCR] ${filename}: Page ${pageNum} FAILED: ${pageErr?.message}`);
      rawPages.push(`[Page ${pageNum} OCR Failed]`);
    }
  }

  const raw = rawPages.join('\n\n');
  const cleaned = cleanExtractedText(raw);
  
  return { text: cleaned, isScanned: false, isPasswordProtected: false };
}

// ─── Image OCR extraction ────────────────────────────────────────────────────
async function extractImageText(uint8Array, mimeType, filename) {
  currentOcrFilename = filename || 'Image';
  totalOcrPages = 1;
  currentOcrPage = 1;
  lastReportedPercent = -1;

  const blob = new Blob([uint8Array], { type: mimeType });
  const url = URL.createObjectURL(blob);
  
  try {
    const img = new Image();
    img.src = url;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(img, 0, 0);

    const worker = await getTesseractWorker();
    const result = await worker.recognize(canvas);
    const ocrText = result.data.text.trim();
    const cleaned = cleanExtractedText(ocrText);
    
    return { text: cleaned };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'EXTRACT_PDF_TEXT') {
    const binary = atob(msg.base64);
    const uint8 = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) uint8[i] = binary.charCodeAt(i);

    // Queue so only one extraction runs at a time (prevents pdf.js render deadlocks)
    queueExtraction(() => extractText(uint8, msg.filename))
      .then(({ text, isScanned, isPasswordProtected }) => sendResponse({ success: true, text, isScanned, isPasswordProtected }))
      .catch(err => sendResponse({ success: false, error: err?.message ?? String(err) }));

    return true;
  }

  if (msg.type === 'EXTRACT_IMAGE_TEXT') {
    const binary = atob(msg.base64);
    const uint8 = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) uint8[i] = binary.charCodeAt(i);

    queueExtraction(() => extractImageText(uint8, msg.mimeType, msg.filename))
      .then(({ text }) => sendResponse({ success: true, text }))
      .catch(err => sendResponse({ success: false, error: err?.message ?? String(err) }));

    return true;
  }

  return false;
});
