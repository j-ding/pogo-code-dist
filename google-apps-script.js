/**
 * Google Apps Script — paste this into your Google Sheet's Apps Script editor.
 *
 * Setup:
 *  1. Create a Google Sheet (tabs and headers are created automatically)
 *  2. Extensions > Apps Script, paste this code
 *  3. Deploy > New deployment > Web app > Execute as "Me", access "Anyone"
 *  4. Copy the URL into js/site-config.js
 *
 *  5. Project Settings (gear icon) > Script properties > add ADMIN_USERNAME and ADMIN_PASSWORD.
 *     These are the dashboard login and never leave Google.
 *  6. Optional backups: pick setupWeeklyBackup in the function dropdown and click Run once.
 *
 * Updating: paste the new code, then Deploy > Manage deployments > edit > Version: New version > Deploy.
 * Bump SCRIPT_VERSION whenever the site starts depending on a new action.
 */

var SCRIPT_VERSION = 21;

// Everything else requires an admin token from login().
var PUBLIC_ACTIONS = ['ping', 'login', 'getEvent', 'checkIn', 'getLottery', 'joinLottery', 'checkCooldown', 'checkRedemption', 'logScan'];

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorResponse(err) {
  var message = String((err && err.message) || err);
  if (/lock/i.test(message)) {
    return { error: 'The server is busy. Please try again in a moment.', busy: true };
  }
  return { error: message };
}

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    if (PUBLIC_ACTIONS.indexOf(params.action) === -1 && !isAuthorized(params.t)) {
      return jsonOut({ error: 'Unauthorized', unauthorized: true });
    }
    return handleGet(e);
  } catch (err) {
    return jsonOut(errorResponse(err));
  }
}

// ---------- Admin auth ----------

function scriptProperty(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function sessionSecret() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SESSION_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SESSION_SECRET', secret);
  }
  return secret;
}

function signValue(value) {
  var bytes = Utilities.computeHmacSha256Signature(String(value), sessionSecret());
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function safeEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Token = expiry timestamp + HMAC of it. Deleting the SESSION_SECRET script property logs everyone out.
function isAuthorized(token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 2) return false;
  var expires = Number(parts[0]);
  if (!expires || expires < Date.now()) return false;
  return safeEqual(parts[1], signValue(parts[0]));
}

function login(username, password, remember) {
  var expectedPassword = scriptProperty('ADMIN_PASSWORD');
  if (!expectedPassword) {
    return { error: 'Admin login is not set up. In Apps Script, open Project Settings > Script properties and add ADMIN_USERNAME and ADMIN_PASSWORD.' };
  }
  var expectedUser = scriptProperty('ADMIN_USERNAME') || 'admin';

  var cache = CacheService.getScriptCache();
  var failures = Number(cache.get('login_failures') || 0);
  if (failures >= 10) return { error: 'Too many failed logins. Try again in 10 minutes.' };

  if (!safeEqual(username, expectedUser) || !safeEqual(password, expectedPassword)) {
    cache.put('login_failures', String(failures + 1), 600);
    return { error: 'Invalid username or password' };
  }
  cache.remove('login_failures');

  var expires = Date.now() + (remember ? 30 : 1) * 24 * 60 * 60 * 1000;
  return { success: true, token: expires + '.' + signValue(expires), expires: expires };
}

function handleGet(e) {
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
    return jsonOut(addCodes(list, e.parameter.source === 'sync'));
  }

  var p = e.parameter;

  if (action === 'login') {
    return jsonOut(login(p.username || '', p.password || '', p.remember === 'true'));
  }

  if (action === 'logScan') {
    return logScan(p);
  }

  if (action === 'getCodeStatus') {
    return jsonOut(getCodeStatus(p.code || ''));
  }

  if (action === 'setGroupEnabled') {
    return jsonOut(setGroupEnabled(p.group || '', p.enabled === 'true'));
  }

  if (action === 'setGroupsEvent') {
    var groupList = [];
    try { groupList = JSON.parse(p.groups || '[]'); } catch (err) {}
    return jsonOut(setGroupsEvent(groupList, p.eventId || ''));
  }

  if (action === 'renameGroup') {
    return jsonOut(renameGroup(p.oldName || '', p.newName || ''));
  }

  if (action === 'deleteGroup') {
    return jsonOut(deleteGroup(p.group || ''));
  }

  if (action === 'setCodeGroup') {
    return jsonOut(setCodeGroup(p.code || '', p.group || ''));
  }

  if (action === 'getTrainerHistory') {
    return jsonOut({ trainers: getTrainerHistory() });
  }

  if (action === 'listCampfire') {
    return jsonOut(listCampfire());
  }

  if (action === 'getCampfire') {
    return jsonOut(getCampfire(p.id || ''));
  }

  if (action === 'deleteCampfire') {
    return jsonOut(deleteCampfire(p.id || ''));
  }

  if (action === 'setLotteryRules') {
    return jsonOut(setLotteryRules(p.id || '', p.excludeRecentEvents || '0', p.excludeLotteryIds || '[]'));
  }

  if (action === 'getEvents') {
    return jsonOut({ events: getEventsWithCounts() });
  }

  if (action === 'getEvent') {
    var foundEvent = findEvent(p.id || '');
    return jsonOut({ event: foundEvent ? { name: foundEvent.event.name, open: foundEvent.event.open } : null });
  }

  if (action === 'createEvent') {
    return jsonOut(createEvent(p.name || '', p.date || ''));
  }

  if (action === 'setEventStatus') {
    return jsonOut(setEventStatus(p.id || '', p.open === 'true'));
  }

  if (action === 'deleteEvent') {
    return jsonOut(deleteEvent(p.id || ''));
  }

  if (action === 'getEventAttendees') {
    var attendeeEvent = findEvent(p.id || '');
    if (!attendeeEvent) return jsonOut({ error: 'Event not found' });
    return jsonOut({ attendees: withRedeemedCodes(attendeeEvent.event, eventAttendees(p.id)) });
  }

  if (action === 'removeAttendee') {
    return jsonOut(removeAttendee(p.id || '', p.trainerName || ''));
  }

  if (action === 'checkIn') {
    return jsonOut(checkIn(p.id || '', p.trainerName || '', p.deviceId || ''));
  }

  if (action === 'createLottery') {
    return jsonOut(createLottery(p.name || '', p.eventId || ''));
  }

  if (action === 'getLotteries') {
    var cfIndex = null;
    return jsonOut({ lotteries: readLotteries().map(function(r) {
      // Campfire-based lotteries carry their source's name, since the site doesn't load every upload.
      if (isCampfireSource(r.lottery.eventId)) {
        cfIndex = cfIndex || campfireIndex();
        var source = resolveLotterySource(r.lottery.eventId, cfIndex);
        r.lottery.sourceName = source ? source.name : '';
      }
      return r.lottery;
    }) });
  }

  if (action === 'getLotterySources') {
    return jsonOut(campfireLotterySources());
  }

  if (action === 'getLottery') {
    var found = findLottery(p.id || '');
    return jsonOut({ lottery: found ? { name: found.lottery.name, open: found.lottery.open } : null });
  }

  if (action === 'setLotteryStatus') {
    return jsonOut(setLotteryStatus(p.id || '', p.open === 'true'));
  }

  if (action === 'recordWinner') {
    return jsonOut(recordWinner(p.id || '', p.trainerName || ''));
  }

  if (action === 'setWinnerCount') {
    return jsonOut(setWinnerCount(p.id || '', p.count || ''));
  }

  if (action === 'updateLottery') {
    return jsonOut(updateLottery(p.id || '', p.name || '', p.eventId || ''));
  }

  if (action === 'deleteLottery') {
    return jsonOut(deleteLottery(p.id || ''));
  }

  if (action === 'renameEntrant') {
    return jsonOut(renameEntrant(p.id || '', p.oldName || '', p.newName || ''));
  }

  if (action === 'removeEntrant') {
    return jsonOut(removeEntrant(p.id || '', p.trainerName || ''));
  }

  if (action === 'skipWinner') {
    return jsonOut(skipWinner(p.id || '', p.trainerName || ''));
  }

  if (action === 'unskipEntrant') {
    return jsonOut(unskipEntrant(p.id || '', p.trainerName || ''));
  }

  if (action === 'unmarkWinner') {
    return jsonOut(unmarkWinner(p.id || '', p.trainerName || ''));
  }

  if (action === 'joinLottery') {
    return jsonOut(joinLottery(p.id || '', p.trainerName || '', p.deviceId || ''));
  }

  if (action === 'getLotteryEntrants') {
    return jsonOut(getLotteryEntrants(p.id || ''));
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

// POST is only used by navigator.sendBeacon from public pages, so it only accepts the two logging actions.
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (data.action === 'logScan') return logScan(data);
    if (data.action === 'logError') return logError(data);
    // Campfire uploads are too large for a GET URL, so they're the one admin action sent by POST.
    if (data.action === 'uploadCampfire') {
      if (!isAuthorized(data.t)) return jsonOut({ error: 'Unauthorized', unauthorized: true });
      return jsonOut(uploadCampfire(data.name || '', data.json || ''));
    }
    return jsonOut({ error: 'Unknown action' });
  } catch (err) {
    return jsonOut(errorResponse(err));
  }
}

// ---------- Campfire exports ----------
// CampfireExports tab: Id | File Name | Uploaded At | Exported At | Events | People | Data...
// Sheets cap a cell at 50,000 characters, so the JSON is split across as many Data columns as it needs.

var CAMPFIRE_CHUNK = 45000;
var CAMPFIRE_DATA_COL = 7;

function campfireSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('CampfireExports');
  if (!sheet) {
    sheet = ss.insertSheet('CampfireExports');
    sheet.appendRow(['Id', 'File Name', 'Uploaded At', 'Exported At', 'Events', 'People', 'Data']);
  }
  return sheet;
}

function uploadCampfire(name, json) {
  var parsed;
  try { parsed = JSON.parse(json); } catch (err) { return { error: 'That file isn\'t valid JSON.' }; }
  if (!parsed || !Array.isArray(parsed.events) || !Array.isArray(parsed.people)) {
    return { error: 'That doesn\'t look like a Campfire export (no events or people list).' };
  }
  var compact = JSON.stringify(parsed);
  var parts = [];
  for (var i = 0; i < compact.length; i += CAMPFIRE_CHUNK) parts.push(compact.slice(i, i + CAMPFIRE_CHUNK));

  return withLock(function() {
    var sheet = campfireSheet();
    var id = Utilities.getUuid().split('-')[0];
    var row = [id, String(name).slice(0, 120), new Date().toISOString(), parsed.exportedAt || '',
      parsed.events.length, parsed.people.length].concat(parts);
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
    return { success: true, export: campfireSummary(row) };
  });
}

function campfireSummary(row) {
  return {
    id: String(row[0]), name: String(row[1]), uploadedAt: toIso(row[2]), exportedAt: toIso(row[3]) || String(row[3] || ''),
    events: Number(row[4]) || 0, people: Number(row[5]) || 0
  };
}

function listCampfire() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('CampfireExports');
  if (!sheet || sheet.getLastRow() < 2) return { exports: [] };
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
  var list = rows.filter(function(r) { return r[0]; }).map(campfireSummary);
  list.sort(function(a, b) { return a.uploadedAt < b.uploadedAt ? 1 : -1; });
  return { exports: list };
}

function getCampfire(id) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('CampfireExports');
  if (!sheet || sheet.getLastRow() < 2) return { error: 'Export not found' };
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== String(id)) continue;
    var json = rows[i].slice(CAMPFIRE_DATA_COL - 1).join('');
    return { export: campfireSummary(rows[i]), data: JSON.parse(json) };
  }
  return { error: 'Export not found' };
}

// Every upload, newest first, with its parsed JSON. Unreadable uploads are skipped.
function readCampfireExports() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('CampfireExports');
  if (!sheet || sheet.getLastRow() < 2) return [];
  var list = [];
  sheet.getDataRange().getValues().slice(1).forEach(function(row) {
    if (!row[0]) return;
    try {
      var data = JSON.parse(row.slice(CAMPFIRE_DATA_COL - 1).join(''));
      if (data && Array.isArray(data.events)) list.push({ summary: campfireSummary(row), data: data });
    } catch (err) {}
  });
  list.sort(function(a, b) { return a.summary.uploadedAt < b.summary.uploadedAt ? 1 : -1; });
  return list;
}

// Meetups by Campfire's own event id (the newest upload of a meetup wins, so re-sending one from the
// phone updates lotteries that use it), plus uploads by id.
function campfireIndex(exports) {
  var index = { meetups: {}, uploads: {} };
  (exports || readCampfireExports()).forEach(function(x) {
    index.uploads[x.summary.id] = x;
    x.data.events.forEach(function(ev) {
      if (ev && ev.id && !index.meetups[ev.id]) index.meetups[ev.id] = { event: ev, upload: x.summary };
    });
  });
  return index;
}

function checkedInNames(ev) {
  return (ev.attendees || []).filter(function(a) { return a.status === 'CHECKED_IN' && a.name; })
    .map(function(a) { return String(a.name).trim(); });
}

function isCampfireSource(id) {
  return /^cfx?:/.test(String(id || ''));
}

// A lottery's entrant source: "cf:<meetup id>", "cfx:<upload id>", or one of our event ids.
// Returns { name, date, campfireNames } (campfireNames only for Campfire sources), or null if it's gone.
function resolveLotterySource(id, index) {
  id = String(id || '');
  if (id.indexOf('cf:') === 0) {
    var meetup = (index || campfireIndex()).meetups[id.slice(3)];
    if (!meetup) return null;
    return { name: meetup.event.name || 'Campfire meetup', date: meetup.event.startTime || meetup.upload.uploadedAt, campfireNames: checkedInNames(meetup.event) };
  }
  if (id.indexOf('cfx:') === 0) {
    var upload = (index || campfireIndex()).uploads[id.slice(4)];
    if (!upload) return null;
    var names = [];
    var latest = '';
    upload.data.events.forEach(function(ev) {
      names = names.concat(checkedInNames(ev));
      if (ev.startTime && ev.startTime > latest) latest = ev.startTime;
    });
    return { name: upload.summary.name, date: latest || upload.summary.uploadedAt, campfireNames: names };
  }
  var ev = findEvent(id);
  return ev ? { name: ev.event.name, date: ev.event.date } : null;
}

function campfireLotterySources() {
  var index = campfireIndex();
  var meetups = Object.keys(index.meetups).map(function(id) {
    var m = index.meetups[id];
    var people = {};
    checkedInNames(m.event).forEach(function(n) { people[trainerKey(n)] = true; });
    return { id: 'cf:' + id, name: m.event.name || 'Campfire meetup', date: m.event.startTime || '', checkedIn: Object.keys(people).length };
  });
  meetups.sort(function(a, b) { return a.date < b.date ? 1 : -1; });
  // A single-meetup upload is already offered as that meetup.
  var uploads = Object.keys(index.uploads).map(function(id) { return index.uploads[id]; })
    .filter(function(x) { return x.data.events.length > 1; })
    .map(function(x) {
      var source = resolveLotterySource('cfx:' + x.summary.id, index);
      var people = {};
      source.campfireNames.forEach(function(n) { people[trainerKey(n)] = true; });
      return { id: 'cfx:' + x.summary.id, name: x.summary.name, date: source.date, meetups: x.data.events.length, checkedIn: Object.keys(people).length };
    });
  return { meetups: meetups, uploads: uploads };
}

function deleteCampfire(id) {
  return withLock(function() {
    // Like events, an upload a lottery draws from can't be deleted, unless a newer upload of the same
    // meetup still covers it (re-sending a meetup from the phone replaces the old copy this way).
    var exports = readCampfireExports();
    var now = campfireIndex(exports);
    var without = campfireIndex(exports.filter(function(x) { return x.summary.id !== String(id); }));
    var usedBy = readLotteries().filter(function(r) {
      var source = r.lottery.eventId;
      return isCampfireSource(source) && resolveLotterySource(source, now) && !resolveLotterySource(source, without);
    });
    if (usedBy.length) {
      return { error: 'Lottery "' + usedBy[0].lottery.name + '" uses this upload. Delete it or switch it to another event first.' };
    }
    var removed = deleteRowsWhere(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('CampfireExports'), function(r) {
      return String(r[0]) === String(id);
    });
    return removed ? { success: true } : { error: 'Export not found' };
  });
}

function logScan(data) {
  return withLock(function() { return logScanLocked(data); });
}

function logScanLocked(data) {
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
    sheet.getRange(1, 13).setValue('Device ID');
  }
  if (headers.indexOf('Scan ID') === -1) {
    sheet.getRange(1, 14).setValue('Scan ID');
  }
  if (headers.indexOf('Group') === -1) {
    sheet.getRange(1, 15).setValue('Group');
    backfillScanGroups(sheet);
  }

  // The redeem page retries over sendBeacon if the confirmed request times out, so drop repeats.
  if (data.scanId) {
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      var start = Math.max(2, lastRow - 299);
      var recentIds = sheet.getRange(start, 14, lastRow - start + 1, 1).getValues();
      for (var r = 0; r < recentIds.length; r++) {
        if (String(recentIds[r][0]) === String(data.scanId)) return jsonOut({ success: true, duplicate: true });
      }
    }
  }

  var isRepeat = checkRepeat(sheet, data.code, data.trainerName);
  var codeInfo = data.code ? findCodeRow(data.code) : null;

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
    data.deviceId || '',
    data.scanId || '',
    codeInfo ? codeInfo.group : ''
  ]);

  // Only real codes have side effects, so a forged logScan can't check people in.
  var knownCode = codeInfo ? deactivateCodeAfterRedeem(data.code) : false;
  if (knownCode && data.trainerName) {
    addRedeemerToOpenEvents(data.trainerName, data.timestamp || new Date().toISOString(), data.deviceId || '', codeInfo.group);
  }

  return jsonOut({ success: true, repeat: isRepeat });
}

// ---------- Code groups ----------
// A code's group is its Label. Groups tab: Group | Enabled | Event ID. Pausing a group is separate from a
// code being used, so re-enabling a group never brings back codes that were already redeemed.
// Event ID ties a group to one event: its redemptions check people into that event only, and that
// event only takes redemptions from its tied groups. Untied groups fall back to matching by date.

function getGroupsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Groups');
  if (!sheet) {
    sheet = ss.insertSheet('Groups');
    sheet.appendRow(['Group', 'Enabled', 'Event ID']);
  } else if (sheet.getLastColumn() < 3) {
    sheet.getRange(1, 3).setValue('Event ID');
  }
  return sheet;
}

function readGroups() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Groups');
  if (!sheet) return [];
  return sheet.getDataRange().getValues().slice(1).map(function(row, i) {
    return { row: i + 2, name: String(row[0] || '').trim(), enabled: row[1] !== 'No', eventId: String(row[2] || '').trim() };
  });
}

function groupsResponse() {
  var names = {};
  readEvents().forEach(function(r) { names[r.event.id] = r.event.name; });
  return readGroups().map(function(g) {
    var tied = g.eventId && names[g.eventId] !== undefined;
    return { name: g.name, enabled: g.enabled, eventId: tied ? g.eventId : '', eventName: tied ? names[g.eventId] : '' };
  });
}

// eventId '' unties the groups so their redemptions go back to matching events by date.
function setGroupsEvent(groups, eventId) {
  eventId = String(eventId || '').trim();
  var names = (groups || []).map(function(g) { return String(g).trim(); });
  return withLock(function() {
    if (eventId && !findEvent(eventId)) return { error: 'Event not found' };
    var sheet = getGroupsSheet();
    var existing = readGroups();
    names.forEach(function(name) {
      var row = existing.filter(function(g) { return g.name === name; })[0];
      if (row) sheet.getRange(row.row, 3).setValue(eventId);
      else if (eventId) sheet.appendRow([name, 'Yes', eventId]);
    });
    return { success: true, groups: groupsResponse() };
  });
}

// { groupName: eventId } for groups tied to an event that still exists.
function groupEventMap() {
  var ids = {};
  readEvents().forEach(function(r) { ids[r.event.id] = true; });
  var map = {};
  readGroups().forEach(function(g) { if (g.eventId && ids[g.eventId]) map[g.name] = g.eventId; });
  return map;
}

function setGroupEnabled(group, enabled) {
  group = String(group).trim();
  return withLock(function() {
    var sheet = getGroupsSheet();
    var existing = readGroups().filter(function(g) { return g.name === group; })[0];
    if (existing) sheet.getRange(existing.row, 2).setValue(enabled ? 'Yes' : 'No');
    else sheet.appendRow([group, enabled ? 'Yes' : 'No']);
    return { success: true, groups: groupsResponse() };
  });
}

function renameGroup(oldName, newName) {
  oldName = String(oldName).trim();
  newName = String(newName).trim().slice(0, 60);
  if (!newName) return { error: 'Group name is required' };

  return withLock(function() {
    var codes = getCodesSheet();
    var renamed = 0;
    if (codes.getLastRow() > 1) {
      var labels = codes.getRange(2, 2, codes.getLastRow() - 1, 1).getValues();
      for (var i = 0; i < labels.length; i++) {
        if (String(labels[i][0] || '').trim() === oldName) {
          codes.getRange(i + 2, 2).setValue(newName);
          renamed++;
        }
      }
    }
    var groups = readGroups();
    var from = groups.filter(function(g) { return g.name === oldName; })[0];
    var into = groups.filter(function(g) { return g.name === newName; })[0];
    if (from && into) getGroupsSheet().deleteRow(from.row);
    else if (from) getGroupsSheet().getRange(from.row, 1).setValue(newName);
    return { success: true, renamed: renamed, groups: groupsResponse() };
  });
}

// Deletes every code in the group (used or not) plus its Groups row. ScanLog history is left alone.
function deleteGroup(group) {
  group = String(group).trim();
  return withLock(function() {
    var deletedCodes = [];
    var removed = deleteRowsWhere(getCodesSheet(), function(row) {
      var match = String(row[1] || '').trim() === group;
      if (match) deletedCodes.push(row[0]);
      return match;
    });
    recordDeletedCodes(deletedCodes);
    var groupsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Groups');
    deleteRowsWhere(groupsSheet, function(row) { return String(row[0] || '').trim() === group; });
    return { success: true, removed: removed, groups: groupsResponse() };
  });
}

function setCodeGroup(code, group) {
  var target = String(code).trim().toUpperCase();
  group = String(group).trim().slice(0, 60);
  return withLock(function() {
    var sheet = getCodesSheet();
    if (sheet.getLastRow() < 2) return { error: 'Code not found' };
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0]).trim().toUpperCase() === target) {
        sheet.getRange(i + 2, 2).setValue(group);
        return { success: true };
      }
    }
    return { error: 'Code not found' };
  });
}

// Polled by the Display tab every few seconds, so it only reads the Codes column it needs.
function getCodeStatus(code) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Codes');
  var target = String(code).trim().toUpperCase();
  if (!sheet || !target || sheet.getLastRow() < 2) return { code: target, exists: false, active: false };
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toUpperCase() === target) {
      return { code: target, exists: true, active: rows[i][4] !== 'No' };
    }
  }
  return { code: target, exists: false, active: false };
}

function findCodeRow(code) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Codes');
  var target = String(code).trim().toUpperCase();
  if (!sheet || !target || sheet.getLastRow() < 2) return null;
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toUpperCase() === target) return { row: i + 2, group: String(rows[i][1] || '').trim() };
  }
  return null;
}

// Runs once when the Group column is first added: fills older scans from each code's current group.
function backfillScanGroups(sheet) {
  var lastRow = sheet.getLastRow();
  var codes = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Codes');
  if (lastRow < 2 || !codes || codes.getLastRow() < 2) return;
  var groupByCode = {};
  codes.getRange(2, 1, codes.getLastRow() - 1, 2).getValues().forEach(function(r) {
    groupByCode[String(r[0]).trim().toUpperCase()] = String(r[1] || '').trim();
  });
  var scanCodes = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  var groups = scanCodes.map(function(r) { return [groupByCode[String(r[0]).trim().toUpperCase()] || '']; });
  sheet.getRange(2, 15, groups.length, 1).setValues(groups);
}

function deactivateCodeAfterRedeem(code) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Codes');
  if (!sheet) return false;

  var target = String(code).trim().toUpperCase();
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toUpperCase() === target) {
      sheet.getRange(i + 1, 5).setValue('No');
      return true;
    }
  }
  return false;
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

// DeletedCodes tab: Code | Deleted At. Remembers deletions so a device with a stale copy can't
// re-upload a code during Sync. Adding the code again by hand clears it from this list.
function deletedCodesSheet(create) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('DeletedCodes');
  if (!sheet && create) {
    sheet = ss.insertSheet('DeletedCodes');
    sheet.appendRow(['Code', 'Deleted At']);
  }
  return sheet;
}

function readDeletedCodes() {
  var sheet = deletedCodesSheet(false);
  var set = {};
  if (!sheet) return set;
  sheet.getDataRange().getValues().slice(1).forEach(function(r) {
    var code = String(r[0] || '').trim().toUpperCase();
    if (code) set[code] = true;
  });
  return set;
}

function recordDeletedCodes(codes) {
  var already = readDeletedCodes();
  var now = new Date().toISOString();
  var rows = [];
  codes.forEach(function(c) {
    var code = String(c || '').trim().toUpperCase();
    if (code && !already[code]) {
      already[code] = true;
      rows.push([code, now]);
    }
  });
  if (!rows.length) return;
  var sheet = deletedCodesSheet(true);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 2).setValues(rows);
}

function forgetDeletedCodes(codes) {
  var sheet = deletedCodesSheet(false);
  if (!sheet || !codes.length) return;
  var targets = {};
  codes.forEach(function(c) { targets[String(c).trim().toUpperCase()] = true; });
  deleteRowsWhere(sheet, function(r) { return targets[String(r[0] || '').trim().toUpperCase()]; });
}

// fromSync: the upload came from a device's background Sync rather than the Add Code form, so codes that
// were deleted elsewhere are refused and reported back for the device to drop.
function addCodes(list, fromSync) {
  return withLock(function() {
    var sheet = getCodesSheet();
    var existing = {};
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      existing[String(rows[i][0]).trim().toUpperCase()] = true;
    }
    var deleted = readDeletedCodes();

    var newRows = [];
    var refused = [];
    for (var j = 0; j < list.length; j++) {
      var c = list[j];
      var code = String(c.code || '').trim().toUpperCase();
      if (!code || existing[code]) continue;
      if (fromSync && deleted[code]) {
        refused.push(code);
        continue;
      }
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
      if (!fromSync) forgetDeletedCodes(newRows.map(function(r) { return r[0]; }));
    }
    return { success: true, added: newRows.length, skipped: list.length - newRows.length, deleted: refused };
  });
}

function addCode(data) {
  return jsonOut(addCodes([data], false));
}

function updateCode(data) {
  var target = String(data.code || '').trim().toUpperCase();
  if (!target) return jsonOut({ success: false, error: 'No code given' });
  return jsonOut(withLock(function() {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Codes');
    if (!sheet) return { success: false, error: 'Code not found' };
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][0]).trim().toUpperCase() === target) {
        if (typeof data.active !== 'undefined') sheet.getRange(i + 1, 5).setValue(data.active ? 'Yes' : 'No');
        return { success: true };
      }
    }
    return { success: false, error: 'Code not found. It may have been deleted on another device. Tap Sync.' };
  }));
}

function removeCodeFromSheet(data) {
  var target = String(data.code || '').trim().toUpperCase();
  if (!target) return jsonOut({ success: false, error: 'No code given' });
  return jsonOut(withLock(function() {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Codes');
    var removed = deleteRowsWhere(sheet, function(r) { return String(r[0]).trim().toUpperCase() === target; });
    recordDeletedCodes([target]);
    return { success: true, removed: removed };
  }));
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
      deviceId: data[i][12] || '',
      group: data[i][14] || ''
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

  return jsonOut({ codes: codes, groups: groupsResponse() });
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

    // Public endpoint: return timestamps only, never the code values.
    recentCodes.push({ timestamp: rowTimestamp.toISOString() });
  }

  recentCodes.sort(function(a, b) { return new Date(a.timestamp) - new Date(b.timestamp); });

  return ContentService
    .createTextOutput(JSON.stringify({ recentCodes: recentCodes, count: recentCodes.length }))
    .setMimeType(ContentService.MimeType.JSON);
}

function toIso(value) {
  if (!value) return '';
  var d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---------- Events & check-ins ----------

// Events tab: Id | Name | Date | Created At | Closed At
function getEventsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Events');
  if (!sheet) {
    sheet = ss.insertSheet('Events');
    sheet.appendRow(['Id', 'Name', 'Date', 'Created At', 'Closed At']);
  }
  return sheet;
}

// CheckIns tab: Timestamp | Event ID | Trainer Name | Device ID | Source (qr / redeem)
function getCheckInsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('CheckIns');
  if (!sheet) {
    sheet = ss.insertSheet('CheckIns');
    sheet.appendRow(['Timestamp', 'Event ID', 'Trainer Name', 'Device ID', 'Source']);
  }
  return sheet;
}

function readEvents() {
  var rows = getEventsSheet().getDataRange().getValues();
  var list = [];
  for (var i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    var closedAt = toIso(rows[i][4]);
    list.push({
      row: i + 1,
      event: {
        id: String(rows[i][0]),
        name: String(rows[i][1]),
        date: toIso(rows[i][2]),
        createdAt: toIso(rows[i][3]),
        closedAt: closedAt,
        open: !closedAt
      }
    });
  }
  list.sort(function(a, b) {
    if (a.event.date !== b.event.date) return a.event.date < b.event.date ? 1 : -1;
    return a.event.createdAt < b.event.createdAt ? 1 : -1;
  });
  return list;
}

function findEvent(id) {
  if (!id) return null;
  var all = readEvents();
  for (var i = 0; i < all.length; i++) {
    if (all[i].event.id === id) return all[i];
  }
  return null;
}

// "date" holds the admin's local midnight, so the event day runs 24h from it (or until check-in closed).
function eventWindow(ev) {
  var since = new Date(ev.date || 0);
  var until = new Date(since.getTime() + 24 * 60 * 60 * 1000);
  if (ev.closedAt) {
    var closedAt = new Date(ev.closedAt);
    if (closedAt < until) until = closedAt;
  }
  return { since: since, until: until };
}

function checkInRows() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('CheckIns');
  return sheet ? sheet.getDataRange().getValues().slice(1) : [];
}

function eventAttendees(id, rows) {
  rows = rows || checkInRows();
  var byKey = {};
  var order = [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][1]) !== id) continue;
    var name = String(rows[i][2] || '').trim();
    var key = trainerKey(name);
    if (!key) continue;
    if (!byKey[key]) {
      byKey[key] = { trainerName: name, redeemed: false, checkedIn: false, firstSeen: toIso(rows[i][0]) };
      order.push(key);
    }
    if (String(rows[i][4]) === 'redeem') byKey[key].redeemed = true;
    else byKey[key].checkedIn = true;
  }
  var list = order.map(function(k) { return byKey[k]; });
  list.sort(function(a, b) { return a.trainerName.toLowerCase() < b.trainerName.toLowerCase() ? -1 : 1; });
  return list;
}

function getEventsWithCounts() {
  var rows = checkInRows();
  var keysByEvent = {};
  rows.forEach(function(r) {
    var id = String(r[1]);
    var key = trainerKey(r[2]);
    if (!key) return;
    keysByEvent[id] = keysByEvent[id] || {};
    keysByEvent[id][key] = true;
  });
  return readEvents().map(function(r) {
    r.event.attendeeCount = Object.keys(keysByEvent[r.event.id] || {}).length;
    return r.event;
  });
}

function createEvent(name, date) {
  name = String(name).trim().slice(0, 60);
  if (!name) return { error: 'Event name is required' };
  var dateIso = toIso(date);
  if (!dateIso) return { error: 'Event date is required' };

  return withLock(function() {
    var id = Utilities.getUuid().split('-')[0];
    var now = new Date().toISOString();
    getEventsSheet().appendRow([id, name, dateIso, now, '']);
    var ev = { id: id, name: name, date: dateIso, createdAt: now, closedAt: '', open: true };

    // Anyone who already redeemed a code on the event's date counts as checked in.
    var backfilled = 0;
    var scanSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('ScanLog');
    if (scanSheet) {
      var w = eventWindow(ev);
      var seen = {};
      var newRows = [];
      var scans = scanSheet.getDataRange().getValues();
      for (var i = 1; i < scans.length; i++) {
        var ts = new Date(scans[i][0]);
        var key = trainerKey(scans[i][2]);
        if (!key || seen[key] || isNaN(ts.getTime()) || ts < w.since || ts >= w.until) continue;
        seen[key] = true;
        newRows.push([ts.toISOString(), id, String(scans[i][2]).trim(), String(scans[i][12] || ''), 'redeem']);
      }
      if (newRows.length) {
        var sheet = getCheckInsSheet();
        sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 5).setValues(newRows);
        backfilled = newRows.length;
      }
    }
    ev.attendeeCount = backfilled;
    return { success: true, event: ev, backfilled: backfilled };
  });
}

function setEventStatus(id, open) {
  return withLock(function() {
    var found = findEvent(id);
    if (!found) return { error: 'Event not found' };
    var closedAt = open ? '' : new Date().toISOString();
    getEventsSheet().getRange(found.row, 5).setValue(closedAt);
    found.event.closedAt = closedAt;
    found.event.open = open;
    return { success: true, event: found.event };
  });
}

function deleteRowsWhere(sheet, predicate) {
  if (!sheet) return 0;
  var rows = sheet.getDataRange().getValues();
  var removed = 0;
  for (var i = rows.length - 1; i >= 1; i--) {
    if (predicate(rows[i])) {
      sheet.deleteRow(i + 1);
      removed++;
    }
  }
  return removed;
}

function deleteEvent(id) {
  return withLock(function() {
    var found = findEvent(id);
    if (!found) return { error: 'Event not found' };
    var usedBy = readLotteries().filter(function(r) { return r.lottery.eventId === id; });
    if (usedBy.length) {
      return { error: 'Lottery "' + usedBy[0].lottery.name + '" uses this event. Delete it or switch it to another event first.' };
    }
    getEventsSheet().deleteRow(found.row);
    readGroups().forEach(function(g) { if (g.eventId === id) getGroupsSheet().getRange(g.row, 3).setValue(''); });
    var removed = deleteRowsWhere(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('CheckIns'), function(r) {
      return String(r[1]) === id;
    });
    return { success: true, removedCheckIns: removed };
  });
}

function removeAttendee(id, trainerName) {
  var key = trainerKey(trainerName);
  if (!key) return { error: 'Trainer name is required' };
  return withLock(function() {
    var found = findEvent(id);
    if (!found) return { error: 'Event not found' };
    deleteRowsWhere(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('CheckIns'), function(r) {
      return String(r[1]) === id && trainerKey(r[2]) === key;
    });
    return { success: true, attendees: withRedeemedCodes(found.event, eventAttendees(id)) };
  });
}

// Adds the codes each attendee redeemed during the event (from the ScanLog), so an admin can reactivate
// one if the trainer's redemption didn't actually go through.
function withRedeemedCodes(ev, attendees) {
  var byKey = {};
  attendees.forEach(function(a) { a.codes = []; byKey[trainerKey(a.trainerName)] = a; });
  var scanSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('ScanLog');
  if (!scanSheet) return attendees;

  var w = eventWindow(ev);
  var ties = groupEventMap();
  var hasTies = Object.keys(ties).some(function(g) { return ties[g] === ev.id; });
  scanSheet.getDataRange().getValues().slice(1).forEach(function(row) {
    var a = byKey[trainerKey(row[2])];
    var ts = new Date(row[0]);
    if (!a || !row[1] || isNaN(ts.getTime())) return;
    var tiedTo = ties[String(row[14] || '').trim()] || '';
    // Same rule as addRedeemerToOpenEvents: tied codes belong to their event, the rest go by date.
    if (tiedTo ? tiedTo !== ev.id : (hasTies || ts < w.since || ts >= w.until)) return;
    var code = String(row[1]).trim().toUpperCase();
    if (a.codes.some(function(c) { return c.code === code; })) return;
    a.codes.push({ code: code, timestamp: ts.toISOString() });
  });
  return attendees;
}

function checkIn(id, trainerName, deviceId) {
  trainerName = String(trainerName).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9]+$/.test(trainerName)) {
    return { success: false, error: 'Trainer names are letters and numbers only' };
  }
  deviceId = String(deviceId || '');
  var trackDevice = deviceId && deviceId !== 'dev-unknown';

  return withLock(function() {
    var found = findEvent(id);
    if (!found) return { success: false, error: 'Event not found' };
    if (!found.event.open) return { success: false, closed: true };

    var key = trainerKey(trainerName);
    var rows = checkInRows();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][1]) !== id) continue;
      if (trainerKey(rows[i][2]) === key) {
        return { success: true, alreadyCheckedIn: true, viaRedemption: String(rows[i][4]) === 'redeem', existingName: String(rows[i][2]) };
      }
    }
    // Only QR check-ins count toward the one-per-phone limit, so a phone used to redeem a code for
    // someone else can still check its owner in.
    for (var j = 0; j < rows.length; j++) {
      if (String(rows[j][1]) === id && trackDevice && String(rows[j][3]) === deviceId && String(rows[j][4]) !== 'redeem') {
        return { success: false, deviceUsed: true, existingName: String(rows[j][2]) };
      }
    }

    getCheckInsSheet().appendRow([new Date().toISOString(), id, trainerName, deviceId, 'qr']);
    return { success: true, alreadyCheckedIn: false };
  });
}

// Caller (logScan) already holds the script lock. A code from a group tied to an event checks the trainer
// into that event (any day, while it's open). Other codes go to open events running that day that
// don't have groups of their own tied to them.
function addRedeemerToOpenEvents(trainerName, timestamp, deviceId, group) {
  var key = trainerKey(trainerName);
  var ts = new Date(timestamp);
  if (!key || isNaN(ts.getTime())) return;

  var ties = groupEventMap();
  var tiedEvent = ties[group || ''] || '';
  var eventsWithTies = {};
  Object.keys(ties).forEach(function(g) { eventsWithTies[ties[g]] = true; });

  var rows = checkInRows();
  var sheet = null;
  readEvents().forEach(function(r) {
    var ev = r.event;
    if (!ev.open) return;
    if (tiedEvent) {
      if (ev.id !== tiedEvent) return;
    } else {
      if (eventsWithTies[ev.id]) return;
      var w = eventWindow(ev);
      if (ts < w.since || ts >= w.until) return;
    }
    var already = rows.some(function(row) { return String(row[1]) === ev.id && trainerKey(row[2]) === key; });
    if (already) return;
    sheet = sheet || getCheckInsSheet();
    sheet.appendRow([ts.toISOString(), ev.id, String(trainerName).trim(), deviceId, 'redeem']);
  });
}

// ---------- Lotteries ----------

// Lotteries tab: Id | Name | Created At | Since | Closed At | Winners (JSON array) | Overrides (JSON) | Winner Count | Event ID
// Overrides = { excluded: [trainerKey], renames: { originalTrainerKey: displayName } } so admin edits
// apply to entrants without touching the ScanLog or CheckIns.
// Lotteries without an Event ID predate events and still use their own check-in date and sign-ups.
function getLotteriesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Lotteries');
  if (!sheet) {
    sheet = ss.insertSheet('Lotteries');
    sheet.appendRow(['Id', 'Name', 'Created At', 'Since', 'Closed At', 'Winners', 'Overrides', 'Winner Count', 'Event ID', 'Rules']);
  } else if (sheet.getLastColumn() < 10) {
    sheet.getRange(1, 7, 1, 4).setValues([['Overrides', 'Winner Count', 'Event ID', 'Rules']]);
  }
  return sheet;
}

// Rules = { excludeRecentEvents: N, excludeLotteryIds: [...] }; they only affect the lottery they're set on.
function parseRules(value) {
  var r = {};
  try { r = JSON.parse(value || '{}') || {}; } catch (err) {}
  return {
    excludeRecentEvents: Math.max(0, Math.min(10, parseInt(r.excludeRecentEvents, 10) || 0)),
    excludeLotteryIds: Array.isArray(r.excludeLotteryIds) ? r.excludeLotteryIds.map(String) : []
  };
}

function parseOverrides(value) {
  var o = {};
  try { o = JSON.parse(value || '{}') || {}; } catch (err) {}
  return { excluded: o.excluded || [], renames: o.renames || {}, skipped: o.skipped || [] };
}

function saveLotteryFields(found) {
  var sheet = getLotteriesSheet();
  sheet.getRange(found.row, 6).setValue(JSON.stringify(found.lottery.winners));
  sheet.getRange(found.row, 7).setValue(JSON.stringify(found.overrides));
}

// Lottery tab: Timestamp | Trainer Name | Device ID | Lottery ID
function getLotteryEntriesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Lottery');
  if (!sheet) {
    sheet = ss.insertSheet('Lottery');
    sheet.appendRow(['Timestamp', 'Trainer Name', 'Device ID', 'Lottery ID']);
  } else if (sheet.getLastColumn() < 4) {
    sheet.getRange(1, 4).setValue('Lottery ID');
  }
  return sheet;
}

function readLotteries() {
  var rows = getLotteriesSheet().getDataRange().getValues();
  var list = [];
  for (var i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    var winners = [];
    try { winners = JSON.parse(rows[i][5] || '[]'); } catch (err) {}
    var closedAt = toIso(rows[i][4]);
    list.push({
      row: i + 1,
      overrides: parseOverrides(rows[i][6]),
      lottery: {
        id: String(rows[i][0]),
        name: String(rows[i][1]),
        createdAt: toIso(rows[i][2]),
        since: toIso(rows[i][3]),
        closedAt: closedAt,
        open: !closedAt,
        winners: winners,
        winnerCount: Math.max(1, parseInt(rows[i][7], 10) || 1),
        eventId: String(rows[i][8] || ''),
        rules: parseRules(rows[i][9])
      }
    });
  }
  list.sort(function(a, b) { return a.lottery.createdAt < b.lottery.createdAt ? 1 : -1; });
  return list;
}

function findLottery(id) {
  if (!id) return null;
  var all = readLotteries();
  for (var i = 0; i < all.length; i++) {
    if (all[i].lottery.id === id) return all[i];
  }
  return null;
}

function createLottery(name, eventId) {
  name = String(name).trim().slice(0, 60);
  if (!name) return { error: 'Lottery name is required' };

  return withLock(function() {
    var source = resolveLotterySource(eventId);
    if (!source) return { error: 'Choose an event for this lottery' };
    var id = Utilities.getUuid().split('-')[0];
    var now = new Date().toISOString();
    getLotteriesSheet().appendRow([id, name, now, source.date, '', '[]', '{}', 1, eventId, '{}']);
    return {
      success: true,
      lottery: {
        id: id, name: name, createdAt: now, since: source.date, closedAt: '', open: true,
        winners: [], winnerCount: 1, eventId: eventId, rules: parseRules('{}'), sourceName: source.name
      }
    };
  });
}

function setLotteryStatus(id, open) {
  return withLock(function() {
    var found = findLottery(id);
    if (!found) return { error: 'Lottery not found' };
    var closedAt = open ? '' : new Date().toISOString();
    getLotteriesSheet().getRange(found.row, 5).setValue(closedAt);
    found.lottery.closedAt = closedAt;
    found.lottery.open = open;
    return { success: true, lottery: found.lottery };
  });
}

function recordWinner(id, trainerName) {
  trainerName = String(trainerName).trim();
  if (!trainerName) return { error: 'Trainer name is required' };

  return withLock(function() {
    var found = findLottery(id);
    if (!found) return { error: 'Lottery not found' };
    var winners = found.lottery.winners;
    var already = winners.some(function(w) { return trainerKey(w) === trainerKey(trainerName); });
    if (found.overrides.skipped.indexOf(trainerKey(trainerName)) !== -1) return { error: trainerName + ' was skipped. Restore them first.' };
    var blockedBy = ineligibleReasons(found)[trainerKey(trainerName)];
    if (blockedBy && !already) return { error: trainerName + ' is excluded by this lottery\'s rules (' + blockedBy + ')' };
    if (!already && winners.length >= found.lottery.winnerCount) return { error: 'All winners have been drawn' };
    if (!already) winners.push(trainerName);
    getLotteriesSheet().getRange(found.row, 6).setValue(JSON.stringify(winners));
    return { success: true, winners: winners };
  });
}

function setWinnerCount(id, count) {
  count = parseInt(count, 10);
  if (!(count >= 1 && count <= 10)) return { error: 'Winner count must be between 1 and 10' };

  return withLock(function() {
    var found = findLottery(id);
    if (!found) return { error: 'Lottery not found' };
    if (count < found.lottery.winners.length) {
      return { error: found.lottery.winners.length + ' winners are already drawn. Undo a win first.' };
    }
    getLotteriesSheet().getRange(found.row, 8).setValue(count);
    found.lottery.winnerCount = count;
    return { success: true, lottery: found.lottery };
  });
}

function setLotteryRules(id, excludeRecentEvents, excludeLotteryIds) {
  var ids;
  try { ids = JSON.parse(excludeLotteryIds || '[]'); } catch (err) { return { error: 'Invalid lottery list' }; }
  var rules = parseRules(JSON.stringify({ excludeRecentEvents: excludeRecentEvents, excludeLotteryIds: ids }));
  rules.excludeLotteryIds = rules.excludeLotteryIds.filter(function(x) { return x !== id; });

  return withLock(function() {
    var found = findLottery(id);
    if (!found) return { error: 'Lottery not found' };
    getLotteriesSheet().getRange(found.row, 10).setValue(JSON.stringify(rules));
    found.lottery.rules = rules;
    return { success: true, lottery: found.lottery, entrants: buildEntrants(found) };
  });
}

function lotteryDate(lottery, eventsById) {
  var ev = lottery.eventId && eventsById[lottery.eventId];
  return ev ? ev.date : lottery.since;
}

// Maps trainerKey -> reason for anyone this lottery's rules exclude.
function ineligibleReasons(found, all, eventsById) {
  var rules = found.lottery.rules || parseRules('{}');
  var reasons = {};
  if (!rules.excludeRecentEvents && !rules.excludeLotteryIds.length) return reasons;

  all = all || readLotteries();
  if (!eventsById) {
    eventsById = {};
    readEvents().forEach(function(r) { eventsById[r.event.id] = r.event; });
  }

  function addWinners(lottery) {
    lottery.winners.forEach(function(w) {
      var k = trainerKey(w);
      if (k && !reasons[k]) reasons[k] = 'Won ' + lottery.name;
    });
  }

  if (rules.excludeRecentEvents > 0) {
    // Group other lotteries by event (older lotteries stand alone) and take the N events before this one.
    var myDate = lotteryDate(found.lottery, eventsById);
    var myGroup = found.lottery.eventId || 'lottery:' + found.lottery.id;
    var groups = {};
    all.forEach(function(r) {
      var l = r.lottery;
      var group = l.eventId || 'lottery:' + l.id;
      var date = lotteryDate(l, eventsById);
      if (group === myGroup || !date || !myDate || date >= myDate) return;
      groups[group] = groups[group] || { date: date, lotteries: [] };
      groups[group].lotteries.push(l);
    });
    Object.keys(groups)
      .map(function(g) { return groups[g]; })
      .sort(function(a, b) { return a.date < b.date ? 1 : -1; })
      .slice(0, rules.excludeRecentEvents)
      .forEach(function(g) { g.lotteries.forEach(addWinners); });
  }

  rules.excludeLotteryIds.forEach(function(lotteryId) {
    if (lotteryId === found.lottery.id) return;
    for (var i = 0; i < all.length; i++) {
      if (all[i].lottery.id === lotteryId) addWinners(all[i].lottery);
    }
  });
  return reasons;
}

function updateLottery(id, name, eventId) {
  name = String(name).trim().slice(0, 60);
  if (!name) return { error: 'Lottery name is required' };

  return withLock(function() {
    var found = findLottery(id);
    if (!found) return { error: 'Lottery not found' };
    var source = resolveLotterySource(eventId);
    if (!source) return { error: 'Choose an event for this lottery' };
    var sheet = getLotteriesSheet();
    sheet.getRange(found.row, 2).setValue(name);
    sheet.getRange(found.row, 4).setValue(source.date);
    sheet.getRange(found.row, 9).setValue(eventId);
    found.lottery.name = name;
    found.lottery.since = source.date;
    found.lottery.eventId = eventId;
    found.lottery.sourceName = source.name;
    return { success: true, lottery: found.lottery };
  });
}

function deleteLottery(id) {
  return withLock(function() {
    var found = findLottery(id);
    if (!found) return { error: 'Lottery not found' };
    getLotteriesSheet().deleteRow(found.row);

    var entrySheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Lottery');
    var removed = 0;
    if (entrySheet) {
      var rows = entrySheet.getDataRange().getValues();
      for (var i = rows.length - 1; i >= 1; i--) {
        if (String(rows[i][3]) === id) {
          entrySheet.deleteRow(i + 1);
          removed++;
        }
      }
    }
    return { success: true, removedEntries: removed };
  });
}

function entrantMutation(id, fn) {
  return withLock(function() {
    var found = findLottery(id);
    if (!found) return { error: 'Lottery not found' };
    var err = fn(found);
    if (err) return { error: err };
    saveLotteryFields(found);
    return { success: true, lottery: found.lottery, entrants: buildEntrants(found) };
  });
}

function withoutKey(winners, key) {
  return winners.filter(function(w) { return trainerKey(w) !== key; });
}

function renameEntrant(id, oldName, newName) {
  newName = String(newName).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9]+$/.test(newName)) return { error: 'Trainer names are letters and numbers only' };
  var oldKey = trainerKey(oldName);
  var newKey = trainerKey(newName);
  if (!oldKey) return { error: 'Trainer name is required' };

  return entrantMutation(id, function(found) {
    var renames = found.overrides.renames;
    // Re-point earlier renames that landed on the old name, then map the old name itself.
    Object.keys(renames).forEach(function(k) {
      if (trainerKey(renames[k]) === oldKey) renames[k] = newName;
    });
    renames[oldKey] = newName;
    found.overrides.excluded = found.overrides.excluded.filter(function(k) { return k !== newKey; });

    var winners = found.lottery.winners;
    if (winners.some(function(w) { return trainerKey(w) === oldKey; })) {
      winners = withoutKey(withoutKey(winners, oldKey), newKey);
      winners.push(newName);
      found.lottery.winners = winners;
    }
  });
}

function removeEntrant(id, trainerName) {
  var key = trainerKey(trainerName);
  if (!key) return { error: 'Trainer name is required' };
  return entrantMutation(id, function(found) {
    if (found.overrides.excluded.indexOf(key) === -1) found.overrides.excluded.push(key);
    found.lottery.winners = withoutKey(found.lottery.winners, key);
  });
}

function unmarkWinner(id, trainerName) {
  var key = trainerKey(trainerName);
  if (!key) return { error: 'Trainer name is required' };
  return entrantMutation(id, function(found) {
    found.lottery.winners = withoutKey(found.lottery.winners, key);
  });
}

// For a winner who isn't around to claim: drop the win and keep them out of later draws for this lottery.
function skipWinner(id, trainerName) {
  var key = trainerKey(trainerName);
  if (!key) return { error: 'Trainer name is required' };
  return entrantMutation(id, function(found) {
    found.lottery.winners = withoutKey(found.lottery.winners, key);
    if (found.overrides.skipped.indexOf(key) === -1) found.overrides.skipped.push(key);
  });
}

function unskipEntrant(id, trainerName) {
  var key = trainerKey(trainerName);
  if (!key) return { error: 'Trainer name is required' };
  return entrantMutation(id, function(found) {
    found.overrides.skipped = found.overrides.skipped.filter(function(k) { return k !== key; });
  });
}

function resolveEntrantName(overrides, rawName) {
  var name = String(rawName || '').trim();
  var renamed = overrides.renames[trainerKey(name)];
  return renamed || name;
}

// Pokemon Go trainer names are letters and numbers only, so spacing/case differences are the same trainer.
function trainerKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function joinLottery(id, trainerName, deviceId) {
  trainerName = String(trainerName).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9]+$/.test(trainerName)) {
    return { success: false, error: 'Trainer names are letters and numbers only' };
  }
  deviceId = String(deviceId || '');
  var trackDevice = deviceId && deviceId !== 'dev-unknown';

  return withLock(function() {
    var found = findLottery(id);
    if (!found) return { success: false, error: 'Lottery not found' };
    if (!found.lottery.open) return { success: false, closed: true };

    var sheet = getLotteryEntriesSheet();
    var key = trainerKey(trainerName);
    if (found.overrides.excluded.indexOf(trainerKey(resolveEntrantName(found.overrides, trainerName))) !== -1) {
      return { success: false, removed: true };
    }
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][3]) !== id) continue;
      if (trainerKey(rows[i][1]) === key) {
        return { success: true, alreadyJoined: true, existingName: String(rows[i][1]) };
      }
      if (trackDevice && String(rows[i][2]) === deviceId) {
        return { success: false, deviceUsed: true, existingName: String(rows[i][1]) };
      }
    }

    var redeemedAs = findRedeemerInWindow(found.lottery, key);
    if (redeemedAs) {
      return { success: true, alreadyJoined: true, viaRedemption: true, existingName: redeemedAs };
    }

    sheet.appendRow([new Date().toISOString(), trainerName, deviceId, id]);
    return { success: true, alreadyJoined: false };
  });
}

// "since" holds the admin's local midnight for the check-in date, so the day runs 24h from it.
function lotteryWindow(lottery) {
  var since = new Date(lottery.since || 0);
  var until = new Date(since.getTime() + 24 * 60 * 60 * 1000);
  if (lottery.closedAt) {
    var closedAt = new Date(lottery.closedAt);
    if (closedAt < until) until = closedAt;
  }
  return { since: since, until: until };
}

function findRedeemerInWindow(lottery, key) {
  var scanSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('ScanLog');
  if (!scanSheet) return '';
  var w = lotteryWindow(lottery);
  var scans = scanSheet.getDataRange().getValues();
  for (var i = 1; i < scans.length; i++) {
    var ts = new Date(scans[i][0]);
    if (isNaN(ts.getTime()) || ts < w.since || ts >= w.until) continue;
    if (trainerKey(scans[i][2]) === key) return String(scans[i][2]).trim();
  }
  return '';
}

function getLotteryEntrants(id) {
  var found = findLottery(id);
  if (!found) return { error: 'Lottery not found' };
  return { entrants: buildEntrants(found) };
}

// Entrants = everyone checked in to the lottery's event, or everyone Campfire marked as checked in at its
// meetup/upload (or, for older lotteries, code redeemers on the check-in date plus their own sign-ups),
// after applying the lottery's admin renames and removals.
function buildEntrants(found) {
  var id = found.lottery.id;
  var overrides = found.overrides;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var entrants = {};

  function add(rawName, flag) {
    var name = resolveEntrantName(overrides, rawName);
    var key = trainerKey(name);
    if (!key || overrides.excluded.indexOf(key) !== -1) return;
    if (!entrants[key]) entrants[key] = { trainerName: name, redeemed: false, signedUp: false, checkedIn: false, campfire: false };
    entrants[key][flag] = true;
  }

  function sorted() {
    var winnerKeys = found.lottery.winners.map(trainerKey);
    var reasons = ineligibleReasons(found);
    var list = Object.keys(entrants).map(function(k) {
      entrants[k].skipped = overrides.skipped.indexOf(k) !== -1;
      // Someone already drawn here stays a winner even if a rule added later would exclude them.
      entrants[k].ineligible = winnerKeys.indexOf(k) === -1 ? (reasons[k] || '') : '';
      return entrants[k];
    });
    list.sort(function(a, b) { return a.trainerName.toLowerCase() < b.trainerName.toLowerCase() ? -1 : 1; });
    return list;
  }

  if (isCampfireSource(found.lottery.eventId)) {
    var source = resolveLotterySource(found.lottery.eventId);
    (source ? source.campfireNames : []).forEach(function(n) { add(n, 'campfire'); });
    return sorted();
  }

  if (found.lottery.eventId) {
    eventAttendees(found.lottery.eventId).forEach(function(a) {
      if (a.redeemed) add(a.trainerName, 'redeemed');
      if (a.checkedIn) add(a.trainerName, 'checkedIn');
    });
    return sorted();
  }

  var w = lotteryWindow(found.lottery);
  var since = w.since;
  var until = w.until;
  var scanSheet = ss.getSheetByName('ScanLog');
  if (scanSheet) {
    var scans = scanSheet.getDataRange().getValues();
    for (var i = 1; i < scans.length; i++) {
      var ts = new Date(scans[i][0]);
      if (isNaN(ts.getTime()) || ts < since || ts >= until) continue;
      add(scans[i][2], 'redeemed');
    }
  }

  var entrySheet = ss.getSheetByName('Lottery');
  if (entrySheet) {
    var entries = entrySheet.getDataRange().getValues();
    for (var j = 1; j < entries.length; j++) {
      if (String(entries[j][3]) === id) add(entries[j][1], 'signedUp');
    }
  }

  return sorted();
}

// ---------- Trainer history ----------

function getTrainerHistory() {
  var people = {};

  function person(rawName) {
    var name = String(rawName || '').trim();
    var key = trainerKey(name);
    if (!key) return null;
    if (!people[key]) people[key] = { trainerName: name, events: [], redemptions: 0, wins: [], lastSeen: '' };
    return people[key];
  }

  function seen(p, value) {
    var iso = toIso(value);
    if (iso && iso > p.lastSeen) p.lastSeen = iso;
  }

  var eventsById = {};
  readEvents().forEach(function(r) { eventsById[r.event.id] = r.event; });

  var attended = {};
  checkInRows().forEach(function(row) {
    var ev = eventsById[String(row[1])];
    var p = person(row[2]);
    if (!ev || !p) return;
    seen(p, row[0]);
    var mark = trainerKey(row[2]) + '|' + ev.id;
    if (attended[mark]) return;
    attended[mark] = true;
    p.events.push({ name: ev.name, date: ev.date });
  });

  var scanSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('ScanLog');
  if (scanSheet) {
    scanSheet.getDataRange().getValues().slice(1).forEach(function(row) {
      var p = person(row[2]);
      if (!p) return;
      p.redemptions++;
      seen(p, row[0]);
    });
  }

  readLotteries().forEach(function(r) {
    var l = r.lottery;
    var ev = l.eventId && eventsById[l.eventId];
    l.winners.forEach(function(w) {
      var p = person(w);
      if (p) p.wins.push({ lottery: l.name, event: ev ? ev.name : '', date: ev ? ev.date : l.since });
    });
  });

  var list = Object.keys(people).map(function(k) {
    var p = people[k];
    p.events.sort(function(a, b) { return a.date < b.date ? 1 : -1; });
    p.wins.sort(function(a, b) { return a.date < b.date ? 1 : -1; });
    return p;
  });
  list.sort(function(a, b) {
    if (b.events.length !== a.events.length) return b.events.length - a.events.length;
    return a.trainerName.toLowerCase() < b.trainerName.toLowerCase() ? -1 : 1;
  });
  return list;
}

// ---------- Backups ----------

var BACKUP_FOLDER = 'PoGo Code Dist Backups';
var BACKUPS_TO_KEEP = 8;

// Run once from the editor to schedule a weekly copy of this spreadsheet into Google Drive.
function setupWeeklyBackup() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'backupSpreadsheet') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupSpreadsheet').timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(3).create();
  backupSpreadsheet();
}

function backupSpreadsheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var folders = DriveApp.getFoldersByName(BACKUP_FOLDER);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(BACKUP_FOLDER);
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm');
  DriveApp.getFileById(ss.getId()).makeCopy(ss.getName() + ' backup ' + stamp, folder);

  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort(function(a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(BACKUPS_TO_KEEP).forEach(function(f) { f.setTrashed(true); });
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
