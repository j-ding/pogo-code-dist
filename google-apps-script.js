/**
 * Google Apps Script — paste this into your Google Sheet's Apps Script editor.
 *
 * Setup:
 *  1. Create a Google Sheet (tabs and headers are created automatically)
 *  2. Extensions > Apps Script, paste this code
 *  3. Deploy > New deployment > Web app > Execute as "Me", access "Anyone"
 *  4. Copy the URL into js/site-config.js
 *
 * Updating: paste the new code, then Deploy > Manage deployments > edit > Version: New version > Deploy.
 * Bump SCRIPT_VERSION whenever the site starts depending on a new action.
 */

var SCRIPT_VERSION = 3;

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var action = e.parameter.action;

  if (action === 'ping') {
    return jsonOut({ version: SCRIPT_VERSION });
  }

  if (action === 'addCodes') {
    var list;
    try {
      list = JSON.parse(e.parameter.codes || '[]');
    } catch (err) {
      return jsonOut({ error: 'Invalid codes JSON' });
    }
    return jsonOut(addCodes(list));
  }

  if (action === 'getLogs') {
    return getLogs();
  }

  if (action === 'getCodes') {
    return getCodesFromSheet();
  }

  if (action === 'getErrors') {
    return getErrors();
  }

  if (action === 'checkCooldown') {
    return checkCooldown(e.parameter.trainerName || '');
  }

  if (action === 'checkRedemption') {
    return checkRedemption(e.parameter.code || '', e.parameter.trainerName || '');
  }

  if (action === 'addCode') {
    return addCode({
      code: e.parameter.code || '',
      label: e.parameter.label || '',
      expiry: e.parameter.expiry || '',
      addedAt: e.parameter.addedAt || new Date().toISOString()
    });
  }

  if (action === 'updateCode') {
    return updateCode({
      code: e.parameter.code || '',
      active: e.parameter.active === 'true'
    });
  }

  if (action === 'removeCode') {
    return removeCodeFromSheet({ code: e.parameter.code || '' });
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

  if (data.action === 'updateCode') {
    return updateCode(data);
  }

  if (data.action === 'removeCode') {
    return removeCodeFromSheet(data);
  }

  if (data.action === 'logError') {
    return logError(data);
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
      'City', 'Country', 'Language', 'Screen Resolution', 'Referrer', 'Repeat', 'Device ID'
    ]);
  }

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.indexOf('Device ID') === -1) {
    sheet.getRange(1, headers.length + 1).setValue('Device ID');
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
    isRepeat ? 'Yes' : 'No',
    data.deviceId || ''
  ]);

  if (data.code) {
    deactivateCodeAfterRedeem(data.code);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ success: true, repeat: isRepeat }))
    .setMimeType(ContentService.MimeType.JSON);
}

function deactivateCodeAfterRedeem(code) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Codes');
  if (!sheet) return;

  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(code)) {
      sheet.getRange(i + 1, 5).setValue('No');
      return;
    }
  }
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

function getCodesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Codes') || ss.insertSheet('Codes');

  var expectedHeaders = ['Code', 'Label', 'Expiry', 'Added At', 'Active'];
  if (sheet.getLastColumn() === 0) {
    sheet.appendRow(expectedHeaders);
  } else {
    var headers = sheet.getRange(1, 1, 1, 5).getValues()[0];
    if (headers[0] !== 'Code' || headers[4] !== 'Active') {
      sheet.getRange(1, 1, 1, 5).setValues([expectedHeaders]);
    }
  }
  return sheet;
}

function addCodes(list) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getCodesSheet();
    var existing = {};
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      existing[String(rows[i][0]).trim().toUpperCase()] = true;
    }

    var newRows = [];
    for (var j = 0; j < list.length; j++) {
      var c = list[j];
      var code = String(c.code || '').trim().toUpperCase();
      if (!code || existing[code]) continue;
      existing[code] = true;
      newRows.push([
        code,
        c.label || '',
        c.expiry || '',
        c.addedAt || new Date().toISOString(),
        c.active === false ? 'No' : 'Yes'
      ]);
    }

    if (newRows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 5).setValues(newRows);
    }
    return { success: true, added: newRows.length, skipped: list.length - newRows.length };
  } finally {
    lock.releaseLock();
  }
}

function addCode(data) {
  return jsonOut(addCodes([data]));
}

function updateCode(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Codes');
  if (!sheet || !data.code) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: 'No sheet or code' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(data.code)) {
      if (typeof data.active !== 'undefined') {
        sheet.getRange(i + 1, 5).setValue(data.active ? 'Yes' : 'No');
      }
      return ContentService
        .createTextOutput(JSON.stringify({ success: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({ success: false, error: 'Code not found' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function removeCodeFromSheet(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Codes');
  if (!sheet || !data.code) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: 'No sheet or code' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(data.code)) {
      sheet.deleteRow(i + 1);
      return ContentService
        .createTextOutput(JSON.stringify({ success: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({ success: false, error: 'Code not found' }))
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
      repeat: data[i][11] === 'Yes',
      deviceId: data[i][12] || ''
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
      addedAt: data[i][3],
      active: data[i][4] !== 'No'
    });
  }

  return ContentService
    .createTextOutput(JSON.stringify({ codes: codes }))
    .setMimeType(ContentService.MimeType.JSON);
}

function logError(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('ErrorLog');

  if (!sheet) {
    sheet = ss.insertSheet('ErrorLog');
    sheet.appendRow(['Timestamp', 'Page', 'Error', 'Stack', 'User Agent', 'URL']);
  }

  sheet.appendRow([
    data.timestamp || new Date().toISOString(),
    data.page || '',
    data.error || '',
    data.stack || '',
    data.userAgent || '',
    data.url || ''
  ]);

  return ContentService
    .createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function checkRedemption(code, trainerName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('ScanLog');

  if (!sheet || !code || !trainerName) {
    return ContentService
      .createTextOutput(JSON.stringify({ redeemed: false }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1]) === String(code) &&
        String(data[i][2]).toLowerCase().trim() === trainerName.toLowerCase().trim()) {
      return ContentService
        .createTextOutput(JSON.stringify({ redeemed: true, timestamp: data[i][0] }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({ redeemed: false }))
    .setMimeType(ContentService.MimeType.JSON);
}

function checkCooldown(trainerName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('ScanLog');

  if (!sheet || !trainerName) {
    return ContentService
      .createTextOutput(JSON.stringify({ recentCodes: [], count: 0 }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var data = sheet.getDataRange().getValues();
  var now = new Date();
  var weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  var seen = {};
  var recentCodes = [];

  for (var i = 1; i < data.length; i++) {
    var rowTrainer = String(data[i][2]).toLowerCase().trim();
    if (rowTrainer !== trainerName.toLowerCase().trim()) continue;

    var rowTimestamp = new Date(data[i][0]);
    if (rowTimestamp < weekAgo) continue;

    var rowCode = String(data[i][1]);
    if (seen[rowCode]) continue;
    seen[rowCode] = true;

    recentCodes.push({ code: rowCode, timestamp: rowTimestamp.toISOString() });
  }

  recentCodes.sort(function(a, b) { return new Date(a.timestamp) - new Date(b.timestamp); });

  return ContentService
    .createTextOutput(JSON.stringify({ recentCodes: recentCodes, count: recentCodes.length }))
    .setMimeType(ContentService.MimeType.JSON);
}

function getErrors() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('ErrorLog');

  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({ errors: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var data = sheet.getDataRange().getValues();
  var errors = [];

  for (var i = data.length - 1; i >= 1; i--) {
    errors.push({
      timestamp: data[i][0],
      page: data[i][1],
      error: data[i][2],
      stack: data[i][3],
      userAgent: data[i][4],
      url: data[i][5]
    });
  }

  return ContentService
    .createTextOutput(JSON.stringify({ errors: errors }))
    .setMimeType(ContentService.MimeType.JSON);
}
