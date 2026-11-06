const STORAGE_KEYS = {
  CODES: 'pogo_codes',
  GROUPS: 'pogo_groups',
  GROUP_EVENTS: 'pogo_group_events',
  SCRIPT_URL: 'pogo_script_url',
};

// A code's group is its label. Groups can be paused without touching whether each code was used.
function groupOf(code) {
  return String(code.label || '').trim();
}

// Each login has its own code bank. A code's owner is that login's username, or '' for the overseer.
function ownerOf(code) {
  return code.owner || '';
}

// Every bank has its own groups, so a group is its owner plus its name.
function groupKey(owner, name) {
  return `${owner || ''}\n${name}`;
}

function getGroupStates() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.GROUPS)) || {}; } catch { return {}; }
}

function saveGroupStates(list) {
  const states = {};
  (list || []).forEach(g => { states[groupKey(g.owner, g.name)] = g.enabled !== false; });
  try { localStorage.setItem(STORAGE_KEYS.GROUPS, JSON.stringify(states)); } catch {}
  const events = {};
  (list || []).forEach(g => { if (g.eventId) events[groupKey(g.owner, g.name)] = { id: g.eventId, name: g.eventName || '' }; });
  try { localStorage.setItem(STORAGE_KEYS.GROUP_EVENTS, JSON.stringify(events)); } catch {}
}

// The event a group is tied to ({ id, name }), or null when its redemptions go by date.
function groupEvent(owner, name) {
  try { return (JSON.parse(localStorage.getItem(STORAGE_KEYS.GROUP_EVENTS)) || {})[groupKey(owner, name)] || null; } catch { return null; }
}

function isGroupEnabled(owner, name) {
  return getGroupStates()[groupKey(owner, name)] !== false;
}

// Codes the Display tab hands out: unused, in an enabled group, and from the bank being shown.
function getDisplayCodes() {
  const bank = displayBank();
  return getCodes().filter(c => ownerOf(c) === bank && c.active !== false && isGroupEnabled(bank, groupOf(c)));
}

// ---------- Logins ----------
// Who's logged in comes from auth.js. The server enforces every permission; the dashboard just hides what
// a login can't use. banks lists every code bank ({ key, name, enabled }), refreshed with each sync.
let banks = [];

function me() {
  return getCurrentUser() || { key: '', name: '', overseer: false, perms: [] };
}

function can(perm) {
  const user = me();
  return user.overseer || user.perms.includes(perm);
}

function bankLabel(key) {
  const bank = banks.find(b => b.key === (key || ''));
  return bank ? bank.name : (key || 'Overseer');
}

// Shown By values are lowercase usernames; show them as the login's own spelling.
function usernameLabel(value) {
  const key = String(value || '').toLowerCase();
  if (!key) return '';
  if (key === me().name.toLowerCase()) return 'you';
  const bank = banks.find(b => b.name.toLowerCase() === key);
  return bank ? bank.name : key;
}

// Elements marked data-needs="perm" (or "overseer") hide for logins without it, including ones drawn later.
const PERMISSION_KEYS = ['sendCodes', 'checkin', 'checkinRemove', 'checkinCodes', 'checkinDelete', 'lottery', 'lotteryEdit',
  'lotteryDelete', 'trainers', 'campfire', 'campfireManage', 'logs'];
const TAB_PERMISSIONS = { checkin: 'checkin', lottery: 'lottery', trainers: 'trainers' };

function applyPermissions() {
  const user = me();
  document.body.classList.toggle('is-overseer', user.overseer);
  PERMISSION_KEYS.forEach(p => document.body.classList.toggle(`lacks-${p}`, !can(p)));
  document.querySelectorAll('.tab').forEach(tab => {
    const perm = TAB_PERMISSIONS[tab.dataset.tab];
    tab.classList.toggle('hidden', !!perm && !can(perm));
  });
  document.getElementById('logged-in-as').textContent = user.name ? `Logged in as ${user.name}${user.overseer ? ' (overseer)' : ''}` : '';
  renderBankPickers();
  const active = document.querySelector('.tab.active');
  if (active && active.classList.contains('hidden')) activateTab('active-codes');
}

function setBanks(list, user) {
  if (Array.isArray(list)) banks = list;
  if (user) {
    const before = JSON.stringify(me());
    updateSessionUser(user);
    if (JSON.stringify(me()) !== before) applyPermissions();
  }
  renderBankPickers();
}

// The overseer can look at any bank on Active Codes (or all of them) and show any bank on Display.
const BANK_VIEW_KEY = 'pogo_bank_view';
const DISPLAY_BANK_KEY = 'pogo_display_bank';

function codesBankView() {
  if (!me().overseer) return me().key;
  let view = '';
  try { view = localStorage.getItem(BANK_VIEW_KEY) || ''; } catch {}
  return view === '*' || banks.some(b => b.key === view) ? view : '';
}

function displayBank() {
  if (!me().overseer) return me().key;
  let bank = '';
  try { bank = localStorage.getItem(DISPLAY_BANK_KEY) || ''; } catch {}
  return banks.some(b => b.key === bank) ? bank : '';
}

function renderBankPickers() {
  const several = me().overseer && banks.length > 1;
  const option = (b) => `<option value="${escapeHtml(b.key)}">${escapeHtml(b.name)}${b.key === '' ? ' (you)' : ''}${b.enabled ? '' : ' (turned off)'}</option>`;
  const codesPicker = document.getElementById('codes-bank');
  codesPicker.innerHTML = banks.map(option).join('') + '<option value="*">All banks</option>';
  codesPicker.value = codesBankView();
  document.getElementById('codes-bank-row').classList.toggle('hidden', !several);
  const displayPicker = document.getElementById('display-bank');
  displayPicker.innerHTML = banks.map(option).join('');
  displayPicker.value = displayBank();
  document.getElementById('display-bank-row').classList.toggle('hidden', !several);
}

document.getElementById('codes-bank').addEventListener('change', (e) => {
  try { localStorage.setItem(BANK_VIEW_KEY, e.target.value); } catch {}
  renderCodesList();
});

document.getElementById('display-bank').addEventListener('change', (e) => {
  try { localStorage.setItem(DISPLAY_BANK_KEY, e.target.value); } catch {}
  initDisplay();
});

function getCodes() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.CODES)) || [];
  } catch {
    return [];
  }
}

function saveCodes(codes) {
  try {
    localStorage.setItem(STORAGE_KEYS.CODES, JSON.stringify(codes));
  } catch {}
}

function getSetting(key) {
  if (key === STORAGE_KEYS.SCRIPT_URL && typeof SITE_CONFIG !== 'undefined' && SITE_CONFIG.scriptUrl) {
    return SITE_CONFIG.scriptUrl;
  }
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

// QR codes and shared links always point at the live site, even when the dashboard runs on localhost.
const PUBLIC_SITE_URL = 'https://j-ding.github.io/pogo-code-dist';

function getBaseUrl() {
  return PUBLIC_SITE_URL;
}

// QR links say whose screen they were shown on (by=username), which the scan and check-in logs record.
function shownByParam() {
  const name = me().name;
  return name ? `&by=${encodeURIComponent(name.toLowerCase())}` : '';
}

function getRedeemUrl(code) {
  return `${getBaseUrl()}/redeem.html?code=${encodeURIComponent(code)}${shownByParam()}`;
}

function getDirectRedeemUrl(code) {
  return `https://store.pokemongo.com/offer-redemption?passcode=${encodeURIComponent(code)}`;
}

function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

// Tabs
function activateTab(name) {
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (!tab) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  tab.classList.add('active');
  document.getElementById(name).classList.add('active');
  try { localStorage.setItem('pogo_active_tab', name); } catch {}
  if (name !== 'display' && typeof stopDisplayPolling === 'function') stopDisplayPolling();

  // Show the cached list right away, then refresh from the sheet so changes from other devices appear.
  if (name === 'active-codes') {
    renderCodesList();
    refreshCodesQuietly().then(changed => { if (changed && activeTabName() === 'active-codes') renderCodesList(); });
  }
  if (name === 'display') {
    initDisplay();
    refreshCodesQuietly().then(changed => { if (changed && activeTabName() === 'display') initDisplay(); });
  }
  if (name === 'settings') {
    if (can('logs')) loadScanLog();
    initCommunity();
    if (can('campfire')) loadCampfireList();
    if (me().overseer) loadAccounts();
  }
  if (name === 'checkin') initCheckIn();
  if (name === 'lottery') initLottery();
  if (name === 'trainers') loadTrainers();
}

// Trainers
let trainerHistory = [];

async function loadTrainers() {
  const list = document.getElementById('trainer-list');
  if (!trainerHistory.length) list.innerHTML = '<p class="empty-state">Loading trainers...</p>';
  try {
    const data = await callSheet({ action: 'getTrainerHistory' });
    trainerHistory = data.trainers || [];
    renderTrainers();
  } catch (err) {
    list.innerHTML = `<p class="empty-state">Couldn't load trainers: ${escapeHtml(err.message)}</p>`;
  }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Wins from before the changelog existed only have their event's date.
function formatChangeTime(entry) {
  const date = new Date(entry.at);
  return entry.dateOnly ? date.toLocaleDateString() : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
}

function formatTimeWithSeconds(value) {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function renderTrainers() {
  const list = document.getElementById('trainer-list');
  const query = trainerKey(document.getElementById('trainer-search').value);
  const shown = query ? trainerHistory.filter(t => trainerKey(t.trainerName).includes(query)) : trainerHistory;
  document.getElementById('trainer-count').textContent = trainerHistory.length;

  if (!shown.length) {
    list.innerHTML = `<p class="empty-state">${trainerHistory.length ? 'No trainers match that search.' : 'No trainers yet. They appear here after checking in or redeeming a code.'}</p>`;
    return;
  }

  list.innerHTML = shown.map(t => {
    const events = t.events.length
      ? `<ul>${t.events.map(ev => `<li>${escapeHtml(ev.name)} <span class="code-meta">${new Date(ev.date).toLocaleDateString()}</span></li>`).join('')}</ul>`
      : '<p class="code-meta">No event check-ins.</p>';
    const wins = t.wins.length
      ? `<ul>${t.wins.map(w => `<li>${escapeHtml(w.lottery)} <span class="code-meta">${escapeHtml(w.event || '')}${w.date ? ' · ' + new Date(w.date).toLocaleDateString() : ''}</span></li>`).join('')}</ul>`
      : '<p class="code-meta">No lottery wins.</p>';
    const changelog = !t.changelog ? '<p class="code-meta">Redeploy the Apps Script to see this.</p>'
      : t.changelog.length ? `<ul>${t.changelog.map(c => `<li>${escapeHtml(c.text)} <span class="code-meta">${formatChangeTime(c)}</span></li>`).join('')}</ul>`
      : '<p class="code-meta">Nothing yet.</p>';
    return `
      <details class="trainer-row">
        <summary>
          <span class="lottery-name">${escapeHtml(t.trainerName)}</span>
          <span class="trainer-stats">
            <span class="badge badge-new">${plural(t.events.length, 'event')}</span>
            <span class="badge badge-active">${plural(t.redemptions, 'code')}</span>
            ${t.wins.length ? `<span class="badge badge-winner">${plural(t.wins.length, 'win')}</span>` : ''}
          </span>
          <span class="code-meta">${t.lastSeen ? 'Last seen ' + new Date(t.lastSeen).toLocaleString() : ''}</span>
        </summary>
        <div class="trainer-detail">
          <div><h4>Events attended</h4>${events}</div>
          <div><h4>Lottery wins</h4>${wins}</div>
          <div class="trainer-changelog"><h4>Changelog</h4>${changelog}</div>
        </div>
      </details>
    `;
  }).join('');
}

document.getElementById('trainer-search').addEventListener('input', renderTrainers);
document.getElementById('trainer-refresh').addEventListener('click', loadTrainers);

const COMMUNITY_LINKS = {
  discord: 'https://discord.gg/EhGPPT4sPA',
  campfire: 'https://campfire.onelink.me/eBr8?af_dp=campfire://&af_force_deeplink=true&deep_link_sub1=cj1jbHVicyZjPWU1N2IyZWZhLTI5NTktNDA2MC1hNzg5LWI4ZGIyZDU3OWFhNiZpPXRydWU=',
  webstore: 'https://store.pokemongo.com/',
};

let communityRendered = false;

function initCommunity() {
  if (communityRendered) return;
  communityRendered = true;
  const size = Math.min(window.innerWidth - 96, 240);
  Object.entries(COMMUNITY_LINKS).forEach(([key, url]) => {
    new QRCode(document.getElementById(`community-qr-${key}`), {
      text: url,
      width: size,
      height: size,
      colorDark: '#1a1a2e',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.L,
    });
  });
}

document.getElementById('community-links').addEventListener('click', (e) => {
  const button = e.target.closest('[data-community-action]');
  if (!button) return;
  const key = button.closest('.community-card').dataset.link;

  if (button.dataset.communityAction === 'copy') {
    navigator.clipboard.writeText(COMMUNITY_LINKS[key]).then(() => showToast('Link copied'));
    return;
  }
  const canvas = document.querySelector(`#community-qr-${key} canvas`);
  if (canvas) downloadQrCanvas(canvas, `pogo-${key}-qr.png`);
});

// Tab order: press and hold a tab to pick it up, then drag. A quick click still switches tabs.
const TAB_ORDER_KEY = 'pogo_tab_order';
const tabBar = document.querySelector('.tabs');
const DEFAULT_TAB_ORDER = [...tabBar.querySelectorAll('.tab')].map(t => t.dataset.tab);

function applyTabOrder(order) {
  const tabs = new Map([...tabBar.querySelectorAll('.tab')].map(t => [t.dataset.tab, t]));
  order.forEach(name => { if (tabs.has(name)) { tabBar.appendChild(tabs.get(name)); tabs.delete(name); } });
  tabs.forEach(t => tabBar.appendChild(t));
}

function saveTabOrder() {
  try { localStorage.setItem(TAB_ORDER_KEY, JSON.stringify([...tabBar.querySelectorAll('.tab')].map(t => t.dataset.tab))); } catch {}
}

try {
  const saved = JSON.parse(localStorage.getItem(TAB_ORDER_KEY));
  if (Array.isArray(saved)) applyTabOrder(saved);
} catch {}

const tabDrag = { timer: null, tab: null, active: false, startX: 0, startY: 0, suppressClick: false };

function endTabDrag() {
  clearTimeout(tabDrag.timer);
  if (tabDrag.active) {
    tabDrag.tab.classList.remove('tab-dragging');
    tabBar.classList.remove('tabs-reordering');
    saveTabOrder();
    tabDrag.suppressClick = true;
  }
  tabDrag.tab = null;
  tabDrag.active = false;
}

tabBar.addEventListener('pointerdown', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab || (e.pointerType === 'mouse' && e.button !== 0)) return;
  tabDrag.tab = tab;
  tabDrag.startX = e.clientX;
  tabDrag.startY = e.clientY;
  tabDrag.timer = setTimeout(() => {
    tabDrag.active = true;
    tab.classList.add('tab-dragging');
    tabBar.classList.add('tabs-reordering');
    try { tab.setPointerCapture(e.pointerId); } catch {}
    if (navigator.vibrate) navigator.vibrate(15);
  }, 350);
});

tabBar.addEventListener('pointermove', (e) => {
  if (!tabDrag.tab) return;
  if (!tabDrag.active) {
    // Moving before the hold finishes means the user is scrolling or clicking, not dragging.
    if (Math.hypot(e.clientX - tabDrag.startX, e.clientY - tabDrag.startY) > 8) endTabDrag();
    return;
  }
  e.preventDefault();
  const over = document.elementFromPoint(e.clientX, e.clientY);
  const target = over && over.closest('.tabs .tab');
  if (!target || target === tabDrag.tab) return;
  const rect = target.getBoundingClientRect();
  const before = e.clientY < rect.top || (e.clientY <= rect.bottom && e.clientX < rect.left + rect.width / 2);
  tabBar.insertBefore(tabDrag.tab, before ? target : target.nextSibling);
});

tabBar.addEventListener('pointerup', endTabDrag);
tabBar.addEventListener('pointercancel', endTabDrag);
// Stops the page from scrolling under your finger while a tab is being dragged on a phone.
tabBar.addEventListener('touchmove', (e) => { if (tabDrag.active) e.preventDefault(); }, { passive: false });
tabBar.addEventListener('contextmenu', (e) => { if (e.target.closest('.tab')) e.preventDefault(); });

tabBar.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  if (tabDrag.suppressClick) {
    tabDrag.suppressClick = false;
    return;
  }
  activateTab(tab.dataset.tab);
});

document.getElementById('reset-tab-order').addEventListener('click', () => {
  applyTabOrder(DEFAULT_TAB_ORDER);
  try { localStorage.removeItem(TAB_ORDER_KEY); } catch {}
  showToast('Tab order reset');
});

// Date-only strings come from the date picker; the sheet returns full timestamps for the same dates.
function formatExpiry(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString();
  }
  const date = new Date(value);
  return isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// Lottery
const lotteryState = { lotteries: [], selectedId: null, entrants: [], drawing: false, editingKey: null };

function todayInputValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function selectedLottery() {
  return lotteryState.lotteries.find(l => l.id === lotteryState.selectedId) || null;
}

function trainerKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isWinner(lottery, name) {
  return lottery.winners.some(w => trainerKey(w) === trainerKey(name));
}

// Campfire meetups and multi-meetup uploads a lottery can draw from (ids "cf:..." and "cfx:...").
let campfireSources = { meetups: [], uploads: [] };

async function loadCampfireSources() {
  try {
    campfireSources = await callSheet({ action: 'getLotterySources' });
  } catch {
    // Lotteries still work from Check In events if the uploads can't be read.
  }
}

async function initLottery() {
  await Promise.all([loadEvents(), loadCampfireSources()]);
  fillEventSelect(document.getElementById('lottery-event'));
  loadLotteries();
}

function eventLabel(ev) {
  return `${ev.name} (${new Date(ev.date).toLocaleDateString()})`;
}

function campfireSourceLabel(s) {
  const day = s.date ? ` (${new Date(s.date).toLocaleDateString()})` : '';
  const meetups = s.meetups ? `${s.meetups} meetups, ` : '';
  return `${s.name}${day} · ${meetups}${s.checkedIn} checked in`;
}

function fillEventSelect(select, selectedId) {
  const events = eventState.events;
  const { meetups = [], uploads = [] } = campfireSources;
  if (!events.length && !meetups.length && !uploads.length) {
    select.innerHTML = '<option value="">Create an event in the Check In tab, or upload a Campfire meetup in Settings</option>';
    return;
  }
  const group = (label, items, text) => items.length
    ? `<optgroup label="${escapeHtml(label)}">${items.map(x => `<option value="${escapeHtml(x.id)}">${escapeHtml(text(x))}</option>`).join('')}</optgroup>`
    : '';
  select.innerHTML = group('Check In events', events, eventLabel)
    + group('Campfire meetups', meetups, campfireSourceLabel)
    + group('Campfire uploads (every meetup in the file)', uploads, campfireSourceLabel);
  if (selectedId && select.querySelector(`option[value="${CSS.escape(selectedId)}"]`)) select.value = selectedId;
}

function lotteryEventName(lottery) {
  if (/^cfx?:/.test(lottery.eventId)) {
    return lottery.sourceName ? `Campfire: ${lottery.sourceName}` : 'Deleted Campfire upload';
  }
  const ev = eventState.events.find(e => e.id === lottery.eventId);
  return ev ? eventLabel(ev) : 'Deleted event';
}

async function loadLotteries() {
  const history = document.getElementById('lottery-history');
  try {
    const data = await callSheet({ action: 'getLotteries' });
    lotteryState.lotteries = data.lotteries || [];
  } catch (err) {
    history.innerHTML = `<p class="empty-state">Couldn't load lotteries: ${escapeHtml(err.message)}</p>`;
    return;
  }

  let saved = null;
  try { saved = localStorage.getItem('pogo_lottery_selected'); } catch {}
  const exists = id => lotteryState.lotteries.some(l => l.id === id);
  const id = exists(lotteryState.selectedId) ? lotteryState.selectedId
    : exists(saved) ? saved
    : (lotteryState.lotteries[0] && lotteryState.lotteries[0].id);

  renderLotteryHistory();
  if (id) selectLottery(id);
  else document.getElementById('lottery-detail').classList.add('hidden');
}

// Old lotteries and used-up code groups sit in a collapsed section at the end of their list. Whether it's open
// is remembered on this device, and it opens by itself when it holds the selected lottery.
const OLDER_OPEN_KEY = 'pogo_older_open';

function isOlderOpen(key) {
  try { return (JSON.parse(localStorage.getItem(OLDER_OPEN_KEY)) || []).includes(key); } catch { return false; }
}

function setOlderOpen(key, open) {
  let keys = [];
  try { keys = JSON.parse(localStorage.getItem(OLDER_OPEN_KEY)) || []; } catch {}
  keys = keys.filter(k => k !== key);
  if (open) keys.push(key);
  try { localStorage.setItem(OLDER_OPEN_KEY, JSON.stringify(keys)); } catch {}
}

function olderSection(key, label, count, inner, forceOpen) {
  if (!count) return '';
  return `
    <details class="older-section" data-older="${key}"${forceOpen ? ' data-forced="1"' : ''}${forceOpen || isOlderOpen(key) ? ' open' : ''}>
      <summary>${label} (${count})</summary>
      <div class="older-body">${inner}</div>
    </details>
  `;
}

// A lottery is old once its day is over: the day of its event, or for older lotteries the day it was made.
function isOldLottery(l) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(l.since || l.createdAt);
  return !isNaN(day.getTime()) && day < today;
}

function renderLotteryHistory() {
  const history = document.getElementById('lottery-history');
  if (lotteryState.lotteries.length === 0) {
    history.innerHTML = '<p class="empty-state">No lotteries yet. Create one above.</p>';
    return;
  }

  const item = l => {
    const source = l.eventId ? lotteryEventName(l) : new Date(l.createdAt).toLocaleDateString();
    const winners = l.winners.length ? ` · Winner${l.winners.length > 1 ? 's' : ''}: ${l.winners.join(', ')}` : '';
    const badge = l.eventId ? '' : `<span class="badge ${l.open ? 'badge-active' : 'badge-inactive'}">${l.open ? 'Open' : 'Closed'}</span>`;
    return `
      <button type="button" class="lottery-history-item${l.id === lotteryState.selectedId ? ' selected' : ''}" data-id="${escapeHtml(l.id)}">
        <span class="lottery-history-main">
          <span class="lottery-name">${escapeHtml(l.name)}</span>
          <span class="code-meta">${escapeHtml(source + winners)}</span>
        </span>
        ${badge}
      </button>
    `;
  };
  const current = lotteryState.lotteries.filter(l => !isOldLottery(l));
  const old = lotteryState.lotteries.filter(isOldLottery);
  history.innerHTML = (current.length ? current.map(item).join('') : '<p class="empty-state">No lotteries today. Older ones are below.</p>')
    + olderSection('lotteries', 'Older lotteries', old.length, old.map(item).join(''), old.some(l => l.id === lotteryState.selectedId));

  history.querySelectorAll('.lottery-history-item').forEach(el => {
    el.addEventListener('click', () => selectLottery(el.dataset.id));
  });
}

document.getElementById('lottery-history').addEventListener('toggle', (e) => {
  // Opening by itself for the selected lottery isn't the viewer's choice, so only a close is saved then.
  if (!e.target.matches('.older-section') || (e.target.dataset.forced && e.target.open)) return;
  setOlderOpen(e.target.dataset.older, e.target.open);
}, true);

function renderLotteryHeader(lottery) {
  document.getElementById('lottery-title').textContent = lottery.name;

  // Lotteries created before events existed keep their own open/closed state and check-in date.
  const legacy = !lottery.eventId;
  const status = document.getElementById('lottery-status');
  status.textContent = lottery.open ? 'Open' : 'Closed';
  status.className = `badge ${lottery.open ? 'badge-active' : 'badge-inactive'}`;
  status.classList.toggle('hidden', !legacy);

  if (legacy) {
    const checkIn = new Date(lottery.since).toLocaleDateString();
    const closed = lottery.closedAt ? ` · Closed ${new Date(lottery.closedAt).toLocaleString()}` : '';
    document.getElementById('lottery-meta').textContent = `Check-in date: ${checkIn}${closed}`;
  } else {
    document.getElementById('lottery-meta').textContent = `Entrants from: ${lotteryEventName(lottery)}`;
  }

  const toggle = document.getElementById('lottery-toggle');
  toggle.textContent = lottery.open ? 'Close Lottery' : 'Reopen';
  toggle.classList.toggle('hidden', !legacy);
  updateDrawButton(lottery);
  renderLotteryRules(lottery);

  const banner = document.getElementById('lottery-winner-banner');
  if (lottery.winners.length) {
    banner.textContent = `Winner${lottery.winners.length > 1 ? 's' : ''}: ${lottery.winners.join(', ')}`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function selectLottery(id) {
  const lottery = lotteryState.lotteries.find(l => l.id === id);
  if (!lottery) return;

  if (lotteryState.selectedId !== id) lotteryState.editingKey = null;
  lotteryState.selectedId = id;
  try { localStorage.setItem('pogo_lottery_selected', id); } catch {}

  showLotteryEditForm(false);
  document.getElementById('lottery-detail').classList.remove('hidden');
  renderLotteryHeader(lottery);
  renderLotteryHistory();
  loadLotteryEntrants();
}

async function loadLotteryEntrants() {
  const lottery = selectedLottery();
  if (!lottery) return;

  const list = document.getElementById('lottery-list');
  list.innerHTML = '<p class="empty-state">Loading entrants...</p>';

  try {
    const data = await callSheet({ action: 'getLotteryEntrants', id: lottery.id });
    if (lotteryState.selectedId !== lottery.id) return;
    lotteryState.entrants = data.entrants || [];
    renderLotteryEntrants();
  } catch (err) {
    lotteryState.entrants = [];
    document.getElementById('lottery-count').textContent = '0';
    list.innerHTML = `<p class="empty-state">Couldn't load entrants: ${escapeHtml(err.message)}</p>`;
  }
}

// How the entrant list is ordered on screen. The draw is random either way, so this is only for reading
// the list. "random" keeps one shuffled order (by trainer key) until Shuffle is pressed again.
const ENTRANT_SORT_KEY = 'pogo_entrant_sort';
let entrantSort = 'name';
try { entrantSort = localStorage.getItem(ENTRANT_SORT_KEY) || 'name'; } catch {}
let shuffleRank = new Map();

function shuffleEntrantOrder() {
  const keys = lotteryState.entrants.map(e => trainerKey(e.trainerName));
  for (let i = keys.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  shuffleRank = new Map(keys.map((k, i) => [k, i]));
}

function sortedEntrants(entrants) {
  const byName = (a, b) => a.trainerName.toLowerCase().localeCompare(b.trainerName.toLowerCase());
  const list = [...entrants];
  if (entrantSort === 'checkins') return list.sort((a, b) => (b.checkIns || 0) - (a.checkIns || 0) || byName(a, b));
  if (entrantSort === 'random') {
    // A different lottery's list (or the first visit) gets its own shuffle.
    if (!list.some(e => shuffleRank.has(trainerKey(e.trainerName)))) shuffleEntrantOrder();
    // Anyone who appeared since the last shuffle (e.g. after Refresh) goes at the end.
    const rank = e => shuffleRank.get(trainerKey(e.trainerName)) ?? Infinity;
    return list.sort((a, b) => rank(a) - rank(b) || byName(a, b));
  }
  return list.sort(byName);
}

function setEntrantSort(value) {
  entrantSort = value;
  try { localStorage.setItem(ENTRANT_SORT_KEY, value); } catch {}
  renderLotteryEntrants();
}

document.getElementById('lottery-sort').addEventListener('change', (e) => setEntrantSort(e.target.value));

document.getElementById('lottery-shuffle').addEventListener('click', () => {
  shuffleEntrantOrder();
  setEntrantSort('random');
});

function renderLotteryEntrants() {
  const lottery = selectedLottery();
  const list = document.getElementById('lottery-list');
  const entrants = lotteryState.entrants;
  const entries = entrants.reduce((n, e) => n + (e.entries || 1), 0);
  document.getElementById('lottery-count').textContent = entries > entrants.length ? `${entrants.length} · ${entries} entries` : entrants.length;

  // Check-in counts only exist for Campfire lotteries.
  const sortSelect = document.getElementById('lottery-sort');
  const hasCheckIns = entrants.some(e => e.checkIns > 0);
  sortSelect.querySelector('option[value="checkins"]').hidden = !hasCheckIns;
  if (entrantSort === 'checkins' && !hasCheckIns) entrantSort = 'name';
  sortSelect.value = entrantSort;
  renderWheel(lottery);

  if (entrants.length === 0) {
    list.innerHTML = '<p class="empty-state">No entrants yet.</p>';
    return;
  }

  list.innerHTML = sortedEntrants(entrants).map(e => {
    const key = trainerKey(e.trainerName);
    const winner = isWinner(lottery, e.trainerName);

    if (lotteryState.editingKey === key) {
      return `
        <form class="lottery-entrant lottery-entrant-edit" data-key="${escapeHtml(key)}" data-name="${escapeHtml(e.trainerName)}">
          <input type="text" class="lottery-entrant-input" value="${escapeHtml(e.trainerName)}" aria-label="Trainer name" required>
          <span class="lottery-entrant-actions">
            <button type="submit" class="btn btn-small btn-primary">Save</button>
            ${winner ? '' : '<button type="button" class="btn btn-small btn-secondary" data-action="mark-winner">Mark Winner</button>'}
            <button type="button" class="btn btn-small btn-secondary" data-action="cancel-edit">Cancel</button>
          </span>
        </form>
      `;
    }

    const badges = [
      winner ? '<span class="badge badge-winner">Winner</span>' : '',
      e.skipped ? '<span class="badge badge-skipped">Skipped</span>' : '',
      e.ineligible ? `<span class="badge badge-skipped" title="Excluded by this lottery's draw rules">${escapeHtml(e.ineligible)}</span>` : '',
      e.redeemed ? '<span class="badge badge-active">Redeemed code</span>' : '',
      e.signedUp ? '<span class="badge badge-new">Lottery sign-up</span>' : '',
      e.manual ? '<span class="badge badge-new">Added by hand</span>' : '',
      e.checkedIn ? '<span class="badge badge-new">Checked in</span>' : '',
      e.campfire ? `<span class="badge badge-new">${e.checkIns > 1 ? `${e.checkIns} Campfire check-ins` : 'Campfire check-in'}</span>` : '',
      e.entries > 1 ? `<span class="badge badge-entries" title="Chances in the draw">×${e.entries} entries</span>` : '',
    ].join(' ');
    const stateClass = winner ? ' is-winner' : (e.skipped || e.ineligible) ? ' is-skipped' : '';
    const winnerActions = winner
      ? '<button type="button" class="btn btn-small btn-primary" data-action="redraw" title="Winner isn\'t here: skip them and draw someone else">Redraw</button>'
        + '<button type="button" class="btn btn-small btn-secondary" data-action="unwin">Undo Win</button>'
      : e.skipped ? '<button type="button" class="btn btn-small btn-secondary" data-action="unskip">Restore</button>' : '';
    return `
      <div class="lottery-entrant${stateClass}" data-key="${escapeHtml(key)}" data-name="${escapeHtml(e.trainerName)}">
        <span class="lottery-name">${escapeHtml(e.trainerName)}</span>
        <span class="lottery-badges">${badges}</span>
        <span class="lottery-entrant-actions">
          ${winnerActions}
          <button type="button" class="btn btn-small btn-secondary" data-action="edit" data-needs="lotteryEdit">Edit</button>
          <button type="button" class="btn btn-small btn-danger" data-action="remove" data-needs="lotteryEdit">Remove</button>
        </span>
      </div>
    `;
  }).join('');

  const input = list.querySelector('.lottery-entrant-input');
  if (input) { input.focus(); input.select(); }
}

function lotteryRules(lottery) {
  return lottery.rules || { excludeRecentEvents: 0, excludeLotteryIds: [], entryPerCheckIn: false };
}

// Only a lottery drawing from a whole Campfire upload can count someone more than once.
function allowsEntryPerCheckIn(lottery) {
  return String(lottery.eventId || '').startsWith('cfx:');
}

function renderLotteryRules(lottery) {
  const rules = lotteryRules(lottery);
  document.getElementById('lottery-rule-recent').value = String(rules.excludeRecentEvents);
  document.getElementById('lottery-rule-weighted-row').classList.toggle('hidden', !allowsEntryPerCheckIn(lottery));
  document.getElementById('lottery-rule-weighted').checked = !!rules.entryPerCheckIn;

  const others = lotteryState.lotteries.filter(l => l.id !== lottery.id);
  const box = document.getElementById('lottery-rule-lotteries');
  box.innerHTML = others.length ? others.map(l => {
    const source = l.eventId ? lotteryEventName(l) : new Date(l.createdAt).toLocaleDateString();
    const checked = rules.excludeLotteryIds.includes(l.id) ? ' checked' : '';
    return `
      <label class="rule-check">
        <input type="checkbox" value="${escapeHtml(l.id)}"${checked}>
        <span>${escapeHtml(l.name)} <span class="code-meta">${escapeHtml(source)}${l.winners.length ? '' : ' · no winners yet'}</span></span>
      </label>
    `;
  }).join('') : '<span class="code-meta">No other lotteries yet.</span>';

  const parts = [];
  if (rules.excludeRecentEvents) parts.push(`last ${rules.excludeRecentEvents} event${rules.excludeRecentEvents > 1 ? 's' : ''}`);
  if (rules.excludeLotteryIds.length) parts.push(`${rules.excludeLotteryIds.length} lotter${rules.excludeLotteryIds.length > 1 ? 'ies' : 'y'}`);
  const summary = [];
  if (parts.length) summary.push(`excluding winners from ${parts.join(' and ')}`);
  const weighted = rules.entryPerCheckIn && allowsEntryPerCheckIn(lottery);
  if (weighted) summary.push('one entry per check-in');
  document.getElementById('lottery-rules-summary').textContent = summary.length ? `· ${summary.join(' · ')}` : '· off';
  if (summary.length) document.getElementById('lottery-rules').open = true;
}

async function saveLotteryRules() {
  const lottery = selectedLottery();
  if (!lottery) return;
  const excludeRecentEvents = document.getElementById('lottery-rule-recent').value;
  const excludeLotteryIds = [...document.querySelectorAll('#lottery-rule-lotteries input:checked')].map(i => i.value);
  const entryPerCheckIn = document.getElementById('lottery-rule-weighted').checked;
  try {
    const data = await callSheet({
      action: 'setLotteryRules',
      id: lottery.id,
      excludeRecentEvents,
      excludeLotteryIds: JSON.stringify(excludeLotteryIds),
      entryPerCheckIn,
    });
    applyLotteryUpdate(data);
    const excluded = lotteryState.entrants.filter(e => e.ineligible).length;
    showToast(excluded ? `Rules saved · ${excluded} entrant${excluded > 1 ? 's' : ''} excluded` : 'Rules saved');
  } catch (err) {
    showToast('Could not save rules: ' + err.message);
    renderLotteryRules(lottery);
  }
}

document.getElementById('lottery-rule-recent').addEventListener('change', saveLotteryRules);
document.getElementById('lottery-rule-lotteries').addEventListener('change', saveLotteryRules);
document.getElementById('lottery-rule-weighted').addEventListener('change', saveLotteryRules);

function applyLotteryUpdate(data) {
  const lottery = selectedLottery();
  if (data.lottery) Object.assign(lottery, data.lottery);
  if (data.entrants) lotteryState.entrants = data.entrants;
  renderLotteryHeader(lottery);
  renderLotteryHistory();
  renderLotteryEntrants();
}

async function handleEntrantAction(action, row) {
  const lottery = selectedLottery();
  if (!lottery || lotteryState.drawing) return;
  const name = row.dataset.name;

  if (action === 'edit') {
    lotteryState.editingKey = row.dataset.key;
    renderLotteryEntrants();
    return;
  }
  if (action === 'cancel-edit') {
    lotteryState.editingKey = null;
    renderLotteryEntrants();
    return;
  }

  try {
    if (action === 'remove') {
      if (!confirm(`Remove ${name} from "${lottery.name}"? They won't be able to sign up for it again.`)) return;
      applyLotteryUpdate(await callSheet({ action: 'removeEntrant', id: lottery.id, trainerName: name }));
      showToast(`${name} removed`);
    } else if (action === 'mark-winner') {
      const entrant = lotteryState.entrants.find(x => trainerKey(x.trainerName) === row.dataset.key);
      const notes = [
        entrant && entrant.ineligible ? `This lottery's draw rules exclude them (${entrant.ineligible}).` : '',
        entrant && entrant.skipped ? 'They were skipped, and this restores them.' : '',
        lottery.winners.length >= winnerCountOf(lottery) ? 'All winners are drawn, so this raises the winner count by 1.' : '',
      ].filter(Boolean).join('\n');
      if (!confirm(`Mark ${name} as a winner of "${lottery.name}"?${notes ? `\n\n${notes}` : ''}`)) return;
      const data = await callSheet({ action: 'markWinner', id: lottery.id, trainerName: name });
      lotteryState.editingKey = null;
      applyLotteryUpdate(data);
      showToast(`${name} marked as a winner`);
    } else if (action === 'unwin') {
      if (!confirm(`Undo ${name}'s win? They'll go back into the draw.`)) return;
      applyLotteryUpdate(await callSheet({ action: 'unmarkWinner', id: lottery.id, trainerName: name }));
      showToast(`${name} is no longer a winner`);
    } else if (action === 'redraw') {
      if (!confirm(`${name} isn't here? They'll be skipped for this lottery and a new winner will be drawn.`)) return;
      applyLotteryUpdate(await callSheet({ action: 'skipWinner', id: lottery.id, trainerName: name }));
      await drawLotteryWinners(1);
    } else if (action === 'unskip') {
      applyLotteryUpdate(await callSheet({ action: 'unskipEntrant', id: lottery.id, trainerName: name }));
      showToast(`${name} is back in the draw`);
    }
  } catch (err) {
    showToast('Could not update entrant: ' + err.message);
  }
}

document.getElementById('lottery-list').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  handleEntrantAction(button.dataset.action, button.closest('.lottery-entrant'));
});

document.getElementById('lottery-list').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target.closest('.lottery-entrant-edit');
  const lottery = selectedLottery();
  if (!form || !lottery) return;

  const oldName = form.dataset.name;
  const newName = form.querySelector('.lottery-entrant-input').value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9]+$/.test(newName)) {
    showToast('Trainer names are letters and numbers only');
    return;
  }
  if (newName === oldName) {
    lotteryState.editingKey = null;
    renderLotteryEntrants();
    return;
  }

  form.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    const data = await callSheet({ action: 'renameEntrant', id: lottery.id, oldName, newName });
    lotteryState.editingKey = null;
    applyLotteryUpdate(data);
    showToast(`Renamed to ${newName}`);
  } catch (err) {
    form.querySelectorAll('button').forEach(b => { b.disabled = false; });
    showToast('Could not rename: ' + err.message);
  }
});

document.getElementById('lottery-add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const lottery = selectedLottery();
  if (!lottery || lotteryState.drawing) return;

  const input = document.getElementById('lottery-add-name');
  const name = input.value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9]+$/.test(name)) {
    showToast('Trainer names are letters and numbers only');
    return;
  }

  const button = document.getElementById('lottery-add-submit');
  button.disabled = true;
  try {
    applyLotteryUpdate(await callSheet({ action: 'addEntrant', id: lottery.id, trainerName: name }));
    input.value = '';
    input.focus();
    showToast(`${name} added`);
  } catch (err) {
    showToast('Could not add: ' + err.message);
  } finally {
    button.disabled = false;
  }
});

function randomIndex(n) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % n;
}

function winnerCountOf(lottery) {
  return lottery.winnerCount || 1;
}

function updateDrawButton(lottery) {
  const button = document.getElementById('lottery-draw');
  const allButton = document.getElementById('lottery-draw-all');
  const count = winnerCountOf(lottery);
  const drawn = lottery.winners.length;
  const remaining = Math.max(count - drawn, 0);
  const done = remaining === 0;

  button.disabled = done || lotteryState.drawing;
  document.getElementById('lottery-wheel-hub').disabled = button.disabled;
  // Auto spin leaves just the button that draws everyone left.
  button.classList.toggle('hidden', autoSpinIsOn() && remaining > 1);
  button.textContent = done ? (count > 1 ? 'All Winners Drawn' : 'Winner Drawn') : 'Choose 1 Winner';
  button.title = done ? 'All winners have been drawn. Raise the winner count or use Undo Win to draw again.'
    : count > 1 ? `Winner ${drawn + 1} of ${count}` : '';

  allButton.classList.toggle('hidden', remaining < 2);
  allButton.disabled = lotteryState.drawing;
  allButton.textContent = `Choose ${remaining} Winners`;

  const select = document.getElementById('lottery-winner-count');
  select.value = String(count);
  select.disabled = lotteryState.drawing;
  [...select.options].forEach(o => { o.disabled = Number(o.value) < Math.max(drawn, 1); });
}

document.getElementById('lottery-winner-count').addEventListener('change', async (e) => {
  const lottery = selectedLottery();
  if (!lottery) return;
  const count = Number(e.target.value);
  try {
    const data = await callSheet({ action: 'setWinnerCount', id: lottery.id, count });
    Object.assign(lottery, data.lottery);
    showToast(`${count} winner${count > 1 ? 's' : ''} will be drawn`);
  } catch (err) {
    showToast('Could not change winner count: ' + err.message);
  }
  updateDrawButton(lottery);
});

function setLotteryButtonsDisabled(disabled) {
  ['lottery-draw', 'lottery-draw-all', 'lottery-refresh', 'lottery-toggle', 'lottery-edit', 'lottery-delete', 'lottery-winner-count', 'lottery-wheel-on', 'lottery-auto-spin', 'lottery-wheel-hub', 'lottery-add-name', 'lottery-add-submit', 'lottery-rule-recent', 'lottery-rule-weighted', 'lottery-sort', 'lottery-shuffle'].forEach(id => {
    document.getElementById(id).disabled = disabled;
  });
  document.querySelectorAll('#lottery-rule-lotteries input').forEach(i => { i.disabled = disabled; });
  document.getElementById('lottery-list').classList.toggle('is-busy', disabled);
}

// Draws `count` winners one after another. Previous winners are never in the pool, so nobody wins twice.
async function drawLotteryWinners(count) {
  const lottery = selectedLottery();
  if (!lottery || lotteryState.drawing) return;
  if (lottery.winners.length >= winnerCountOf(lottery)) {
    showToast('All winners have been drawn. Raise the winner count or use Undo Win to draw again.');
    return;
  }
  if (lotteryState.editingKey) {
    lotteryState.editingKey = null;
    renderLotteryEntrants();
  }

  lotteryState.drawing = true;
  setLotteryButtonsDisabled(true);
  const picked = [];
  try {
    for (let i = 0; i < count; i++) {
      const name = await drawOneWinner(lottery);
      if (!name) break;
      picked.push(name);
      // The wheel gets a longer pause so everyone can see who won before it spins again.
      if (i < count - 1) await new Promise(r => setTimeout(r, wheelIsOn() ? 3000 : 900));
    }
    if (picked.length > 1) showToast(`Winners: ${picked.join(', ')}`);
  } finally {
    lotteryState.drawing = false;
    setLotteryButtonsDisabled(false);
    const current = selectedLottery();
    if (current) updateDrawButton(current);
  }
}

function drawablePool(lottery) {
  return lotteryState.entrants.filter(e => !e.skipped && !e.ineligible && !isWinner(lottery, e.trainerName));
}

// The raffle wheel. Its slices are the people who can be drawn right now, in list order and sized by their
// entries, and it's rebuilt whenever the list is, so removing or skipping someone takes them off the wheel.
const WHEEL_KEY = 'pogo_lottery_wheel';
const AUTO_SPIN_KEY = 'pogo_lottery_auto_spin';
const WHEEL_COLORS = ['#d63a3f', '#2f6fde', '#c9770a', '#15803d', '#7c4ddb', '#0f8a80'];
const wheel = { slices: [], rotation: 0, spinning: false, held: null };
const wheelToggle = document.getElementById('lottery-wheel-on');
const autoSpinToggle = document.getElementById('lottery-auto-spin');
try {
  wheelToggle.checked = localStorage.getItem(WHEEL_KEY) === 'on';
  autoSpinToggle.checked = localStorage.getItem(AUTO_SPIN_KEY) === 'on';
} catch {}

function wheelIsOn() {
  return wheelToggle.checked;
}

function autoSpinIsOn() {
  return wheelIsOn() && autoSpinToggle.checked;
}

function wheelOptionsChanged() {
  const lottery = selectedLottery();
  renderWheel(lottery);
  if (lottery) updateDrawButton(lottery);
}

wheelToggle.addEventListener('change', () => {
  try { localStorage.setItem(WHEEL_KEY, wheelToggle.checked ? 'on' : 'off'); } catch {}
  wheelOptionsChanged();
});

autoSpinToggle.addEventListener('change', () => {
  try { localStorage.setItem(AUTO_SPIN_KEY, autoSpinToggle.checked ? 'on' : 'off'); } catch {}
  wheelOptionsChanged();
});

function buildWheelSlices(pool) {
  const tickets = pool.reduce((n, e) => n + (e.entries || 1), 0);
  let at = 0;
  return sortedEntrants(pool).map((e, i) => {
    const entries = e.entries || 1;
    const start = at;
    at += entries / tickets * 360;
    // The last slice sits next to the first, so don't let them share a color.
    const wraps = i > 0 && i === pool.length - 1 && i % WHEEL_COLORS.length === 0;
    return { key: trainerKey(e.trainerName), name: e.trainerName, entries, start, end: at, color: WHEEL_COLORS[wraps ? 1 : i % WHEEL_COLORS.length] };
  });
}

function paintWheel() {
  const canvas = document.getElementById('lottery-wheel-canvas');
  const size = canvas.clientWidth;
  if (!size) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = canvas.height = Math.round(size * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  const center = size / 2;
  const radius = center - 4;
  const heldKey = wheel.held && wheel.held.key;

  wheel.slices.forEach(slice => {
    // Slice angles count clockwise from the top, where the pointer is.
    const from = (slice.start - 90) * Math.PI / 180;
    const to = (slice.end - 90) * Math.PI / 180;
    ctx.globalAlpha = heldKey && slice.key !== heldKey ? 0.3 : 1;
    ctx.fillStyle = slice.color;
    ctx.beginPath();
    ctx.moveTo(center, center);
    ctx.arc(center, center, radius, from, to);
    ctx.closePath();
    ctx.fill();
    if (wheel.slices.length > 1) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  });

  // Names go on after every slice is painted, or each slice would cover the end of its neighbor's name.
  wheel.slices.forEach(slice => {
    const from = (slice.start - 90) * Math.PI / 180;
    const to = (slice.end - 90) * Math.PI / 180;
    ctx.globalAlpha = heldKey && slice.key !== heldKey ? 0.3 : 1;

    // Fit the name to its slice. Slices too thin to read go unlabeled; the readout still names them.
    const room = radius * 0.8 - 14;
    let px = Math.min(radius * 0.075, (to - from) * radius * 0.6);
    ctx.font = `600 ${px}px Inter, sans-serif`;
    const width = ctx.measureText(slice.name).width;
    if (width > room) px *= room / width;
    if (px < 7) return;
    ctx.font = `600 ${px}px Inter, sans-serif`;
    ctx.save();
    ctx.translate(center, center);
    ctx.rotate((from + to) / 2);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(slice.name, radius - 10, 0);
    ctx.restore();
  });
  ctx.globalAlpha = 1;
}

function setWheelRotation(degrees) {
  wheel.rotation = degrees;
  document.getElementById('lottery-wheel-canvas').style.transform = `rotate(${degrees}deg)`;
}

function setWheelReadout(text, state) {
  const readout = document.getElementById('lottery-wheel-readout');
  readout.textContent = text;
  readout.className = `lottery-wheel-readout${state ? ` is-${state}` : ''}`;
}

// After a spin the wheel stays as it landed, winner lit up, until the list changes in some other way than
// that winner leaving the pool. Otherwise their slice would vanish and the pointer would be on someone else.
function wheelHoldStands(lottery, slices) {
  const held = wheel.held;
  if (!held || held.lotteryId !== lottery.id || !isWinner(lottery, held.name)) return false;
  const shape = list => list.map(s => `${s.key}:${s.entries}`).join();
  return shape(wheel.slices.filter(s => s.key !== held.key)) === shape(slices);
}

// With more than one winner to draw, the wheel keeps a running list of who has won so far.
function renderWheelWinners(lottery) {
  const box = document.getElementById('lottery-wheel-winners');
  const show = winnerCountOf(lottery) > 1 && lottery.winners.length > 0;
  box.classList.toggle('hidden', !show);
  box.innerHTML = show ? `<h4>Winners</h4><ol>${lottery.winners.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ol>` : '';
}

function renderWheel(lottery) {
  const on = wheelIsOn() && !!lottery;
  document.getElementById('lottery-wheel').classList.toggle('hidden', !on);
  document.getElementById('lottery-auto-spin-row').classList.toggle('hidden', !on);
  if (!on || wheel.spinning) return;
  renderWheelWinners(lottery);

  const pool = drawablePool(lottery);
  const slices = buildWheelSlices(pool);
  if (!wheelHoldStands(lottery, slices)) {
    wheel.held = null;
    wheel.slices = slices;
  }
  document.getElementById('lottery-wheel-stage').classList.toggle('hidden', wheel.slices.length === 0);
  paintWheel();

  if (wheel.held) {
    setWheelReadout(`Winner: ${wheel.held.name}`, 'winner');
  } else if (pool.length) {
    const tickets = pool.reduce((n, e) => n + (e.entries || 1), 0);
    setWheelReadout(`${plural(pool.length, 'trainer')} on the wheel${tickets > pool.length ? ` · ${tickets} entries` : ''}`, 'idle');
  } else {
    setWheelReadout(lotteryState.entrants.length ? 'No one left to draw' : 'No entrants yet', 'idle');
  }
}

// The canvas has no size while its tab is hidden, and its size changes when a phone is turned.
new ResizeObserver(paintWheel).observe(document.getElementById('lottery-wheel-canvas'));

function wheelSliceAtPointer() {
  const angle = ((-wheel.rotation % 360) + 360) % 360;
  return wheel.slices.find(s => angle < s.end) || wheel.slices[wheel.slices.length - 1];
}

// Spins until the pointer rests inside the winner's slice. The winner is already chosen by then, so where in
// the slice it stops is only for show.
async function spinWheelTo(lottery, pool, winner) {
  // A landed wheel still shows the last winner, so take them off in plain view before spinning again.
  const ejecting = !!wheel.held;
  wheel.held = null;
  wheel.slices = buildWheelSlices(pool);
  wheel.spinning = true;
  paintWheel();
  document.getElementById('lottery-wheel').scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (ejecting) {
    setWheelReadout(`${plural(pool.length, 'trainer')} left on the wheel`, 'idle');
    await new Promise(r => setTimeout(r, 1000));
  }

  const slice = wheel.slices.find(s => s.key === trainerKey(winner.trainerName));
  const sweep = slice.end - slice.start;
  const target = slice.start + sweep * (0.1 + 0.8 * randomIndex(1000) / 1000);
  const from = wheel.rotation;
  const turns = pool.length > 1 ? 6 + randomIndex(3) : 0;
  const to = from + turns * 360 + (((-target - from) % 360) + 360) % 360;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const duration = pool.length > 1 && !reduceMotion ? 9000 : 0;

  await new Promise(resolve => {
    const began = performance.now();
    const frame = (now) => {
      const progress = duration ? Math.min((now - began) / duration, 1) : 1;
      setWheelRotation(from + (to - from) * (1 - Math.pow(1 - progress, 4)));
      setWheelReadout(wheelSliceAtPointer().name);
      if (progress < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });

  setWheelRotation(to % 360);
  wheel.spinning = false;
  wheel.held = { lotteryId: lottery.id, key: slice.key, name: winner.trainerName };
  paintWheel();
  setWheelReadout(`Winner: ${winner.trainerName}`, 'winner');
}

// Returns the winner's name, or null if nothing could be drawn.
async function drawOneWinner(lottery) {
  const pool = drawablePool(lottery);
  if (pool.length === 0) {
    showToast(lotteryState.entrants.length ? 'No one left to draw' : 'No entrants to draw from');
    return null;
  }

  // Each entry is one ticket, so someone with 3 entries is 3 times as likely to be drawn. Once drawn they're
  // out of the pool, so they can't win twice.
  const tickets = pool.reduce((n, e) => n + (e.entries || 1), 0);
  let ticket = randomIndex(tickets);
  const winner = pool.find(e => (ticket -= (e.entries || 1)) < 0);
  const nodes = pool.map(e => document.querySelector(`.lottery-entrant[data-key="${CSS.escape(trainerKey(e.trainerName))}"]`));
  const winnerNode = nodes[pool.indexOf(winner)];

  const spun = wheelIsOn();
  if (spun) {
    await spinWheelTo(lottery, pool, winner);
  } else {
    const ticks = pool.length > 1 ? 24 : 1;
    let last = null;
    for (let i = 0; i < ticks; i++) {
      let node = i === ticks - 1 ? winnerNode : nodes[randomIndex(nodes.length)];
      if (node === last && nodes.length > 1 && i !== ticks - 1) node = nodes[(nodes.indexOf(node) + 1) % nodes.length];
      if (last) last.classList.remove('is-drawing');
      node.classList.add('is-drawing');
      node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      last = node;
      await new Promise(r => setTimeout(r, 50 + i * i * 0.8));
    }
    winnerNode.classList.remove('is-drawing');
  }

  try {
    const data = await callSheet({ action: 'recordWinner', id: lottery.id, trainerName: winner.trainerName });
    lottery.winners = data.winners || [...lottery.winners, winner.trainerName];
    renderLotteryHeader(lottery);
    renderLotteryHistory();
    renderLotteryEntrants();
    setLotteryButtonsDisabled(true);
    const node = document.querySelector(`.lottery-entrant[data-key="${CSS.escape(trainerKey(winner.trainerName))}"]`);
    if (node && !spun) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    showToast(`Winner: ${winner.trainerName}`);
    return winner.trainerName;
  } catch (err) {
    if (err.message.includes('All winners have been drawn')) {
      showToast('The winners were already drawn on another device');
      await loadLotteries();
    } else {
      showToast(`Picked ${winner.trainerName}, but saving failed: ${err.message}`);
      winnerNode.classList.add('is-winner');
    }
    return null;
  }
}

document.getElementById('lottery-create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('lottery-name').value.trim();
  const eventId = document.getElementById('lottery-event').value;
  if (!name) return;
  if (!eventId) {
    showToast('Create an event in the Check In tab first');
    return;
  }

  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    const data = await callSheet({ action: 'createLottery', name, eventId });
    document.getElementById('lottery-name').value = '';
    lotteryState.selectedId = data.lottery.id;
    await loadLotteries();
    showToast('Lottery created');
  } catch (err) {
    showToast('Could not create lottery: ' + err.message);
  } finally {
    button.disabled = false;
  }
});

document.getElementById('lottery-toggle').addEventListener('click', async () => {
  const lottery = selectedLottery();
  if (!lottery) return;
  if (lottery.open && !confirm(`Close "${lottery.name}"? New sign-ups will be turned away and later code redemptions won't count.`)) return;

  try {
    const data = await callSheet({ action: 'setLotteryStatus', id: lottery.id, open: lottery.open ? 'false' : 'true' });
    Object.assign(lottery, data.lottery);
    selectLottery(lottery.id);
    showToast(lottery.open ? 'Lottery reopened' : 'Lottery closed');
  } catch (err) {
    showToast('Could not update lottery: ' + err.message);
  }
});

function showLotteryEditForm(show) {
  document.getElementById('lottery-view-header').classList.toggle('hidden', show);
  document.getElementById('lottery-edit-form').classList.toggle('hidden', !show);
  if (!show) return;
  const lottery = selectedLottery();
  document.getElementById('lottery-edit-name').value = lottery.name;
  fillEventSelect(document.getElementById('lottery-edit-event'), lottery.eventId);
  document.getElementById('lottery-edit-name').focus();
}

document.getElementById('lottery-edit').addEventListener('click', () => showLotteryEditForm(true));
document.getElementById('lottery-edit-cancel').addEventListener('click', () => showLotteryEditForm(false));

document.getElementById('lottery-edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const lottery = selectedLottery();
  const name = document.getElementById('lottery-edit-name').value.trim();
  const eventId = document.getElementById('lottery-edit-event').value;
  if (!lottery || !name || !eventId) return;

  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    const data = await callSheet({ action: 'updateLottery', id: lottery.id, name, eventId });
    Object.assign(lottery, data.lottery);
    showLotteryEditForm(false);
    renderLotteryHeader(lottery);
    renderLotteryHistory();
    loadLotteryEntrants();
    showToast('Lottery updated');
  } catch (err) {
    showToast('Could not update lottery: ' + err.message);
  } finally {
    button.disabled = false;
  }
});

document.getElementById('lottery-delete').addEventListener('click', async () => {
  const lottery = selectedLottery();
  if (!lottery) return;
  if (!confirm(`Delete "${lottery.name}"? Its sign-ups, winners, and edits will be permanently removed. Code redemptions in the scan log are not affected.`)) return;

  try {
    await callSheet({ action: 'deleteLottery', id: lottery.id });
    lotteryState.selectedId = null;
    try { localStorage.removeItem('pogo_lottery_selected'); } catch {}
    await loadLotteries();
    showToast('Lottery deleted');
  } catch (err) {
    showToast('Could not delete lottery: ' + err.message);
  }
});

document.getElementById('lottery-draw').addEventListener('click', () => drawLotteryWinners(1));
document.getElementById('lottery-wheel-hub').addEventListener('click', () => {
  const lottery = selectedLottery();
  if (lottery) drawLotteryWinners(autoSpinIsOn() ? winnerCountOf(lottery) - lottery.winners.length : 1);
});
document.getElementById('lottery-draw-all').addEventListener('click', () => {
  const lottery = selectedLottery();
  if (lottery) drawLotteryWinners(winnerCountOf(lottery) - lottery.winners.length);
});
document.getElementById('lottery-refresh').addEventListener('click', loadLotteryEntrants);

// Events / Check In
const eventState = { events: [], selectedId: null, attendees: [] };

function getCheckInUrl(id) {
  return `${getBaseUrl()}/checkin.html?event=${encodeURIComponent(id)}${shownByParam()}`;
}

function selectedEvent() {
  return eventState.events.find(ev => ev.id === eventState.selectedId) || null;
}

function dateInputToIso(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).toISOString();
}

// QR scanners need a white quiet zone around the code, which the raw canvas doesn't include.
function downloadQrCanvas(canvas, filename) {
  const margin = Math.round(canvas.width * 0.08);
  const out = document.createElement('canvas');
  out.width = canvas.width + margin * 2;
  out.height = canvas.height + margin * 2;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, margin, margin);
  const link = document.createElement('a');
  link.download = filename;
  link.href = out.toDataURL('image/png');
  link.click();
}

async function loadEvents() {
  const data = await callSheet({ action: 'getEvents' }).catch(err => {
    document.getElementById('event-history').innerHTML =
      `<p class="empty-state">Couldn't load events: ${escapeHtml(err.message)}</p>`;
    return null;
  });
  if (data) eventState.events = data.events || [];
  return eventState.events;
}

async function initCheckIn() {
  const dateInput = document.getElementById('event-date');
  if (!dateInput.value) dateInput.value = todayInputValue();
  await loadEvents();

  let saved = null;
  try { saved = localStorage.getItem('pogo_event_selected'); } catch {}
  const exists = id => eventState.events.some(ev => ev.id === id);
  const id = exists(eventState.selectedId) ? eventState.selectedId
    : exists(saved) ? saved
    : (eventState.events[0] && eventState.events[0].id);

  renderEventHistory();
  if (id) selectEvent(id);
  else document.getElementById('event-detail').classList.add('hidden');
}

function renderEventHistory() {
  const history = document.getElementById('event-history');
  if (eventState.events.length === 0) {
    history.innerHTML = '<p class="empty-state">No events yet. Create one above.</p>';
    return;
  }
  history.innerHTML = eventState.events.map(ev => `
    <button type="button" class="lottery-history-item${ev.id === eventState.selectedId ? ' selected' : ''}" data-id="${escapeHtml(ev.id)}">
      <span class="lottery-history-main">
        <span class="lottery-name">${escapeHtml(ev.name)}</span>
        <span class="code-meta">${new Date(ev.date).toLocaleDateString()} · ${ev.attendeeCount} checked in</span>
      </span>
      <span class="badge ${ev.open ? 'badge-active' : 'badge-inactive'}">${ev.open ? 'Open' : 'Closed'}</span>
    </button>
  `).join('');
  history.querySelectorAll('.lottery-history-item').forEach(el => {
    el.addEventListener('click', () => selectEvent(el.dataset.id));
  });
}

function selectEvent(id) {
  const ev = eventState.events.find(e => e.id === id);
  if (!ev) return;
  eventState.selectedId = id;
  try { localStorage.setItem('pogo_event_selected', id); } catch {}

  document.getElementById('event-detail').classList.remove('hidden');
  document.getElementById('event-title').textContent = ev.name;
  const status = document.getElementById('event-status');
  status.textContent = ev.open ? 'Open' : 'Closed';
  status.className = `badge ${ev.open ? 'badge-active' : 'badge-inactive'}`;
  const closed = ev.closedAt ? ` · Closed ${new Date(ev.closedAt).toLocaleString()}` : '';
  document.getElementById('event-meta').textContent = `${new Date(ev.date).toLocaleDateString()}${closed}`;
  document.getElementById('event-toggle').textContent = ev.open ? 'Close Check-In' : 'Reopen';
  document.getElementById('event-signup').classList.toggle('hidden', !ev.open);

  const qr = document.getElementById('event-qr');
  qr.innerHTML = '';
  if (ev.open) {
    new QRCode(qr, {
      text: getCheckInUrl(id),
      width: 200,
      height: 200,
      colorDark: '#1a1a2e',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  renderEventHistory();
  loadEventAttendees();
}

async function loadEventAttendees() {
  const ev = selectedEvent();
  if (!ev) return;
  const list = document.getElementById('event-attendees');
  list.innerHTML = '<p class="empty-state">Loading check-ins...</p>';
  try {
    const data = await callSheet({ action: 'getEventAttendees', id: ev.id });
    if (eventState.selectedId !== ev.id) return;
    eventState.attendees = data.attendees || [];
    ev.attendeeCount = eventState.attendees.length;
    renderEventAttendees();
    renderEventHistory();
  } catch (err) {
    document.getElementById('event-count').textContent = '0';
    list.innerHTML = `<p class="empty-state">Couldn't load check-ins: ${escapeHtml(err.message)}</p>`;
  }
}

// How the Checked In list is ordered on screen. Remembered per browser, like the lottery's sort.
const ATTENDEE_SORT_KEY = 'pogo_attendee_sort';
let attendeeSort = 'name';
try { attendeeSort = localStorage.getItem(ATTENDEE_SORT_KEY) || 'name'; } catch {}
document.getElementById('event-sort').value = attendeeSort;

function sortedAttendees(attendees) {
  const byName = (a, b) => a.trainerName.toLowerCase().localeCompare(b.trainerName.toLowerCase());
  const list = [...attendees];
  if (attendeeSort === 'name') return list.sort(byName);
  const direction = attendeeSort === 'newest' ? -1 : 1;
  // Anyone without a usable time goes at the end either way.
  const time = a => Date.parse(a.firstSeen) || null;
  return list.sort((a, b) => {
    const [ta, tb] = [time(a), time(b)];
    if (ta === null || tb === null) return (ta === null) - (tb === null) || byName(a, b);
    return (ta - tb) * direction || byName(a, b);
  });
}

document.getElementById('event-sort').addEventListener('change', (e) => {
  attendeeSort = e.target.value;
  try { localStorage.setItem(ATTENDEE_SORT_KEY, attendeeSort); } catch {}
  renderEventAttendees();
});

function renderEventAttendees() {
  const list = document.getElementById('event-attendees');
  const attendees = eventState.attendees;
  document.getElementById('event-count').textContent = attendees.length;
  if (attendees.length === 0) {
    list.innerHTML = '<p class="empty-state">No one has checked in yet.</p>';
    return;
  }
  if (EVENT_ALERTS_ENABLED) renderEventAlertSummary();
  list.innerHTML = sortedAttendees(attendees).map(a => `
    <div class="lottery-entrant attendee-row" data-name="${escapeHtml(a.trainerName)}">
      <span class="lottery-name">${escapeHtml(a.trainerName)}</span>
      <span class="lottery-badges">
        ${a.redeemed ? '<span class="badge badge-active">Redeemed code</span>' : ''}
        ${a.checkedIn ? '<span class="badge badge-new">Checked in</span>' : ''}
        ${a.shownBy ? `<span class="badge badge-bank" title="Whose QR they scanned">via ${escapeHtml(usernameLabel(a.shownBy))}</span>` : ''}
        ${EVENT_ALERTS_ENABLED && a.alertsOn ? '<span class="badge badge-event" title="Turned on event alerts on their phone">Alerts on</span>' : ''}
      </span>
      <span class="code-meta">${formatTimeWithSeconds(a.firstSeen)}</span>
      <span class="lottery-entrant-actions">
        <button type="button" class="btn btn-small btn-danger" data-action="remove-attendee" data-needs="checkinRemove">Remove</button>
      </span>
      ${(a.codes || []).length ? `<div class="attendee-codes">${a.codes.map(redeemedCodeChip).join('')}</div>` : ''}
    </div>
  `).join('');
}

// Tabled for now, along with the alert box in index.html. See the note at the top of js/alerts.js.
const EVENT_ALERTS_ENABLED = false;

// Event alerts: whether OneSignal is set up (the Apps Script only shares the public app id).
let alertsConfigured = null;

async function loadAlertsConfig() {
  if (alertsConfigured !== null) return alertsConfigured;
  try {
    alertsConfigured = !!(await callSheet({ action: 'pushConfig' })).appId;
  } catch {
    alertsConfigured = false;
  }
  return alertsConfigured;
}

async function renderEventAlertSummary() {
  const configured = await loadAlertsConfig();
  const attendees = eventState.attendees;
  const on = attendees.filter(a => a.alertsOn).length;
  document.getElementById('event-alert-summary').textContent = !configured ? '· not set up'
    : attendees.length ? `· ${on} of ${attendees.length} attendee${attendees.length === 1 ? '' : 's'} have alerts on` : '';
  document.getElementById('event-alert-note').textContent = configured
    ? "Sends a phone notification to attendees who turned on alerts when they checked in or redeemed a code. iPhones and iPads can't get them, so also post in Campfire's chat."
    : 'Alerts are not set up yet. See "Event alerts" in Settings > Google Apps Script Setup.';
  document.getElementById('event-alert-form').classList.toggle('hidden', !configured);
}

const DEFAULT_ALERT_MESSAGE = "Please return to the food court. We'll be starting our raffle soon!";

function fillDefaultAlert() {
  const input = document.getElementById('event-alert-message');
  if (document.getElementById('event-alert-default').checked) input.value = DEFAULT_ALERT_MESSAGE;
  else if (input.value === DEFAULT_ALERT_MESSAGE) input.value = '';
}

document.getElementById('event-alert-default').addEventListener('change', () => {
  fillDefaultAlert();
  if (!document.getElementById('event-alert-default').checked) document.getElementById('event-alert-message').focus();
});

// Typing a custom message turns the checkbox off, so it always says whether the default is what's going out.
document.getElementById('event-alert-message').addEventListener('input', (e) => {
  document.getElementById('event-alert-default').checked = e.target.value === DEFAULT_ALERT_MESSAGE;
});

fillDefaultAlert();

document.getElementById('event-alert-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ev = selectedEvent();
  const input = document.getElementById('event-alert-message');
  const message = input.value.trim();
  if (!ev || !message) return;
  const on = eventState.attendees.filter(a => a.alertsOn).length;
  if (!confirm(`Send this alert to the ${on} attendee${on === 1 ? '' : 's'} of "${ev.name}" who have alerts on?\n\n${message}`)) return;

  const button = document.getElementById('event-alert-send');
  button.disabled = true;
  button.textContent = 'Sending...';
  try {
    const site = location.origin + location.pathname.replace(/[^/]*$/, '');
    const data = await callSheet({ action: 'sendAlert', id: ev.id, message, site });
    // The default stays filled in, ready to send again; a custom message is cleared.
    if (!document.getElementById('event-alert-default').checked) input.value = '';
    showToast(`Alert sent to ${data.sentTo} phone${data.sentTo === 1 ? '' : 's'}`);
  } catch (err) {
    showToast("Couldn't send the alert: " + err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Send Alert';
  }
});

// The server says whether each redeemed code is still on the Codes tab, whether it's active, whose bank
// it's in, and whether this login may reactivate it or show its QR (its own, or any with that permission).
function redeemedCodeChip(scan) {
  const time = formatTimeWithSeconds(scan.timestamp);
  const bank = scan.bank && scan.bank !== me().name ? ` · ${escapeHtml(scan.bank)}'s code` : '';
  const showQr = `<button type="button" class="btn btn-small btn-primary" data-action="show-code-qr" data-code="${escapeHtml(scan.code)}"
    title="Show this code's QR so the trainer can scan it again">Show QR</button>`;
  const status = !scan.exists ? '<span class="code-status">deleted from codes</span>'
    : !scan.canManage ? `<span class="code-status${scan.active ? ' is-active' : ''}">${scan.active ? 'active' : 'used'}</span>`
    : scan.active ? `<span class="code-status is-active">active</span>${showQr}`
    : `<span class="code-status">used</span>
       <button type="button" class="btn btn-small btn-secondary" data-action="reactivate-code" data-code="${escapeHtml(scan.code)}"
         title="Put this code back in Active Codes if the trainer couldn't redeem it">Reactivate</button>
       ${showQr}`;
  return `
    <span class="attendee-code">
      <span class="attendee-code-value">${escapeHtml(scan.code)}</span>
      <span class="code-meta">${time}${bank}</span>
      ${status}
    </span>
  `;
}

// Keeps the Check In list and this device's own code list in step with a code's status on the sheet.
function setRedeemedCodeActive(code, active) {
  eventState.attendees.forEach(a => (a.codes || []).forEach(c => { if (c.code === code) c.active = active; }));
  const codes = getCodes();
  const entry = codes.find(c => c.code === code);
  if (entry && entry.active !== active) {
    entry.active = active;
    saveCodes(codes);
  }
}

function redeemedCode(code) {
  for (const a of eventState.attendees) {
    const found = (a.codes || []).find(c => c.code === code);
    if (found) return found;
  }
  return null;
}

async function reactivateFromCheckIn(code) {
  try {
    await callSheet({ action: 'updateCode', code, active: 'true' });
    setRedeemedCodeActive(code, true);
    renderEventAttendees();
    showToast(`${code} is active again`);
    return true;
  } catch (err) {
    showToast('Could not reactivate: ' + err.message);
    return false;
  }
}

let openQrCode = null;

function openCodeQr(code, trainerName) {
  const image = document.getElementById('code-qr-image');
  image.innerHTML = '';
  const size = Math.min(window.innerWidth - 96, window.innerHeight - 260, 320);
  new QRCode(image, {
    text: getRedeemUrl(code),
    width: size,
    height: size,
    colorDark: '#1a1a2e',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M,
  });
  document.getElementById('code-qr-trainer').textContent = trainerName;
  document.getElementById('code-qr-text').textContent = code;
  document.getElementById('code-qr-overlay').classList.remove('hidden');
  document.getElementById('code-qr-close').focus();
  openQrCode = code;
}

// A scan marks the code used on the sheet, so catch up on closing and the row offers Reactivate again.
async function closeCodeQr() {
  const code = openQrCode;
  if (!code) return;
  openQrCode = null;
  document.getElementById('code-qr-overlay').classList.add('hidden');
  try {
    const status = await callSheet({ action: 'getCodeStatus', code });
    const scan = redeemedCode(code);
    if (status.exists && scan && scan.active !== status.active) {
      setRedeemedCodeActive(code, status.active);
      renderEventAttendees();
    }
  } catch {}
}

document.getElementById('code-qr-close').addEventListener('click', closeCodeQr);
document.getElementById('code-qr-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'code-qr-overlay') closeCodeQr();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCodeQr();
});

document.getElementById('event-attendees').addEventListener('click', async (e) => {
  const showQr = e.target.closest('[data-action="show-code-qr"]');
  if (showQr) {
    const code = showQr.dataset.code;
    const name = showQr.closest('.lottery-entrant').dataset.name;
    const entry = redeemedCode(code);
    // A used code has to go back to active first, or it wouldn't count as available while they scan it.
    if (entry && !entry.active) {
      if (!confirm(`${code} is marked used. Reactivate it and show its QR for ${name}?`)) return;
      showQr.disabled = true;
      if (!await reactivateFromCheckIn(code)) {
        showQr.disabled = false;
        return;
      }
    }
    openCodeQr(code, name);
    return;
  }
  const reactivate = e.target.closest('[data-action="reactivate-code"]');
  if (reactivate) {
    const code = reactivate.dataset.code;
    if (confirm(`Reactivate ${code}? It goes back to Active Codes so it can be handed out again.`)) {
      reactivate.disabled = true;
      await reactivateFromCheckIn(code);
    }
    return;
  }
  const button = e.target.closest('[data-action="remove-attendee"]');
  const ev = selectedEvent();
  if (!button || !ev) return;
  const name = button.closest('.lottery-entrant').dataset.name;
  if (!confirm(`Remove ${name} from "${ev.name}"? They'll also drop out of any lottery for this event.`)) return;
  try {
    const data = await callSheet({ action: 'removeAttendee', id: ev.id, trainerName: name });
    eventState.attendees = data.attendees || [];
    ev.attendeeCount = eventState.attendees.length;
    renderEventAttendees();
    renderEventHistory();
    showToast(`${name} removed`);
  } catch (err) {
    showToast('Could not remove: ' + err.message);
  }
});

document.getElementById('event-create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('event-name').value.trim();
  const dateValue = document.getElementById('event-date').value || todayInputValue();
  if (!name) return;
  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const data = await callSheet({ action: 'createEvent', name, date: dateInputToIso(dateValue) });
    document.getElementById('event-name').value = '';
    eventState.selectedId = data.event.id;
    await initCheckIn();
    showToast(data.backfilled ? `Event created · ${data.backfilled} already checked in from redemptions` : 'Event created');
  } catch (err) {
    showToast('Could not create event: ' + err.message);
  } finally {
    button.disabled = false;
  }
});

document.getElementById('event-toggle').addEventListener('click', async () => {
  const ev = selectedEvent();
  if (!ev) return;
  if (ev.open && !confirm(`Close check-in for "${ev.name}"? The QR code will stop accepting check-ins and later redemptions won't be added.`)) return;
  try {
    const data = await callSheet({ action: 'setEventStatus', id: ev.id, open: ev.open ? 'false' : 'true' });
    Object.assign(ev, data.event);
    selectEvent(ev.id);
    showToast(ev.open ? 'Check-in reopened' : 'Check-in closed');
  } catch (err) {
    showToast('Could not update event: ' + err.message);
  }
});

document.getElementById('event-delete').addEventListener('click', async () => {
  const ev = selectedEvent();
  if (!ev) return;
  if (!confirm(`Delete "${ev.name}" and its check-in list? This can't be undone.`)) return;
  try {
    await callSheet({ action: 'deleteEvent', id: ev.id });
    eventState.selectedId = null;
    try { localStorage.removeItem('pogo_event_selected'); } catch {}
    await initCheckIn();
    showToast('Event deleted');
  } catch (err) {
    showToast('Could not delete event: ' + err.message);
  }
});

document.getElementById('event-refresh').addEventListener('click', loadEventAttendees);

document.getElementById('event-copy-link').addEventListener('click', () => {
  if (!eventState.selectedId) return;
  navigator.clipboard.writeText(getCheckInUrl(eventState.selectedId)).then(() => showToast('Check-in link copied'));
});

document.getElementById('event-download-qr').addEventListener('click', () => {
  const ev = selectedEvent();
  const canvas = document.querySelector('#event-qr canvas');
  if (!ev || !canvas) return;
  downloadQrCanvas(canvas, `pogo-checkin-${ev.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
});

// Setup banner
function checkSetup() {
  const url = getSetting(STORAGE_KEYS.SCRIPT_URL);
  document.getElementById('setup-banner').classList.toggle('hidden', !!url);
}
checkSetup();

// Settings form
const settingsForm = document.getElementById('settings-form');
document.getElementById('script-url').value = getSetting(STORAGE_KEYS.SCRIPT_URL);

settingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  saveSetting(STORAGE_KEYS.SCRIPT_URL, document.getElementById('script-url').value.trim());
  checkSetup();
  showToast('Settings saved');
});

// Add mode toggle
let addMode = 'single';

function setAddMode(mode) {
  addMode = mode;
  document.getElementById('mode-single').classList.toggle('active', mode === 'single');
  document.getElementById('mode-bulk').classList.toggle('active', mode === 'bulk');
  document.getElementById('single-input-group').classList.toggle('hidden', mode !== 'single');
  document.getElementById('bulk-input-group').classList.toggle('hidden', mode !== 'bulk');
}

// The Add Code form lives at the top of Settings; this shortcut on Active Codes jumps straight to it.
document.getElementById('go-add-codes').addEventListener('click', () => {
  activateTab('settings');
  document.getElementById('add-code-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById(addMode === 'bulk' ? 'code-bulk' : 'code-input').focus({ preventScroll: true });
});

// Add Code form
document.getElementById('add-code-form').addEventListener('submit', (e) => {
  e.preventDefault();

  const label = document.getElementById('code-label').value.trim();
  const expiry = document.getElementById('code-expiry').value;

  let newCodes = [];

  if (addMode === 'bulk') {
    const raw = document.getElementById('code-bulk').value;
    const parsed = raw.split(/[,\n]+/).map(c => c.trim().toUpperCase()).filter(Boolean);
    if (parsed.length === 0) return;

    const existing = getCodes();
    const existingSet = new Set(existing.map(c => c.code));
    let skipped = 0;

    for (const code of parsed) {
      if (existingSet.has(code)) {
        skipped++;
        continue;
      }
      existingSet.add(code);
      const entry = { code, label, expiry: expiry || null, addedAt: new Date().toISOString(), pending: true, owner: me().key };
      newCodes.push(entry);
      existing.unshift(entry);
    }

    saveCodes(existing);
    document.getElementById('code-bulk').value = '';

    if (newCodes.length > 0) {
      generateBulkQRPreview(newCodes);
      const msg = `${newCodes.length} code(s) added` + (skipped ? `, ${skipped} skipped (duplicates)` : '');
      showToast(msg);
      pushCodesToSheet(newCodes).then(result => { markCodesSaved(newCodes); dropRefusedCodes(result); }).catch(reportSyncError);
    } else {
      showToast('All codes already exist');
    }
  } else {
    const code = document.getElementById('code-input').value.trim().toUpperCase();
    if (!code) return;

    const codes = getCodes();
    if (codes.some(c => c.code === code)) {
      showToast('Code already exists');
      return;
    }

    const entry = { code, label, expiry: expiry || null, addedAt: new Date().toISOString(), pending: true, owner: me().key };
    codes.unshift(entry);
    saveCodes(codes);
    generateQRPreview(code, label);
    document.getElementById('code-input').value = '';
    showToast('Code added');
    pushCodesToSheet([entry]).then(result => { markCodesSaved([entry]); dropRefusedCodes(result); }).catch(reportSyncError);
  }

  document.getElementById('code-label').value = '';
  document.getElementById('code-expiry').value = '';
});

function generateQRPreview(code, label) {
  const container = document.getElementById('qr-container');
  container.innerHTML = '';

  new QRCode(container, {
    text: getRedeemUrl(code),
    width: 200,
    height: 200,
    colorDark: '#1a1a2e',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M,
  });

  document.getElementById('qr-code-text').textContent = code;
  document.getElementById('qr-label-text').textContent = label || '';
  document.getElementById('qr-preview').classList.remove('hidden');

  document.getElementById('download-qr').onclick = () => {
    const canvas = container.querySelector('canvas');
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `pogo-qr-${code}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  document.getElementById('copy-link').onclick = () => {
    navigator.clipboard.writeText(getDirectRedeemUrl(code)).then(() => showToast('Link copied'));
  };
}

function generateBulkQRPreview(entries) {
  const container = document.getElementById('qr-container');
  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'bulk-results';

  entries.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'code-item';

    const qrDiv = document.createElement('div');
    qrDiv.className = 'code-item-qr';

    new QRCode(qrDiv, {
      text: getRedeemUrl(entry.code),
      width: 100,
      height: 100,
      colorDark: '#1a1a2e',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });

    const info = document.createElement('div');
    info.className = 'code-item-info';
    info.innerHTML = `
      <div class="code-value">${entry.code}</div>
      <div class="code-meta">${entry.label || ''}</div>
    `;

    const actions = document.createElement('div');
    actions.className = 'code-item-actions';
    actions.innerHTML = `
      <button class="btn btn-small btn-secondary" onclick="copyCodeLink('${entry.code}')">Copy Link</button>
      <button class="btn btn-small btn-secondary" onclick="downloadCodeQR('bulk-qr-${entry.code}')">Download QR</button>
    `;

    qrDiv.id = `bulk-qr-${entry.code}`;
    item.appendChild(qrDiv);
    item.appendChild(info);
    item.appendChild(actions);
    wrapper.appendChild(item);
  });

  container.appendChild(wrapper);

  document.getElementById('qr-code-text').textContent = `${entries.length} codes generated`;
  document.getElementById('qr-label-text').textContent = entries[0].label || '';
  document.getElementById('qr-preview').classList.remove('hidden');

  document.getElementById('download-qr').onclick = () => downloadAllQRs(entries);
  document.getElementById('copy-link').classList.add('hidden');
}

function downloadAllQRs(entries) {
  entries.forEach((entry, i) => {
    const el = document.getElementById(`bulk-qr-${entry.code}`);
    const canvas = el && el.querySelector('canvas');
    if (!canvas) return;
    setTimeout(() => {
      const link = document.createElement('a');
      link.download = `pogo-qr-${entry.code}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    }, i * 300);
  });
}

// Render codes list, grouped by label
const COLLAPSED_GROUPS_KEY = 'pogo_collapsed_groups';

function getCollapsedGroups() {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY)) || []); } catch { return new Set(); }
}

function saveCollapsedGroups(set) {
  try { localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...set])); } catch {}
}

function groupDisplayName(name) {
  return name || 'Ungrouped';
}

function codeMeta(entry) {
  return [
    entry.expiry ? `Expires: ${formatExpiry(entry.expiry)}` : null,
    `Added: ${new Date(entry.addedAt).toLocaleDateString()}`,
  ].filter(Boolean).join(' · ');
}

function unusedCodeItem(entry, groupEnabled) {
  const isExpired = entry.expiry && new Date(entry.expiry) < new Date();
  const badge = !groupEnabled ? '<span class="badge badge-inactive">Paused</span>'
    : isExpired ? '<span class="badge badge-expired">Expired</span>'
    : '<span class="badge badge-active">Active</span>';
  const code = escapeHtml(entry.code);
  return `
    <div class="code-item${groupEnabled ? '' : ' code-item-paused'}" data-code="${code}">
      <div class="code-item-qr" id="qr-list-${code}"></div>
      <div class="code-item-info">
        <div class="code-value">${code}</div>
        <div class="code-meta">${codeMeta(entry)}</div>
        <div>${badge}</div>
      </div>
      <div class="code-item-actions">
        <button class="btn btn-small btn-secondary" onclick="copyCodeLink('${code}')">Copy Link</button>
        <button class="btn btn-small btn-secondary" onclick="downloadCodeQR('${code}')">Download QR</button>
        <button class="btn btn-small btn-secondary" data-code-action="move" data-code="${code}">Move</button>
        <button class="btn btn-small btn-secondary" data-code-action="send" data-code="${code}" data-needs="sendCodes" title="Move this code into another login's bank">Send</button>
        <button class="btn btn-small btn-warning" onclick="deactivateCode('${code}')" title="Mark as handed out / redeemed">Mark Used</button>
        <button class="btn btn-small btn-danger" onclick="removeCode('${code}')">Remove</button>
      </div>
    </div>
  `;
}

function usedCodeItem(entry) {
  const code = escapeHtml(entry.code);
  return `
    <div class="code-item code-item-inactive" data-code="${code}">
      <div class="code-item-info">
        <div class="code-value">${code}</div>
        <div class="code-meta">${codeMeta(entry)}</div>
        <div><span class="badge badge-inactive">Used</span></div>
      </div>
      <div class="code-item-actions">
        <button class="btn btn-small btn-secondary" onclick="reactivateCode('${code}')">Reactivate</button>
        <button class="btn btn-small btn-secondary" data-code-action="move" data-code="${code}">Move</button>
        <button class="btn btn-small btn-danger" onclick="removeCode('${code}')">Remove</button>
      </div>
    </div>
  `;
}

// The codes Active Codes lists: this login's bank, or for the overseer, the bank picked above the list.
function listedCodes() {
  const view = codesBankView();
  return view === '*' ? getCodes() : getCodes().filter(c => ownerOf(c) === view);
}

function renderCodesList() {
  const list = document.getElementById('codes-list');
  const codes = listedCodes();
  const allBanks = codesBankView() === '*';
  updateGroupOptions();
  updateLogFilter();

  if (codes.length === 0) {
    list.innerHTML = '<p class="empty-state">No codes added yet.</p>';
    return;
  }

  const groups = new Map();
  codes.forEach(c => {
    const key = groupKey(ownerOf(c), groupOf(c));
    if (!groups.has(key)) groups.set(key, { owner: ownerOf(c), name: groupOf(c), items: [] });
    groups.get(key).items.push(c);
  });
  const sorted = [...groups.values()].sort((a, b) =>
    bankLabel(a.owner).localeCompare(bankLabel(b.owner)) || (a.name === '') - (b.name === '') || a.name.localeCompare(b.name));
  const collapsed = getCollapsedGroups();

  const groupHtml = ({ owner, name, items }) => {
    const key = groupKey(owner, name);
    const enabled = isGroupEnabled(owner, name);
    const unused = items.filter(c => c.active !== false);
    const used = items.filter(c => c.active === false);
    const tied = groupEvent(owner, name);
    return `
      <details class="code-group${enabled ? '' : ' is-paused'}" data-group="${escapeHtml(name)}" data-owner="${escapeHtml(owner)}"${collapsed.has(key) ? '' : ' open'}>
        <summary class="code-group-summary">
          <span class="code-group-name">${escapeHtml(groupDisplayName(name))}</span>
          ${allBanks ? `<span class="badge badge-bank">${escapeHtml(bankLabel(owner))}</span>` : ''}
          <span class="badge ${enabled ? 'badge-active' : 'badge-inactive'}">${enabled ? 'Enabled' : 'Paused'}</span>
          ${tied ? `<span class="badge badge-event" title="Redemptions check in to this event">${escapeHtml(tied.name)}</span>` : ''}
          <span class="code-meta">${unused.length} unused · ${used.length} used</span>
          <span class="code-group-actions">
            <button type="button" class="btn btn-small ${enabled ? 'btn-warning' : 'btn-primary'}" data-group-action="toggle">${enabled ? 'Pause' : 'Enable'}</button>
            <button type="button" class="btn btn-small btn-secondary" data-group-action="rename">Rename</button>
            ${unused.length ? '<button type="button" class="btn btn-small btn-secondary" data-group-action="send" data-needs="sendCodes" title="Move this group\'s unused codes into another login\'s bank">Send</button>' : ''}
            <button type="button" class="btn btn-small btn-danger" data-group-action="delete">Delete</button>
          </span>
        </summary>
        <div class="codes-list code-group-body">
          ${unused.length ? unused.map(c => unusedCodeItem(c, enabled)).join('') : '<p class="empty-state">No unused codes in this group.</p>'}
          ${used.length ? `
            <details class="code-group-used">
              <summary>Used codes (${used.length})</summary>
              <div class="codes-list">${used.map(usedCodeItem).join('')}</div>
            </details>` : ''}
        </div>
      </details>
    `;
  };
  // Groups with no unused codes left are done with, so they're tucked away below the rest.
  const usedUp = g => g.items.every(c => c.active === false);
  const live = sorted.filter(g => !usedUp(g));
  const done = sorted.filter(usedUp);
  list.innerHTML = live.map(groupHtml).join('')
    + olderSection('groups', 'Used-up groups', done.length, done.map(groupHtml).join(''));

  visibleOpenGroups(list).forEach(renderGroupQrs);
}

function visibleOpenGroups(root) {
  return [...root.querySelectorAll('.code-group[open]')].filter(g => !g.closest('.older-section:not([open])'));
}

// QR thumbnails are only drawn for expanded groups, so big collapsed groups stay cheap.
function renderGroupQrs(groupEl) {
  groupEl.querySelectorAll('.code-item-qr:empty').forEach(el => {
    new QRCode(el, {
      text: getRedeemUrl(el.closest('.code-item').dataset.code),
      width: 80,
      height: 80,
      colorDark: '#1a1a2e',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  });
}

// New codes go in this login's own bank, so suggest its own groups.
function updateGroupOptions() {
  const mine = getCodes().filter(c => ownerOf(c) === me().key);
  const names = [...new Set(mine.map(groupOf).filter(Boolean))].sort();
  document.getElementById('group-options').innerHTML = names.map(n => `<option value="${escapeHtml(n)}"></option>`).join('');
}

function groupFromElement(el) {
  const group = el.closest('.code-group');
  return { name: group.dataset.group, owner: group.dataset.owner };
}

document.getElementById('codes-list').addEventListener('toggle', (e) => {
  if (e.target.matches('.older-section')) {
    setOlderOpen(e.target.dataset.older, e.target.open);
    if (e.target.open) visibleOpenGroups(e.target).forEach(renderGroupQrs);
    return;
  }
  const group = e.target.closest && e.target.matches('.code-group') ? e.target : null;
  if (!group) return;
  const collapsed = getCollapsedGroups();
  const key = groupKey(group.dataset.owner, group.dataset.group);
  if (group.open) {
    collapsed.delete(key);
    renderGroupQrs(group);
  } else {
    collapsed.add(key);
  }
  saveCollapsedGroups(collapsed);
}, true);

document.getElementById('codes-list').addEventListener('click', async (e) => {
  const groupButton = e.target.closest('[data-group-action]');
  const codeButton = e.target.closest('[data-code-action]');
  if (groupButton) {
    // Buttons sit inside <summary>, so stop the click from also collapsing the group.
    e.preventDefault();
    const { name, owner } = groupFromElement(groupButton);
    const action = groupButton.dataset.groupAction;
    if (action === 'toggle') await toggleGroup(owner, name);
    else if (action === 'rename') await renameCodeGroup(owner, name);
    else if (action === 'delete') await deleteCodeGroup(owner, name);
    else if (action === 'send') {
      const codes = getCodes().filter(c => ownerOf(c) === owner && groupOf(c) === name && c.active !== false).map(c => c.code);
      await sendCodes(codes, owner, `the ${codes.length} unused code${codes.length === 1 ? '' : 's'} in ${groupDisplayName(name)}`);
    }
  } else if (codeButton && codeButton.dataset.codeAction === 'move') {
    await moveCodeToGroup(codeButton.dataset.code);
  } else if (codeButton && codeButton.dataset.codeAction === 'send') {
    const entry = getCodes().find(c => c.code === codeButton.dataset.code);
    if (entry) await sendCodes([entry.code], ownerOf(entry), entry.code);
  }
});

// Moves unused codes into another login's bank. The server only moves codes that are still unused.
async function sendCodes(codes, fromOwner, description) {
  if (!codes.length) return;
  const targets = banks.filter(b => b.enabled && b.key !== fromOwner);
  if (!targets.length) {
    showToast('There are no other logins to send codes to. The overseer can add one in Admin Settings.');
    return;
  }
  let target = targets[0];
  if (targets.length === 1) {
    if (!confirm(`Send ${description} to ${target.name}? They'll leave this bank and show up in ${target.name}'s.`)) return;
  } else {
    const answer = prompt(`Send ${description} to which login?\n${targets.map((b, i) => `${i + 1}. ${b.name}`).join('\n')}\n\nType the number or the name.`);
    if (answer === null) return;
    const typed = answer.trim().toLowerCase();
    target = targets[Number(typed) - 1] || targets.find(b => b.name.toLowerCase() === typed);
    if (!target) {
      showToast(`No login called "${answer.trim()}"`);
      return;
    }
  }
  try {
    const data = await callSheet({ action: 'transferCodes', codes: JSON.stringify(codes), to: target.key });
    const skipped = new Set(data.skipped || []);
    const moved = new Set(codes.filter(c => !skipped.has(c)));
    // Codes that left a login's own bank drop out of its list; the overseer keeps seeing them, under their new bank.
    const keep = me().overseer;
    saveCodes(getCodes().flatMap(c => !moved.has(c.code) ? [c] : keep ? [{ ...c, owner: target.key }] : []));
    renderCodesList();
    showToast(`Sent ${data.moved} code${data.moved === 1 ? '' : 's'} to ${data.to}`
      + (skipped.size ? `. ${skipped.size} weren't sent because they were used or already moved.` : ''));
  } catch (err) {
    showToast('Could not send: ' + err.message);
  }
}

async function toggleGroup(owner, name) {
  const enable = !isGroupEnabled(owner, name);
  try {
    const data = await callSheet({ action: 'setGroupEnabled', group: name, enabled: String(enable), owner });
    saveGroupStates(data.groups);
    renderCodesList();
    showToast(enable
      ? `${groupDisplayName(name)} enabled. Its unused codes are back on the Display tab.`
      : `${groupDisplayName(name)} paused. Its codes won't show on the Display tab.`);
  } catch (err) {
    showToast('Could not update group: ' + err.message);
  }
}

async function renameCodeGroup(owner, name) {
  const next = (prompt(`Rename group "${groupDisplayName(name)}" to:`, name) || '').trim();
  if (!next || next === name) return;
  try {
    const data = await callSheet({ action: 'renameGroup', oldName: name, newName: next, owner });
    saveCodes(getCodes().map(c => ownerOf(c) === owner && groupOf(c) === name ? { ...c, label: next } : c));
    saveGroupStates(data.groups);
    renderCodesList();
    showToast(`Renamed to ${next}`);
  } catch (err) {
    showToast('Could not rename group: ' + err.message);
  }
}

async function deleteCodeGroup(owner, name) {
  const inGroup = c => ownerOf(c) === owner && groupOf(c) === name;
  const codes = getCodes().filter(inGroup);
  const used = codes.filter(c => c.active === false).length;
  const detail = `${codes.length} code${codes.length === 1 ? '' : 's'}` + (used ? ` (${used} used, ${codes.length - used} unused)` : '');
  if (!confirm(`Delete "${groupDisplayName(name)}" and its ${detail}? They'll be removed from the sheet too. This can't be undone, but scan log history is kept.`)) return;
  try {
    const data = await callSheet({ action: 'deleteGroup', group: name, owner });
    saveCodes(getCodes().filter(c => !inGroup(c)));
    saveGroupStates(data.groups);
    const collapsed = getCollapsedGroups();
    collapsed.delete(groupKey(owner, name));
    saveCollapsedGroups(collapsed);
    renderCodesList();
    showToast(`Deleted ${groupDisplayName(name)} (${data.removed} code${data.removed === 1 ? '' : 's'})`);
  } catch (err) {
    showToast('Could not delete group: ' + err.message);
  }
}

async function moveCodeToGroup(code) {
  const entry = getCodes().find(c => c.code === code);
  if (!entry) return;
  const existing = [...new Set(getCodes().filter(c => ownerOf(c) === ownerOf(entry)).map(groupOf).filter(Boolean))].sort();
  const hint = existing.length ? `\nExisting groups: ${existing.join(', ')}` : '';
  const answer = prompt(`Move ${code} to which group? Leave blank for Ungrouped.${hint}`, groupOf(entry));
  if (answer === null) return;
  const group = answer.trim();
  if (group === groupOf(entry)) return;
  try {
    await callSheet({ action: 'setCodeGroup', code, group });
    saveCodes(getCodes().map(c => c.code === code ? { ...c, label: group } : c));
    renderCodesList();
    showToast(`${code} moved to ${groupDisplayName(group)}`);
  } catch (err) {
    showToast('Could not move code: ' + err.message);
  }
}

function copyCodeLink(code) {
  navigator.clipboard.writeText(getDirectRedeemUrl(code)).then(() => showToast('Link copied'));
}

function downloadCodeQR(idOrCode) {
  let container = document.getElementById(idOrCode);
  if (!container) container = document.getElementById(`qr-list-${idOrCode}`);
  const canvas = container && container.querySelector('canvas');
  if (!canvas) return;
  const code = idOrCode.replace('qr-list-', '').replace('bulk-qr-', '');
  const link = document.createElement('a');
  link.download = `pogo-qr-${code}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function deactivateCode(code) {
  const codes = getCodes();
  const entry = codes.find(c => c.code === code);
  if (entry) {
    entry.active = false;
    saveCodes(codes);
    renderCodesList();
    syncUpdateToSheet(code, false);
    showToast('Code marked used');
  }
}

function reactivateCode(code) {
  const codes = getCodes();
  const entry = codes.find(c => c.code === code);
  if (entry) {
    entry.active = true;
    saveCodes(codes);
    renderCodesList();
    syncUpdateToSheet(code, true);
    showToast('Code reactivated');
  }
}

function removeCode(code) {
  if (!confirm(`Remove code ${code}?`)) return;
  const codes = getCodes().filter(c => c.code !== code);
  saveCodes(codes);
  renderCodesList();
  syncRemoveFromSheet(code);
  showToast('Code removed');
}

const REQUIRED_SCRIPT_VERSION = 29;

async function callSheet(params) {
  const scriptUrl = getSetting(STORAGE_KEYS.SCRIPT_URL);
  if (!scriptUrl) throw new Error('No script URL configured');

  const query = Object.entries({ ...params, t: getAuthToken() })
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const res = await fetch(`${scriptUrl}?${query}`);
  const data = await res.json();
  if (data.unauthorized) {
    clearSession();
    showLogin('Your session expired. Please log in again.');
    throw new Error('Not logged in');
  }
  if (data.forbidden) {
    if (params.action !== 'whoami') refreshPermissions();
    throw new Error(data.error);
  }
  if (data.error === 'Unknown action') {
    throw new Error('Apps Script is outdated — paste the latest google-apps-script.js and redeploy');
  }
  if (data.error) throw new Error(data.error);
  return data;
}

// The login's permissions may have changed since this page loaded, so a refusal re-checks them.
function refreshPermissions() {
  callSheet({ action: 'whoami' }).then(data => setBanks(data.banks, data.me)).catch(() => {});
}

async function checkScriptVersion() {
  let data;
  try {
    data = await callSheet({ action: 'ping' });
  } catch (err) {
    if (err.message.startsWith('Apps Script is outdated')) throw err;
    throw new Error('Could not reach Apps Script: ' + err.message);
  }
  if ((data.version || 0) < REQUIRED_SCRIPT_VERSION) {
    throw new Error('Apps Script is outdated — paste the latest google-apps-script.js and redeploy');
  }
}

// Requests are chunked to keep URLs short and run one at a time so Apps Script doesn't drop concurrent writes.
// fromSync marks a background upload: the sheet then refuses codes deleted on another device and lists them.
// taken: codes already in another login's bank. used: codes that were redeemed before. Neither gets added.
async function pushCodesToSheet(entries, fromSync) {
  let added = 0;
  const refused = new Set();
  const taken = new Set();
  const used = new Set();
  for (let i = 0; i < entries.length; i += 15) {
    const chunk = entries.slice(i, i + 15).map(e => ({
      code: e.code,
      label: e.label || '',
      expiry: e.expiry || '',
      addedAt: e.addedAt || '',
      active: e.active !== false,
    }));
    const params = { action: 'addCodes', codes: JSON.stringify(chunk) };
    if (fromSync) params.source = 'sync';
    const data = await callSheet(params);
    added += data.added || 0;
    (data.deleted || []).forEach(c => refused.add(String(c).toUpperCase()));
    (data.taken || []).forEach(c => taken.add(String(c).toUpperCase()));
    (data.used || []).forEach(c => used.add(String(c).toUpperCase()));
  }
  return { added, refused, taken, used };
}

// Takes codes the sheet wouldn't add back out of this device's list, and says why.
function dropRefusedCodes(result) {
  const dropped = new Set([...result.taken, ...result.used]);
  if (!dropped.size) return;
  saveCodes(getCodes().filter(c => !dropped.has(String(c.code).toUpperCase())));
  renderCodesList();
  const parts = [];
  if (result.taken.size) parts.push(`${result.taken.size} already in another login's bank (${[...result.taken].join(', ')})`);
  if (result.used.size) parts.push(`${result.used.size} already redeemed before (${[...result.used].join(', ')})`);
  showToast(`Not added: ${parts.join('; ')}`);
}

// The sheet is the source of truth. The only local codes uploaded are ones added on this device whose
// upload never finished (pending). Anything else missing from the sheet was deleted elsewhere, so it's dropped.
async function syncCodesFromSheet() {
  await checkScriptVersion();

  const data = await callSheet({ action: 'getCodes' });
  setBanks(data.banks, data.me);
  saveGroupStates(data.groups);
  const sheetCodes = (data.codes || []).map(c => ({
    code: String(c.code).trim().toUpperCase(),
    label: c.label || '',
    expiry: c.expiry || null,
    addedAt: c.addedAt || '',
    active: c.active !== false,
    owner: c.owner || '',
  }));

  const sheetSet = new Set(sheetCodes.map(c => c.code));
  const toUpload = getCodes().filter(c => c.pending && !sheetSet.has(String(c.code).toUpperCase()));
  let pushed = 0;
  let kept = [];
  if (toUpload.length) {
    const result = await pushCodesToSheet(toUpload, true);
    pushed = result.added;
    const dropped = new Set([...result.refused, ...result.taken, ...result.used]);
    kept = toUpload.filter(c => !dropped.has(String(c.code).toUpperCase())).map(c => ({ ...c, pending: false }));
  }

  saveCodes([...kept, ...sheetCodes]);
  announceReceivedCodes(data.received || []);
  return { fromSheet: sheetCodes.length, pushed };
}

// Says once when another login has sent codes to this one. The first sync on a device just notes where things stand.
function announceReceivedCodes(received) {
  const key = `pogo_received_seen_${me().key}`;
  let seen = null;
  try { seen = localStorage.getItem(key); } catch {}
  const latest = received.reduce((max, r) => (r.at > max ? r.at : max), seen || '');
  try { localStorage.setItem(key, latest || new Date().toISOString()); } catch {}
  if (seen === null) return;
  const fresh = received.filter(r => r.at > seen);
  if (!fresh.length) return;
  const bySender = new Map();
  fresh.forEach(r => bySender.set(r.from, (bySender.get(r.from) || 0) + 1));
  showToast([...bySender].map(([from, n]) => `${n} code${n === 1 ? '' : 's'} received from ${from}`).join(' · '));
}

function markCodesSaved(entries) {
  const saved = new Set(entries.map(e => e.code));
  saveCodes(getCodes().map(c => saved.has(c.code) ? { ...c, pending: false } : c));
}

function activeTabName() {
  const tab = document.querySelector('.tab.active');
  return tab ? tab.dataset.tab : '';
}

// Background refresh used when opening code tabs; returns whether anything changed.
async function refreshCodesQuietly() {
  const snapshot = () => [STORAGE_KEYS.CODES, STORAGE_KEYS.GROUPS, STORAGE_KEYS.GROUP_EVENTS].map(k => localStorage.getItem(k)).join('|');
  const before = snapshot();
  try {
    await syncCodesFromSheet();
  } catch {
    return false;
  }
  return before !== snapshot();
}

async function syncAndRender(silent) {
  if (!silent) showToast('Syncing...');
  try {
    const { fromSheet, pushed } = await syncCodesFromSheet();
    renderCodesList();
    if (!silent) {
      showToast(pushed ? `Synced ${fromSheet} from sheet, uploaded ${pushed}` : `Synced ${fromSheet} codes`);
    }
  } catch (err) {
    renderCodesList();
    showToast('Sync failed: ' + err.message);
  }
}

function reportSyncError(err) {
  showToast('Sheet not updated: ' + err.message);
}

function syncUpdateToSheet(code, active) {
  callSheet({ action: 'updateCode', code, active: active ? 'true' : 'false' }).catch(reportSyncError);
}

function syncRemoveFromSheet(code) {
  callSheet({ action: 'removeCode', code }).catch(reportSyncError);
}

// Scan log
async function loadScanLog() {
  const scriptUrl = getSetting(STORAGE_KEYS.SCRIPT_URL);
  if (!scriptUrl) {
    document.getElementById('log-table-container').innerHTML =
      '<p class="empty-state">Configure your Google Apps Script URL in Settings to view scan logs.</p>';
    return;
  }

  document.getElementById('log-table-container').innerHTML =
    '<p class="empty-state">Loading scan log...</p>';

  try {
    const data = await callSheet({ action: 'getLogs' });

    if (!data.logs || data.logs.length === 0) {
      document.getElementById('log-table-container').innerHTML =
        '<p class="empty-state">No scans recorded yet.</p>';
      return;
    }

    renderLogTable(data.logs);
  } catch (err) {
    document.getElementById('log-table-container').innerHTML =
      `<p class="empty-state">Error loading logs: ${escapeHtml(err.message)}</p>`;
  }
}

function renderLogTable(logs) {
  const filter = document.getElementById('log-filter').value;
  const filtered = filter === 'all' ? logs : logs.filter(l => l.code === filter);

  const html = `
    <table class="log-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Code</th>
          <th>Group</th>
          <th>Bank</th>
          <th>Shown By</th>
          <th>Trainer</th>
          <th>Device</th>
          <th>OS</th>
          <th>Browser</th>
          <th>City</th>
          <th>Country</th>
          <th>Language</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map(log => `
          <tr>
            <td>${new Date(log.timestamp).toLocaleString()}</td>
            <td><strong>${escapeHtml(log.code)}</strong></td>
            <td>${escapeHtml(log.group)}</td>
            <td>${escapeHtml(log.bank)}</td>
            <td>${escapeHtml(usernameLabel(log.shownBy))}</td>
            <td>${escapeHtml(log.trainerName)}</td>
            <td>${escapeHtml(log.device)}</td>
            <td>${escapeHtml(log.os)}</td>
            <td>${escapeHtml(log.browser)}</td>
            <td>${escapeHtml(log.city)}</td>
            <td>${escapeHtml(log.country)}</td>
            <td>${escapeHtml(log.language)}</td>
            <td><span class="badge ${log.repeat ? 'badge-repeat' : 'badge-new'}">${log.repeat ? 'Repeat' : 'New'}</span></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  document.getElementById('log-table-container').innerHTML = html;
}

function updateLogFilter() {
  const select = document.getElementById('log-filter');
  const codes = getCodes();
  const current = select.value;

  select.innerHTML = '<option value="all">All Codes</option>' +
    codes.map(c => `<option value="${escapeHtml(c.code)}">${escapeHtml(c.code)}${c.label ? ` - ${escapeHtml(c.label)}` : ''}</option>`).join('');

  select.value = current;
}

document.getElementById('refresh-log').addEventListener('click', loadScanLog);
document.getElementById('log-filter').addEventListener('change', loadScanLog);

// Error log
async function loadErrorLog() {
  const scriptUrl = getSetting(STORAGE_KEYS.SCRIPT_URL);
  if (!scriptUrl) {
    document.getElementById('error-log-container').innerHTML =
      '<p class="empty-state">Configure your Google Apps Script URL to view error logs.</p>';
    return;
  }

  document.getElementById('error-log-container').innerHTML =
    '<p class="empty-state">Loading errors...</p>';

  try {
    const data = await callSheet({ action: 'getErrors' });

    if (!data.errors || data.errors.length === 0) {
      document.getElementById('error-log-container').innerHTML =
        '<p class="empty-state">No errors recorded.</p>';
      return;
    }

    const html = `
      <table class="log-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Page</th>
            <th>Error</th>
            <th>Browser</th>
          </tr>
        </thead>
        <tbody>
          ${data.errors.map(err => `
            <tr>
              <td>${new Date(err.timestamp).toLocaleString()}</td>
              <td>${escapeHtml(err.page)}</td>
              <td title="${escapeHtml(err.stack)}">${escapeHtml(err.error)}</td>
              <td>${err.userAgent ? escapeHtml(err.userAgent.slice(0, 40)) + '...' : ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    document.getElementById('error-log-container').innerHTML = html;
  } catch {
    document.getElementById('error-log-container').innerHTML =
      '<p class="empty-state">Error loading error logs.</p>';
  }
}

document.getElementById('refresh-errors').addEventListener('click', loadErrorLog);

// Display viewer
let displayIndex = 0;

function initDisplay() {
  const codes = getDisplayCodes();
  if (codes.length === 0) {
    document.getElementById('display-empty').classList.remove('hidden');
    document.getElementById('display-viewer').classList.add('hidden');
    return;
  }

  document.getElementById('display-empty').classList.add('hidden');
  document.getElementById('display-viewer').classList.remove('hidden');
  displayIndex = 0;
  renderDisplayQR();
  startDisplayPolling();
  renderDisplayEventPicker();
  loadEvents().then(renderDisplayEventPicker);
}

// Ties every group in the display queue to one event, so their redemptions check people in there
// (and into its lotteries) instead of into whatever events happen to be running that day.
function displayedGroups() {
  return [...new Set(getDisplayCodes().map(groupOf))];
}

function renderDisplayEventPicker() {
  const select = document.getElementById('display-event');
  const bank = displayBank();
  const tied = displayedGroups().map(g => (groupEvent(bank, g) || {}).id || '');
  const current = tied.every(id => id === tied[0]) ? (tied[0] || '') : 'mixed';
  const events = eventState.events.filter(ev => ev.open || ev.id === current);
  // An event this device hasn't loaded yet still shows by the name the sheet sent with the group.
  if (current && current !== 'mixed' && !events.some(ev => ev.id === current)) {
    const g = displayedGroups().find(name => (groupEvent(bank, name) || {}).id === current);
    events.unshift({ id: current, name: groupEvent(bank, g).name, date: '' });
  }
  select.innerHTML = '<option value="">Any open event that day</option>'
    + (current === 'mixed' ? '<option value="mixed" disabled>Mixed: groups go to different events</option>' : '')
    + events.map(ev => {
      const day = ev.date ? ' · ' + new Date(ev.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
      return `<option value="${escapeHtml(ev.id)}">${escapeHtml(ev.name + day)}</option>`;
    }).join('');
  select.value = current;
}

document.getElementById('display-event').addEventListener('change', async (e) => {
  const select = e.target;
  const groups = displayedGroups();
  if (!groups.length) return;
  select.disabled = true;
  try {
    const data = await callSheet({ action: 'setGroupsEvent', groups: JSON.stringify(groups), eventId: select.value, owner: displayBank() });
    if (data.error) throw new Error(data.error);
    saveGroupStates(data.groups);
    const label = select.value ? select.selectedOptions[0].textContent : 'any open event that day';
    showToast(`Redemptions of these codes now check in to ${label}.`);
  } catch (err) {
    showToast(`Couldn't save: ${err.message}`);
  } finally {
    select.disabled = false;
    renderDisplayEventPicker();
  }
});

// Auto-advance: while the Display tab is open, poll the code on screen. Once it's redeemed, flash
// "Redeemed!", move to the next active code, and after the last one switch to Check In.
const DISPLAY_AUTO_KEY = 'pogo_display_auto';
const DISPLAY_POLL_MS = 3000;
const displayAuto = { timer: null, busy: false };

function displayAutoEnabled() {
  return document.getElementById('display-auto').checked;
}

function setDisplayAutoStatus(text) {
  document.getElementById('display-auto-status').textContent = text;
}

function stopDisplayPolling() {
  clearInterval(displayAuto.timer);
  displayAuto.timer = null;
  setDisplayAutoStatus('');
}

function startDisplayPolling() {
  stopDisplayPolling();
  if (!displayAutoEnabled() || !document.getElementById('display').classList.contains('active')) return;
  if (!getDisplayCodes().length) return;
  setDisplayAutoStatus('watching');
  displayAuto.timer = setInterval(pollDisplayedCode, DISPLAY_POLL_MS);
}

async function pollDisplayedCode() {
  if (displayAuto.busy) return;
  const codes = getDisplayCodes();
  const entry = codes[displayIndex];
  if (!entry) return;

  displayAuto.busy = true;
  try {
    const status = await callSheet({ action: 'getCodeStatus', code: entry.code });
    const current = getDisplayCodes()[displayIndex];
    // Ignore the answer if someone swiped to a different code while the request was in flight.
    if (!current || current.code !== entry.code || !status.exists || status.active) return;
    await showCodeRedeemed(entry.code);
  } catch (err) {
    setDisplayAutoStatus('connection issue, retrying');
  } finally {
    displayAuto.busy = false;
  }
}

async function showCodeRedeemed(code) {
  const codes = getCodes();
  const local = codes.find(c => c.code === code);
  if (local) {
    local.active = false;
    saveCodes(codes);
  }

  const overlay = document.getElementById('display-redeemed');
  overlay.classList.remove('hidden');
  await new Promise(r => setTimeout(r, 2200));
  overlay.classList.add('hidden');
  if (!document.getElementById('display').classList.contains('active')) return;

  if (!getDisplayCodes().length) {
    stopDisplayPolling();
    showToast('All codes distributed. Switching to Check In.');
    activateTab('checkin');
    return;
  }
  // The redeemed code dropped out of the active list, so the same index now points at the next one.
  renderDisplayQR();
  setDisplayAutoStatus('watching');
}

(function initDisplayAuto() {
  const toggle = document.getElementById('display-auto');
  try { toggle.checked = localStorage.getItem(DISPLAY_AUTO_KEY) === '1'; } catch {}
  toggle.addEventListener('change', () => {
    try { localStorage.setItem(DISPLAY_AUTO_KEY, toggle.checked ? '1' : '0'); } catch {}
    if (toggle.checked) startDisplayPolling();
    else stopDisplayPolling();
  });
})();

function renderDisplayQR() {
  const codes = getDisplayCodes();
  if (codes.length === 0) return;
  document.getElementById('display-redeemed').classList.add('hidden');

  if (displayIndex < 0) displayIndex = codes.length - 1;
  if (displayIndex >= codes.length) displayIndex = 0;

  const entry = codes[displayIndex];
  const container = document.getElementById('display-qr');
  container.innerHTML = '';

  const size = Math.min(window.innerWidth - 96, 280);

  new QRCode(container, {
    text: getRedeemUrl(entry.code),
    width: size,
    height: size,
    colorDark: '#1a1a2e',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M,
  });

  document.getElementById('display-code-text').textContent = entry.code;
  document.getElementById('display-label-text').textContent = entry.label || '';
  document.getElementById('display-pos').textContent = displayIndex + 1;
  document.getElementById('display-total').textContent = codes.length;
}

document.getElementById('display-prev').addEventListener('click', () => {
  displayIndex--;
  renderDisplayQR();
});

document.getElementById('display-next').addEventListener('click', () => {
  displayIndex++;
  renderDisplayQR();
});

// Swipe support
(function () {
  const el = document.getElementById('display-swipe');
  let startX = 0;
  let startY = 0;
  let dragging = false;

  el.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dragging = true;
  }, { passive: true });

  el.addEventListener('touchend', (e) => {
    if (!dragging) return;
    dragging = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) { displayIndex++; renderDisplayQR(); }
      else { displayIndex--; renderDisplayQR(); }
    }
  }, { passive: true });

  // Mouse drag support
  el.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    dragging = true;
  });

  document.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 50) {
      if (dx < 0) { displayIndex++; renderDisplayQR(); }
      else { displayIndex--; renderDisplayQR(); }
    }
  });
})();

// Keyboard arrow support
document.addEventListener('keydown', (e) => {
  const displayTab = document.getElementById('display');
  if (!displayTab.classList.contains('active')) return;
  if (e.key === 'ArrowLeft') { displayIndex--; renderDisplayQR(); }
  if (e.key === 'ArrowRight') { displayIndex++; renderDisplayQR(); }
});

// Campfire exports (uploaded JSON from the Campfire meetup tracker, stored in the sheet)
const CAMPFIRE_STATUS = {
  CHECKED_IN: { label: 'Checked in', badge: 'badge-active' },
  ACCEPTED: { label: "RSVP'd, didn't check in", badge: 'badge-expired' },
  DECLINED: { label: 'Declined', badge: 'badge-inactive' },
};
const campfireState = { exports: [], cache: new Map(), view: 'events', selectedId: null, hidden: new Set(), showHidden: false };

function isCampfireHidden(name) {
  return campfireState.hidden.has(trainerKey(name));
}

// Whether this name is left out of what's on screen right now.
function campfireNameGone(name) {
  return !campfireState.showHidden && isCampfireHidden(name);
}

function campfireHideButton(name, className) {
  if (!trainerKey(name)) return '';
  const hidden = isCampfireHidden(name);
  return `<button type="button" class="${className}" data-campfire-hide="${escapeHtml(name)}" data-hidden="${hidden}" data-needs="campfireManage"
    aria-label="${hidden ? 'Unhide' : 'Hide'} ${escapeHtml(name)}" title="${hidden ? 'Unhide this name' : 'Hide this name from Campfire Exports'}">${hidden ? 'Unhide' : 'Hide'}</button>`;
}

// Uploads are too large for a GET URL, so this one call is a POST. text/plain avoids a CORS preflight.
async function postSheet(payload) {
  const scriptUrl = getSetting(STORAGE_KEYS.SCRIPT_URL);
  const res = await fetch(scriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, t: getAuthToken() }),
  });
  const data = await res.json();
  if (data.unauthorized) {
    clearSession();
    showLogin('Your session expired. Please log in again.');
    throw new Error('Not logged in');
  }
  if (data.error === 'Unknown action') throw new Error('Apps Script is outdated — paste the latest google-apps-script.js and redeploy');
  if (data.error) throw new Error(data.error);
  return data;
}

function campfireOptionLabel(x) {
  const when = x.exportedAt ? new Date(x.exportedAt) : null;
  const date = when && !isNaN(when) ? when.toLocaleDateString() : 'unknown date';
  return `${x.name} · exported ${date} · ${x.events} events, ${x.people} people`;
}

async function loadCampfireList() {
  const select = document.getElementById('campfire-select');
  try {
    const data = await callSheet({ action: 'listCampfire' });
    campfireState.exports = data.exports || [];
    campfireState.hidden = new Set(data.hidden || []);
  } catch (err) {
    document.getElementById('campfire-view').innerHTML = `<p class="empty-state">Couldn't load exports: ${escapeHtml(err.message)}</p>`;
    return;
  }

  if (!campfireState.exports.length) {
    select.innerHTML = '<option value="">No exports uploaded yet</option>';
    document.getElementById('campfire-delete').disabled = true;
    document.getElementById('campfire-view').innerHTML = '';
    return;
  }

  let saved = null;
  try { saved = localStorage.getItem('pogo_campfire_selected'); } catch {}
  const exists = id => campfireState.exports.some(x => x.id === id);
  const id = exists(campfireState.selectedId) ? campfireState.selectedId : exists(saved) ? saved : campfireState.exports[0].id;

  select.innerHTML = campfireState.exports.map(x => `<option value="${escapeHtml(x.id)}">${escapeHtml(campfireOptionLabel(x))}</option>`).join('');
  select.value = id;
  document.getElementById('campfire-delete').disabled = false;
  showCampfire(id);
}

async function showCampfire(id) {
  campfireState.selectedId = id;
  try { localStorage.setItem('pogo_campfire_selected', id); } catch {}
  const view = document.getElementById('campfire-view');
  if (!campfireState.cache.has(id)) {
    view.innerHTML = '<p class="empty-state">Loading export...</p>';
    try {
      const data = await callSheet({ action: 'getCampfire', id });
      campfireState.cache.set(id, data.data);
    } catch (err) {
      view.innerHTML = `<p class="empty-state">Couldn't load this export: ${escapeHtml(err.message)}</p>`;
      return;
    }
  }
  if (campfireState.selectedId === id) renderCampfire(campfireState.cache.get(id));
}

function formatEventTime(start, end) {
  const s = new Date(start);
  if (isNaN(s)) return '';
  const day = s.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const time = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const e = new Date(end);
  return `${day} · ${time(s)}${isNaN(e) ? '' : '–' + time(e)}`;
}

function renderCampfire(data) {
  const view = document.getElementById('campfire-view');
  const events = [...(data.events || [])].sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)));
  const people = data.people || [];
  const totals = data.totals || {};
  const stat = (value, label) => `<div class="campfire-stat"><span class="campfire-stat-value">${Number(value || 0).toLocaleString()}</span><span class="campfire-stat-label">${label}</span></div>`;
  const exported = data.exportedAt ? new Date(data.exportedAt).toLocaleString() : 'unknown';

  // Totals come from the export, so take off whatever the people out of view added to them.
  const gonePeople = people.filter(p => campfireNameGone(p.name));
  const shownPeople = people.filter(p => !campfireNameGone(p.name));
  const less = (value, n) => (value == null ? value : Math.max(0, value - n));
  const goneSum = (field) => gonePeople.reduce((n, p) => n + (p[field] || 0), 0);
  const hiddenHere = new Set(people.map(p => p.name)
    .concat(...events.map(ev => (ev.attendees || []).map(a => a.name)))
    .filter(isCampfireHidden).map(trainerKey));

  view.innerHTML = `
    <p class="code-meta campfire-meta">Exported ${escapeHtml(exported)}${data.source ? ' from ' + escapeHtml(data.source) : ''}</p>
    <div class="campfire-stats">
      ${stat(totals.events ?? events.length, 'Events')}
      ${stat(less(totals.checkIns, goneSum('checkedInCount')), 'Check-ins')}
      ${stat(less(totals.uniquePeopleCheckedIn, gonePeople.filter(p => p.checkedInCount > 0).length), 'People checked in')}
      ${stat(less(totals.rsvpOnly, goneSum('rsvpOnlyCount')), "RSVP'd, no check-in")}
      ${stat(less(totals.uniquePeople ?? people.length, gonePeople.length), 'People total')}
    </div>
    <div class="campfire-tabs" role="tablist">
      <button type="button" class="btn btn-small ${campfireState.view === 'events' ? 'btn-primary' : 'btn-secondary'}" data-campfire-view="events">Events (${events.length})</button>
      <button type="button" class="btn btn-small ${campfireState.view === 'people' ? 'btn-primary' : 'btn-secondary'}" data-campfire-view="people">People (${shownPeople.length})</button>
      ${hiddenHere.size ? `<button type="button" id="campfire-show-hidden" class="btn btn-small btn-secondary campfire-show-hidden" aria-pressed="${campfireState.showHidden}">${campfireState.showHidden ? 'Hide hidden' : 'Show hidden'} (${hiddenHere.size})</button>` : ''}
    </div>
    <div id="campfire-body"></div>
  `;
  if (campfireState.view === 'events') renderCampfireEvents(events);
  else renderCampfirePeople(shownPeople, events);
}

// Redraws after a hide or unhide without closing what's open or clearing the search.
function redrawCampfireInPlace() {
  const data = campfireState.cache.get(campfireState.selectedId);
  if (!data) return;
  const view = document.getElementById('campfire-view');
  const open = new Set([...view.querySelectorAll('details[open][data-open-key]')].map(d => d.dataset.openKey));
  const search = document.getElementById('campfire-people-search');
  const query = search ? search.value : '';
  renderCampfire(data);
  const newSearch = document.getElementById('campfire-people-search');
  if (newSearch && query) {
    newSearch.value = query;
    newSearch.dispatchEvent(new Event('input'));
  }
  view.querySelectorAll('details[data-open-key]').forEach(d => { d.open = open.has(d.dataset.openKey); });
}

async function setCampfireNameHidden(name, hide) {
  const key = trainerKey(name);
  const apply = (hidden) => {
    if (hidden) campfireState.hidden.add(key);
    else campfireState.hidden.delete(key);
    redrawCampfireInPlace();
  };
  apply(hide);
  showToast(hide ? `${name} hidden` : `${name} unhidden`);
  try {
    await callSheet({ action: 'setCampfireHidden', name, hidden: String(hide) });
  } catch (err) {
    apply(!hide);
    showToast(`Could not ${hide ? 'hide' : 'unhide'} ${name}: ${err.message}`);
  }
}

function renderCampfireEvents(events) {
  const body = document.getElementById('campfire-body');
  if (!events.length) {
    body.innerHTML = '<p class="empty-state">This export has no events.</p>';
    return;
  }
  body.innerHTML = `<div class="campfire-list">${events.map(ev => {
    const counts = ev.counts || {};
    const byStatus = { CHECKED_IN: [], ACCEPTED: [], DECLINED: [] };
    const goneByStatus = {};
    (ev.attendees || []).forEach(a => {
      if (campfireNameGone(a.name)) goneByStatus[a.status] = (goneByStatus[a.status] || 0) + 1;
      else (byStatus[a.status] || (byStatus[a.status] = [])).push(a.name);
    });
    const sections = Object.keys(byStatus).filter(s => byStatus[s].length).map(s => `
      <div class="campfire-attendees">
        <h4>${escapeHtml((CAMPFIRE_STATUS[s] || { label: s }).label)} (${byStatus[s].length})</h4>
        <div class="campfire-names">${byStatus[s].sort((a, b) => String(a).localeCompare(String(b))).map(n => `<span class="campfire-name${isCampfireHidden(n) ? ' is-hidden' : ''}">${escapeHtml(n)}${campfireHideButton(n, 'campfire-hide')}</span>`).join('')}</div>
      </div>
    `).join('');
    const details = [
      ev.group && ev.group.name ? `<div><span class="code-meta">Group</span> ${escapeHtml(ev.group.name)}</div>` : '',
      ev.host && !campfireNameGone(ev.host) ? `<div><span class="code-meta">Host</span> ${escapeHtml(ev.host)}</div>` : '',
      ev.address ? `<div><span class="code-meta">Where</span> ${escapeHtml(ev.address)}</div>` : '',
      /^https:\/\//.test(ev.url || '') ? `<div><a href="${escapeHtml(ev.url)}" target="_blank" rel="noopener noreferrer">Open in Campfire</a></div>` : '',
    ].join('');
    return `
      <details class="trainer-row campfire-event" data-open-key="event:${escapeHtml(ev.id || '')}">
        <summary>
          <span class="campfire-event-title">
            <span class="lottery-name">${escapeHtml(ev.name || 'Untitled event')}</span>
            <span class="code-meta">${escapeHtml(formatEventTime(ev.startTime, ev.endTime))}</span>
          </span>
          <span class="trainer-stats">
            <span class="badge badge-active">${counts.checkedIn != null ? Math.max(0, counts.checkedIn - (goneByStatus.CHECKED_IN || 0)) : byStatus.CHECKED_IN.length} checked in</span>
            <span class="badge badge-expired">${counts.rsvpOnly != null ? Math.max(0, counts.rsvpOnly - (goneByStatus.ACCEPTED || 0)) : byStatus.ACCEPTED.length} RSVP only</span>
          </span>
        </summary>
        <div class="campfire-event-body">
          <div class="campfire-details">${details}</div>
          ${sections || '<p class="code-meta">No attendees listed.</p>'}
        </div>
      </details>
    `;
  }).join('')}</div>`;
}

function renderCampfirePeople(people, events) {
  const body = document.getElementById('campfire-body');
  const eventsById = new Map(events.map(e => [e.id, e]));
  body.innerHTML = `
    <div class="form-group campfire-search">
      <input type="search" id="campfire-people-search" placeholder="Search names" autocomplete="off" aria-label="Search people">
    </div>
    <div id="campfire-people" class="campfire-list"></div>
  `;
  const sorted = [...people].sort((a, b) => (b.checkedInCount || 0) - (a.checkedInCount || 0) || String(a.name).localeCompare(String(b.name)));
  const draw = () => {
    const q = document.getElementById('campfire-people-search').value.trim().toLowerCase();
    const shown = q ? sorted.filter(p => String(p.name || '').toLowerCase().includes(q)) : sorted;
    document.getElementById('campfire-people').innerHTML = shown.length ? shown.map(p => {
      const history = (p.events || []).map(pe => ({ ev: eventsById.get(pe.eventId), status: pe.status }))
        .sort((a, b) => String(b.ev && b.ev.startTime).localeCompare(String(a.ev && a.ev.startTime)));
      return `
        <details class="trainer-row${isCampfireHidden(p.name) ? ' is-hidden' : ''}" data-open-key="person:${escapeHtml(trainerKey(p.name))}">
          <summary>
            <span class="lottery-name">${escapeHtml(p.name || 'Unknown')}</span>
            <span class="trainer-stats">
              <span class="badge badge-active">${plural(p.checkedInCount || 0, 'check-in')}</span>
              ${p.rsvpOnlyCount ? `<span class="badge badge-expired">${p.rsvpOnlyCount} RSVP only</span>` : ''}
            </span>
            ${campfireHideButton(p.name, 'btn btn-small btn-secondary')}
          </summary>
          <div class="campfire-event-body">
            <ul class="campfire-history">${history.map(h => `
              <li>
                <span>${escapeHtml(h.ev ? h.ev.name : 'Event not in this export')}</span>
                <span class="code-meta">${h.ev ? escapeHtml(formatEventTime(h.ev.startTime)) : ''}</span>
                <span class="badge ${(CAMPFIRE_STATUS[h.status] || {}).badge || 'badge-inactive'}">${escapeHtml((CAMPFIRE_STATUS[h.status] || { label: h.status }).label)}</span>
              </li>`).join('')}
            </ul>
          </div>
        </details>
      `;
    }).join('') : '<p class="empty-state">No names match that search.</p>';
  };
  document.getElementById('campfire-people-search').addEventListener('input', draw);
  draw();
}

document.getElementById('campfire-view').addEventListener('click', (e) => {
  const hide = e.target.closest('[data-campfire-hide]');
  if (hide) {
    // These can sit inside a row's summary, where a click would also open or close the row.
    e.preventDefault();
    setCampfireNameHidden(hide.dataset.campfireHide, hide.dataset.hidden !== 'true');
    return;
  }
  if (e.target.closest('#campfire-show-hidden')) {
    campfireState.showHidden = !campfireState.showHidden;
    redrawCampfireInPlace();
    return;
  }
  const tab = e.target.closest('[data-campfire-view]');
  if (!tab) return;
  campfireState.view = tab.dataset.campfireView;
  const data = campfireState.cache.get(campfireState.selectedId);
  if (data) renderCampfire(data);
});

document.getElementById('campfire-select').addEventListener('change', (e) => {
  if (e.target.value) showCampfire(e.target.value);
});

document.getElementById('campfire-file').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const label = document.getElementById('campfire-upload-label');
  let lastId = null;
  let failures = 0;
  for (const [i, file] of files.entries()) {
    label.textContent = files.length > 1 ? `Uploading ${i + 1}/${files.length}...` : 'Uploading...';
    try {
      const text = await file.text();
      JSON.parse(text);
      const data = await postSheet({ action: 'uploadCampfire', name: file.name, json: text });
      lastId = data.export.id;
    } catch (err) {
      failures++;
      showToast(`${file.name}: ${err instanceof SyntaxError ? "isn't valid JSON" : err.message}`);
    }
  }
  label.textContent = 'Upload JSON';
  if (lastId) {
    campfireState.selectedId = lastId;
    await loadCampfireList();
    if (!failures) showToast(files.length > 1 ? `${files.length} exports uploaded` : 'Export uploaded');
  }
});

document.getElementById('campfire-delete').addEventListener('click', async () => {
  const x = campfireState.exports.find(e => e.id === campfireState.selectedId);
  if (!x || !confirm(`Delete "${x.name}" from the sheet? This can't be undone.`)) return;
  try {
    await callSheet({ action: 'deleteCampfire', id: x.id });
    campfireState.cache.delete(x.id);
    campfireState.selectedId = null;
    await loadCampfireList();
    showToast('Export deleted');
  } catch (err) {
    showToast('Could not delete: ' + err.message);
  }
});

// Phone bookmarklet. It has to stay short (Chrome on Android won't run a long one), and Campfire's page
// blocks scripts loaded from other sites, so the bookmark opens cfcheck.html, which messages the current
// js/campfire-bookmarklet.js back to it. The bookmark only runs messages from this site, and always shows
// something: the script's panel, or an alert saying why it couldn't start.
function campfireBookmarklet() {
  const page = `${location.origin}${location.pathname.replace(/index\.html$/, '')}cfcheck.html`;
  return `javascript:(()=>{const w=open('${page}','pogocf');`
    + `if(!w){alert('cfcheck needs pop-ups. Allow pop-ups for campfire.scopely.com in Chrome site settings, then try again.');return}`
    + `const t=setTimeout(()=>{removeEventListener('message',h);alert('cfcheck did not hear back from PoGo Code Dist. Check your connection and try again.')},20000);`
    + `function h(e){if(e.origin!=='${location.origin}'||e.source!==w)return;removeEventListener('message',h);clearTimeout(t);`
    + `if(e.data.cfcheckError)return alert('cfcheck could not load: '+e.data.cfcheckError);`
    + `try{(0,eval)(e.data.cfcheck)}catch(x){alert('cfcheck hit an error: '+x.message)}}`
    + `addEventListener('message',h)})()`;
}

// iPhones only allow clipboard writes straight from the tap, so nothing may be awaited before this.
function copyBookmarklet(text, label) {
  const box = document.getElementById('campfire-bookmarklet-code');
  box.value = text;
  const selectForHand = () => {
    box.focus();
    box.setSelectionRange(0, box.value.length);
    showToast('Copying was blocked. The text in the box is selected: copy it by hand.');
  };
  if (!navigator.clipboard) return selectForHand();
  navigator.clipboard.writeText(text)
    .then(() => showToast(`${label} copied. Paste it as a bookmark's address.`))
    .catch(selectForHand);
}

document.querySelector('.campfire-phone').addEventListener('toggle', (e) => {
  if (e.target.open) document.getElementById('campfire-bookmarklet-code').value = campfireBookmarklet();
});

document.getElementById('campfire-bookmarklet-copy').addEventListener('click', () => {
  copyBookmarklet(campfireBookmarklet(), 'Bookmarklet');
});

// The bookmarklet opens this page with #campfire=<export JSON>. Save it like an upload, replacing an
// earlier copy of the same meetup so re-sending during an event keeps one up-to-date entry.
async function receiveCampfireFromLink() {
  const prefix = '#campfire=';
  if (!location.hash.startsWith(prefix)) return;
  const raw = location.hash.slice(prefix.length);
  history.replaceState(null, '', location.pathname + location.search);

  let data;
  try {
    data = JSON.parse(decodeURIComponent(raw));
  } catch {
    showToast('That Campfire link was cut off or damaged. Try sending it again.');
    return;
  }
  const ev = data && Array.isArray(data.events) && data.events[0];
  if (!ev || !Array.isArray(data.people)) {
    showToast("That link doesn't contain a Campfire meetup.");
    return;
  }

  const day = ev.startTime ? new Date(ev.startTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const name = `Meetup: ${ev.name || 'Untitled'}${day ? ' (' + day + ')' : ''}`;
  activateTab('settings');
  showToast('Saving Campfire meetup...');
  try {
    const before = await callSheet({ action: 'listCampfire' });
    const saved = await postSheet({ action: 'uploadCampfire', name, json: JSON.stringify(data) });
    for (const old of (before.exports || []).filter(x => x.name === name)) {
      await callSheet({ action: 'deleteCampfire', id: old.id }).catch(() => {});
      campfireState.cache.delete(old.id);
    }
    campfireState.selectedId = saved.export.id;
    campfireState.view = 'events';
    await loadCampfireList();
    document.getElementById('campfire-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    const checkedIn = ev.counts ? ev.counts.checkedIn : 0;
    showToast(`Saved "${ev.name}": ${checkedIn} checked in`);
  } catch (err) {
    showToast("Couldn't save the meetup: " + err.message);
  }
}

window.addEventListener('hashchange', () => {
  if (getAuthToken()) receiveCampfireFromLink();
});

// ---------- Admin Settings (overseer only) ----------
// Logins for other admins: each has its own code bank and the permissions ticked here. Passwords are
// stored hashed in the Apps Script's Script properties, never in the sheet.
const adminState = { accounts: [], permissions: [] };

async function loadAccounts() {
  const list = document.getElementById('account-list');
  try {
    const data = await callSheet({ action: 'listAccounts' });
    adminState.accounts = data.accounts || [];
    adminState.permissions = data.permissions || [];
    setBanks(data.banks);
    renderAccounts();
  } catch (err) {
    list.innerHTML = `<p class="empty-state">Couldn't load logins: ${escapeHtml(err.message)}</p>`;
  }
}

function renderAccounts() {
  const list = document.getElementById('account-list');
  if (!adminState.accounts.length) {
    list.innerHTML = '<p class="empty-state">No other logins yet. Add one below.</p>';
    return;
  }
  const open = new Set([...list.querySelectorAll('.account[open]')].map(d => d.dataset.key));
  list.innerHTML = adminState.accounts.map(a => `
    <details class="account${a.enabled ? '' : ' is-off'}" data-key="${escapeHtml(a.key)}"${open.has(a.key) ? ' open' : ''}>
      <summary class="account-summary">
        <span class="lottery-name">${escapeHtml(a.name)}</span>
        <span class="badge ${a.enabled ? 'badge-active' : 'badge-inactive'}">${a.enabled ? 'On' : 'Turned off'}</span>
        <span class="code-meta">${a.perms.length} of ${adminState.permissions.length} permissions</span>
      </summary>
      <div class="account-body">
        <div class="account-perms">
          ${adminState.permissions.map(([key, label]) => `
            <label class="rule-row account-perm">
              <input type="checkbox" data-perm="${escapeHtml(key)}"${a.perms.includes(key) ? ' checked' : ''}>
              <span>${escapeHtml(label)}</span>
            </label>
          `).join('')}
        </div>
        <p class="card-note">Their own code bank, Display and Add Codes are always on. Changes apply on their next tap.</p>
        <div class="lottery-toolbar-actions">
          <button type="button" class="btn btn-small btn-secondary" data-account-action="password">Reset Password</button>
          <button type="button" class="btn btn-small ${a.enabled ? 'btn-warning' : 'btn-primary'}" data-account-action="toggle">${a.enabled ? 'Turn Off' : 'Turn On'}</button>
          <button type="button" class="btn btn-small btn-danger" data-account-action="delete">Delete</button>
        </div>
      </div>
    </details>
  `).join('');
}

async function saveAccountChange(params, message) {
  const data = await callSheet({ action: 'saveAccount', ...params });
  adminState.accounts = data.accounts || [];
  setBanks(data.banks);
  renderAccounts();
  if (message) showToast(message);
}

document.getElementById('account-list').addEventListener('change', async (e) => {
  const box = e.target.closest('input[data-perm]');
  if (!box) return;
  const details = box.closest('.account');
  const perms = [...details.querySelectorAll('input[data-perm]:checked')].map(i => i.dataset.perm);
  details.querySelectorAll('input[data-perm]').forEach(i => { i.disabled = true; });
  try {
    await saveAccountChange({ username: details.dataset.key, perms: JSON.stringify(perms) }, 'Permissions saved');
  } catch (err) {
    showToast('Could not save: ' + err.message);
    renderAccounts();
  }
});

document.getElementById('account-list').addEventListener('click', async (e) => {
  const button = e.target.closest('[data-account-action]');
  if (!button) return;
  const key = button.closest('.account').dataset.key;
  const account = adminState.accounts.find(a => a.key === key);
  if (!account) return;
  const action = button.dataset.accountAction;
  try {
    if (action === 'password') {
      const password = prompt(`New password for ${account.name} (at least 8 characters). They'll be logged out everywhere.`);
      if (!password) return;
      await saveAccountChange({ username: key, password }, `${account.name}'s password changed`);
    } else if (action === 'toggle') {
      if (account.enabled && !confirm(`Turn off ${account.name}? They're logged out right away and can't log in until you turn them back on. Their codes stay in their bank.`)) return;
      await saveAccountChange({ username: key, enabled: String(!account.enabled) }, account.enabled ? `${account.name} turned off` : `${account.name} turned on`);
    } else if (action === 'delete') {
      if (!confirm(`Delete ${account.name}'s login? All codes in their bank move to yours. Scan logs and check-ins keep their name.`)) return;
      const data = await callSheet({ action: 'deleteAccount', username: key });
      adminState.accounts = data.accounts || [];
      setBanks(data.banks);
      renderAccounts();
      await syncAndRender(true);
      showToast(`${account.name} deleted. ${data.moved} code${data.moved === 1 ? '' : 's'} moved to your bank.`);
    }
  } catch (err) {
    showToast('Could not update login: ' + err.message);
  }
});

document.getElementById('account-add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('account-username').value.trim();
  const password = document.getElementById('account-password').value;
  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await saveAccountChange({ username, password, create: 'true' }, `${username} can now log in`);
    e.target.reset();
    const details = document.querySelector(`#account-list .account[data-key="${CSS.escape(username.toLowerCase())}"]`);
    if (details) details.open = true;
  } catch (err) {
    showToast('Could not add login: ' + err.message);
  } finally {
    button.disabled = false;
  }
});

// Called by auth.js once a valid admin session exists (after login, or on load with a saved session).
function onAdminReady() {
  applyPermissions();
  syncAndRender(true);
  let saved = null;
  try { saved = localStorage.getItem('pogo_active_tab'); } catch {}
  // Add Code, Scan Log, and Community used to be their own tabs; they now live under Settings.
  if (saved === 'scan-log' || saved === 'community') saved = 'settings';
  if (saved === 'add-code') saved = 'settings';
  const tab = saved && document.querySelector(`.tab[data-tab="${saved}"]`);
  activateTab(tab && !tab.classList.contains('hidden') ? saved : 'active-codes');
  receiveCampfireFromLink();
}
