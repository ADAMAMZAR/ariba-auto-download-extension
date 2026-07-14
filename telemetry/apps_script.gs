// ============================================================
// Telemetry sink and Google Drive OCR webhook for GPO extension.
//
// Deploy this as a Google Apps Script Web App (see SETUP.md in this
// folder), then paste the resulting /exec URL into
// shared/constants.js → TELEMETRY_ENDPOINT.
//
// Every error/report the extension sends becomes one row in the bound
// Google Sheet — no server to run or maintain.
// ============================================================

const TELEMETRY_SHEET_NAME = 'Reports';

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    // Handle OCR request
    if (payload.action === 'ocr') {
      let text = payload.text || '';
      if (!text && payload.fileBase64) {
        text = runDriveOcr(payload.fileBase64, payload.filename, payload.mimeType);
      }
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, text: text }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Default: Log telemetry to sheet
    const sheet = getOrCreateSheet(TELEMETRY_SHEET_NAME, [
      'Received At', 'Client Timestamp', 'Type', 'Extension Version',
      'User Agent', 'Supplier', 'Message', 'Note', 'Stack', 'Recent Events (JSON)'
    ]);
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
  const boundary = '-------314159265358979323846';
  const delimiter = "\r\n--" + boundary + "\r\n";
  const close_delim = "\r\n--" + boundary + "--";

  const metadata = {
    name: 'Temp_OCR_' + filename,
    mimeType: 'application/vnd.google-apps.document'  // converting to Google Doc triggers OCR
  };

  const multipartRequestBody =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    'Content-Type: ' + mimeType + '\r\n' +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    base64Data +
    close_delim;

  // Upload the file to Google Drive using the REST API
  const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
  const response = UrlFetchApp.fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
      'Content-Type': 'multipart/related; boundary="' + boundary + '"'
    },
    payload: multipartRequestBody,
    muteHttpExceptions: true
  });

  const respCode = response.getResponseCode();
  const respText = response.getContentText();

  if (respCode !== 200) {
    throw new Error('Drive API Upload failed (' + respCode + '): ' + respText);
  }

  const fileInfo = JSON.parse(respText);
  const fileId = fileInfo.id;

  // Retrieve the OCR-ed text using Drive export
  const exportUrl = 'https://www.googleapis.com/drive/v3/files/' + fileId + '/export?mimeType=text%2Fplain';
  const docResponse = UrlFetchApp.fetch(exportUrl, {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + ScriptApp.getOAuthToken()
    },
    muteHttpExceptions: true
  });

  const docCode = docResponse.getResponseCode();
  const docText = docResponse.getContentText();

  // Delete the temporary file from Google Drive
  const deleteUrl = 'https://www.googleapis.com/drive/v3/files/' + fileId;
  UrlFetchApp.fetch(deleteUrl, {
    method: 'DELETE',
    headers: {
      'Authorization': 'Bearer ' + ScriptApp.getOAuthToken()
    },
    muteHttpExceptions: true
  });

  if (docCode !== 200) {
    throw new Error('Failed to retrieve OCR text (' + docCode + '): ' + docText);
  }

  return docText;
}

function getOrCreateSheet(sheetName, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    if (headers && headers.length > 0) {
      sheet.appendRow(headers);
    }
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Force Google Apps Script static analyzer to request Drive and UrlFetch OAuth scopes
function authorizeService() {
  DriveApp.getRootFolder();
  UrlFetchApp.fetch("https://www.google.com", { muteHttpExceptions: true });
  Logger.log("Authorization successful! You can now deploy the web app.");
}
