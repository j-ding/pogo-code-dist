// The Apps Script checks the password and returns a signed token; admin actions send it as `t`.
const SESSION_KEY = 'pogo_admin_session';

function getSession() {
  for (const store of [localStorage, sessionStorage]) {
    try {
      const session = JSON.parse(store.getItem(SESSION_KEY));
      if (session && session.token && session.expires > Date.now()) return session;
    } catch {}
  }
  return null;
}

function getAuthToken() {
  const session = getSession();
  return session ? session.token : '';
}

function saveSession(token, expires, remember) {
  clearSession();
  try {
    (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, JSON.stringify({ token, expires }));
  } catch {}
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  try { localStorage.removeItem('pogo_session'); } catch {}
  try { sessionStorage.removeItem('pogo_session'); } catch {}
}

function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');
  if (typeof onAdminReady === 'function') onAdminReady();
}

function showLogin(message) {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
  const error = document.getElementById('login-error');
  error.textContent = message || '';
  error.classList.toggle('hidden', !message);
}

function logout() {
  clearSession();
  showLogin();
}

function scriptUrlForLogin() {
  if (typeof SITE_CONFIG !== 'undefined' && SITE_CONFIG.scriptUrl) return SITE_CONFIG.scriptUrl;
  try { return localStorage.getItem('pogo_script_url') || ''; } catch { return ''; }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  const remember = document.getElementById('login-remember').checked;
  const button = e.target.querySelector('button[type="submit"]');
  const scriptUrl = scriptUrlForLogin();
  if (!scriptUrl) {
    showLogin('The Apps Script URL is missing from js/site-config.js.');
    return;
  }

  button.disabled = true;
  button.textContent = 'Logging in...';
  try {
    const params = new URLSearchParams({ action: 'login', username, password, remember: String(remember) });
    const res = await fetch(`${scriptUrl}?${params}`);
    const data = await res.json();
    if (!data.success) {
      showLogin(data.error === 'Unknown action'
        ? 'The Apps Script is outdated. Paste the latest google-apps-script.js and redeploy.'
        : data.error || 'Login failed');
      return;
    }
    saveSession(data.token, data.expires, remember);
    document.getElementById('login-pass').value = '';
    showApp();
  } catch {
    showLogin("Couldn't reach the server. Check your connection and try again.");
  } finally {
    button.disabled = false;
    button.textContent = 'Log In';
  }
});

// Scripts load at the end of <body>, so app.js is ready by the time DOMContentLoaded fires.
document.addEventListener('DOMContentLoaded', () => {
  if (getSession()) showApp();
  else showLogin();
});
