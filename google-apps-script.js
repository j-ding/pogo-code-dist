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
 *     This is the overseer login, which can do everything. Other logins are made in the dashboard's
 *     Admin Settings and are stored in the ACCOUNTS script property, never in the sheet.
 *  6. Optional backups: pick setupWeeklyBackup in the function dropdown and click Run once.
 *  7. Optional event alerts (free OneSignal web push): add ONESIGNAL_APP_ID and ONESIGNAL_API_KEY
 *     to Script properties. The API key stays here; only the app id is sent to the pages.
 *
 * Updating: paste the new code, then Deploy > Manage deployments > edit > Version: New version > Deploy.
 * Bump SCRIPT_VERSION whenever the site starts depending on a new action.
 */

var SCRIPT_VERSION = 29;

// Everything else requires an admin token from login().
var PUBLIC_ACTIONS = ['ping', 'login', 'getEvent', 'checkIn', 'getLottery', 'joinLottery', 'checkCooldown', 'checkRedemption', 'logScan', 'pushConfig', 'pushOptIn', 'getAlert'];

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
    CURRENT_USER = null;
    if (PUBLIC_ACTIONS.indexOf(params.action) === -1) {
      CURRENT_USER = authUser(params.t);
      if (!CURRENT_USER) return jsonOut({ error: 'Unauthorized', unauthorized: true });
      if (!isAllowed(params.action)) return jsonOut({ error: 'Your account doesn\'t have permission for that.', forbidden: true });
    }
    return handleGet(e);
  } catch (err) {
    return jsonOut(errorResponse(err));
  }
}

// ---------- Accounts and permissions ----------
// The overseer logs in with ADMIN_USERNAME / ADMIN_PASSWORD and can do everything. Other accounts live in the
// ACCOUNTS script property as { username: { name, salt, hash, enabled, perms } }, so passwords never touch the
// sheet. Each login has its own code bank: a code's Owner on the Codes tab is the account's username, or blank
// for the overseer. Events, lotteries and logs are shared, limited by each account's permissions.

var PERMISSIONS = [
  ['sendCodes', 'Send codes to another bank'],
  ['checkin', 'Check In: see events, create, close and reopen them'],
  ['checkinRemove', 'Check In: remove people from an event'],
  ['checkinCodes', 'Check In: reactivate and show QR for anyone\'s redeemed codes'],
  ['checkinDelete', 'Check In: delete events'],
  ['lottery', 'Lottery: see, create and draw, including redraw and undo win'],
  ['lotteryEdit', 'Lottery: add, rename, remove and mark winners'],
  ['lotteryDelete', 'Lottery: delete lotteries'],
  ['trainers', 'Trainers tab'],
  ['campfire', 'Campfire exports: view'],
  ['campfireManage', 'Campfire exports: upload, delete and hide names'],
  ['logs', 'Scan log and error log']
];
var DEFAULT_PERMISSIONS = ['sendCodes', 'checkin', 'checkinRemove', 'checkinCodes', 'lottery', 'lotteryEdit', 'logs'];

// '' means any logged-in account. Admin actions missing from this list are overseer-only.
var ACTION_PERMISSIONS = {
  whoami: '', getCodes: '', addCodes: '', addCode: '', updateCode: '', removeCode: '', getCodeStatus: '',
  setGroupEnabled: '', setGroupsEvent: '', renameGroup: '', deleteGroup: '', setCodeGroup: '', getEvents: '',
  transferCodes: 'sendCodes',
  getEventAttendees: 'checkin', createEvent: 'checkin', setEventStatus: 'checkin',
  removeAttendee: 'checkinRemove', deleteEvent: 'checkinDelete',
  getLotteries: 'lottery', getLotterySources: 'lottery', getLotteryEntrants: 'lottery', createLottery: 'lottery',
  setLotteryStatus: 'lottery', recordWinner: 'lottery', setWinnerCount: 'lottery', updateLottery: 'lottery',
  setLotteryRules: 'lottery', skipWinner: 'lottery', unskipEntrant: 'lottery', unmarkWinner: 'lottery',
  renameEntrant: 'lotteryEdit', removeEntrant: 'lotteryEdit', addEntrant: 'lotteryEdit', markWinner: 'lotteryEdit',
  deleteLottery: 'lotteryDelete',
  getTrainerHistory: 'trainers',
  listCampfire: 'campfire', getCampfire: 'campfire',
  uploadCampfire: 'campfireManage', deleteCampfire: 'campfireManage', setCampfireHidden: 'campfireManage',
  getLogs: 'logs', getErrors: 'logs'
};

// Who made the current admin request, or null on public requests.
var CURRENT_USER = null;

function isAllowed(action) {
  if (CURRENT_USER.overseer) return true;
  if (!ACTION_PERMISSIONS.hasOwnProperty(action)) return false;
  return ACTION_PERMISSIONS[action] === '' || hasPerm(ACTION_PERMISSIONS[action]);
}

function hasPerm(perm) {
  return !!CURRENT_USER && (CURRENT_USER.overseer || CURRENT_USER.perms.indexOf(perm) !== -1);
}

function overseerName() {
  return scriptProperty('ADMIN_USERNAME') || 'admin';
}

function readAccounts() {
  try { return JSON.parse(scriptProperty('ACCOUNTS') || '{}') || {}; } catch (err) { return {}; }
}

function saveAccounts(accounts) {
  PropertiesService.getScriptProperties().setProperty('ACCOUNTS', JSON.stringify(accounts));
}

function validPerms(list) {
  var known = PERMISSIONS.map(function(p) { return p[0]; });
  return (list || []).filter(function(p, i, all) { return known.indexOf(p) !== -1 && all.indexOf(p) === i; });
}

// key '' is the overseer.
function userInfo(key, accounts) {
  if (!key) return { key: '', name: overseerName(), overseer: true, perms: PERMISSIONS.map(function(p) { return p[0]; }) };
  var account = (accounts || readAccounts())[key];
  if (!account || !account.enabled) return null;
  return { key: key, name: account.name || key, overseer: false, perms: validPerms(account.perms) };
}

// Every bank codes can live in, for the overseer's filter and as places to send codes.
function bankList() {
  var accounts = readAccounts();
  return [{ key: '', name: overseerName(), enabled: true }].concat(Object.keys(accounts).sort().map(function(k) {
    return { key: k, name: accounts[k].name || k, enabled: !!accounts[k].enabled };
  }));
}

function bankName(key) {
  if (!key) return overseerName();
  var account = readAccounts()[key];
  return account ? account.name || key : key;
}

// The sheet shows banks by name; this turns one back into its key (blank or the overseer's name is '').
function bankKeyFromName(name) {
  var key = String(name || '').trim().toLowerCase();
  return !key || key === overseerName().toLowerCase() ? '' : key;
}

// The bank a request acts on: the caller's own, or for the overseer, whichever bank they name.
function actingBank(requested) {
  if (CURRENT_USER && CURRENT_USER.overseer && requested !== undefined && requested !== null) return bankKeyFromName(requested);
  return CURRENT_USER ? CURRENT_USER.key : '';
}

function canTouchCode(owner) {
  return !!CURRENT_USER && (CURRENT_USER.overseer || owner === CURRENT_USER.key);
}

// A QR link's by= value: the username of whoever showed it. Only kept for the record, so it's just tidied up.
function cleanBy(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
}

function hashPassword(password, salt) {
  var value = String(password);
  for (var i = 0; i < 200; i++) value = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(value, salt));
  return value;
}

// Part of every token, so changing a password logs that login out everywhere.
function passwordStamp(key, accounts) {
  if (!key) return signValue('overseer:' + (scriptProperty('ADMIN_PASSWORD') || '')).slice(0, 12);
  var account = (accounts || readAccounts())[key];
  return account ? String(account.hash).slice(0, 12) : '';
}

function publicUser(user) {
  return { key: user.key, name: user.name, overseer: user.overseer, perms: user.perms };
}

function accountList() {
  var accounts = readAccounts();
  return Object.keys(accounts).sort().map(function(k) {
    return { key: k, name: accounts[k].name || k, enabled: !!accounts[k].enabled, perms: validPerms(accounts[k].perms) };
  });
}

function saveAccount(username, password, enabled, perms, isNew) {
  var name = String(username).trim();
  var key = name.toLowerCase();
  if (!/^[a-z0-9_-]{2,30}$/.test(key)) return { error: 'Usernames are 2 to 30 letters, numbers, - or _' };
  if (key === overseerName().toLowerCase()) return { error: 'That username is the overseer login' };
  if (password && String(password).length < 8) return { error: 'Passwords need at least 8 characters' };
  return withLock(function() {
    var accounts = readAccounts();
    var account = accounts[key];
    if (isNew) {
      if (account) return { error: 'There\'s already an account named ' + account.name };
      if (!password) return { error: 'Choose a password' };
      account = { name: name, enabled: true, perms: DEFAULT_PERMISSIONS.slice(), createdAt: new Date().toISOString() };
    } else if (!account) {
      return { error: 'Account not found' };
    }
    if (password) {
      account.salt = Utilities.getUuid();
      account.hash = hashPassword(password, account.salt);
    }
    if (enabled !== null) account.enabled = enabled;
    if (perms) account.perms = validPerms(perms);
    accounts[key] = account;
    saveAccounts(accounts);
    return { success: true, accounts: accountList(), banks: bankList() };
  });
}

// The account's unused and used codes move to the overseer's bank, merging into groups of the same name.
function deleteAccount(username) {
  var key = String(username).trim().toLowerCase();
  return withLock(function() {
    var accounts = readAccounts();
    if (!accounts[key]) return { error: 'Account not found' };
    var codes = getCodesSheet();
    var moved = 0;
    if (codes.getLastRow() > 1) {
      var owners = codes.getRange(2, 6, codes.getLastRow() - 1, 1).getValues();
      for (var i = 0; i < owners.length; i++) {
        if (bankKeyFromName(owners[i][0]) === key) {
          codes.getRange(i + 2, 6).setValue('');
          moved++;
        }
      }
    }
    var groups = readGroups();
    var groupsSheet = getGroupsSheet();
    groups.filter(function(g) { return g.owner === key; }).reverse().forEach(function(g) {
      var clash = groups.some(function(o) { return o.owner === '' && o.name === g.name; });
      if (clash) groupsSheet.deleteRow(g.row);
      else groupsSheet.getRange(g.row, 4).setValue('');
    });
    delete accounts[key];
    saveAccounts(accounts);
    return { success: true, moved: moved, accounts: accountList(), banks: bankList() };
  });
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

// Token = expiry . account key ('' for the overseer) . HMAC of both plus the password stamp. Disabling or
// deleting an account takes effect on its next request. Deleting the SESSION_SECRET script property logs everyone out.
function authUser(token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  var expires = Number(parts[0]);
  if (!expires || expires < Date.now()) return null;
  var key = parts[1];
  var accounts = key ? readAccounts() : null;
  if (!safeEqual(parts[2], signValue(parts[0] + '.' + key + '.' + passwordStamp(key, accounts)))) return null;
  return userInfo(key, accounts);
}

function login(username, password, remember) {
  var expectedPassword = scriptProperty('ADMIN_PASSWORD');
  if (!expectedPassword) {
    return { error: 'Admin login is not set up. In Apps Script, open Project Settings > Script properties and add ADMIN_USERNAME and ADMIN_PASSWORD.' };
  }
  var name = String(username).trim().toLowerCase().slice(0, 60);

  // Counted per username, so someone guessing one login's password doesn't lock out the others.
  var cache = CacheService.getScriptCache();
  var failKey = 'login_failures_' + name;
  var failures = Number(cache.get(failKey) || 0);
  if (failures >= 10) return { error: 'Too many failed logins. Try again in 10 minutes.' };

  var key = null;
  var accounts = readAccounts();
  if (safeEqual(name, overseerName().toLowerCase())) {
    if (safeEqual(password, expectedPassword)) key = '';
  } else if (accounts[name] && safeEqual(hashPassword(password, accounts[name].salt), accounts[name].hash)) {
    if (!accounts[name].enabled) return { error: 'This login is turned off. Ask the overseer to turn it back on.' };
    key = name;
  }
  if (key === null) {
    cache.put(failKey, String(failures + 1), 600);
    return { error: 'Invalid username or password' };
  }
  cache.remove(failKey);

  var expires = Date.now() + (remember ? 30 : 1) * 24 * 60 * 60 * 1000;
  var user = userInfo(key, accounts);
  return {
    success: true, expires: expires, user: publicUser(user),
    token: expires + '.' + key + '.' + signValue(expires + '.' + key + '.' + passwordStamp(key, accounts))
  };
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

  if (action === 'whoami') {
    return jsonOut({ me: publicUser(CURRENT_USER), banks: bankList() });
  }

  if (action === 'listAccounts') {
    return jsonOut({ accounts: accountList(), permissions: PERMISSIONS, banks: bankList() });
  }

  if (action === 'saveAccount') {
    var perms = null;
    if (p.perms) { try { perms = JSON.parse(p.perms); } catch (err) { return jsonOut({ error: 'Invalid permissions' }); } }
    var enabled = p.enabled === undefined || p.enabled === '' ? null : p.enabled === 'true';
    return jsonOut(saveAccount(p.username || '', p.password || '', enabled, perms, p.create === 'true'));
  }

  if (action === 'deleteAccount') {
    return jsonOut(deleteAccount(p.username || ''));
  }

  if (action === 'transferCodes') {
    var sendList = [];
    try { sendList = JSON.parse(p.codes || '[]'); } catch (err) { return jsonOut({ error: 'Invalid codes list' }); }
    return jsonOut(transferCodes(sendList, p.to || ''));
  }

  if (action === 'pushConfig') {
    return jsonOut({ appId: scriptProperty('ONESIGNAL_APP_ID') || '' });
  }

  if (action === 'pushOptIn') {
    return jsonOut(recordPushOptIn(p.trainerName || ''));
  }

  if (action === 'sendAlert') {
    return jsonOut(sendEventAlert(p.id || '', p.message || '', p.site || ''));
  }

  if (action === 'getAlert') {
    return jsonOut({ alert: getAlert(p.id || '') });
  }

  if (action === 'getCodeStatus') {
    return jsonOut(getCodeStatus(p.code || ''));
  }

  if (action === 'setGroupEnabled') {
    return jsonOut(setGroupEnabled(p.group || '', p.enabled === 'true', actingBank(p.owner)));
  }

  if (action === 'setGroupsEvent') {
    var groupList = [];
    try { groupList = JSON.parse(p.groups || '[]'); } catch (err) {}
    return jsonOut(setGroupsEvent(groupList, p.eventId || '', actingBank(p.owner)));
  }

  if (action === 'renameGroup') {
    return jsonOut(renameGroup(p.oldName || '', p.newName || '', actingBank(p.owner)));
  }

  if (action === 'deleteGroup') {
    return jsonOut(deleteGroup(p.group || '', actingBank(p.owner)));
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

  if (action === 'setCampfireHidden') {
    return jsonOut(setCampfireHidden(p.name || '', p.hidden === 'true'));
  }

  if (action === 'deleteCampfire') {
    return jsonOut(deleteCampfire(p.id || ''));
  }

  if (action === 'setLotteryRules') {
    return jsonOut(setLotteryRules(p.id || '', p.excludeRecentEvents || '0', p.excludeLotteryIds || '[]', p.entryPerCheckIn === 'true'));
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
    return jsonOut(checkIn(p.id || '', p.trainerName || '', p.deviceId || '', p.by || ''));
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

  if (action === 'addEntrant') {
    return jsonOut(addEntrant(p.id || '', p.trainerName || ''));
  }

  if (action === 'markWinner') {
    return jsonOut(markWinner(p.id || '', p.trainerName || ''));
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
    CURRENT_USER = null;
    var data = JSON.parse(e.postData.contents);
    if (data.action === 'logScan') return logScan(data);
    if (data.action === 'logError') return logError(data);
    // Campfire uploads are too large for a GET URL, so they're the one admin action sent by POST.
    if (data.action === 'uploadCampfire') {
      CURRENT_USER = authUser(data.t);
      if (!CURRENT_USER) return jsonOut({ error: 'Unauthorized', unauthorized: true });
      if (!isAllowed('uploadCampfire')) return jsonOut({ error: 'Your account doesn\'t have permission for that.', forbidden: true });
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
  if (!sheet || sheet.getLastRow() < 2) return { exports: [], hidden: readCampfireHidden() };
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
  var list = rows.filter(function(r) { return r[0]; }).map(campfireSummary);
  list.sort(function(a, b) { return a.uploadedAt < b.uploadedAt ? 1 : -1; });
  return { exports: list, hidden: readCampfireHidden() };
}

// CampfireHidden tab: Trainer Key | Trainer Name | Hidden At
// Only affects what Campfire Exports shows. Hidden people stay in the uploads and can still be lottery entrants.
function readCampfireHidden() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('CampfireHidden');
  if (!sheet) return [];
  return sheet.getDataRange().getValues().slice(1).map(function(r) { return String(r[0]); }).filter(Boolean);
}

function setCampfireHidden(name, hidden) {
  var key = trainerKey(name);
  if (!key) return { error: 'Name is required' };
  return withLock(function() {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('CampfireHidden');
    if (!sheet) {
      sheet = ss.insertSheet('CampfireHidden');
      sheet.appendRow(['Trainer Key', 'Trainer Name', 'Hidden At']);
    }
    deleteRowsWhere(sheet, function(r) { return String(r[0]) === key; });
    if (hidden) sheet.appendRow([key, plainCell(String(name).trim().slice(0, 60)), new Date().toISOString()]);
    return { success: true, hidden: readCampfireHidden() };
  });
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

// Only one write can run at a time, so a crowd redeeming at once waits in line for the script lock.
// Everything that can be read beforehand is, and the lock only covers the writes plus a look at rows
// added while waiting.
function logScan(data) {
  var sheet = scanLogSheet();
  var rows = sheet.getDataRange().getValues();

  // The redeem page retries, and can fall back to sendBeacon, so drop repeats.
  if (data.scanId && hasScanId(rows.slice(Math.max(1, rows.length - 300)).map(function(r) { return [r[13]]; }), data.scanId)) {
    return jsonOut({ success: true, duplicate: true });
  }

  var isRepeat = checkRepeat(rows, data.code, data.trainerName);
  var codeInfo = data.code ? findCodeRow(data.code) : null;
  var timestamp = data.timestamp || new Date().toISOString();
  var checkIns = checkInRows();
  var targets = codeInfo && data.trainerName ? redeemerEventIds(data.trainerName, timestamp, codeInfo.group, codeInfo.owner, checkIns) : [];
  var by = cleanBy(data.by);

  return withLock(function() {
    var lastRow = sheet.getLastRow();
    if (data.scanId && lastRow > rows.length) {
      var added = sheet.getRange(rows.length + 1, 14, lastRow - rows.length, 1).getValues();
      if (hasScanId(added, data.scanId)) return jsonOut({ success: true, duplicate: true });
    }

    sheet.appendRow([
      timestamp,
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
      codeInfo ? codeInfo.group : '',
      codeInfo ? bankName(codeInfo.owner) : '',
      by
    ]);

    // Only real codes have side effects, so a forged logScan can't check people in.
    if (codeInfo && markCodeUsed(codeInfo, data.code)) {
      addRedeemerToEvents(targets, data.trainerName, timestamp, data.deviceId || '', checkIns.length + 1, by);
    }
    return jsonOut({ success: true, repeat: isRepeat });
  });
}

function hasScanId(rows, scanId) {
  return rows.some(function(r) { return String(r[0]) === String(scanId); });
}

function scanLogSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var existing = ss.getSheetByName('ScanLog');
  if (existing) {
    var current = existing.getRange(1, 1, 1, existing.getLastColumn()).getValues()[0];
    if (current.indexOf('Device ID') !== -1 && current.indexOf('Scan ID') !== -1 && current.indexOf('Group') !== -1 && current.indexOf('Shown By') !== -1) return existing;
  }

  return withLock(function() {
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
    // Bank is whose code it was; Shown By is whose screen it was scanned from. Older scans leave both blank.
    if (headers.indexOf('Bank') === -1) sheet.getRange(1, 16).setValue('Bank');
    if (headers.indexOf('Shown By') === -1) sheet.getRange(1, 17).setValue('Shown By');
    return sheet;
  });
}

// ---------- Event alerts (OneSignal web push) ----------
// Trainers who allow alerts on the redeem or check-in page are linked to OneSignal by their trainerKey,
// so an alert for an event goes to that event's attendees who turned alerts on.
// PushOptIns tab: Trainer Key | Trainer Name | Opted In At. It's how the dashboard knows how many
// attendees an alert can reach (someone may since have turned notifications off on their phone).
// Alerts tab: Sent At | Event ID | Event | Message | Attendees | Alerts On | Result | Alert ID

function pushOptInsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('PushOptIns');
  if (!sheet) {
    sheet = ss.insertSheet('PushOptIns');
    sheet.appendRow(['Trainer Key', 'Trainer Name', 'Opted In At']);
  }
  return sheet;
}

function readPushOptIns() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PushOptIns');
  var keys = {};
  if (!sheet) return keys;
  sheet.getDataRange().getValues().slice(1).forEach(function(r) { if (r[0]) keys[String(r[0])] = true; });
  return keys;
}

function recordPushOptIn(trainerName) {
  var name = String(trainerName).trim().slice(0, 40);
  var key = trainerKey(name);
  if (!key) return { error: 'Trainer name is required' };
  if (readPushOptIns()[key]) return { success: true }; // Already recorded, so no need to wait for the lock.
  return withLock(function() {
    var sheet = pushOptInsSheet();
    var rows = sheet.getDataRange().getValues();
    var now = new Date().toISOString();
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === key) {
        sheet.getRange(i + 1, 2, 1, 2).setValues([[name, now]]);
        return { success: true };
      }
    }
    sheet.appendRow([key, name, now]);
    return { success: true };
  });
}

function alertsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Alerts');
  if (!sheet) {
    sheet = ss.insertSheet('Alerts');
    sheet.appendRow(['Sent At', 'Event ID', 'Event', 'Message', 'Attendees', 'Alerts On', 'Result', 'Alert ID']);
  } else if (sheet.getLastColumn() < 8) {
    sheet.getRange(1, 8).setValue('Alert ID');
  }
  return sheet;
}

// Public, for the page a tapped notification opens. Alerts that failed to send aren't shown.
function getAlert(id) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Alerts');
  if (!sheet || !id) return null;
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][7]) !== String(id)) continue;
    if (String(rows[i][6]).indexOf('Sen') !== 0) return null;
    return { eventName: String(rows[i][2]), message: String(rows[i][3]), sentAt: toIso(rows[i][0]) };
  }
  return null;
}

// Run once from the editor to approve the permission alerts need. It only contacts OneSignal; nothing is sent.
function authorizeAlerts() {
  var res = UrlFetchApp.fetch('https://api.onesignal.com/', { muteHttpExceptions: true });
  Logger.log('Alerts can reach OneSignal (HTTP ' + res.getResponseCode() + ').');
}

// site is the dashboard's own address, which is where the notification's logo and landing page live.
function sendEventAlert(eventId, message, site) {
  var appId = scriptProperty('ONESIGNAL_APP_ID');
  var apiKey = scriptProperty('ONESIGNAL_API_KEY');
  if (!appId || !apiKey) {
    return { error: 'Alerts aren\'t set up. Add ONESIGNAL_APP_ID and ONESIGNAL_API_KEY in Apps Script Script properties.' };
  }
  message = String(message).trim().slice(0, 300);
  if (!message) return { error: 'Write a message first' };
  var found = findEvent(eventId);
  if (!found) return { error: 'Event not found' };

  var keys = {};
  eventAttendees(eventId).forEach(function(a) { keys[trainerKey(a.trainerName)] = true; });
  var attendees = Object.keys(keys);
  var optedIn = readPushOptIns();
  var reachable = attendees.filter(function(k) { return optedIn[k]; });
  if (!reachable.length) {
    return { error: 'No one checked in to this event (' + attendees.length + ' so far) has alerts turned on.' };
  }

  // Logged before sending, so the landing page works for anyone who taps the notification right away.
  var alertId = Utilities.getUuid().split('-')[0];
  var log = alertsSheet();
  log.appendRow([new Date().toISOString(), eventId, found.event.name, message, attendees.length, reachable.length, 'Sending', alertId]);

  var notification = {
    app_id: appId,
    target_channel: 'push',
    include_aliases: { external_id: reachable },
    headings: { en: found.event.name },
    contents: { en: message }
  };
  // OneSignal needs public https addresses for both of these.
  if (/^https:\/\//.test(site)) {
    var base = String(site).replace(/\/*$/, '/');
    notification.url = base + 'alert.html?id=' + alertId;
    notification.chrome_web_icon = base + 'img/north-fulton-icon.png';
    notification.firefox_icon = base + 'img/north-fulton-icon.png';
  }

  var res = UrlFetchApp.fetch('https://api.onesignal.com/notifications?c=push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Key ' + apiKey },
    payload: JSON.stringify(notification),
    muteHttpExceptions: true
  });
  var body = {};
  try { body = JSON.parse(res.getContentText()) || {}; } catch (err) {}
  var sent = res.getResponseCode() === 200 && !!body.id;
  var problem = '';
  if (!sent) {
    var errors = Array.isArray(body.errors) ? body.errors.join('; ') : (body.errors ? JSON.stringify(body.errors) : '');
    problem = /not subscribed/i.test(errors)
      ? 'None of the attendees with alerts on can be reached anymore (they may have turned notifications off).'
      : 'OneSignal: ' + (errors || 'HTTP ' + res.getResponseCode());
  }

  var logged = log.getDataRange().getValues();
  for (var i = logged.length - 1; i >= 1; i--) {
    if (String(logged[i][7]) === alertId) {
      log.getRange(i + 1, 7).setValue(sent ? 'Sent ' + body.id : 'Failed: ' + problem);
      break;
    }
  }

  return sent ? { success: true, sentTo: reachable.length, attendees: attendees.length } : { error: problem };
}

// ---------- Code groups ----------
// A code's group is its Label. Groups tab: Group | Enabled | Event ID | Owner. Each bank has its own groups, so a
// group is its owner plus its name (blank owner is the overseer). Pausing a group is separate from a code being
// used, so re-enabling a group never brings back codes that were already redeemed.
// Event ID ties a group to one event: its redemptions check people into that event only, and that
// event only takes redemptions from its tied groups. Untied groups fall back to matching by date.

function getGroupsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Groups');
  if (!sheet) {
    sheet = ss.insertSheet('Groups');
    sheet.appendRow(['Group', 'Enabled', 'Event ID', 'Owner']);
  } else if (sheet.getLastColumn() < 4) {
    sheet.getRange(1, 3, 1, 2).setValues([['Event ID', 'Owner']]);
  }
  return sheet;
}

function readGroups() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Groups');
  if (!sheet) return [];
  return sheet.getDataRange().getValues().slice(1).map(function(row, i) {
    return {
      row: i + 2, name: String(row[0] || '').trim(), enabled: row[1] !== 'No', eventId: String(row[2] || '').trim(),
      owner: bankKeyFromName(row[3])
    };
  });
}

function findGroup(groups, name, owner) {
  return groups.filter(function(g) { return g.name === name && g.owner === owner; })[0];
}

// The caller's groups, or every bank's for the overseer.
function groupsResponse() {
  var names = {};
  readEvents().forEach(function(r) { names[r.event.id] = r.event.name; });
  return readGroups().filter(function(g) { return canTouchCode(g.owner); }).map(function(g) {
    var tied = g.eventId && names[g.eventId] !== undefined;
    return { name: g.name, owner: g.owner, enabled: g.enabled, eventId: tied ? g.eventId : '', eventName: tied ? names[g.eventId] : '' };
  });
}

// eventId '' unties the groups so their redemptions go back to matching events by date.
function setGroupsEvent(groups, eventId, owner) {
  eventId = String(eventId || '').trim();
  var names = (groups || []).map(function(g) { return String(g).trim(); });
  return withLock(function() {
    if (eventId && !findEvent(eventId)) return { error: 'Event not found' };
    var sheet = getGroupsSheet();
    var existing = readGroups();
    names.forEach(function(name) {
      var row = findGroup(existing, name, owner);
      if (row) sheet.getRange(row.row, 3).setValue(eventId);
      else if (eventId) sheet.appendRow([name, 'Yes', eventId, owner]);
    });
    return { success: true, groups: groupsResponse() };
  });
}

function groupTieKey(owner, name) {
  return owner + '\n' + name;
}

// { groupTieKey: eventId } for groups tied to an event that still exists.
function groupEventMap() {
  var ids = {};
  readEvents().forEach(function(r) { ids[r.event.id] = true; });
  var map = {};
  readGroups().forEach(function(g) { if (g.eventId && ids[g.eventId]) map[groupTieKey(g.owner, g.name)] = g.eventId; });
  return map;
}

function setGroupEnabled(group, enabled, owner) {
  group = String(group).trim();
  return withLock(function() {
    var sheet = getGroupsSheet();
    var existing = findGroup(readGroups(), group, owner);
    if (existing) sheet.getRange(existing.row, 2).setValue(enabled ? 'Yes' : 'No');
    else sheet.appendRow([group, enabled ? 'Yes' : 'No', '', owner]);
    return { success: true, groups: groupsResponse() };
  });
}

function renameGroup(oldName, newName, owner) {
  oldName = String(oldName).trim();
  newName = String(newName).trim().slice(0, 60);
  if (!newName) return { error: 'Group name is required' };

  return withLock(function() {
    var codes = getCodesSheet();
    var renamed = 0;
    if (codes.getLastRow() > 1) {
      var rows = codes.getRange(2, 1, codes.getLastRow() - 1, 6).getValues();
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i][1] || '').trim() === oldName && codeOwner(rows[i]) === owner) {
          codes.getRange(i + 2, 2).setValue(newName);
          renamed++;
        }
      }
    }
    var groups = readGroups();
    var from = findGroup(groups, oldName, owner);
    var into = findGroup(groups, newName, owner);
    if (from && into) getGroupsSheet().deleteRow(from.row);
    else if (from) getGroupsSheet().getRange(from.row, 1).setValue(newName);
    return { success: true, renamed: renamed, groups: groupsResponse() };
  });
}

// Deletes every code in the group (used or not) plus its Groups row. ScanLog history is left alone.
function deleteGroup(group, owner) {
  group = String(group).trim();
  return withLock(function() {
    var deletedCodes = [];
    var removed = deleteRowsWhere(getCodesSheet(), function(row) {
      var match = String(row[1] || '').trim() === group && codeOwner(row) === owner;
      if (match) deletedCodes.push(row[0]);
      return match;
    });
    recordDeletedCodes(deletedCodes);
    var groupsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Groups');
    deleteRowsWhere(groupsSheet, function(row) { return String(row[0] || '').trim() === group && bankKeyFromName(row[3]) === owner; });
    return { success: true, removed: removed, groups: groupsResponse() };
  });
}

function setCodeGroup(code, group) {
  var target = String(code).trim().toUpperCase();
  group = String(group).trim().slice(0, 60);
  return withLock(function() {
    var sheet = getCodesSheet();
    if (sheet.getLastRow() < 2) return { error: 'Code not found' };
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0]).trim().toUpperCase() === target) {
        if (!canTouchCode(codeOwner(values[i]))) return { error: 'That code is in another bank' };
        sheet.getRange(i + 2, 2).setValue(group);
        return { success: true };
      }
    }
    return { error: 'Code not found' };
  });
}

// Moves unused codes into another bank. Each code is one row, so it can't end up in two banks.
// CodeTransfers tab: Sent At | Code | Group | From | To | By
function transferCodes(codes, to) {
  var target = bankKeyFromName(to);
  var bank = bankList().filter(function(b) { return b.key === target && b.enabled; })[0];
  if (!bank) return { error: 'Choose who to send them to' };
  var wanted = {};
  (codes || []).forEach(function(c) { wanted[String(c).trim().toUpperCase()] = true; });

  return withLock(function() {
    var sheet = getCodesSheet();
    var rows = sheet.getDataRange().getValues();
    var moved = [];
    var skipped = [];
    for (var i = 1; i < rows.length; i++) {
      var code = String(rows[i][0]).trim().toUpperCase();
      if (!wanted[code]) continue;
      delete wanted[code];
      var owner = codeOwner(rows[i]);
      if (!canTouchCode(owner) || rows[i][4] === 'No' || owner === target) {
        skipped.push(code);
        continue;
      }
      sheet.getRange(i + 1, 6).setValue(target);
      moved.push([new Date().toISOString(), code, plainCell(String(rows[i][1] || '')), bankName(owner), bank.name, CURRENT_USER.name]);
    }
    skipped = skipped.concat(Object.keys(wanted));
    if (moved.length) {
      var log = codeTransfersSheet();
      log.getRange(log.getLastRow() + 1, 1, moved.length, 6).setValues(moved);
    }
    return { success: true, moved: moved.length, skipped: skipped, to: bank.name };
  });
}

function codeTransfersSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('CodeTransfers');
  if (!sheet) {
    sheet = ss.insertSheet('CodeTransfers');
    sheet.appendRow(['Sent At', 'Code', 'Group', 'From', 'To', 'By']);
  }
  return sheet;
}

// Codes sent to this bank in the last two weeks, so the dashboard can say what arrived.
function recentTransfersTo(key) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('CodeTransfers');
  if (!sheet) return [];
  var since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  return sheet.getDataRange().getValues().slice(1).filter(function(r) {
    return bankKeyFromName(r[4]) === key && toIso(r[0]) >= since;
  }).map(function(r) { return { at: toIso(r[0]), code: String(r[1]), from: String(r[3]), by: String(r[5]) }; });
}

// Polled by the Display tab every few seconds, so it only reads the Codes columns it needs. Other banks' codes
// only show to someone allowed to handle them from Check In.
function getCodeStatus(code) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Codes');
  var target = String(code).trim().toUpperCase();
  if (!sheet || !target || sheet.getLastRow() < 2) return { code: target, exists: false, active: false };
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toUpperCase() === target) {
      if (!canTouchCode(codeOwner(rows[i])) && !hasPerm('checkinCodes')) break;
      return { code: target, exists: true, active: rows[i][4] !== 'No' };
    }
  }
  return { code: target, exists: false, active: false };
}

function codeOwner(row) {
  return bankKeyFromName(row[5]);
}

function findCodeRow(code) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Codes');
  var target = String(code).trim().toUpperCase();
  if (!sheet || !target || sheet.getLastRow() < 2) return null;
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toUpperCase() === target) return { row: i + 2, group: String(rows[i][1] || '').trim(), owner: codeOwner(rows[i]) };
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

// Caller holds the script lock. The row was looked up before the lock, so make sure it's still that code.
function markCodeUsed(info, code) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Codes');
  if (!sheet) return false;
  var target = String(code).trim().toUpperCase();
  var row = info.row;
  var same = row <= sheet.getLastRow() && String(sheet.getRange(row, 1, 1, 1).getValues()[0][0]).trim().toUpperCase() === target;
  if (!same) {
    var moved = findCodeRow(code);
    if (!moved) return false;
    row = moved.row;
  }
  sheet.getRange(row, 5).setValue('No');
  return true;
}

function checkRepeat(rows, code, trainerName) {
  if (!code || !trainerName) return false;

  for (var i = 1; i < rows.length; i++) {
    if (rows[i][1] === code && rows[i][2] === trainerName) {
      return true;
    }
  }
  return false;
}

function getCodesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Codes') || ss.insertSheet('Codes');

  // Owner is the bank a code belongs to: an account's username, or blank for the overseer.
  var expectedHeaders = ['Code', 'Label', 'Expiry', 'Added At', 'Active', 'Owner'];
  if (sheet.getLastColumn() === 0) {
    sheet.appendRow(expectedHeaders);
  } else {
    var headers = sheet.getRange(1, 1, 1, 6).getValues()[0];
    if (headers[0] !== 'Code' || headers[4] !== 'Active' || headers[5] !== 'Owner') {
      sheet.getRange(1, 1, 1, 6).setValues([expectedHeaders]);
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

// Codes that show up in the ScanLog, so a code someone already redeemed can't come back as unused.
function scannedCodes() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('ScanLog');
  var set = {};
  if (!sheet || sheet.getLastRow() < 2) return set;
  sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues().forEach(function(r) {
    var code = String(r[0] || '').trim().toUpperCase();
    if (code) set[code] = true;
  });
  return set;
}

// New codes go in the caller's bank. A code already in any bank is never added twice, and one that's been
// redeemed before (in the ScanLog but no longer on the Codes tab) is refused, both reported back by name.
// fromSync: the upload came from a device's background Sync rather than the Add Code form, so codes that
// were deleted elsewhere are refused and reported back for the device to drop.
function addCodes(list, fromSync) {
  var owner = CURRENT_USER ? CURRENT_USER.key : '';
  return withLock(function() {
    var sheet = getCodesSheet();
    var existing = {};
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      existing[String(rows[i][0]).trim().toUpperCase()] = codeOwner(rows[i]);
    }
    var deleted = readDeletedCodes();
    var scanned = scannedCodes();

    var newRows = [];
    var refused = [];
    var taken = [];
    var used = [];
    for (var j = 0; j < list.length; j++) {
      var c = list[j];
      var code = String(c.code || '').trim().toUpperCase();
      if (!code) continue;
      if (existing.hasOwnProperty(code)) {
        if (existing[code] !== owner) taken.push(code);
        continue;
      }
      if (fromSync && deleted[code]) {
        refused.push(code);
        continue;
      }
      if (scanned[code]) {
        used.push(code);
        continue;
      }
      existing[code] = owner;
      newRows.push([
        code,
        plainCell(c.label || ''),
        c.expiry || '',
        c.addedAt || new Date().toISOString(),
        c.active === false ? 'No' : 'Yes',
        owner
      ]);
    }

    if (newRows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 6).setValues(newRows);
      if (!fromSync) forgetDeletedCodes(newRows.map(function(r) { return r[0]; }));
    }
    return { success: true, added: newRows.length, skipped: list.length - newRows.length, deleted: refused, taken: taken, used: used };
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
        // Reactivating from Check In is allowed on any bank's code for accounts with that permission.
        if (!canTouchCode(codeOwner(rows[i])) && !(data.active === true && hasPerm('checkinCodes'))) {
          return { success: false, error: 'That code is in another bank' };
        }
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
    var otherBank = false;
    var removed = deleteRowsWhere(sheet, function(r) {
      if (String(r[0]).trim().toUpperCase() !== target) return false;
      if (canTouchCode(codeOwner(r))) return true;
      otherBank = true;
      return false;
    });
    if (otherBank) return { success: false, error: 'That code is in another bank' };
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
      group: data[i][14] || '',
      bank: data[i][15] || '',
      shownBy: data[i][16] || ''
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
    return jsonOut({ codes: [], groups: groupsResponse(), me: publicUser(CURRENT_USER), banks: bankList(), received: [] });
  }

  var data = sheet.getDataRange().getValues();
  var codes = [];

  // Each login gets its own bank; the overseer gets every bank's codes, each marked with its owner.
  for (var i = 1; i < data.length; i++) {
    var owner = codeOwner(data[i]);
    if (!canTouchCode(owner)) continue;
    codes.push({
      code: data[i][0],
      label: data[i][1],
      expiry: data[i][2],
      addedAt: data[i][3],
      active: data[i][4] !== 'No',
      owner: owner
    });
  }

  return jsonOut({
    codes: codes, groups: groupsResponse(), me: publicUser(CURRENT_USER), banks: bankList(),
    received: recentTransfersTo(CURRENT_USER.key)
  });
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

  var key = trainerKey(trainerName);
  for (var i = 1; i < data.length; i++) {
    if (!key || trainerKey(data[i][2]) !== key) continue;

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

// CheckIns tab: Timestamp | Event ID | Trainer Name | Device ID | Source (qr / redeem) | Shown By
// Shown By is the username whose screen the check-in or code QR was scanned from (blank on older rows).
function getCheckInsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('CheckIns');
  if (!sheet) {
    sheet = ss.insertSheet('CheckIns');
    sheet.appendRow(['Timestamp', 'Event ID', 'Trainer Name', 'Device ID', 'Source', 'Shown By']);
  } else if (sheet.getLastColumn() < 6) {
    sheet.getRange(1, 6).setValue('Shown By');
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
      byKey[key] = { trainerName: name, redeemed: false, checkedIn: false, firstSeen: toIso(rows[i][0]), shownBy: '' };
      order.push(key);
    }
    if (!byKey[key].shownBy && rows[i][5]) byKey[key].shownBy = String(rows[i][5]);
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
        newRows.push([ts.toISOString(), id, String(scans[i][2]).trim(), String(scans[i][12] || ''), 'redeem', String(scans[i][16] || '')]);
      }
      if (newRows.length) {
        var sheet = getCheckInsSheet();
        sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 6).setValues(newRows);
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
    logTrainerChanges([[trainerName, 'Removed from event']], found.event.name);
    return { success: true, attendees: withRedeemedCodes(found.event, eventAttendees(id)) };
  });
}

// Adds the codes each attendee redeemed during the event (from the ScanLog), so an admin can reactivate
// one if the trainer's redemption didn't actually go through, and whether they have event alerts on.
// Each code also says whether it's still on the Codes tab, whether it's active, which bank it's in, and
// whether this login may reactivate it or show its QR.
function withRedeemedCodes(ev, attendees) {
  var byKey = {};
  attendees.forEach(function(a) { a.codes = []; byKey[trainerKey(a.trainerName)] = a; });
  var scanSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('ScanLog');
  if (!scanSheet) return attendees;

  var w = eventWindow(ev);
  var ties = groupEventMap();
  var hasTies = Object.keys(ties).some(function(g) { return ties[g] === ev.id; });
  var codeRows = {};
  var codesSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Codes');
  if (codesSheet && codesSheet.getLastRow() > 1) {
    codesSheet.getRange(2, 1, codesSheet.getLastRow() - 1, 6).getValues().forEach(function(r) {
      codeRows[String(r[0]).trim().toUpperCase()] = { active: r[4] !== 'No', owner: codeOwner(r) };
    });
  }
  scanSheet.getDataRange().getValues().slice(1).forEach(function(row) {
    var a = byKey[trainerKey(row[2])];
    var ts = new Date(row[0]);
    if (!a || !row[1] || isNaN(ts.getTime())) return;
    var tiedTo = ties[groupTieKey(bankKeyFromName(row[15]), String(row[14] || '').trim())] || '';
    // Same rule as redeemerEventIds: tied codes belong to their event, the rest go by date.
    if (tiedTo ? tiedTo !== ev.id : (hasTies || ts < w.since || ts >= w.until)) return;
    var code = String(row[1]).trim().toUpperCase();
    if (a.codes.some(function(c) { return c.code === code; })) return;
    var current = codeRows[code];
    a.codes.push({
      code: code, timestamp: ts.toISOString(), shownBy: String(row[16] || ''),
      exists: !!current, active: !!current && current.active, bank: current ? bankName(current.owner) : '',
      canManage: !!current && (canTouchCode(current.owner) || hasPerm('checkinCodes'))
    });
  });
  var optedIn = readPushOptIns();
  attendees.forEach(function(a) { a.alertsOn = !!optedIn[trainerKey(a.trainerName)]; });
  return attendees;
}

// Why this trainer can't be added to this event's check-ins, or null if they can.
function checkInOutcome(rows, id, key, deviceId, trackDevice) {
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
  return null;
}

// Check-in rows added since seen sheet rows (header included) were read. Caller holds the script lock.
function checkInRowsSince(sheet, seen) {
  var last = sheet.getLastRow();
  if (last < seen) return sheet.getDataRange().getValues().slice(1); // Rows were removed, so check everything.
  if (last === seen) return [];
  return sheet.getRange(seen + 1, 1, last - seen, 5).getValues();
}

function checkIn(id, trainerName, deviceId, by) {
  trainerName = String(trainerName).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9]+$/.test(trainerName)) {
    return { success: false, error: 'Trainer names are letters and numbers only' };
  }
  deviceId = String(deviceId || '');
  var trackDevice = deviceId && deviceId !== 'dev-unknown';

  // Read before taking the lock, so a crowd checking in spends as little time as possible waiting in line.
  var found = findEvent(id);
  if (!found) return { success: false, error: 'Event not found' };
  if (!found.event.open) return { success: false, closed: true };

  var key = trainerKey(trainerName);
  var rows = checkInRows();
  var outcome = checkInOutcome(rows, id, key, deviceId, trackDevice);
  if (outcome) return outcome;

  return withLock(function() {
    var sheet = getCheckInsSheet();
    // Someone may have checked in while this request waited for the lock.
    var late = checkInOutcome(checkInRowsSince(sheet, rows.length + 1), id, key, deviceId, trackDevice);
    if (late) return late;
    sheet.appendRow([new Date().toISOString(), id, trainerName, deviceId, 'qr', cleanBy(by)]);
    return { success: true, alreadyCheckedIn: false };
  });
}

// The events a redeemed code checks this trainer into. A code from a group tied to an event checks them into
// that event (any day, while it's open). Other codes go to open events running that day that don't have
// groups of their own tied to them. Groups belong to a bank, so owner says whose group it is.
function redeemerEventIds(trainerName, timestamp, group, owner, rows) {
  var key = trainerKey(trainerName);
  var ts = new Date(timestamp);
  if (!key || isNaN(ts.getTime())) return [];

  var ties = groupEventMap();
  var tiedEvent = ties[groupTieKey(owner || '', group || '')] || '';
  var eventsWithTies = {};
  Object.keys(ties).forEach(function(g) { eventsWithTies[ties[g]] = true; });

  var ids = [];
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
    if (!already) ids.push(ev.id);
  });
  return ids;
}

// Caller (logScan) holds the script lock. seen is how many CheckIns sheet rows existed when ids was worked out.
function addRedeemerToEvents(ids, trainerName, timestamp, deviceId, seen, by) {
  if (!ids.length) return;
  var key = trainerKey(trainerName);
  var sheet = getCheckInsSheet();
  var late = checkInRowsSince(sheet, seen);
  ids.forEach(function(id) {
    var already = late.some(function(row) { return String(row[1]) === id && trainerKey(row[2]) === key; });
    if (!already) sheet.appendRow([new Date(timestamp).toISOString(), id, String(trainerName).trim(), deviceId, 'redeem', by || '']);
  });
}

// ---------- Lotteries ----------

// Lotteries tab: Id | Name | Created At | Since | Closed At | Winners (JSON array) | Overrides (JSON) | Winner Count | Event ID
// Overrides = { excluded: [trainerKey], renames: { originalTrainerKey: displayName }, added: [trainerName] } so
// admin edits apply to entrants without touching the ScanLog or CheckIns.
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

// Rules = { excludeRecentEvents: N, excludeLotteryIds: [...], entryPerCheckIn: bool }; they only affect the
// lottery they're set on. entryPerCheckIn only applies to lotteries drawing from a whole Campfire upload:
// each meetup someone checked in to is one more entry for them.
function parseRules(value) {
  var r = {};
  try { r = JSON.parse(value || '{}') || {}; } catch (err) {}
  return {
    excludeRecentEvents: Math.max(0, Math.min(10, parseInt(r.excludeRecentEvents, 10) || 0)),
    excludeLotteryIds: Array.isArray(r.excludeLotteryIds) ? r.excludeLotteryIds.map(String) : [],
    entryPerCheckIn: r.entryPerCheckIn === true
  };
}

function parseOverrides(value) {
  var o = {};
  try { o = JSON.parse(value || '{}') || {}; } catch (err) {}
  return { excluded: o.excluded || [], renames: o.renames || {}, skipped: o.skipped || [], added: o.added || [] };
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
    if (!already) logTrainerChanges([[trainerName, 'Won']], found.lottery.name);
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

function setLotteryRules(id, excludeRecentEvents, excludeLotteryIds, entryPerCheckIn) {
  var ids;
  try { ids = JSON.parse(excludeLotteryIds || '[]'); } catch (err) { return { error: 'Invalid lottery list' }; }
  var rules = parseRules(JSON.stringify({ excludeRecentEvents: excludeRecentEvents, excludeLotteryIds: ids, entryPerCheckIn: !!entryPerCheckIn }));
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
    if (found.changes) logTrainerChanges(found.changes, found.lottery.name);
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
    found.changes = [[newName, 'Renamed from ' + oldName]];
    if (oldKey !== newKey) found.changes.push([oldName, 'Renamed to ' + newName]);
  });
}

function removeEntrant(id, trainerName) {
  var key = trainerKey(trainerName);
  if (!key) return { error: 'Trainer name is required' };
  return entrantMutation(id, function(found) {
    if (found.overrides.excluded.indexOf(key) === -1) found.overrides.excluded.push(key);
    found.overrides.added = found.overrides.added.filter(function(n) {
      return trainerKey(resolveEntrantName(found.overrides, n)) !== key;
    });
    found.lottery.winners = withoutKey(found.lottery.winners, key);
    found.changes = [[trainerName, 'Removed from lottery']];
  });
}

// Typed in by an admin, so it also brings back someone who was removed from this lottery.
function addEntrant(id, trainerName) {
  trainerName = String(trainerName).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9]+$/.test(trainerName)) return { error: 'Trainer names are letters and numbers only' };

  return entrantMutation(id, function(found) {
    var name = resolveEntrantName(found.overrides, trainerName);
    var key = trainerKey(name);
    if (buildEntrants(found).some(function(e) { return trainerKey(e.trainerName) === key; })) {
      return name + ' is already on the list';
    }
    found.overrides.excluded = found.overrides.excluded.filter(function(k) { return k !== key; });
    found.overrides.added.push(trainerName);
    found.changes = [[name, 'Added to lottery']];
  });
}

// An admin's call, so unlike a draw it overrides draw rules and a skip, and makes room if every winner is drawn.
function markWinner(id, trainerName) {
  var key = trainerKey(trainerName);
  if (!key) return { error: 'Trainer name is required' };

  return entrantMutation(id, function(found) {
    var entrant = buildEntrants(found).filter(function(e) { return trainerKey(e.trainerName) === key; })[0];
    if (!entrant) return trainerName + ' is not on this lottery\'s list';
    var winners = found.lottery.winners;
    if (winners.some(function(w) { return trainerKey(w) === key; })) return;
    if (winners.length >= 10) return 'A lottery can have at most 10 winners';
    winners.push(entrant.trainerName);
    if (winners.length > found.lottery.winnerCount) {
      getLotteriesSheet().getRange(found.row, 8).setValue(winners.length);
      found.lottery.winnerCount = winners.length;
    }
    found.overrides.skipped = found.overrides.skipped.filter(function(k) { return k !== key; });
    found.changes = [[entrant.trainerName, 'Marked as winner']];
  });
}

function unmarkWinner(id, trainerName) {
  var key = trainerKey(trainerName);
  if (!key) return { error: 'Trainer name is required' };
  return entrantMutation(id, function(found) {
    found.lottery.winners = withoutKey(found.lottery.winners, key);
    found.changes = [[trainerName, 'Win undone']];
  });
}

// For a winner who isn't around to claim: drop the win and keep them out of later draws for this lottery.
function skipWinner(id, trainerName) {
  var key = trainerKey(trainerName);
  if (!key) return { error: 'Trainer name is required' };
  return entrantMutation(id, function(found) {
    found.lottery.winners = withoutKey(found.lottery.winners, key);
    if (found.overrides.skipped.indexOf(key) === -1) found.overrides.skipped.push(key);
    found.changes = [[trainerName, 'Skipped as a winner']];
  });
}

function unskipEntrant(id, trainerName) {
  var key = trainerKey(trainerName);
  if (!key) return { error: 'Trainer name is required' };
  return entrantMutation(id, function(found) {
    found.overrides.skipped = found.overrides.skipped.filter(function(k) { return k !== key; });
    found.changes = [[trainerName, 'Restored to the draw']];
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
    if (!entrants[key]) entrants[key] = { trainerName: name, redeemed: false, signedUp: false, checkedIn: false, campfire: false, checkIns: 0, entries: 1 };
    entrants[key][flag] = true;
    if (flag === 'campfire') entrants[key].checkIns++;
  }

  function sorted() {
    overrides.added.forEach(function(n) { add(n, 'manual'); });
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
    // A whole upload lists each person once per meetup they checked in to; with the rule on, each is an entry.
    if (found.lottery.eventId.indexOf('cfx:') === 0 && found.lottery.rules.entryPerCheckIn) {
      Object.keys(entrants).forEach(function(k) { entrants[k].entries = Math.max(1, entrants[k].checkIns); });
    }
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

// TrainerLog tab: Timestamp | Trainer Key | Trainer Name | Change | Where | By
// Holds admin changes, which would otherwise leave no trace. Check-ins, redemptions and sign-ups already have
// timestamped rows of their own, so the public pages never write here and stay as fast as they were.
function trainerLogSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('TrainerLog');
  if (!sheet) {
    sheet = ss.insertSheet('TrainerLog');
    sheet.appendRow(['Timestamp', 'Trainer Key', 'Trainer Name', 'Change', 'Where', 'By']);
  } else if (sheet.getLastColumn() < 6) {
    sheet.getRange(1, 6).setValue('By');
  }
  return sheet;
}

// A leading apostrophe stops a name or title from being read as a sheet formula.
function plainCell(value) {
  var text = String(value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

// changes: [[trainerName, change], ...]. The change itself has already been saved, so a logging problem
// shouldn't report it as failed.
function logTrainerChanges(changes, where) {
  try {
    var sheet = trainerLogSheet();
    var now = new Date().toISOString();
    changes.forEach(function(c) {
      sheet.appendRow([now, trainerKey(c[0]), plainCell(c[0]), plainCell(c[1]), plainCell(where), CURRENT_USER ? CURRENT_USER.name : '']);
    });
  } catch (err) {}
}

function getTrainerHistory() {
  var people = {};

  function person(rawName) {
    var name = String(rawName || '').trim();
    var key = trainerKey(name);
    if (!key) return null;
    if (!people[key]) people[key] = { trainerName: name, events: [], redemptions: 0, wins: [], lastSeen: '', changelog: [] };
    return people[key];
  }

  function seen(p, value) {
    var iso = toIso(value);
    if (iso && iso > p.lastSeen) p.lastSeen = iso;
  }

  function logged(p, value, text, dateOnly) {
    var at = toIso(value);
    if (at) p.changelog.push({ at: at, text: text, dateOnly: !!dateOnly });
  }

  var eventsById = {};
  readEvents().forEach(function(r) { eventsById[r.event.id] = r.event; });

  var attended = {};
  checkInRows().forEach(function(row) {
    var ev = eventsById[String(row[1])];
    var p = person(row[2]);
    if (!ev || !p) return;
    seen(p, row[0]);
    logged(p, row[0], (String(row[4]) === 'redeem' ? 'Checked in by redeeming a code: ' : 'Checked in: ') + ev.name);
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
      logged(p, row[0], 'Redeemed code: ' + row[1]);
    });
  }

  var loggedWins = {};
  var logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('TrainerLog');
  if (logSheet) {
    logSheet.getDataRange().getValues().slice(1).forEach(function(row) {
      var p = person(row[2]);
      if (!p) return;
      logged(p, row[0], row[3] + ': ' + row[4] + (row[5] ? ' (by ' + row[5] + ')' : ''));
      if (row[3] === 'Won' || row[3] === 'Marked as winner') loggedWins[trainerKey(row[2]) + '|' + row[4]] = true;
    });
  }

  var lotteries = readLotteries();
  var lotteryNames = {};
  lotteries.forEach(function(r) {
    var l = r.lottery;
    lotteryNames[l.id] = l.name;
    var ev = l.eventId && eventsById[l.eventId];
    l.winners.forEach(function(w) {
      var p = person(w);
      if (!p) return;
      var date = ev ? ev.date : l.since;
      p.wins.push({ lottery: l.name, event: ev ? ev.name : '', date: date });
      if (!loggedWins[trainerKey(w) + '|' + l.name]) logged(p, date, 'Won: ' + l.name, true);
    });
  });

  var entrySheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Lottery');
  if (entrySheet) {
    entrySheet.getDataRange().getValues().slice(1).forEach(function(row) {
      var p = person(row[1]);
      if (p && lotteryNames[String(row[3])]) logged(p, row[0], 'Entered lottery: ' + lotteryNames[String(row[3])]);
    });
  }

  var list = Object.keys(people).map(function(k) {
    var p = people[k];
    p.events.sort(function(a, b) { return a.date < b.date ? 1 : -1; });
    p.wins.sort(function(a, b) { return a.date < b.date ? 1 : -1; });
    p.changelog.sort(function(a, b) { return a.at < b.at ? 1 : -1; });
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
