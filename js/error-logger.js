// GitHub Pages caches files for 10 minutes, so right after a deploy a stale page can load newer scripts.
// Keep APP_VERSION in sync with the app-version meta tag and ?v= strings in the HTML files.
var APP_VERSION = '2.8.4';

(function reloadIfStale() {
  var meta = document.querySelector('meta[name="app-version"]');
  var pageVersion = meta ? meta.getAttribute('content') : '';
  if (pageVersion === APP_VERSION) return;
  try {
    if (sessionStorage.getItem('pogo_reloaded_for') === APP_VERSION) return;
    sessionStorage.setItem('pogo_reloaded_for', APP_VERSION);
  } catch (e) {
    return;
  }
  location.reload();
})();

function getScriptUrlForErrors() {
  if (typeof SITE_CONFIG !== 'undefined' && SITE_CONFIG.scriptUrl) {
    return SITE_CONFIG.scriptUrl;
  }
  try {
    return localStorage.getItem('pogo_script_url') || '';
  } catch {
    return '';
  }
}

function reportError(error, source) {
  var scriptUrl = getScriptUrlForErrors();
  if (!scriptUrl) return;

  var payload = JSON.stringify({
    action: 'logError',
    timestamp: new Date().toISOString(),
    page: source || window.location.pathname,
    error: String(error.message || error),
    stack: String(error.stack || '').slice(0, 500),
    userAgent: navigator.userAgent,
    url: window.location.href
  });

  if (navigator.sendBeacon) {
    navigator.sendBeacon(scriptUrl, payload);
  } else {
    try {
      fetch(scriptUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: payload
      });
    } catch {}
  }
}

window.addEventListener('error', function (e) {
  reportError(e.error || e.message, e.filename || 'window.onerror');
});

window.addEventListener('unhandledrejection', function (e) {
  reportError(e.reason || 'Unhandled promise rejection', 'unhandledrejection');
});
