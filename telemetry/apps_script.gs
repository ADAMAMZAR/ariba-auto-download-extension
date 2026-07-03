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
  const sheet = getOrCreateSheet();
  const payload = JSON.parse(e.postData.contents);

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
