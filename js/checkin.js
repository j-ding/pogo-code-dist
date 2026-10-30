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

const eventId = new URLSearchParams(window.location.search).get('event') || '';
let eventName = '';

function showStep(id) {
  ['step-loading', 'step-unavailable', 'step-join', 'step-joined'].forEach(step => {
    document.getElementById(step).classList.toggle('hidden', step !== id);
  });
}

function showUnavailable(title, message) {
  document.getElementById('unavailable-title').textContent = title;
  document.getElementById('unavailable-message').textContent = message;
  showStep('step-unavailable');
}

function showError(message) {
  const el = document.getElementById('checkin-error');
  el.textContent = message;
  el.classList.remove('hidden');
}

function resetButton() {
  const button = document.getElementById('checkin-submit');
  button.disabled = false;
  button.textContent = 'Check In';
}

async function callScript(params) {
  const res = await fetch(`${getScriptUrl()}?${new URLSearchParams(params)}`);
  return res.json();
}

async function initCheckInPage() {
  if (!eventId || !getScriptUrl()) {
    showUnavailable('Event Not Found', "This check-in link isn't valid. Ask an organizer for a new one.");
    return;
  }

  try {
    const data = await callScript({ action: 'getEvent', id: eventId });
    if (!data.event) {
      showUnavailable('Event Not Found', "This check-in link isn't valid. Ask an organizer for a new one.");
      return;
    }
    eventName = data.event.name;
    if (!data.event.open) {
      showUnavailable('Check-In Closed', `Check-in for "${eventName}" is closed.`);
      return;
    }
    document.getElementById('join-title').textContent = eventName;
    showStep('step-join');
    document.getElementById('checkin-trainer').focus();
  } catch (err) {
    showUnavailable('Something Went Wrong', "Couldn't load the event. Check your connection and refresh the page.");
    if (typeof reportError === 'function') reportError(err, 'checkin.js');
  }
}

document.getElementById('checkin-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const trainerName = document.getElementById('checkin-trainer').value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9]+$/.test(trainerName)) {
    showError('Trainer names are letters and numbers only.');
    return;
  }

  rememberTrainerName('remember-name', trainerName);
  const button = document.getElementById('checkin-submit');
  button.disabled = true;
  button.textContent = 'Checking in...';
  // Before any other await, so the browser still treats the permission prompt as part of the tap.
  await PogoAlerts.applyChoice('alerts-optin', trainerName);
  document.getElementById('checkin-error').classList.add('hidden');

  try {
    const data = await callScript({ action: 'checkIn', id: eventId, trainerName, deviceId: getDeviceId() });
    if (data.busy) {
      showError('Lots of people are checking in right now. Please tap Check In again.');
      resetButton();
      return;
    }
    if (data.closed) {
      showUnavailable('Check-In Closed', `Check-in for "${eventName}" is closed.`);
      return;
    }
    if (data.deviceUsed) {
      showUnavailable('Already Checked In', `This phone already checked in to ${eventName} as ${data.existingName}. Each phone can check in once.`);
      return;
    }
    if (!data.success && data.error && data.error.startsWith('Trainer names')) {
      showError(data.error + '.');
      resetButton();
      return;
    }
    if (!data.success) throw new Error(data.error || 'Check-in failed');

    if (data.alreadyCheckedIn) {
      const name = data.existingName || trainerName;
      showUnavailable('Already Checked In', data.viaRedemption
        ? `${name} is already checked in to ${eventName} from redeeming a code. You're all set!`
        : `${name} is already checked in to ${eventName}. You're all set!`);
      return;
    }

    document.getElementById('joined-message').textContent = `${trainerName} is checked in to ${eventName}. Have fun!`;
    showStep('step-joined');
  } catch (err) {
    showError("Couldn't check in. Check your connection and try again.");
    resetButton();
    if (typeof reportError === 'function') reportError(err, 'checkin.js');
  }
});

setupRememberedName('checkin-trainer', 'remember-name');
initCheckInPage();
PogoAlerts.start(getScriptUrl(), 'alerts-row', 'alerts-optin');
