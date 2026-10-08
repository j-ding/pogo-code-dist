const POGO_REDEEM_BASE = 'https://store.pokemongo.com/offer-redemption?passcode=';

function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function getScriptUrl() {
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

function init() {
  const code = getParam('code');

  if (!code) {
    document.getElementById('step-trainer').classList.add('hidden');
    document.getElementById('step-error').classList.remove('hidden');
    return;
  }

  const redeemUrl = POGO_REDEEM_BASE + encodeURIComponent(code);
  document.getElementById('display-code').textContent = code;
  document.getElementById('manual-link').href = redeemUrl;

  document.getElementById('trainer-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const trainerName = document.getElementById('trainer-name').value.trim();
    if (!trainerName) return;

    document.getElementById('step-trainer').classList.add('hidden');
    document.getElementById('step-redirect').classList.remove('hidden');

    const { device, os, browser } = parseUserAgent();
    const language = navigator.language || navigator.userLanguage || '';
    const screenRes = `${screen.width}x${screen.height}`;

    const location = await getLocationWithTimeout(2000);

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
    };

    const scriptUrl = getScriptUrl();
    if (scriptUrl) {
      navigator.sendBeacon(scriptUrl, JSON.stringify(logData));
    }

    window.location.href = redeemUrl;
  });
}

init();
