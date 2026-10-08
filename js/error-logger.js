function getScriptUrlForErrors() {
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
