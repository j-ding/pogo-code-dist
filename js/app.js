const STORAGE_KEYS = {
  CODES: 'pogo_codes',
  SCRIPT_URL: 'pogo_script_url',
};

function getCodes() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.CODES)) || [];
  } catch {
    return [];
  }
}

function getActiveCodes() {
  return getCodes().filter(c => c.active !== false);
}

function getInactiveCodes() {
  return getCodes().filter(c => c.active === false);
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

  if (name === 'active-codes') renderCodesList();
  if (name === 'display') initDisplay();
  if (name === 'scan-log') loadScanLog();
  if (name === 'lottery') initLottery();
  if (name === 'community') initCommunity();
}

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

document.getElementById('community').addEventListener('click', (e) => {
  const button = e.target.closest('[data-community-action]');
  if (!button) return;
  const key = button.closest('.community-card').dataset.link;

  if (button.dataset.communityAction === 'copy') {
    navigator.clipboard.writeText(COMMUNITY_LINKS[key]).then(() => showToast('Link copied'));
    return;
  }
  const canvas = document.querySelector(`#community-qr-${key} canvas`);
  if (!canvas) return;
  // QR scanners need a white quiet zone around the code, which the raw canvas doesn't include.
  const margin = Math.round(canvas.width * 0.08);
  const out = document.createElement('canvas');
  out.width = canvas.width + margin * 2;
  out.height = canvas.height + margin * 2;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, margin, margin);
  const link = document.createElement('a');
  link.download = `pogo-${key}-qr.png`;
  link.href = out.toDataURL('image/png');
  link.click();
});

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
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

function getLotteryUrl(id) {
  return `${getBaseUrl()}/lottery.html?id=${encodeURIComponent(id)}`;
}

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

function initLottery() {
  const sinceInput = document.getElementById('lottery-since');
  if (!sinceInput.value) sinceInput.value = todayInputValue();
  loadLotteries();
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

  history.innerHTML = lotteryState.lotteries.map(l => `
    <button type="button" class="lottery-history-item${l.id === lotteryState.selectedId ? ' selected' : ''}" data-id="${escapeHtml(l.id)}">
      <span class="lottery-history-main">
        <span class="lottery-name">${escapeHtml(l.name)}</span>
        <span class="code-meta">${new Date(l.createdAt).toLocaleDateString()}${l.winners.length ? ' · Winner: ' + escapeHtml(l.winners.join(', ')) : ''}</span>
      </span>
      <span class="badge ${l.open ? 'badge-active' : 'badge-inactive'}">${l.open ? 'Open' : 'Closed'}</span>
    </button>
  `).join('');

  history.querySelectorAll('.lottery-history-item').forEach(el => {
    el.addEventListener('click', () => selectLottery(el.dataset.id));
  });
}

function renderLotteryHeader(lottery) {
  document.getElementById('lottery-title').textContent = lottery.name;

  const status = document.getElementById('lottery-status');
  status.textContent = lottery.open ? 'Open' : 'Closed';
  status.className = `badge ${lottery.open ? 'badge-active' : 'badge-inactive'}`;

  const checkIn = new Date(lottery.since).toLocaleDateString();
  const closed = lottery.closedAt ? ` · Closed ${new Date(lottery.closedAt).toLocaleString()}` : '';
  document.getElementById('lottery-meta').textContent = `Check-in date: ${checkIn}${closed}`;

  document.getElementById('lottery-signup').classList.toggle('hidden', !lottery.open);
  document.getElementById('lottery-toggle').textContent = lottery.open ? 'Close Lottery' : 'Reopen';
  updateDrawButton(lottery);

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

  const qr = document.getElementById('lottery-qr');
  qr.innerHTML = '';
  new QRCode(qr, {
    text: getLotteryUrl(id),
    width: 180,
    height: 180,
    colorDark: '#1a1a2e',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M,
  });

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
      e.redeemed ? '<span class="badge badge-active">Redeemed code</span>' : '',
      e.signedUp ? '<span class="badge badge-new">Lottery sign-up</span>' : '',
    ].join(' ');
    return `
      <div class="lottery-entrant${winner ? ' is-winner' : ''}" data-key="${escapeHtml(key)}" data-name="${escapeHtml(e.trainerName)}">
        <span class="lottery-name">${escapeHtml(e.trainerName)}</span>
        <span class="lottery-badges">${badges}</span>
        <span class="lottery-entrant-actions">
          ${winner ? '<button type="button" class="btn btn-small btn-secondary" data-action="unwin">Undo Win</button>' : ''}
          <button type="button" class="btn btn-small btn-secondary" data-action="edit">Edit</button>
          <button type="button" class="btn btn-small btn-danger" data-action="remove">Remove</button>
        </span>
      </div>
    `;
  }).join('');

  const input = list.querySelector('.lottery-entrant-input');
  if (input) { input.focus(); input.select(); }
}

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

function updateDrawButton(lottery) {
  const button = document.getElementById('lottery-draw');
  const hasWinner = lottery.winners.length > 0;
  button.disabled = hasWinner || lotteryState.drawing;
  button.title = hasWinner ? 'This lottery already has a winner. Use Undo Win to draw again.' : '';
}

function setLotteryButtonsDisabled(disabled) {
  ['lottery-draw', 'lottery-refresh', 'lottery-toggle', 'lottery-edit', 'lottery-delete'].forEach(id => {
    document.getElementById(id).disabled = disabled;
  });
  document.getElementById('lottery-list').classList.toggle('is-busy', disabled);
}

async function drawLotteryWinner() {
  const lottery = selectedLottery();
  if (!lottery || lotteryState.drawing) return;
  if (lottery.winners.length) {
    showToast('This lottery already has a winner. Use Undo Win to draw again.');
    return;
  }

  if (lotteryState.editingKey) {
    lotteryState.editingKey = null;
    renderLotteryEntrants();
  }
  const pool = lotteryState.entrants.filter(e => !isWinner(lottery, e.trainerName));
  if (pool.length === 0) {
    showToast(lotteryState.entrants.length ? 'Everyone has already won' : 'No entrants to draw from');
    return;
  }

  const winner = pool[randomIndex(pool.length)];
  const nodes = pool.map(e => document.querySelector(`.lottery-entrant[data-key="${CSS.escape(trainerKey(e.trainerName))}"]`));
  const winnerNode = nodes[pool.indexOf(winner)];

  lotteryState.drawing = true;
  setLotteryButtonsDisabled(true);

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
    const node = document.querySelector(`.lottery-entrant[data-key="${CSS.escape(trainerKey(winner.trainerName))}"]`);
    if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    showToast(`Winner: ${winner.trainerName}`);
  } catch (err) {
    if (err.message.includes('already has a winner')) {
      showToast('A winner was already drawn on another device');
      lotteryState.drawing = false;
      await loadLotteries();
    } else {
      showToast(`Picked ${winner.trainerName}, but saving failed: ${err.message}`);
      winnerNode.classList.add('is-winner');
    }
  } finally {
    lotteryState.drawing = false;
    setLotteryButtonsDisabled(false);
    const current = selectedLottery();
    if (current) updateDrawButton(current);
  }
}

document.getElementById('lottery-create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('lottery-name').value.trim();
  const sinceValue = document.getElementById('lottery-since').value || todayInputValue();
  if (!name) return;

  const [y, m, d] = sinceValue.split('-').map(Number);
  const since = new Date(y, m - 1, d).toISOString();
  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    const data = await callSheet({ action: 'createLottery', name, since });
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

function toDateInputValue(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return todayInputValue();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function showLotteryEditForm(show) {
  document.getElementById('lottery-view-header').classList.toggle('hidden', show);
  document.getElementById('lottery-edit-form').classList.toggle('hidden', !show);
  if (!show) return;
  const lottery = selectedLottery();
  document.getElementById('lottery-edit-name').value = lottery.name;
  document.getElementById('lottery-edit-since').value = toDateInputValue(lottery.since);
  document.getElementById('lottery-edit-name').focus();
}

document.getElementById('lottery-edit').addEventListener('click', () => showLotteryEditForm(true));
document.getElementById('lottery-edit-cancel').addEventListener('click', () => showLotteryEditForm(false));

document.getElementById('lottery-edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const lottery = selectedLottery();
  const name = document.getElementById('lottery-edit-name').value.trim();
  const sinceValue = document.getElementById('lottery-edit-since').value;
  if (!lottery || !name || !sinceValue) return;

  const [y, m, d] = sinceValue.split('-').map(Number);
  const since = new Date(y, m - 1, d).toISOString();
  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    const data = await callSheet({ action: 'updateLottery', id: lottery.id, name, since });
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

document.getElementById('lottery-draw').addEventListener('click', drawLotteryWinner);
document.getElementById('lottery-refresh').addEventListener('click', loadLotteryEntrants);

document.getElementById('lottery-copy-link').addEventListener('click', () => {
  if (!lotteryState.selectedId) return;
  navigator.clipboard.writeText(getLotteryUrl(lotteryState.selectedId)).then(() => showToast('Sign-up link copied'));
});

document.getElementById('lottery-download-qr').addEventListener('click', () => {
  const lottery = selectedLottery();
  const canvas = document.querySelector('#lottery-qr canvas');
  if (!lottery || !canvas) return;
  const link = document.createElement('a');
  link.download = `pogo-lottery-${lottery.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
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
      const entry = { code, label, expiry: expiry || null, addedAt: new Date().toISOString() };
      newCodes.push(entry);
      existing.unshift(entry);
    }

    saveCodes(existing);
    document.getElementById('code-bulk').value = '';

    if (newCodes.length > 0) {
      generateBulkQRPreview(newCodes);
      const msg = `${newCodes.length} code(s) added` + (skipped ? `, ${skipped} skipped (duplicates)` : '');
      showToast(msg);
      pushCodesToSheet(newCodes).catch(reportSyncError);
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

    const entry = { code, label, expiry: expiry || null, addedAt: new Date().toISOString() };
    codes.unshift(entry);
    saveCodes(codes);
    generateQRPreview(code, label);
    document.getElementById('code-input').value = '';
    showToast('Code added');
    pushCodesToSheet([entry]).catch(reportSyncError);
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

// Render codes list
function renderCodesList() {
  const activeCodes = getActiveCodes();
  const inactiveCodes = getInactiveCodes();
  const activeList = document.getElementById('codes-list');
  const inactiveList = document.getElementById('inactive-codes-list');
  const inactiveCard = document.getElementById('inactive-codes-card');

  const now = new Date();

  if (activeCodes.length === 0) {
    activeList.innerHTML = '<p class="empty-state">No active codes.</p>';
  } else {
    activeList.innerHTML = activeCodes.map(entry => {
      const isExpired = entry.expiry && new Date(entry.expiry) < now;
      const badge = isExpired
        ? '<span class="badge badge-expired">Expired</span>'
        : '<span class="badge badge-active">Active</span>';

      const meta = [
        entry.label,
        entry.expiry ? `Expires: ${formatExpiry(entry.expiry)}` : null,
        `Added: ${new Date(entry.addedAt).toLocaleDateString()}`,
      ].filter(Boolean).join(' · ');

      return `
        <div class="code-item" data-code="${entry.code}">
          <div class="code-item-qr" id="qr-list-${entry.code}"></div>
          <div class="code-item-info">
            <div class="code-value">${entry.code}</div>
            <div class="code-meta">${meta}</div>
            <div>${badge}</div>
          </div>
          <div class="code-item-actions">
            <button class="btn btn-small btn-secondary" onclick="copyCodeLink('${entry.code}')">Copy Link</button>
            <button class="btn btn-small btn-secondary" onclick="downloadCodeQR('${entry.code}')">Download QR</button>
            <button class="btn btn-small btn-warning" onclick="deactivateCode('${entry.code}')">Deactivate</button>
            <button class="btn btn-small btn-danger" onclick="removeCode('${entry.code}')">Remove</button>
          </div>
        </div>
      `;
    }).join('');
  }

  if (inactiveCodes.length === 0) {
    inactiveCard.classList.add('hidden');
  } else {
    inactiveCard.classList.remove('hidden');
    inactiveList.innerHTML = inactiveCodes.map(entry => {
      const meta = [
        entry.label,
        entry.expiry ? `Expires: ${formatExpiry(entry.expiry)}` : null,
        `Added: ${new Date(entry.addedAt).toLocaleDateString()}`,
      ].filter(Boolean).join(' · ');

      return `
        <div class="code-item code-item-inactive" data-code="${entry.code}">
          <div class="code-item-info">
            <div class="code-value">${entry.code}</div>
            <div class="code-meta">${meta}</div>
            <div><span class="badge badge-inactive">Inactive</span></div>
          </div>
          <div class="code-item-actions">
            <button class="btn btn-small btn-secondary" onclick="reactivateCode('${entry.code}')">Reactivate</button>
            <button class="btn btn-small btn-danger" onclick="removeCode('${entry.code}')">Remove</button>
          </div>
        </div>
      `;
    }).join('');
  }

  activeCodes.forEach(entry => {
    const el = document.getElementById(`qr-list-${entry.code}`);
    if (el) {
      new QRCode(el, {
        text: getRedeemUrl(entry.code),
        width: 80,
        height: 80,
        colorDark: '#1a1a2e',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M,
      });
    }
  });

  updateLogFilter();
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
    showToast('Code moved to non-active');
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

const REQUIRED_SCRIPT_VERSION = 9;

async function callSheet(params) {
  const scriptUrl = getSetting(STORAGE_KEYS.SCRIPT_URL);
  if (!scriptUrl) throw new Error('No script URL configured');

  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const res = await fetch(`${scriptUrl}?${query}`);
  const data = await res.json();
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
async function pushCodesToSheet(entries) {
  let added = 0;
  for (let i = 0; i < entries.length; i += 15) {
    const chunk = entries.slice(i, i + 15).map(e => ({
      code: e.code,
      label: e.label || '',
      expiry: e.expiry || '',
      addedAt: e.addedAt || '',
      active: e.active !== false,
    }));
    const data = await callSheet({ action: 'addCodes', codes: JSON.stringify(chunk) });
    added += data.added || 0;
  }
  return added;
}

async function syncCodesFromSheet() {
  await checkScriptVersion();

  const data = await callSheet({ action: 'getCodes' });
  const sheetCodes = (data.codes || []).map(c => ({
    code: String(c.code),
    label: c.label || '',
    expiry: c.expiry || null,
    addedAt: c.addedAt || '',
    active: c.active !== false,
  }));

  const sheetSet = new Set(sheetCodes.map(c => c.code));
  const localOnly = getCodes().filter(c => !sheetSet.has(c.code));
  const pushed = localOnly.length ? await pushCodesToSheet(localOnly) : 0;

  saveCodes([...localOnly, ...sheetCodes]);
  return { fromSheet: sheetCodes.length, pushed };
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
    const response = await fetch(`${scriptUrl}?action=getLogs`);
    const data = await response.json();

    if (!data.logs || data.logs.length === 0) {
      document.getElementById('log-table-container').innerHTML =
        '<p class="empty-state">No scans recorded yet.</p>';
      return;
    }

    renderLogTable(data.logs);
  } catch (err) {
    document.getElementById('log-table-container').innerHTML =
      `<p class="empty-state">Error loading logs. Check your Apps Script URL.</p>`;
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
    const response = await fetch(`${scriptUrl}?action=getErrors`);
    const data = await response.json();

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
  const codes = getActiveCodes();
  if (codes.length === 0) {
    document.getElementById('display-empty').classList.remove('hidden');
    document.getElementById('display-viewer').classList.add('hidden');
    return;
  }

  document.getElementById('display-empty').classList.add('hidden');
  document.getElementById('display-viewer').classList.remove('hidden');
  displayIndex = 0;
  renderDisplayQR();
}

function renderDisplayQR() {
  const codes = getActiveCodes();
  if (codes.length === 0) return;

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

// Runs last so every tab's state and helpers are initialized before the saved tab loads.
(function restoreTab() {
  let saved = null;
  try { saved = localStorage.getItem('pogo_active_tab'); } catch {}
  if (saved && saved !== 'add-code') activateTab(saved);
})();
