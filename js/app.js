const STORAGE_KEYS = {
  CODES: 'pogo_codes',
  SCRIPT_URL: 'pogo_script_url',
  BASE_URL: 'pogo_base_url',
};

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

function getBaseUrl() {
  const saved = getSetting(STORAGE_KEYS.BASE_URL);
  if (saved) return saved.replace(/\/$/, '');
  return window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '');
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
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');

    if (tab.dataset.tab === 'active-codes') renderCodesList();
    if (tab.dataset.tab === 'display') initDisplay();
    if (tab.dataset.tab === 'scan-log') loadScanLog();
  });
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
document.getElementById('site-base-url').value = getSetting(STORAGE_KEYS.BASE_URL);

settingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  saveSetting(STORAGE_KEYS.SCRIPT_URL, document.getElementById('script-url').value.trim());
  saveSetting(STORAGE_KEYS.BASE_URL, document.getElementById('site-base-url').value.trim());
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
      syncCodeToSheet(entry);
    }

    saveCodes(existing);
    document.getElementById('code-bulk').value = '';

    if (newCodes.length > 0) {
      generateBulkQRPreview(newCodes);
      const msg = `${newCodes.length} code(s) added` + (skipped ? `, ${skipped} skipped (duplicates)` : '');
      showToast(msg);
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
    syncCodeToSheet(entry);
    document.getElementById('code-input').value = '';
    showToast('Code added');
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
  const list = document.getElementById('codes-list');
  const codes = getCodes();

  if (codes.length === 0) {
    list.innerHTML = '<p class="empty-state">No codes added yet.</p>';
    return;
  }

  const now = new Date();
  list.innerHTML = codes.map(entry => {
    const isExpired = entry.expiry && new Date(entry.expiry) < now;
    const badge = isExpired
      ? '<span class="badge badge-expired">Expired</span>'
      : '<span class="badge badge-active">Active</span>';

    const meta = [
      entry.label,
      entry.expiry ? `Expires: ${entry.expiry}` : null,
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
          <button class="btn btn-small btn-danger" onclick="removeCode('${entry.code}')">Remove</button>
        </div>
      </div>
    `;
  }).join('');

  codes.forEach(entry => {
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

function removeCode(code) {
  if (!confirm(`Remove code ${code}?`)) return;
  const codes = getCodes().filter(c => c.code !== code);
  saveCodes(codes);
  renderCodesList();
  showToast('Code removed');
}

// Sync code to Google Sheet
async function syncCodeToSheet(entry) {
  const scriptUrl = getSetting(STORAGE_KEYS.SCRIPT_URL);
  if (!scriptUrl) return;

  try {
    await fetch(scriptUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        action: 'addCode',
        code: entry.code,
        label: entry.label || '',
        expiry: entry.expiry || '',
        addedAt: entry.addedAt,
      }),
    });
  } catch {}
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
            <td><strong>${log.code || ''}</strong></td>
            <td>${log.trainerName || ''}</td>
            <td>${log.device || ''}</td>
            <td>${log.os || ''}</td>
            <td>${log.browser || ''}</td>
            <td>${log.city || ''}</td>
            <td>${log.country || ''}</td>
            <td>${log.language || ''}</td>
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
              <td>${err.page || ''}</td>
              <td title="${(err.stack || '').replace(/"/g, '&quot;')}">${err.error || ''}</td>
              <td>${err.userAgent ? err.userAgent.slice(0, 40) + '...' : ''}</td>
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
  const codes = getCodes();
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
  const codes = getCodes();
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
