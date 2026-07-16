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
 * Scans the canvas for continuous horizontal and vertical lines (box borders)
 * and paints them white. This prevents Tesseract from dropping text that is
 * enclosed inside graphical boxes.
 */
function removeBoxLines(ctx, width, height) {
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  
  // Consider pixel black/dark if all RGB values are < 150
  const isBlack = (idx) => data[idx] < 150 && data[idx+1] < 150 && data[idx+2] < 150;
  const setWhite = (idx) => { data[idx] = 255; data[idx+1] = 255; data[idx+2] = 255; };

  // A run of >200 dark pixels is a drawn line/border. (200px is ~0.6 inches, safe for fonts)
  const MIN_LINE_LENGTH = 200; 

  // 1. Erase horizontal lines
  for (let y = 0; y < height; y++) {
    let runStart = -1;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (isBlack(idx)) {
        if (runStart === -1) runStart = x;
      } else {
        if (runStart !== -1) {
          if (x - runStart >= MIN_LINE_LENGTH) {
            for (let k = runStart; k < x; k++) {
              setWhite((y * width + k) * 4);
            }
          }
          runStart = -1;
        }
      }
    }
    if (runStart !== -1 && width - runStart >= MIN_LINE_LENGTH) {
      for (let k = runStart; k < width; k++) {
        setWhite((y * width + k) * 4);
      }
    }
  }

  // 2. Erase vertical lines
  for (let x = 0; x < width; x++) {
    let runStart = -1;
    for (let y = 0; y < height; y++) {
      const idx = (y * width + x) * 4;
      if (isBlack(idx)) {
        if (runStart === -1) runStart = y;
      } else {
        if (runStart !== -1) {
          if (y - runStart >= MIN_LINE_LENGTH) {
            for (let k = runStart; k < y; k++) {
              setWhite((k * width + x) * 4);
            }
          }
          runStart = -1;
        }
      }
    }
    if (runStart !== -1 && height - runStart >= MIN_LINE_LENGTH) {
      for (let k = runStart; k < height; k++) {
        setWhite((k * width + x) * 4);
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

/**
 * Render the page, paint white rectangles over all native text, crop the remaining 
 * graphics (logos/signatures), and OCR only that cropped region.
 */
async function renderAndMaskPage(page, textContent, scheduler, filename, pageNum) {
  const baseViewport = page.getViewport({ scale: 1.0 });
  
  // Tesseract requires ~300 DPI for accurate OCR on small text.
  // Standard A4 in PDF points is 595px wide. 300 DPI means we need a canvas ~2500px wide.
  let scale = 2500 / baseViewport.width;
  // Clamp scale between 2.0 and 5.0 to prevent memory crashes on unusually large/small PDFs
  if (scale < 2.0) scale = 2.0;
  if (scale > 5.0) scale = 5.0;
  
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  // willReadFrequently optimizes getImageData performance
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // 1. Render the full page (images + text)
  const renderPromise = page.render({ canvasContext: ctx, viewport }).promise;
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('page.render() timed out after 60s')), 60000)
  );
  await Promise.race([renderPromise, timeoutPromise]);

  // 2. Mask out all native text with white rectangles
  ctx.fillStyle = 'white';
  for (const item of textContent.items) {
    if (!item.str || item.str.trim() === '') continue;

    // The baseline coordinates in PDF points
    const tx = item.transform[4];
    const ty = item.transform[5];
    
    // Convert to canvas coordinates
    const [canvasX, canvasY] = viewport.convertToViewportPoint(tx, ty);
    
    // transform[3] is the unscaled font height
    const pdfFontHeight = Math.abs(item.transform[3]);
    const fontHeight = pdfFontHeight * viewport.scale;
    const fontWidth = item.width * viewport.scale;
    
    ctx.fillRect(
      canvasX, 
      canvasY - fontHeight, 
      fontWidth, 
      fontHeight
    );
  }

  // 2.5 Image Processing: Erase drawn box borders so Tesseract doesn't get confused
  removeBoxLines(ctx, canvas.width, canvas.height);

  // 3. Find bounding box of remaining non-white pixels
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;
  let hasPixels = false;
  
  for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
          const idx = (y * canvas.width + x) * 4;
          const r = imgData[idx];
          const g = imgData[idx+1];
          const b = imgData[idx+2];
          
          // Check if NOT white (allow tolerance for JPEG artifacts/off-white backgrounds)
          if (r < 250 || g < 250 || b < 250) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
              hasPixels = true;
          }
      }
  }

  if (!hasPixels) {
    // Nothing left on page after erasing text! No OCR needed!
    return '';
  }

  // 4. Crop the canvas to the bounding box
  const pad = 20;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(canvas.width, maxX + pad);
  maxY = Math.min(canvas.height, maxY + pad);
  
  const cropW = maxX - minX;
  const cropH = maxY - minY;

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropW;
  cropCanvas.height = cropH;
  const cropCtx = cropCanvas.getContext('2d');
  cropCtx.drawImage(canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
  
  // Use lossless PNG instead of JPEG to prevent compression artifacts from ruining OCR!
  const dataUrl = cropCanvas.toDataURL('image/png');
  
  // Debug output: sends the exact masked crop to the side panel
  chrome.runtime.sendMessage({
    type: 'DEBUG_SAVE_IMAGE',
    dataUrl: dataUrl,
    filename: `test_${filename}_page_${pageNum}_masked_crop.png`
  }).catch(() => {});

  // 5. OCR the cropped image
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
  const pagePromises = [];

  _sendOcrStatus(`[Extract] ${filename}: Processing ${pdf.numPages} pages...`);

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);

      // ── Step 1: Native text extraction ──
      let nativeText = '';
      let textContent = null;
      try {
        _sendOcrStatus(`[Extract] ${filename}: Page ${pageNum}/${pdf.numPages} — extracting native text...`);
        textContent = await page.getTextContent();
        nativeText = textContentToString(textContent);
        
        // Extract text from fillable form fields (Widget annotations) which getTextContent ignores!
        try {
          const annotations = await page.getAnnotations();
          const formValues = annotations
            .filter(a => a.subtype === 'Widget' && a.fieldValue)
            .map(a => a.fieldValue)
            .join(' ');
          if (formValues) {
            nativeText += (nativeText ? ' ' : '') + formValues;
          }
        } catch(annoErr) {
          console.warn(`[Offscreen] Page ${pageNum} annotation extraction failed:`, annoErr?.message);
        }
      } catch (e) {
        console.warn(`[Offscreen] Page ${pageNum} native text failed:`, e?.message);
      }

      // ── Step 2: Render & Mask Image OCR ──
      const pNum = pageNum;
      const pNative = nativeText;
      const tc = textContent || { items: [] };

      pagePromises.push(
        renderAndMaskPage(page, tc, scheduler, filename, pNum)
          .then(imageOcrText => {
            _ocrPagesCompleted++;
            
            let combined = pNative;
            if (imageOcrText) {
                // Combine native text and the OCR'd logo text
                combined = pNative ? `${pNative}\n[Image OCR]:\n${imageOcrText}` : `[Image OCR]:\n${imageOcrText}`;
            }
            
            _sendOcrStatus(`[Extract] ${filename}: ${_ocrPagesCompleted}/${_ocrPagesTotal} pages complete.`);
            return { pageNum: pNum, text: combined };
          })
          .catch(err => {
             _ocrPagesCompleted++;
             console.warn(`[Offscreen] Page ${pNum} Render & Mask OCR failed:`, err?.message);
             // If image OCR fails, we STILL keep the perfect native text!
             const fallbackText = pNative ? `${pNative}\n[Image OCR Failed]` : `[Page ${pNum} Extraction Failed]`;
             return { pageNum: pNum, text: fallbackText };
          })
      );

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

  const finalPages = results.map(r => {
    const cleanedText = cleanExtractedText(r.text);
    return `--- Page ${r.pageNum} ---\n${cleanedText}`;
  });

  const finalCombinedText = finalPages.join('\n\n');

  _sendOcrStatus(`[Extract] ${filename}: All ${pdf.numPages} pages complete.`);

  return { text: finalCombinedText, isScanned: false, isPasswordProtected: false };
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
