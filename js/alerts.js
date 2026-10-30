// Optional event alerts ("We're starting the raffle soon") through OneSignal's free web push.
// Nothing loads unless the Apps Script has ONESIGNAL_APP_ID set, and the opt-in checkbox only shows on
// browsers that can receive web push (iPhones only can from a site added to the Home Screen).
// A trainer who opts in is linked to OneSignal by their trainer key, so an alert sent for an event
// reaches the attendees who turned alerts on.
const PogoAlerts = (() => {
  const SDK = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
  let oneSignal = null;
  let scriptUrl = '';

  const key = name => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const within = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))]);

  function loadSdk() {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SDK;
      s.defer = true;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // The site lives in a subfolder on GitHub Pages, so OneSignal's worker sits in its own folder below it.
  function workerOptions() {
    const base = location.pathname.replace(/[^/]*$/, '');
    return {
      serviceWorkerPath: `${base.slice(1)}push/onesignal/OneSignalSDKWorker.js`,
      serviceWorkerParam: { scope: `${base}push/onesignal/` },
    };
  }

  async function init(appId) {
    await loadSdk();
    return new Promise(resolve => {
      window.OneSignalDeferred = window.OneSignalDeferred || [];
      window.OneSignalDeferred.push(async OneSignal => {
        try {
          await OneSignal.init({ appId, ...workerOptions() });
          resolve(OneSignal.Notifications.isPushSupported() ? OneSignal : null);
        } catch {
          resolve(null);
        }
      });
    });
  }

  function optedIn() {
    return !!(oneSignal && oneSignal.User.PushSubscription.optedIn);
  }

  // Shows the checkbox once OneSignal is ready. It's checked when this phone already has alerts on.
  async function start(url, rowId, checkboxId) {
    scriptUrl = url;
    if (!scriptUrl) return;
    try {
      const res = await fetch(`${scriptUrl}?action=pushConfig`);
      const { appId } = await res.json();
      if (!appId) return;
      oneSignal = await within(init(appId), 10000) || null;
    } catch {
      oneSignal = null;
    }
    if (!oneSignal) return;
    document.getElementById(checkboxId).checked = optedIn();
    document.getElementById(rowId).classList.remove('hidden');
  }

  // Call straight from the form's submit handler: browsers only show the permission prompt in response
  // to a tap, so the prompt has to be requested before anything else is awaited.
  async function applyChoice(checkboxId, trainerName) {
    const box = document.getElementById(checkboxId);
    if (!oneSignal || !box) return;
    try {
      if (!box.checked) {
        if (optedIn()) await oneSignal.User.PushSubscription.optOut();
        return;
      }
      if (!optedIn()) await within(oneSignal.User.PushSubscription.optIn(), 30000);
      if (!optedIn()) return;
      await within(oneSignal.login(key(trainerName)), 5000);
      const params = new URLSearchParams({ action: 'pushOptIn', trainerName });
      await within(fetch(`${scriptUrl}?${params}`), 5000);
    } catch (err) {
      if (typeof reportError === 'function') reportError(err, 'alerts.js');
    }
  }

  return { start, applyChoice };
})();
