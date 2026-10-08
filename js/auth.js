let appConfig = null;

async function loadConfig() {
  try {
    const res = await fetch('config.json');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function getSession() {
  try {
    const stored = localStorage.getItem('pogo_session');
    if (stored) return JSON.parse(stored);
  } catch {}
  try {
    const stored = sessionStorage.getItem('pogo_session');
    if (stored) return JSON.parse(stored);
  } catch {}
  return null;
}

function saveSession(username, remember) {
  const data = JSON.stringify({ username, ts: Date.now() });
  try {
    if (remember) {
      localStorage.setItem('pogo_session', data);
    } else {
      sessionStorage.setItem('pogo_session', data);
    }
  } catch {}
}

function clearSession() {
  try { localStorage.removeItem('pogo_session'); } catch {}
  try { sessionStorage.removeItem('pogo_session'); } catch {}
}

function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');
  if (typeof syncCodesFromSheet === 'function') {
    syncCodesFromSheet().then(() => {
      if (typeof renderCodesList === 'function') renderCodesList();
    });
  }
}

function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
}

async function initAuth() {
  appConfig = await loadConfig();

  if (!appConfig || !appConfig.admins || appConfig.admins.length === 0) {
    showApp();
    return;
  }

  const session = getSession();
  if (session && appConfig.admins.some(a => a.username === session.username)) {
    showApp();
    return;
  }

  showLogin();

  document.getElementById('login-form').addEventListener('submit', (e) => {
    e.preventDefault();

    const username = document.getElementById('login-user').value.trim();
    const password = document.getElementById('login-pass').value;
    const remember = document.getElementById('login-remember').checked;

    const match = appConfig.admins.find(
      a => a.username === username && a.password === password
    );

    if (match) {
      saveSession(username, remember);
      document.getElementById('login-error').classList.add('hidden');
      showApp();
    } else {
      document.getElementById('login-error').classList.remove('hidden');
    }
  });
}

initAuth();
