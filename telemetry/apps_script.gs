// ============================================================
// Telemetry sink & Gemini extraction webhook for GPO extension.
//
// Deploy this as a Google Apps Script Web App (see SETUP.md in this
// folder), then paste the resulting /exec URL into
// shared/constants.js → TELEMETRY_ENDPOINT.
//
// Every error/report the extension sends becomes one row in the bound
// Google Sheet — no server to run or maintain.
// ============================================================

const TELEMETRY_SHEET_NAME = 'Reports';
const DATA_SHEET_NAME = 'ExtractedData';

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    // Handle OCR & Gemini request
    if (payload.action === 'ocr') {
      let text = payload.text || '';
      if (!text && payload.fileBase64) {
        text = runDriveOcr(payload.fileBase64, payload.filename, payload.mimeType);
      }
      
      const extractionResult = writeToSheetAndGetGeminiResult(payload.filename, text);
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, text: text, extraction: extractionResult }))
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

function writeToSheetAndGetGeminiResult(filename, rawText) {
  const headers = [
    'Received At', 'Filename', 'Raw Text', 'Gemini JSON Output',
    'Supplier Name', 'Issuer Name', 'Year of Publication',
    'Certificate Number', 'Effective Date', 'Expiration Date', 'Amount'
  ];
  const sheet = getOrCreateSheet(DATA_SHEET_NAME, headers);
  const nextRow = sheet.getLastRow() + 1;

  // Append raw text in Row first (Cols 1, 2, 3)
  sheet.appendRow([
    new Date(),
    filename,
    rawText
  ]);

  // Prompt that extracts target fields as JSON
  const prompt = "Extract the following fields from the document text:\n" +
    "1. Supplier Name (insured, policyholder, or vendor).\n" +
    "2. Issuer Name (insurance company/broker or issuing authority).\n" +
    "3. Year of Publication (year document was published/issued).\n" +
    "4. Certificate Number (or policy number).\n" +
    "5. Effective Date (policy start date, format: DD/MM/YYYY).\n" +
    "6. Expiration Date (expiry date, format: DD/MM/YYYY).\n" +
    "7. Amount (indemnity/liability limit or insured amount, ONLY if certificate type is Public Indemnity / Public Liability for Australia. Else null).\n\n" +
    "Return strictly a JSON object with keys: supplierName, issuerName, yearOfPublication, certificateNumber, effectiveDate, expirationDate, amount.";

  // Write `=GEMINI(...)` formula in Column 4 (Col D)
  // Double quotes inside prompt are escaped for Excel-like formula syntax
  const escapedPrompt = prompt.replace(/"/g, '""');
  sheet.getRange(nextRow, 4).setFormula(`=GEMINI("${escapedPrompt} Text: " & C${nextRow})`);

  // Write `=GET_JSON_FIELD` formulas in Columns 5 to 11 (Col E to K)
  sheet.getRange(nextRow, 5).setFormula(`=GET_JSON_FIELD(D${nextRow}, "supplierName")`);
  sheet.getRange(nextRow, 6).setFormula(`=GET_JSON_FIELD(D${nextRow}, "issuerName")`);
  sheet.getRange(nextRow, 7).setFormula(`=GET_JSON_FIELD(D${nextRow}, "yearOfPublication")`);
  sheet.getRange(nextRow, 8).setFormula(`=GET_JSON_FIELD(D${nextRow}, "certificateNumber")`);
  sheet.getRange(nextRow, 9).setFormula(`=GET_JSON_FIELD(D${nextRow}, "effectiveDate")`);
  sheet.getRange(nextRow, 10).setFormula(`=GET_JSON_FIELD(D${nextRow}, "expirationDate")`);
  sheet.getRange(nextRow, 11).setFormula(`=GET_JSON_FIELD(D${nextRow}, "amount")`);

  SpreadsheetApp.flush();

  // Poll Column D to evaluate (up to 20 seconds)
  const startTime = new Date().getTime();
  const maxWaitTimeMs = 20000;
  let geminiResultStr = "";

  while (new Date().getTime() - startTime < maxWaitTimeMs) {
    Utilities.sleep(1000);
    SpreadsheetApp.flush();
    const cellValue = sheet.getRange(nextRow, 4).getValue();
    const cellStr = String(cellValue).trim();
    if (cellStr && !cellStr.startsWith('#') && !cellStr.toLowerCase().includes('loading')) {
      geminiResultStr = cellStr;
      break;
    }
  }

  if (!geminiResultStr) {
    return {
      supplierName: "Timed out / Pending in Sheet",
      issuerName: "Timed out",
      yearOfPublication: "",
      certificateNumber: "",
      effectiveDate: "",
      expirationDate: "",
      amount: ""
    };
  }

  try {
    // Attempt to clean JSON block format (```json ... ```) if Gemini returns it
    let cleanJson = geminiResultStr;
    const jsonStart = cleanJson.indexOf('{');
    const jsonEnd = cleanJson.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) {
      cleanJson = cleanJson.substring(jsonStart, jsonEnd + 1);
    }
    return JSON.parse(cleanJson);
  } catch (e) {
    return {
      supplierName: "Parsing Error",
      rawResult: geminiResultStr
    };
  }
}

// Custom Spreadsheet Function: Parses specific key from JSON string
function GET_JSON_FIELD(jsonStr, field) {
  if (!jsonStr) return "";
  try {
    // Clean codeblock markdown format if returned
    let cleanJson = String(jsonStr).trim();
    const jsonStart = cleanJson.indexOf('{');
    const jsonEnd = cleanJson.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) {
      cleanJson = cleanJson.substring(jsonStart, jsonEnd + 1);
    }
    const obj = JSON.parse(cleanJson);
    const val = obj[field];
    return val !== undefined && val !== null ? val : "";
  } catch (e) {
    return "";
  }
}

function getOrCreateSheet(sheetName, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}
