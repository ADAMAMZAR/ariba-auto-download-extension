// ============================================================
// Telemetry sink for the GPO - Automatic Certificate Checker extension.
//
// Deploy this as a Google Apps Script Web App (see SETUP.md in this
// folder), then paste the resulting /exec URL into
// shared/constants.js → TELEMETRY_ENDPOINT.
//
// Every error/report the extension sends becomes one row in the bound
// Google Sheet — no server to run or maintain.
// ============================================================

const SHEET_NAME = 'Reports';

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    // Handle OCR request
    if (payload.action === 'ocr') {
      const text = runDriveOcr(payload.fileBase64, payload.filename, payload.mimeType);
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, text: text }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Default: Log telemetry to sheet
    const sheet = getOrCreateSheet();
    sheet.appendRow([
      new Date(),                          // when the sheet received it
      payload.ts || '',                    // client-side timestamp
      payload.type || '',                  // 'error' | 'fatal' | 'manual-report'
      payload.version || '',               // extension version
      payload.ua || '',                    // browser/OS user agent
      payload.supplier || '',
      payload.message || '',
      payload.note || '',
      payload.stack || '',
      payload.recentEvents ? JSON.stringify(payload.recentEvents) : '',
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message || String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function runDriveOcr(base64Data, filename, mimeType) {
  const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, filename);
  const resource = {
    title: 'Temp_OCR_' + filename,
    mimeType: MimeType.GOOGLE_DOCS
  };
  // Advanced Drive Service (v2) creates temporary document running OCR
  const tempFile = Drive.Files.insert(resource, blob, { ocr: true, ocrLanguage: 'en' });
  const doc = DocumentApp.openById(tempFile.id);
  const text = doc.getBody().getText();
  
  // Delete temporary doc
  Drive.Files.remove(tempFile.id);
  
  return text;
}

function getOrCreateSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow([
      'Received At', 'Client Timestamp', 'Type', 'Extension Version',
      'User Agent', 'Supplier', 'Message', 'Note', 'Stack', 'Recent Events (JSON)',
    ]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}
