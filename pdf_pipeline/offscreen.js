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

// ─── Tesseract Worker Pool ────────────────────────────────────────────────────
// Uses a pool of OCR_POOL_SIZE workers managed by Tesseract.createScheduler()
// so multiple pages can be OCR'd in parallel instead of one at a time.
const OCR_POOL_SIZE = 3;
let _tesseractScheduler = null;
let _tesseractSchedulerPromise = null;
let currentOcrFilename = '';
let _ocrPagesCompleted = 0;
let _ocrPagesTotal = 0;
let lastReportedStatus = '';

function _sendOcrStatus(text) {
  chrome.runtime.sendMessage({ type: 'status', text }).catch(() => {});
}

async function getTesseractScheduler() {
  if (_tesseractScheduler) return _tesseractScheduler;
  if (_tesseractSchedulerPromise) return _tesseractSchedulerPromise;

  _sendOcrStatus(`[OCR] Initializing Tesseract engine (${OCR_POOL_SIZE} workers)...`);

  _tesseractSchedulerPromise = (async () => {
    const scheduler = Tesseract.createScheduler();

    for (let i = 0; i < OCR_POOL_SIZE; i++) {
      _sendOcrStatus(`[OCR] Loading worker ${i + 1}/${OCR_POOL_SIZE}...`);
      const worker = await Tesseract.createWorker('eng', 1, {
        workerPath: chrome.runtime.getURL('pdf_pipeline/worker.min.js'),
        corePath: chrome.runtime.getURL('pdf_pipeline/tesseract-core.wasm.js'),
        langPath: chrome.runtime.getURL('tessdata'),
        workerBlobURL: false,
        logger: m => {
          // Report initialization phases only (per-page progress tracked separately)
          if (m.status && m.status !== 'recognizing text' && m.status !== lastReportedStatus) {
            lastReportedStatus = m.status;
            _sendOcrStatus(`[OCR] Worker ${i + 1}: ${m.status}...`);
          }
        }
      });
      scheduler.addWorker(worker);
      _sendOcrStatus(`[OCR] Worker ${i + 1}/${OCR_POOL_SIZE} ready.`);
    }

    return scheduler;
  })();

  try {
    _tesseractScheduler = await _tesseractSchedulerPromise;
    _sendOcrStatus(`[OCR] All ${OCR_POOL_SIZE} workers ready.`);
    return _tesseractScheduler;
  } catch (err) {
    _tesseractSchedulerPromise = null; // allow retry on next call
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

// ─── Hybrid extraction helpers ────────────────────────────────────────────────

/**
 * Convert pdf.js TextContent to a plain string with line breaks preserved.
 * Uses hasEOL when available (pdf.js 3.x+), falls back to simple join.
 */
function textContentToString(textContent) {
  let text = '';
  let hasEolSupport = false;
  for (const item of textContent.items) {
    if (item.str) text += item.str;
    if (item.hasEOL !== undefined) {
      hasEolSupport = true;
      if (item.hasEOL) text += '\n';
    }
  }
  // If hasEOL was never present (older pdf.js), add spaces between items
  if (!hasEolSupport) {
    text = textContent.items.map(i => i.str || '').join(' ');
  }
  return text.trim();
}

/**
 * Extract embedded image objects from a PDF page via the operator list.
 * Returns only images large enough to potentially contain text (≥ 30×30 px).
 * Falls back to empty array if the API is unavailable or fails.
 */
async function getPageImages(page) {
  if (!page.objs || typeof page.objs.get !== 'function') return [];

  const ops = await page.getOperatorList();
  const IMAGE_OPS = new Set([
    pdfjsLib.OPS.paintImageXObject,
    pdfjsLib.OPS.paintJpegXObject,
    pdfjsLib.OPS.paintImageXObjectRepeat,
  ]);

  // Collect unique image names referenced by paint operations
  const seenNames = new Set();
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (IMAGE_OPS.has(ops.fnArray[i])) {
      seenNames.add(ops.argsArray[i][0]);
    }
  }
  if (seenNames.size === 0) return [];

  // Load image data for each unique image
  const images = [];
  for (const imgName of seenNames) {
    try {
      const imgData = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 10000);
        page.objs.get(imgName, (data) => { clearTimeout(timeout); resolve(data); });
      });

      // Determine dimensions (handle ImageBitmap vs raw pixel data)
      let width, height;
      if (imgData instanceof ImageBitmap) {
        width = imgData.width; height = imgData.height;
      } else if (imgData?.bitmap instanceof ImageBitmap) {
        width = imgData.bitmap.width; height = imgData.bitmap.height;
      } else if (imgData?.width && imgData?.height) {
        width = imgData.width; height = imgData.height;
      } else {
        continue; // Unknown format, skip
      }

      // Skip tiny images (decorative borders, spacers, styling blocks)
      if (width < 30 || height < 30 || width * height < 2500) continue;

      images.push({ name: imgName, data: imgData, width, height });
    } catch (err) {
      console.warn(`[Offscreen] Couldn't load image ${imgName}:`, err?.message);
    }
  }
  return images;
}

/**
 * Paint a pdf.js image object onto a canvas for OCR.
 * Handles ImageBitmap (modern pdf.js) and raw pixel data (RGBA/RGB/1BPP).
 */
function paintImageToCanvas(imgData) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  // Handle ImageBitmap (modern pdf.js with OffscreenCanvas support)
  if (imgData instanceof ImageBitmap || imgData?.bitmap instanceof ImageBitmap) {
    const bmp = imgData instanceof ImageBitmap ? imgData : imgData.bitmap;
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    ctx.drawImage(bmp, 0, 0);
    return canvas;
  }

  // Handle raw pixel data
  const { width, height, data, kind } = imgData;
  if (!data || !width || !height) throw new Error('Invalid image data');

  canvas.width = width;
  canvas.height = height;
  const pixels = width * height;

  let rgba;
  if (kind === 3 || data.length === pixels * 4) {
    // RGBA_32BPP
    rgba = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);
  } else if (kind === 2 || data.length === pixels * 3) {
    // RGB_24BPP → RGBA
    rgba = new Uint8ClampedArray(pixels * 4);
    for (let s = 0, d = 0; s < data.length; s += 3, d += 4) {
      rgba[d] = data[s]; rgba[d+1] = data[s+1]; rgba[d+2] = data[s+2]; rgba[d+3] = 255;
    }
  } else if (kind === 1) {
    // GRAYSCALE_1BPP — each bit is a pixel (packed 8 per byte)
    rgba = new Uint8ClampedArray(pixels * 4);
    for (let i = 0; i < pixels; i++) {
      const v = ((data[i >> 3] >> (7 - (i & 7))) & 1) ? 0 : 255;
      rgba[i*4] = rgba[i*4+1] = rgba[i*4+2] = v; rgba[i*4+3] = 255;
    }
  } else if (data.length === pixels) {
    // Grayscale 8bpp
    rgba = new Uint8ClampedArray(pixels * 4);
    for (let i = 0; i < pixels; i++) {
      rgba[i*4] = rgba[i*4+1] = rgba[i*4+2] = data[i]; rgba[i*4+3] = 255;
    }
  } else {
    // Unknown format — best effort as RGBA
    rgba = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);
  }

  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

/**
 * Full-page OCR fallback — renders the entire page to canvas and OCRs it.
 * Used when image extraction fails for a page.
 */
async function _fullPageOcr(page, scheduler, filename, pageNum) {
  const baseViewport = page.getViewport({ scale: 1.0 });
  const scale = (baseViewport.width >= 1500 || baseViewport.height >= 2000) ? 1.0 : 1.5;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');

  const renderPromise = page.render({ canvasContext: ctx, viewport }).promise;
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('page.render() timed out after 60s')), 60000)
  );
  await Promise.race([renderPromise, timeoutPromise]);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  canvas.width = 0;
  canvas.height = 0;

  const result = await scheduler.addJob('recognize', dataUrl);
  return result.data.text.trim();
}

// ─── Main PDF extraction (Hybrid: native text + image-only OCR) ───────────────

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
  _ocrPagesCompleted = 0;
  _ocrPagesTotal = pdf.numPages;

  const scheduler = await getTesseractScheduler();

  // Each page becomes a Promise that resolves to { pageNum, text }.
  // Native text extraction is synchronous per page, but image OCR jobs are
  // submitted to the scheduler in parallel across all pages and workers.
  const pagePromises = [];

  _sendOcrStatus(`[Extract] ${filename}: Processing ${pdf.numPages} pages...`);

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);

      // ── Step 1: Native text extraction (instant, 100% accurate) ──
      let nativeText = '';
      try {
        _sendOcrStatus(`[Extract] ${filename}: Page ${pageNum}/${pdf.numPages} — extracting native text...`);
        const textContent = await page.getTextContent();
        nativeText = textContentToString(textContent);
      } catch (e) {
        console.warn(`[Offscreen] Page ${pageNum} native text failed:`, e?.message);
      }

      // ── Step 2: Detect and extract embedded images ──
      let imageOcrSucceeded = false;
      try {
        const images = await getPageImages(page);

        if (images.length === 0) {
          // Fast path — no images, native text only (zero OCR needed!)
          _ocrPagesCompleted++;
          _sendOcrStatus(`[Extract] ${filename}: Page ${pageNum} — text only (${nativeText.length} chars, no OCR).`);
          pagePromises.push(Promise.resolve({ pageNum, text: nativeText }));
          continue;
        }

        // ── Step 3: OCR each embedded image (not the full page!) ──
        _sendOcrStatus(`[OCR] ${filename}: Page ${pageNum} — ${images.length} image(s) detected, OCR-ing images only...`);

        const imageOcrJobs = [];
        for (const img of images) {
          try {
            const canvas = paintImageToCanvas(img.data);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            canvas.width = 0;
            canvas.height = 0;

            imageOcrJobs.push(
              scheduler.addJob('recognize', dataUrl)
                .then(r => r.data.text.trim())
                .catch(err => {
                  console.warn(`[Offscreen] Image OCR failed (${img.width}x${img.height}):`, err?.message);
                  return '';
                })
            );
          } catch (paintErr) {
            console.warn(`[Offscreen] Image paint failed (${img.width}x${img.height}):`, paintErr?.message);
          }
        }

        // Wrap all image OCR jobs for this page into a single promise
        const pNum = pageNum;
        const pNative = nativeText;
        pagePromises.push(
          Promise.all(imageOcrJobs).then(imageTexts => {
            _ocrPagesCompleted++;
            const imageOcrText = imageTexts.filter(t => t.length > 0).join('\n');
            const combined = imageOcrText ? `${pNative}\n${imageOcrText}` : pNative;
            _sendOcrStatus(`[Extract] ${filename}: ${_ocrPagesCompleted}/${_ocrPagesTotal} pages complete.`);
            return { pageNum: pNum, text: combined };
          })
        );
        imageOcrSucceeded = true;

      } catch (imgErr) {
        // Image extraction API failed — fall back to full-page OCR
        console.warn(`[Offscreen] Page ${pageNum} image extraction failed:`, imgErr?.message);
        _sendOcrStatus(`[OCR] ${filename}: Page ${pageNum} — image extraction unavailable, using full-page OCR...`);
      }

      // ── Fallback: full-page render + OCR if image extraction failed ──
      if (!imageOcrSucceeded) {
        const pNum = pageNum;
        pagePromises.push(
          _fullPageOcr(page, scheduler, filename, pageNum)
            .then(text => {
              _ocrPagesCompleted++;
              _sendOcrStatus(`[OCR] ${filename}: ${_ocrPagesCompleted}/${_ocrPagesTotal} pages complete (fallback).`);
              return { pageNum: pNum, text };
            })
            .catch(err => {
              _ocrPagesCompleted++;
              console.warn(`[Offscreen] Page ${pNum} full-page OCR failed:`, err?.message);
              return { pageNum: pNum, text: `[Page ${pNum} Extraction Failed]` };
            })
        );
      }

    } catch (pageErr) {
      _ocrPagesCompleted++;
      console.warn(`[Offscreen] Page ${pageNum} failed entirely:`, pageErr?.message);
      _sendOcrStatus(`[Extract] ${filename}: Page ${pageNum} FAILED: ${pageErr?.message}`);
      pagePromises.push(Promise.resolve({ pageNum, text: `[Page ${pageNum} Extraction Failed]` }));
    }
  }

  // Wait for all page results (image OCR jobs run in parallel across workers)
  const results = await Promise.all(pagePromises);

  // Sort by page number (results may complete out of order)
  results.sort((a, b) => a.pageNum - b.pageNum);

  const raw = results.map(r => r.text).join('\n\n');
  const cleaned = cleanExtractedText(raw);

  _sendOcrStatus(`[Extract] ${filename}: All ${pdf.numPages} pages complete.`);

  return { text: cleaned, isScanned: false, isPasswordProtected: false };
}

// ─── Image OCR extraction ────────────────────────────────────────────────────
async function extractImageText(uint8Array, mimeType, filename) {
  currentOcrFilename = filename || 'Image';
  _ocrPagesCompleted = 0;
  _ocrPagesTotal = 1;

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

    const scheduler = await getTesseractScheduler();
    const result = await scheduler.addJob('recognize', canvas);
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
