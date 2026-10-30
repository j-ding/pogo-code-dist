// Landing page for a tapped event alert. The link only carries the alert's id, and the message comes from
// the Alerts sheet, so only messages the organizers really sent can show on this page.
function showStep(id) {
  ['step-loading', 'step-unavailable', 'step-alert'].forEach(step => {
    document.getElementById(step).classList.toggle('hidden', step !== id);
  });
}

function showUnavailable(title, message) {
  document.getElementById('unavailable-title').textContent = title;
  document.getElementById('unavailable-message').textContent = message;
  showStep('step-unavailable');
}

async function initAlertPage() {
  const id = new URLSearchParams(window.location.search).get('id') || '';
  const scriptUrl = typeof SITE_CONFIG !== 'undefined' ? SITE_CONFIG.scriptUrl : '';
  if (!id || !scriptUrl) {
    showUnavailable('Alert Not Found', "This alert isn't available. Check with an organizer at the event.");
    return;
  }

  try {
    const res = await fetch(`${scriptUrl}?${new URLSearchParams({ action: 'getAlert', id })}`);
    const { alert } = await res.json();
    if (!alert) {
      showUnavailable('Alert Not Found', "This alert isn't available. Check with an organizer at the event.");
      return;
    }
    document.getElementById('alert-event').textContent = alert.eventName;
    document.getElementById('alert-message').textContent = alert.message;
    const sent = new Date(alert.sentAt);
    document.getElementById('alert-time').textContent = isNaN(sent)
      ? ''
      : `Sent ${sent.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    showStep('step-alert');
  } catch (err) {
    showUnavailable('Something Went Wrong', "Couldn't load the alert. Check your connection and refresh the page.");
    if (typeof reportError === 'function') reportError(err, 'alert-page.js');
  }
}

initAlertPage();
