// Shared by the redeem, check-in, and lottery pages so a remembered trainer name carries across all three.
var TRAINER_NAME_KEY = 'pogo_trainer_name';

function setupRememberedName(inputId, checkboxId) {
  var input = document.getElementById(inputId);
  var box = document.getElementById(checkboxId);
  var saved = '';
  try { saved = localStorage.getItem(TRAINER_NAME_KEY) || ''; } catch (e) {}
  if (saved) {
    input.value = saved;
    box.checked = true;
  }
  // Unchecking forgets the name right away, which matters on a shared phone.
  box.addEventListener('change', function() {
    if (!box.checked) {
      try { localStorage.removeItem(TRAINER_NAME_KEY); } catch (e) {}
    }
  });
}

function rememberTrainerName(checkboxId, name) {
  try {
    if (document.getElementById(checkboxId).checked && name) localStorage.setItem(TRAINER_NAME_KEY, name);
    else localStorage.removeItem(TRAINER_NAME_KEY);
  } catch (e) {}
}
