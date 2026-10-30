const POGO_REDEEM_BASE = 'https://store.pokemongo.com/offer-redemption?passcode=';

function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function getDeviceId() {
  try {
    let id = localStorage.getItem('pogo_device_id');
    if (!id) {
      id = 'dev-' + crypto.randomUUID();
      localStorage.setItem('pogo_device_id', id);
    }
    return id;
  } catch {
    return 'dev-unknown';
  }
}


function getScriptUrl() {
  if (typeof SITE_CONFIG !== 'undefined' && SITE_CONFIG.scriptUrl) {
    return SITE_CONFIG.scriptUrl;
  }
  try {
    return localStorage.getItem('pogo_script_url') || '';
  } catch {
    return '';
  }
}

function parseUserAgent() {
  const ua = navigator.userAgent;
  let device = 'Unknown';
  let os = 'Unknown';
  let browser = 'Unknown';

  if (/iPhone/.test(ua)) device = 'iPhone';
  else if (/iPad/.test(ua)) device = 'iPad';
  else if (/Android/.test(ua)) {
    const match = ua.match(/;\s*([^;)]+)\s*Build/);
    device = match ? match[1].trim() : 'Android Device';
  }
  else if (/Windows/.test(ua)) device = 'Desktop (Windows)';
  else if (/Macintosh/.test(ua)) device = 'Desktop (Mac)';
  else if (/Linux/.test(ua)) device = 'Desktop (Linux)';

  if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
  else if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Mac OS X ([0-9_]+)/.test(ua)) os = 'macOS ' + ua.match(/Mac OS X ([0-9_]+)/)[1].replace(/_/g, '.');
  else if (/iPhone OS ([0-9_]+)/.test(ua)) os = 'iOS ' + ua.match(/iPhone OS ([0-9_]+)/)[1].replace(/_/g, '.');
  else if (/Android ([0-9.]+)/.test(ua)) os = 'Android ' + ua.match(/Android ([0-9.]+)/)[1];
  else if (/Linux/.test(ua)) os = 'Linux';

  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Browser';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';

  return { device, os, browser };
}

function getLocationWithTimeout(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);

  return fetch('https://ipapi.co/json/', { signal: controller.signal })
    .then(res => {
      clearTimeout(timeout);
      return res.ok ? res.json() : { city: '', country_name: '' };
    })
    .then(data => ({ city: data.city || '', country: data.country_name || '' }))
    .catch(() => ({ city: '', country: '' }));
}

function formatTimeRemaining(ms) {
  const totalMinutes = Math.ceil(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}

async function checkRedemption(code, trainerName, scriptUrl) {
  if (!scriptUrl) return null;

  try {
    const url = `${scriptUrl}?action=checkRedemption&code=${encodeURIComponent(code)}&trainerName=${encodeURIComponent(trainerName)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function checkCooldown(trainerName, scriptUrl) {
  if (!scriptUrl) return null;

  try {
    const url = `${scriptUrl}?action=checkCooldown&trainerName=${encodeURIComponent(trainerName)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function proceedWithRedeem(code, trainerName, redeemUrl) {
  document.getElementById('step-already-redeemed').classList.add('hidden');
  document.getElementById('step-cooldown').classList.add('hidden');
  document.getElementById('step-trainer').classList.add('hidden');
  document.getElementById('step-redirect').classList.remove('hidden');

  const { device, os, browser } = parseUserAgent();
  const language = navigator.language || navigator.userLanguage || '';
  const screenRes = `${screen.width}x${screen.height}`;

  getLocationWithTimeout(2000).then(location => {
    const logData = {
      action: 'logScan',
      timestamp: new Date().toISOString(),
      code: code,
      trainerName: trainerName,
      device: device,
      os: os,
      browser: browser,
      city: location.city,
      country: location.country,
      language: language,
      screenResolution: screenRes,
      referrer: document.referrer || 'direct',
      deviceId: getDeviceId(),
      scanId: newScanId(),
    };

    sendScanLog(logData).finally(() => {
      window.location.href = redeemUrl;
    });
  });
}

function newScanId() {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

// Wait briefly for a confirmed save; if that fails or is slow, fall back to a beacon (the scan ID dedupes it).
async function sendScanLog(logData) {
  const scriptUrl = getScriptUrl();
  if (!scriptUrl) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${scriptUrl}?${new URLSearchParams(logData)}`, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    if (data.success) return;
  } catch {}
  try { navigator.sendBeacon(scriptUrl, JSON.stringify(logData)); } catch {}
}

function init() {
  const code = getParam('code');

  if (!code) {
    document.getElementById('step-trainer').classList.add('hidden');
    document.getElementById('step-error').classList.remove('hidden');
    return;
  }

  const redeemUrl = POGO_REDEEM_BASE + encodeURIComponent(code);
  setupRememberedName('trainer-name', 'remember-name');
  PogoAlerts.start(getScriptUrl(), 'alerts-row', 'alerts-optin');
  document.getElementById('display-code').textContent = code;
  document.getElementById('manual-link').href = redeemUrl;

  const submitButton = document.getElementById('redeem-submit');
  function setRedeeming(busy) {
    submitButton.disabled = busy;
    submitButton.querySelector('.btn-spinner').classList.toggle('hidden', !busy);
    submitButton.querySelector('.btn-label').textContent = busy ? 'Redeeming...' : 'Redeem Code';
    document.getElementById('trainer-name').readOnly = busy;
  }
  function backToForm(stepId) {
    document.getElementById(stepId).classList.add('hidden');
    document.getElementById('step-trainer').classList.remove('hidden');
    setRedeeming(false);
  }
  // Returning with the browser's back button can restore the page with the button still disabled.
  window.addEventListener('pageshow', (e) => { if (e.persisted) setRedeeming(false); });

  document.getElementById('trainer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitButton.disabled) return;

    const trainerName = document.getElementById('trainer-name').value.trim();
    if (!trainerName) return;

    rememberTrainerName('remember-name', trainerName);
    setRedeeming(true);
    // Before any other await, so the browser still treats the permission prompt as part of the tap.
    await PogoAlerts.applyChoice('alerts-optin', trainerName);
    const scriptUrl = getScriptUrl();

    // Both checks are independent, so run them together instead of waiting for one then the other.
    const [redemption, cooldown] = await Promise.all([
      checkRedemption(code, trainerName, scriptUrl),
      checkCooldown(trainerName, scriptUrl),
    ]);
    if (redemption && redemption.redeemed) {
      document.getElementById('step-trainer').classList.add('hidden');
      document.getElementById('redeemed-trainer').textContent = trainerName;
      document.getElementById('step-already-redeemed').classList.remove('hidden');

      document.getElementById('redeemed-proceed').onclick = () => {
        proceedWithRedeem(code, trainerName, redeemUrl);
      };
      document.getElementById('redeemed-cancel').onclick = () => backToForm('step-already-redeemed');
      return;
    }

    if (cooldown && cooldown.count >= 2) {
      const oldest = new Date(cooldown.recentCodes[0].timestamp);
      const cooldownEnd = new Date(oldest.getTime() + 7 * 24 * 60 * 60 * 1000);
      const remaining = cooldownEnd.getTime() - Date.now();

      if (remaining > 0) {
        document.getElementById('step-trainer').classList.add('hidden');
        document.getElementById('cooldown-count').textContent = cooldown.count;
        document.getElementById('cooldown-timer').textContent = formatTimeRemaining(remaining);
        document.getElementById('step-cooldown').classList.remove('hidden');

        document.getElementById('cooldown-proceed').onclick = () => {
          proceedWithRedeem(code, trainerName, redeemUrl);
        };
        document.getElementById('cooldown-cancel').onclick = () => backToForm('step-cooldown');
        return;
      }
    }

    proceedWithRedeem(code, trainerName, redeemUrl);
  });
}

init();
