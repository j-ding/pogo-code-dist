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

function getGroupStates() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.GROUPS)) || {}; } catch { return {}; }
}

function saveGroupStates(list) {
  const states = {};
  (list || []).forEach(g => { states[g.name] = g.enabled !== false; });
  try { localStorage.setItem(STORAGE_KEYS.GROUPS, JSON.stringify(states)); } catch {}
  const events = {};
  (list || []).forEach(g => { if (g.eventId) events[g.name] = { id: g.eventId, name: g.eventName || '' }; });
  try { localStorage.setItem(STORAGE_KEYS.GROUP_EVENTS, JSON.stringify(events)); } catch {}
}

// The event a group is tied to ({ id, name }), or null when its redemptions go by date.
function groupEvent(name) {
  try { return (JSON.parse(localStorage.getItem(STORAGE_KEYS.GROUP_EVENTS)) || {})[name] || null; } catch { return null; }
}

function isGroupEnabled(name) {
  return getGroupStates()[name] !== false;
}

// Codes the Display tab hands out: unused and in an enabled group.
function getDisplayCodes() {
  return getCodes().filter(c => c.active !== false && isGroupEnabled(groupOf(c)));
}

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

function getRedeemUrl(code) {
  return `${getBaseUrl()}/redeem.html?code=${encodeURIComponent(code)}`;
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
    loadScanLog();
    initCommunity();
    loadCampfireList();
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
    return `
      <details class="trainer-row">
        <summary>
          <span class="lottery-name">${escapeHtml(t.trainerName)}</span>
          <span class="trainer-stats">
            <span class="badge badge-new">${plural(t.events.length, 'event')}</span>
            <span class="badge badge-active">${plural(t.redemptions, 'code')}</span>
            ${t.wins.length ? `<span class="badge badge-winner">${plural(t.wins.length, 'win')}</span>` : ''}
          </span>
          <span class="code-meta">${t.lastSeen ? 'Last seen ' + new Date(t.lastSeen).toLocaleDateString() : ''}</span>
        </summary>
        <div class="trainer-detail">
          <div><h4>Events attended</h4>${events}</div>
          <div><h4>Lottery wins</h4>${wins}</div>
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

async function initLottery() {
  await loadEvents();
  fillEventSelect(document.getElementById('lottery-event'));
  loadLotteries();
}

function eventLabel(ev) {
  return `${ev.name} (${new Date(ev.date).toLocaleDateString()})`;
}

function fillEventSelect(select, selectedId) {
  const events = eventState.events;
  if (events.length === 0) {
    select.innerHTML = '<option value="">Create an event in the Check In tab first</option>';
    return;
  }
  select.innerHTML = events.map(ev => `<option value="${escapeHtml(ev.id)}">${escapeHtml(eventLabel(ev))}</option>`).join('');
  if (selectedId && events.some(ev => ev.id === selectedId)) select.value = selectedId;
}

function lotteryEventName(lottery) {
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

function renderLotteryHistory() {
  const history = document.getElementById('lottery-history');
  if (lotteryState.lotteries.length === 0) {
    history.innerHTML = '<p class="empty-state">No lotteries yet. Create one above.</p>';
    return;
  }

  history.innerHTML = lotteryState.lotteries.map(l => {
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
  }).join('');

  history.querySelectorAll('.lottery-history-item').forEach(el => {
    el.addEventListener('click', () => selectLottery(el.dataset.id));
  });
}

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

function renderLotteryEntrants() {
  const lottery = selectedLottery();
  const list = document.getElementById('lottery-list');
  const entrants = lotteryState.entrants;
  document.getElementById('lottery-count').textContent = entrants.length;

  if (entrants.length === 0) {
    list.innerHTML = '<p class="empty-state">No entrants yet.</p>';
    return;
  }

  list.innerHTML = entrants.map(e => {
    const key = trainerKey(e.trainerName);
    const winner = isWinner(lottery, e.trainerName);

    if (lotteryState.editingKey === key) {
      return `
        <form class="lottery-entrant lottery-entrant-edit" data-key="${escapeHtml(key)}" data-name="${escapeHtml(e.trainerName)}">
          <input type="text" class="lottery-entrant-input" value="${escapeHtml(e.trainerName)}" aria-label="Trainer name" required>
          <span class="lottery-entrant-actions">
            <button type="submit" class="btn btn-small btn-primary">Save</button>
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
      e.checkedIn ? '<span class="badge badge-new">Checked in</span>' : '',
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
          <button type="button" class="btn btn-small btn-secondary" data-action="edit">Edit</button>
          <button type="button" class="btn btn-small btn-danger" data-action="remove">Remove</button>
        </span>
      </div>
    `;
  }).join('');

  const input = list.querySelector('.lottery-entrant-input');
  if (input) { input.focus(); input.select(); }
}

function lotteryRules(lottery) {
  return lottery.rules || { excludeRecentEvents: 0, excludeLotteryIds: [] };
}

function renderLotteryRules(lottery) {
  const rules = lotteryRules(lottery);
  document.getElementById('lottery-rule-recent').value = String(rules.excludeRecentEvents);

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
  document.getElementById('lottery-rules-summary').textContent = parts.length ? `· excluding winners from ${parts.join(' and ')}` : '· off';
  if (parts.length) document.getElementById('lottery-rules').open = true;
}

async function saveLotteryRules() {
  const lottery = selectedLottery();
  if (!lottery) return;
  const excludeRecentEvents = document.getElementById('lottery-rule-recent').value;
  const excludeLotteryIds = [...document.querySelectorAll('#lottery-rule-lotteries input:checked')].map(i => i.value);
  try {
    const data = await callSheet({
      action: 'setLotteryRules',
      id: lottery.id,
      excludeRecentEvents,
      excludeLotteryIds: JSON.stringify(excludeLotteryIds),
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
  ['lottery-draw', 'lottery-draw-all', 'lottery-refresh', 'lottery-toggle', 'lottery-edit', 'lottery-delete', 'lottery-winner-count', 'lottery-rule-recent'].forEach(id => {
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
      if (i < count - 1) await new Promise(r => setTimeout(r, 900));
    }
    if (picked.length > 1) showToast(`Winners: ${picked.join(', ')}`);
  } finally {
    lotteryState.drawing = false;
    setLotteryButtonsDisabled(false);
    const current = selectedLottery();
    if (current) updateDrawButton(current);
  }
}

// Returns the winner's name, or null if nothing could be drawn.
async function drawOneWinner(lottery) {
  const pool = lotteryState.entrants.filter(e => !e.skipped && !e.ineligible && !isWinner(lottery, e.trainerName));
  if (pool.length === 0) {
    showToast(lotteryState.entrants.length ? 'No one left to draw' : 'No entrants to draw from');
    return null;
  }

  const winner = pool[randomIndex(pool.length)];
  const nodes = pool.map(e => document.querySelector(`.lottery-entrant[data-key="${CSS.escape(trainerKey(e.trainerName))}"]`));
  const winnerNode = nodes[pool.indexOf(winner)];

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

  try {
    const data = await callSheet({ action: 'recordWinner', id: lottery.id, trainerName: winner.trainerName });
    lottery.winners = data.winners || [...lottery.winners, winner.trainerName];
    renderLotteryHeader(lottery);
    renderLotteryHistory();
    renderLotteryEntrants();
    setLotteryButtonsDisabled(true);
    const node = document.querySelector(`.lottery-entrant[data-key="${CSS.escape(trainerKey(winner.trainerName))}"]`);
    if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
document.getElementById('lottery-draw-all').addEventListener('click', () => {
  const lottery = selectedLottery();
  if (lottery) drawLotteryWinners(winnerCountOf(lottery) - lottery.winners.length);
});
document.getElementById('lottery-refresh').addEventListener('click', loadLotteryEntrants);

// Events / Check In
const eventState = { events: [], selectedId: null, attendees: [] };

function getCheckInUrl(id) {
  return `${getBaseUrl()}/checkin.html?event=${encodeURIComponent(id)}`;
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

function renderEventAttendees() {
  const list = document.getElementById('event-attendees');
  const attendees = eventState.attendees;
  document.getElementById('event-count').textContent = attendees.length;
  if (attendees.length === 0) {
    list.innerHTML = '<p class="empty-state">No one has checked in yet.</p>';
    return;
  }
  const knownCodes = new Map(getCodes().map(c => [c.code, c]));
  list.innerHTML = attendees.map(a => `
    <div class="lottery-entrant attendee-row" data-name="${escapeHtml(a.trainerName)}">
      <span class="lottery-name">${escapeHtml(a.trainerName)}</span>
      <span class="lottery-badges">
        ${a.redeemed ? '<span class="badge badge-active">Redeemed code</span>' : ''}
        ${a.checkedIn ? '<span class="badge badge-new">Checked in</span>' : ''}
      </span>
      <span class="code-meta">${new Date(a.firstSeen).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
      <span class="lottery-entrant-actions">
        <button type="button" class="btn btn-small btn-danger" data-action="remove-attendee">Remove</button>
      </span>
      ${(a.codes || []).length ? `<div class="attendee-codes">${a.codes.map(c => redeemedCodeChip(c, knownCodes.get(c.code))).join('')}</div>` : ''}
    </div>
  `).join('');
}

function redeemedCodeChip(scan, entry) {
  const time = new Date(scan.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const status = !entry ? '<span class="code-status">not in your codes</span>'
    : entry.active !== false ? '<span class="code-status is-active">active</span>'
    : `<span class="code-status">used</span>
       <button type="button" class="btn btn-small btn-secondary" data-action="reactivate-code" data-code="${escapeHtml(scan.code)}"
         title="Put this code back in Active Codes if the trainer couldn't redeem it">Reactivate</button>`;
  return `
    <span class="attendee-code">
      <span class="attendee-code-value">${escapeHtml(scan.code)}</span>
      <span class="code-meta">${time}</span>
      ${status}
    </span>
  `;
}

async function reactivateFromCheckIn(code) {
  try {
    await callSheet({ action: 'updateCode', code, active: 'true' });
    const codes = getCodes();
    const entry = codes.find(c => c.code === code);
    if (entry) {
      entry.active = true;
      saveCodes(codes);
    }
    renderEventAttendees();
    showToast(`${code} is active again`);
  } catch (err) {
    showToast('Could not reactivate: ' + err.message);
  }
}

document.getElementById('event-attendees').addEventListener('click', async (e) => {
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
      const entry = { code, label, expiry: expiry || null, addedAt: new Date().toISOString(), pending: true };
      newCodes.push(entry);
      existing.unshift(entry);
    }

    saveCodes(existing);
    document.getElementById('code-bulk').value = '';

    if (newCodes.length > 0) {
      generateBulkQRPreview(newCodes);
      const msg = `${newCodes.length} code(s) added` + (skipped ? `, ${skipped} skipped (duplicates)` : '');
      showToast(msg);
      pushCodesToSheet(newCodes).then(() => markCodesSaved(newCodes)).catch(reportSyncError);
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

    const entry = { code, label, expiry: expiry || null, addedAt: new Date().toISOString(), pending: true };
    codes.unshift(entry);
    saveCodes(codes);
    generateQRPreview(code, label);
    document.getElementById('code-input').value = '';
    showToast('Code added');
    pushCodesToSheet([entry]).then(() => markCodesSaved([entry])).catch(reportSyncError);
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

function renderCodesList() {
  const list = document.getElementById('codes-list');
  const codes = getCodes();
  updateGroupOptions();
  updateLogFilter();

  if (codes.length === 0) {
    list.innerHTML = '<p class="empty-state">No codes added yet.</p>';
    return;
  }

  const groups = new Map();
  codes.forEach(c => {
    const name = groupOf(c);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(c);
  });
  const names = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
  const collapsed = getCollapsedGroups();

  list.innerHTML = names.map(name => {
    const items = groups.get(name);
    const enabled = isGroupEnabled(name);
    const unused = items.filter(c => c.active !== false);
    const used = items.filter(c => c.active === false);
    const esc = escapeHtml(name);
    return `
      <details class="code-group${enabled ? '' : ' is-paused'}" data-group="${esc}"${collapsed.has(name) ? '' : ' open'}>
        <summary class="code-group-summary">
          <span class="code-group-name">${escapeHtml(groupDisplayName(name))}</span>
          <span class="badge ${enabled ? 'badge-active' : 'badge-inactive'}">${enabled ? 'Enabled' : 'Paused'}</span>
          ${groupEvent(name) ? `<span class="badge badge-event" title="Redemptions check in to this event">${escapeHtml(groupEvent(name).name)}</span>` : ''}
          <span class="code-meta">${unused.length} unused · ${used.length} used</span>
          <span class="code-group-actions">
            <button type="button" class="btn btn-small ${enabled ? 'btn-warning' : 'btn-primary'}" data-group-action="toggle">${enabled ? 'Pause' : 'Enable'}</button>
            <button type="button" class="btn btn-small btn-secondary" data-group-action="rename">Rename</button>
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
  }).join('');

  list.querySelectorAll('.code-group[open]').forEach(renderGroupQrs);
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

function updateGroupOptions() {
  const names = [...new Set(getCodes().map(groupOf).filter(Boolean))].sort();
  document.getElementById('group-options').innerHTML = names.map(n => `<option value="${escapeHtml(n)}"></option>`).join('');
}

document.getElementById('codes-list').addEventListener('toggle', (e) => {
  const group = e.target.closest && e.target.matches('.code-group') ? e.target : null;
  if (!group) return;
  const collapsed = getCollapsedGroups();
  if (group.open) {
    collapsed.delete(group.dataset.group);
    renderGroupQrs(group);
  } else {
    collapsed.add(group.dataset.group);
  }
  saveCollapsedGroups(collapsed);
}, true);

document.getElementById('codes-list').addEventListener('click', async (e) => {
  const groupButton = e.target.closest('[data-group-action]');
  const codeButton = e.target.closest('[data-code-action="move"]');
  if (groupButton) {
    // Buttons sit inside <summary>, so stop the click from also collapsing the group.
    e.preventDefault();
    const name = groupButton.closest('.code-group').dataset.group;
    const action = groupButton.dataset.groupAction;
    if (action === 'toggle') await toggleGroup(name);
    else if (action === 'rename') await renameCodeGroup(name);
    else if (action === 'delete') await deleteCodeGroup(name);
  } else if (codeButton) {
    await moveCodeToGroup(codeButton.dataset.code);
  }
});

async function toggleGroup(name) {
  const enable = !isGroupEnabled(name);
  try {
    const data = await callSheet({ action: 'setGroupEnabled', group: name, enabled: String(enable) });
    saveGroupStates(data.groups);
    renderCodesList();
    showToast(enable
      ? `${groupDisplayName(name)} enabled. Its unused codes are back on the Display tab.`
      : `${groupDisplayName(name)} paused. Its codes won't show on the Display tab.`);
  } catch (err) {
    showToast('Could not update group: ' + err.message);
  }
}

async function renameCodeGroup(name) {
  const next = (prompt(`Rename group "${groupDisplayName(name)}" to:`, name) || '').trim();
  if (!next || next === name) return;
  try {
    const data = await callSheet({ action: 'renameGroup', oldName: name, newName: next });
    saveCodes(getCodes().map(c => groupOf(c) === name ? { ...c, label: next } : c));
    saveGroupStates(data.groups);
    renderCodesList();
    showToast(`Renamed to ${next}`);
  } catch (err) {
    showToast('Could not rename group: ' + err.message);
  }
}

async function deleteCodeGroup(name) {
  const codes = getCodes().filter(c => groupOf(c) === name);
  const used = codes.filter(c => c.active === false).length;
  const detail = `${codes.length} code${codes.length === 1 ? '' : 's'}` + (used ? ` (${used} used, ${codes.length - used} unused)` : '');
  if (!confirm(`Delete "${groupDisplayName(name)}" and its ${detail}? They'll be removed from the sheet too. This can't be undone, but scan log history is kept.`)) return;
  try {
    const data = await callSheet({ action: 'deleteGroup', group: name });
    saveCodes(getCodes().filter(c => groupOf(c) !== name));
    saveGroupStates(data.groups);
    const collapsed = getCollapsedGroups();
    collapsed.delete(name);
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
  const existing = [...new Set(getCodes().map(groupOf).filter(Boolean))].sort();
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

const REQUIRED_SCRIPT_VERSION = 20;

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
  if (data.error === 'Unknown action') {
    throw new Error('Apps Script is outdated — paste the latest google-apps-script.js and redeploy');
  }
  if (data.error) throw new Error(data.error);
  return data;
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
async function pushCodesToSheet(entries, fromSync) {
  let added = 0;
  const refused = new Set();
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
  }
  return { added, refused };
}

// The sheet is the source of truth. The only local codes uploaded are ones added on this device whose
// upload never finished (pending). Anything else missing from the sheet was deleted elsewhere, so it's dropped.
async function syncCodesFromSheet() {
  await checkScriptVersion();

  const data = await callSheet({ action: 'getCodes' });
  saveGroupStates(data.groups);
  const sheetCodes = (data.codes || []).map(c => ({
    code: String(c.code).trim().toUpperCase(),
    label: c.label || '',
    expiry: c.expiry || null,
    addedAt: c.addedAt || '',
    active: c.active !== false,
  }));

  const sheetSet = new Set(sheetCodes.map(c => c.code));
  const toUpload = getCodes().filter(c => c.pending && !sheetSet.has(String(c.code).toUpperCase()));
  let pushed = 0;
  let kept = [];
  if (toUpload.length) {
    const result = await pushCodesToSheet(toUpload, true);
    pushed = result.added;
    kept = toUpload.filter(c => !result.refused.has(String(c.code).toUpperCase())).map(c => ({ ...c, pending: false }));
  }

  saveCodes([...kept, ...sheetCodes]);
  return { fromSheet: sheetCodes.length, pushed };
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
    codes.map(c => `<option value="${c.code}">${c.code}${c.label ? ` - ${c.label}` : ''}</option>`).join('');

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
  const tied = displayedGroups().map(g => (groupEvent(g) || {}).id || '');
  const current = tied.every(id => id === tied[0]) ? (tied[0] || '') : 'mixed';
  const events = eventState.events.filter(ev => ev.open || ev.id === current);
  // An event this device hasn't loaded yet still shows by the name the sheet sent with the group.
  if (current && current !== 'mixed' && !events.some(ev => ev.id === current)) {
    const g = displayedGroups().find(name => (groupEvent(name) || {}).id === current);
    events.unshift({ id: current, name: groupEvent(g).name, date: '' });
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
    const data = await callSheet({ action: 'setGroupsEvent', groups: JSON.stringify(groups), eventId: select.value });
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
const campfireState = { exports: [], cache: new Map(), view: 'events', selectedId: null };

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

  view.innerHTML = `
    <p class="code-meta campfire-meta">Exported ${escapeHtml(exported)}${data.source ? ' from ' + escapeHtml(data.source) : ''}</p>
    <div class="campfire-stats">
      ${stat(totals.events ?? events.length, 'Events')}
      ${stat(totals.checkIns, 'Check-ins')}
      ${stat(totals.uniquePeopleCheckedIn, 'People checked in')}
      ${stat(totals.rsvpOnly, "RSVP'd, no check-in")}
      ${stat(totals.uniquePeople ?? people.length, 'People total')}
    </div>
    <div class="campfire-tabs" role="tablist">
      <button type="button" class="btn btn-small ${campfireState.view === 'events' ? 'btn-primary' : 'btn-secondary'}" data-campfire-view="events">Events (${events.length})</button>
      <button type="button" class="btn btn-small ${campfireState.view === 'people' ? 'btn-primary' : 'btn-secondary'}" data-campfire-view="people">People (${people.length})</button>
    </div>
    <div id="campfire-body"></div>
  `;
  if (campfireState.view === 'events') renderCampfireEvents(events);
  else renderCampfirePeople(people, events);
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
    (ev.attendees || []).forEach(a => (byStatus[a.status] || (byStatus[a.status] = [])).push(a.name));
    const sections = Object.keys(byStatus).filter(s => byStatus[s].length).map(s => `
      <div class="campfire-attendees">
        <h4>${escapeHtml((CAMPFIRE_STATUS[s] || { label: s }).label)} (${byStatus[s].length})</h4>
        <div class="campfire-names">${byStatus[s].sort((a, b) => String(a).localeCompare(String(b))).map(n => `<span class="campfire-name">${escapeHtml(n)}</span>`).join('')}</div>
      </div>
    `).join('');
    const details = [
      ev.group && ev.group.name ? `<div><span class="code-meta">Group</span> ${escapeHtml(ev.group.name)}</div>` : '',
      ev.host ? `<div><span class="code-meta">Host</span> ${escapeHtml(ev.host)}</div>` : '',
      ev.address ? `<div><span class="code-meta">Where</span> ${escapeHtml(ev.address)}</div>` : '',
      /^https:\/\//.test(ev.url || '') ? `<div><a href="${escapeHtml(ev.url)}" target="_blank" rel="noopener noreferrer">Open in Campfire</a></div>` : '',
    ].join('');
    return `
      <details class="trainer-row campfire-event">
        <summary>
          <span class="campfire-event-title">
            <span class="lottery-name">${escapeHtml(ev.name || 'Untitled event')}</span>
            <span class="code-meta">${escapeHtml(formatEventTime(ev.startTime, ev.endTime))}</span>
          </span>
          <span class="trainer-stats">
            <span class="badge badge-active">${counts.checkedIn ?? byStatus.CHECKED_IN.length} checked in</span>
            <span class="badge badge-expired">${counts.rsvpOnly ?? byStatus.ACCEPTED.length} RSVP only</span>
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
        <details class="trainer-row">
          <summary>
            <span class="lottery-name">${escapeHtml(p.name || 'Unknown')}</span>
            <span class="trainer-stats">
              <span class="badge badge-active">${plural(p.checkedInCount || 0, 'check-in')}</span>
              ${p.rsvpOnlyCount ? `<span class="badge badge-expired">${p.rsvpOnlyCount} RSVP only</span>` : ''}
            </span>
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

// Phone bookmarklet. The short one loads js/campfire-bookmarklet.js from this site each time it runs, so
// it's easy to paste and always current. The full one inlines that file with this site's address baked
// in, for browsers where the short one can't load it.
const campfireSite = () => location.origin + location.pathname.replace(/index\.html$/, '');
let campfireFullBookmarklet = null;

function campfireShortBookmarklet() {
  const src = `${campfireSite()}js/campfire-bookmarklet.js?t=`;
  return `javascript:(()=>{const s=document.createElement('script');s.src='${src}'+Date.now();document.body.appendChild(s)})()`;
}

async function buildCampfireFullBookmarklet() {
  if (campfireFullBookmarklet) return campfireFullBookmarklet;
  const version = document.querySelector('meta[name="app-version"]').content;
  const res = await fetch(`js/campfire-bookmarklet.js?v=${version}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const source = (await res.text())
    .replace(/^\/\*[\s\S]*?\*\/\s*/, '')
    .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//')).join('\n')
    .replace('__POGO_URL__', campfireSite());
  campfireFullBookmarklet = 'javascript:' + encodeURIComponent(source);
  return campfireFullBookmarklet;
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
  if (!e.target.open) return;
  document.getElementById('campfire-bookmarklet-code').value = campfireShortBookmarklet();
  buildCampfireFullBookmarklet().catch(() => {});
});

document.getElementById('campfire-bookmarklet-copy').addEventListener('click', () => {
  copyBookmarklet(campfireShortBookmarklet(), 'Bookmarklet');
});

document.getElementById('campfire-bookmarklet-full').addEventListener('click', () => {
  if (campfireFullBookmarklet) return copyBookmarklet(campfireFullBookmarklet, 'Full bookmarklet');
  showToast('Still loading the full version. Tap again in a moment.');
  buildCampfireFullBookmarklet().catch(err => showToast("Couldn't load the full version: " + err.message));
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

// Called by auth.js once a valid admin session exists (after login, or on load with a saved session).
function onAdminReady() {
  syncAndRender(true);
  let saved = null;
  try { saved = localStorage.getItem('pogo_active_tab'); } catch {}
  // Add Code, Scan Log, and Community used to be their own tabs; they now live under Settings.
  if (saved === 'scan-log' || saved === 'community') saved = 'settings';
  if (saved === 'add-code') saved = 'settings';
  activateTab(saved && document.querySelector(`.tab[data-tab="${saved}"]`) ? saved : 'active-codes');
  receiveCampfireFromLink();
}
