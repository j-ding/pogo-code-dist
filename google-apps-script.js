/**
 * Google Apps Script — paste this into your Google Sheet's Apps Script editor.
 *
 * Setup:
 *  1. Create a Google Sheet with two tabs named "Codes" and "ScanLog"
 *  2. In "Codes" row 1, add headers: Code | Label | Expiry | Added At
 *  3. In "ScanLog" row 1, add headers:
 *     Timestamp | Code | Trainer Name | Device | OS | Browser | City | Country | Language | Screen Resolution | Referrer | Repeat
 *  4. Extensions > Apps Script, paste this code
 *  5. Deploy > New deployment > Web app > "Anyone" access
 *  6. Copy the URL into your PoGo Code Dist settings
 */

function doGet(e) {
  var action = e.parameter.action;

  if (action === 'getLogs') {
    return getLogs();
  }

  if (action === 'getCodes') {
    return getCodesFromSheet();
  }

  return ContentService
    .createTextOutput(JSON.stringify({ error: 'Unknown action' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'Invalid JSON' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (data.action === 'logScan') {
    return logScan(data);
  }

  if (data.action === 'addCode') {
    return addCode(data);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ error: 'Unknown action' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function logScan(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('ScanLog');

  if (!sheet) {
    sheet = ss.insertSheet('ScanLog');
    sheet.appendRow([
      'Timestamp', 'Code', 'Trainer Name', 'Device', 'OS', 'Browser',
      'City', 'Country', 'Language', 'Screen Resolution', 'Referrer', 'Repeat'
    ]);
  }

  var isRepeat = checkRepeat(sheet, data.code, data.trainerName);

  sheet.appendRow([
    data.timestamp || new Date().toISOString(),
    data.code || '',
    data.trainerName || '',
    data.device || '',
    data.os || '',
    data.browser || '',
    data.city || '',
    data.country || '',
    data.language || '',
    data.screenResolution || '',
    data.referrer || '',
    isRepeat ? 'Yes' : 'No'
  ]);

  return ContentService
    .createTextOutput(JSON.stringify({ success: true, repeat: isRepeat }))
    .setMimeType(ContentService.MimeType.JSON);
}

function checkRepeat(sheet, code, trainerName) {
  if (!code || !trainerName) return false;

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === code && data[i][2] === trainerName) {
      return true;
    }
  }
  return false;
}

function addCode(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Codes');

  if (!sheet) {
    sheet = ss.insertSheet('Codes');
    sheet.appendRow(['Code', 'Label', 'Expiry', 'Added At']);
  }

  sheet.appendRow([
    data.code || '',
    data.label || '',
    data.expiry || '',
    data.addedAt || new Date().toISOString()
  ]);

  return ContentService
    .createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function getLogs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('ScanLog');

  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({ logs: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var logs = [];

  for (var i = data.length - 1; i >= 1; i--) {
    logs.push({
      timestamp: data[i][0],
      code: data[i][1],
      trainerName: data[i][2],
      device: data[i][3],
      os: data[i][4],
      browser: data[i][5],
      city: data[i][6],
      country: data[i][7],
      language: data[i][8],
      screenResolution: data[i][9],
      referrer: data[i][10],
      repeat: data[i][11] === 'Yes'
    });
  }

  return ContentService
    .createTextOutput(JSON.stringify({ logs: logs }))
    .setMimeType(ContentService.MimeType.JSON);
}

function getCodesFromSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Codes');

  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({ codes: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var data = sheet.getDataRange().getValues();
  var codes = [];

  for (var i = 1; i < data.length; i++) {
    codes.push({
      code: data[i][0],
      label: data[i][1],
      expiry: data[i][2],
      addedAt: data[i][3]
    });
  }

  return ContentService
    .createTextOutput(JSON.stringify({ codes: codes }))
    .setMimeType(ContentService.MimeType.JSON);
}
