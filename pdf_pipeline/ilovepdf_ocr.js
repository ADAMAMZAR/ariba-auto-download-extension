/**
 * ilovepdf_ocr.js
 * ─────────────────────────────────────────────────────────────────────────────
 * iLovePDF OCR API bridge for the GPO Automatic Certificate Checker extension.
 *
 * Called ONLY when pdf.js extraction returns isScanned: true (garbled or empty
 * text layer), so API credits are spent only on documents that truly need OCR.
 *
 * API flow (5 steps):
 *   1. POST https://api.ilovepdf.com/v1/auth          → JWT token
 *   2. GET  https://api.ilovepdf.com/v1/start/ocr     → { server, task }
 *   3. POST https://{server}/v1/upload                 → { server_filename }
 *   4. POST https://{server}/v1/process                → (OCR processing)
 *   5. GET  https://{server}/v1/download/{task}        → OCR'd PDF blob
 *
 * The returned blob is then fed back through the existing extractTextFromPdfBuffer()
 * pipeline so the OCR'd text goes through the same cleaning/validation path.
 *
 * Dependencies
 * ────────────
 *   ILOVEPDF_PUBLIC_KEY  — defined in shared/constants.js (loaded before this)
 */

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Send a PDF blob through iLovePDF OCR and return the OCR'd PDF as a new blob.
 *
 * @param {Blob}   pdfBlob  - The original PDF blob to OCR.
 * @param {string} filename - Original filename (used as the upload name).
 * @returns {Promise<Blob>} - OCR'd PDF blob with a searchable text layer.
 * @throws  {Error}         - If any API step fails (caller should handle).
 */
async function ocrPdfWithIlovePdf(pdfBlob, filename = 'document.pdf') {

  // ── Step 1: Authenticate — get a short-lived JWT ──────────────────────────
  const authResp = await fetch('https://api.ilovepdf.com/v1/auth', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ public_key: ILOVEPDF_PUBLIC_KEY }),
  });
  if (!authResp.ok) {
    throw new Error(`iLovePDF auth failed: HTTP ${authResp.status}`);
  }
  const { token } = await authResp.json();

  // ── Step 2: Start OCR task — get assigned server + task ID ───────────────
  const startResp = await fetch('https://api.ilovepdf.com/v1/start/ocr', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!startResp.ok) {
    throw new Error(`iLovePDF start task failed: HTTP ${startResp.status}`);
  }
  const { server, task } = await startResp.json();

  // ── Step 3: Upload PDF ────────────────────────────────────────────────────
  const formData = new FormData();
  formData.append('task', task);
  formData.append('file', pdfBlob, filename);

  const uploadResp = await fetch(`https://${server}/v1/upload`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body:    formData,
  });
  if (!uploadResp.ok) {
    throw new Error(`iLovePDF upload failed: HTTP ${uploadResp.status}`);
  }
  const { server_filename } = await uploadResp.json();

  // ── Step 4: Process — run OCR ─────────────────────────────────────────────
  // ocr_languages: ['eng'] covers Australian insurance / workcover documents.
  // The API returns a searchable PDF with an embedded text layer.
  const processResp = await fetch(`https://${server}/v1/process`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      task,
      tool:          'ocr',
      files:         [{ server_filename, filename }],
      ocr_languages: ['eng'],
    }),
  });
  if (!processResp.ok) {
    const body = await processResp.text().catch(() => '');
    throw new Error(`iLovePDF OCR process failed: HTTP ${processResp.status} — ${body}`);
  }

  // ── Step 5: Download OCR'd PDF ────────────────────────────────────────────
  const downloadResp = await fetch(`https://${server}/v1/download/${task}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!downloadResp.ok) {
    throw new Error(`iLovePDF download failed: HTTP ${downloadResp.status}`);
  }

  // Single-file tasks return the PDF directly (not zipped).
  return await downloadResp.blob();
}
