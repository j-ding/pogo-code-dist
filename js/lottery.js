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

const lotteryId = new URLSearchParams(window.location.search).get('id') || '';
let lotteryName = '';

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
  const el = document.getElementById('lottery-error');
  el.textContent = message;
  el.classList.remove('hidden');
}

async function callScript(params) {
  const res = await fetch(`${getScriptUrl()}?${new URLSearchParams(params)}`);
  return res.json();
}

async function initLotteryPage() {
  if (!lotteryId || !getScriptUrl()) {
    showUnavailable('Lottery Not Found', "This sign-up link isn't valid. Ask an organizer for a new one.");
    return;
  }

  try {
    const data = await callScript({ action: 'getLottery', id: lotteryId });
    if (!data.lottery) {
      showUnavailable('Lottery Not Found', "This sign-up link isn't valid. Ask an organizer for a new one.");
      return;
    }
    lotteryName = data.lottery.name;
    if (!data.lottery.open) {
      showUnavailable('Lottery Closed', `"${lotteryName}" is no longer accepting entries.`);
      return;
    }
    document.getElementById('join-title').textContent = lotteryName;
    showStep('step-join');
    document.getElementById('lottery-trainer').focus();
  } catch (err) {
    showUnavailable('Something Went Wrong', "Couldn't load the lottery. Check your connection and refresh the page.");
    if (typeof reportError === 'function') reportError(err, 'lottery.js');
  }
}

document.getElementById('lottery-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const trainerName = document.getElementById('lottery-trainer').value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9]+$/.test(trainerName)) {
    showError('Trainer names are letters and numbers only.');
    return;
  }

  const button = document.getElementById('lottery-submit');
  button.disabled = true;
  button.textContent = 'Entering...';
  document.getElementById('lottery-error').classList.add('hidden');

  try {
    const data = await callScript({ action: 'joinLottery', id: lotteryId, trainerName, deviceId: getDeviceId() });
    if (data.busy) {
      showError('Lots of people are signing up right now. Please tap Enter Lottery again.');
      button.disabled = false;
      button.textContent = 'Enter Lottery';
      return;
    }
    if (data.closed) {
      showUnavailable('Lottery Closed', `"${lotteryName}" is no longer accepting entries.`);
      return;
    }
    if (data.removed) {
      showUnavailable("Can't Enter", `This trainer can't enter ${lotteryName}. Please talk to an organizer.`);
      return;
    }
    if (data.deviceUsed) {
      showUnavailable('Already Entered', `This phone already entered ${lotteryName} as ${data.existingName}. Each phone can enter once.`);
      return;
    }
    if (!data.success && data.error && data.error.startsWith('Trainer names')) {
      showError(data.error + '.');
      button.disabled = false;
      button.textContent = 'Enter Lottery';
      return;
    }
    if (!data.success) throw new Error(data.error || 'Sign-up failed');

    if (data.alreadyJoined) {
      const name = data.existingName || trainerName;
      showUnavailable('Already Entered', data.viaRedemption
        ? `${name} has already entered this raffle by redeeming a code. Each trainer can only enter once.`
        : `${name} has already entered this raffle. Each trainer can only enter once.`);
      return;
    }

    document.getElementById('joined-message').textContent = `${trainerName} has been entered into ${lotteryName}. Good luck!`;
    showStep('step-joined');
  } catch (err) {
    showError("Couldn't enter the lottery. Check your connection and try again.");
    button.disabled = false;
    button.textContent = 'Enter Lottery';
    if (typeof reportError === 'function') reportError(err, 'lottery.js');
  }
});

initLotteryPage();
