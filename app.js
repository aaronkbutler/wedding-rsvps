// Paste the deployed Google Apps Script Web App URL here (ends in /exec).
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbz4c3rJbXaJITGTpxcVGswgkCd4PwCFDISwbNw3pJF97ywp87uAppiof31jUcWx-nwC/exec';

const nameInput = document.getElementById('name-input');
const searchButton = document.getElementById('search-button');
const searchMessage = document.getElementById('search-message');

const optionsSection = document.getElementById('options-section');
const optionsList = document.getElementById('options-list');

const rsvpSection = document.getElementById('rsvp-section');
const invitationTitle = document.getElementById('invitation-title');
const guestsContainer = document.getElementById('guests-container');
const rsvpForm = document.getElementById('rsvp-form');
const messageInput = document.getElementById('message-input');
const submitButton = document.getElementById('submit-button');
const submitMessage = document.getElementById('submit-message');
const continueButton = document.getElementById('continue-button');

let currentInvitation = null;
let lastWebsitePassword = null;

function setMessage(el, text, type) {
  el.textContent = text || '';
  el.classList.remove('error', 'success');
  if (type) el.classList.add(type);
}

function apiGet(params) {
  const url = new URL(APPS_SCRIPT_URL);
  Object.keys(params).forEach((key) => url.searchParams.set(key, params[key]));
  return fetch(url.toString()).then((res) => res.json());
}

function apiPost(payload) {
  // Sent as text/plain to avoid a CORS preflight request against Apps Script.
  return fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  }).then((res) => res.json());
}

function resetSections() {
  optionsSection.classList.add('hidden');
  rsvpSection.classList.add('hidden');
  rsvpForm.classList.remove('hidden');
  submitButton.disabled = false;
  optionsList.innerHTML = '';
  guestsContainer.innerHTML = '';
  setMessage(submitMessage, '');
  continueButton.classList.add('hidden');
  lastWebsitePassword = null;
}

async function handleSearch() {
  const name = nameInput.value.trim();
  if (!name) {
    setMessage(searchMessage, 'Please enter a name.', 'error');
    return;
  }

  setMessage(searchMessage, 'Searching…');
  resetSections();
  searchButton.disabled = true;

  try {
    const result = await apiGet({ action: 'search', name });

    if (result.error) {
      setMessage(searchMessage, result.error, 'error');
      return;
    }

    if (result.ambiguous) {
      setMessage(searchMessage, '');
      showOptions(result.options);
      return;
    }

    if (!result.invitationGroup) {
      setMessage(searchMessage, "We couldn't find your invitation. Please check the spelling of your name, or contact us directly.", 'error');
      return;
    }

    setMessage(searchMessage, '');
    showInvitation(result);
  } catch (err) {
    setMessage(searchMessage, 'Something went wrong. Please try again later.', 'error');
  } finally {
    searchButton.disabled = false;
  }
}

function showOptions(options) {
  optionsSection.classList.remove('hidden');
  options.forEach((groupName) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = groupName;
    button.addEventListener('click', () => selectOption(groupName));
    li.appendChild(button);
    optionsList.appendChild(li);
  });
}

async function selectOption(groupName) {
  setMessage(searchMessage, 'Loading…');
  optionsSection.classList.add('hidden');
  optionsList.innerHTML = '';

  try {
    const result = await apiGet({ action: 'byGroup', group: groupName });
    if (result.error || !result.invitationGroup) {
      setMessage(searchMessage, 'Unable to resolve your invitation. Please contact us directly.', 'error');
      return;
    }
    setMessage(searchMessage, '');
    showInvitation(result);
  } catch (err) {
    setMessage(searchMessage, 'Something went wrong. Please try again later.', 'error');
  }
}

function showInvitation(invitation) {
  currentInvitation = invitation;
  invitationTitle.textContent = invitation.invitationGroup;
  guestsContainer.innerHTML = '';

  invitation.guests.forEach((guest) => {
    guestsContainer.appendChild(buildGuestCard(guest, invitation));
  });

  rsvpSection.classList.remove('hidden');
}

function buildGuestCard(guest, invitation) {
  const card = document.createElement('div');
  card.className = 'guest-card';
  card.dataset.guestId = guest.guestId;

  const heading = document.createElement('h3');
  heading.textContent = guest.guestName;
  card.appendChild(heading);

  guest.events.forEach((eventName) => {
    const row = document.createElement('div');
    row.className = 'event-row';

    const label = document.createElement('span');
    label.className = 'event-name';
    label.textContent = eventName;
    row.appendChild(label);

    const toggle = document.createElement('div');
    toggle.className = 'rsvp-toggle';
    const groupName = `rsvp-${guest.guestId}-${slugify(eventName)}`;

    ['Attending', 'Not Attending'].forEach((choice) => {
      const label2 = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = groupName;
      radio.value = choice;
      radio.dataset.event = eventName;
      radio.required = true;
      label2.appendChild(radio);
      label2.appendChild(document.createTextNode(choice));
      toggle.appendChild(label2);
    });

    row.appendChild(toggle);
    card.appendChild(row);
  });

  if (guest.events.length > 0) {
    const mealField = document.createElement('div');
    mealField.className = 'form-field';

    const mealLabel = document.createElement('label');
    mealLabel.textContent = 'Meal choice';
    mealField.appendChild(mealLabel);

    const select = document.createElement('select');
    select.className = 'meal-select';
    select.required = true;

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a meal';
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);

    invitation.mealOptions.forEach((meal) => {
      const option = document.createElement('option');
      option.value = meal;
      option.textContent = meal;
      select.appendChild(option);
    });

    mealField.appendChild(select);
    card.appendChild(mealField);
  }

  return card;
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

async function handleSubmit(evt) {
  evt.preventDefault();
  if (!currentInvitation) return;

  submitButton.disabled = true;
  setMessage(submitMessage, 'Submitting…');

  const guestCards = guestsContainer.querySelectorAll('.guest-card');
  const guests = [];

  guestCards.forEach((card) => {
    const guestId = card.dataset.guestId;
    const guestData = currentInvitation.guests.find((g) => String(g.guestId) === String(guestId));
    const rsvps = {};

    guestData.events.forEach((eventName) => {
      const checked = card.querySelector(`input[data-event="${cssEscape(eventName)}"]:checked`);
      rsvps[eventName] = checked ? checked.value : '';
    });

    const mealSelect = card.querySelector('.meal-select');

    guests.push({
      guestId,
      guestName: guestData.guestName,
      rsvps,
      mealChoice: mealSelect ? mealSelect.value : ''
    });
  });

  const payload = {
    invitationGroup: currentInvitation.invitationGroup,
    message: messageInput.value.trim(),
    guests
  };

  try {
    const result = await apiPost(payload);
    if (result.error) {
      setMessage(submitMessage, result.error, 'error');
      submitButton.disabled = false;
      return;
    }
    rsvpForm.classList.add('hidden');
    const thankYouText = result.websitePassword
      ? `Thank you! Your RSVP has been recorded. Your wedding website password is: ${result.websitePassword}`
      : 'Thank you! Your RSVP has been recorded.';
    setMessage(submitMessage, thankYouText, 'success');
    lastWebsitePassword = result.websitePassword || null;
    continueButton.classList.remove('hidden');
  } catch (err) {
    setMessage(submitMessage, 'Something went wrong submitting your RSVP. Please try again later.', 'error');
    submitButton.disabled = false;
  }
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

function handleContinue() {
  // This widget is embedded in Wix via an HTML iframe element, so it can't
  // call Velo (site) code directly. Instead it posts a message to the
  // parent window; the Wix page code must listen for it with
  // $w('#htmlElementId').onMessage(...) and call submitPassword() itself.
  // See README.md "Embed in Wix" for the corresponding Velo snippet.
  if (window.parent) {
    window.parent.postMessage(
      { type: 'wedding-rsvp-continue', websitePassword: lastWebsitePassword },
      '*'
    );
  }
}

searchButton.addEventListener('click', handleSearch);
nameInput.addEventListener('keydown', (evt) => {
  if (evt.key === 'Enter') handleSearch();
});
rsvpForm.addEventListener('submit', handleSubmit);
continueButton.addEventListener('click', handleContinue);
