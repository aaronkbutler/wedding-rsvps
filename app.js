// Paste the deployed Google Apps Script Web App URL here (ends in /exec).
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbw2tfP_tJIYvGfMAT9I66gzYngFp0s5NZPUVBFZ3gBnDbwk1LeIHTtxc1II7nmb5BS1QQ/exec';

// Maps raw event column headers from the Google Sheet to user-friendly display names.
const EVENT_DISPLAY_NAMES = {
  'fri night': 'Kabbalat Shabbat and Dinner - Friday, October 23rd @ 6 pm',
  'saturday': 'Aufruf - Saturday, October 24th @ 9:30 am',
  'sunday': 'Wedding - Sunday, October 25th @ 3 pm',
};

function displayEventName(eventName) {
  return EVENT_DISPLAY_NAMES[eventName.toLowerCase()] || eventName;
}

const landingSection = document.getElementById('landing-section');
const rsvpButton = document.getElementById('rsvp-button');
const loginButton = document.getElementById('login-button');

const loginSection = document.getElementById('login-section');
const loginPasswordInput = document.getElementById('login-password-input');
const loginSubmitButton = document.getElementById('login-submit-button');
const loginMessage = document.getElementById('login-message');

const searchSection = document.getElementById('search-section');
const nameInput = document.getElementById('name-input');
const searchButton = document.getElementById('search-button');
const searchMessage = document.getElementById('search-message');

const optionsSection = document.getElementById('options-section');
const optionsList = document.getElementById('options-list');

const rsvpSection = document.getElementById('rsvp-section');
const invitationTitle = document.getElementById('invitation-title');
const guestsContainer = document.getElementById('guests-container');
const rsvpForm = document.getElementById('rsvp-form');
const emailInput = document.getElementById('email-input');
const messageInput = document.getElementById('message-input');
const submitButton = document.getElementById('submit-button');
const submitMessage = document.getElementById('submit-message');
const rsvpSummary = document.getElementById('rsvp-summary');
const rsvpSummaryContent = document.getElementById('rsvp-summary-content');
const continueButton = document.getElementById('continue-button');

let currentInvitation = null;
let lastWebsitePassword = null;

function setMessage(el, text, type, isHtml) {
  if (isHtml) {
    el.innerHTML = text || '';
  } else {
    el.textContent = text || '';
  }
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
  emailInput.value = '';
  rsvpSummaryContent.innerHTML = '';
  rsvpSummary.open = false;
  rsvpSummary.classList.add('hidden');
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

  invitation.eventNames.forEach((eventName) => {
    const eventGuests = invitation.guests.filter((guest) => guest.events.includes(eventName));
    if (eventGuests.length > 0) {
      guestsContainer.appendChild(buildEventCard(eventName, eventGuests, invitation));
    }
  });

  rsvpSection.classList.remove('hidden');
}

function buildEventCard(eventName, guests, invitation) {
  const card = document.createElement('div');
  card.className = 'guest-card event-card';
  card.dataset.event = eventName;

  const heading = document.createElement('h3');
  heading.textContent = displayEventName(eventName);
  card.appendChild(heading);

  guests.forEach((guest) => {
    const row = document.createElement('div');
    row.className = 'event-guest-row';

    const label = document.createElement('span');
    label.className = 'event-guest-name';
    label.textContent = guest.guestName;
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
      radio.dataset.guestId = guest.guestId;
      radio.required = true;
      label2.appendChild(radio);
      label2.appendChild(document.createTextNode(choice));
      toggle.appendChild(label2);
    });

    row.appendChild(toggle);
    card.appendChild(row);
  });

  if (isWeddingEvent(eventName) && guests.length > 0) {
    const mealSection = document.createElement('div');
    mealSection.className = 'meal-section';

    const mealHeading = document.createElement('h4');
    mealHeading.textContent = 'Meal choices';
    mealSection.appendChild(mealHeading);

    guests.forEach((guest) => {
      const mealField = document.createElement('div');
      mealField.className = 'form-field meal-row';

      const mealLabel = document.createElement('label');
      mealLabel.htmlFor = `meal-${guest.guestId}`;
      mealLabel.textContent = `${guest.guestName}'s meal choice`;
      mealField.appendChild(mealLabel);

      const select = document.createElement('select');
      select.className = 'meal-select';
      select.id = `meal-${guest.guestId}`;
      select.dataset.mealGuestId = guest.guestId;
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
      mealSection.appendChild(mealField);
    });

    card.appendChild(mealSection);
  }

  if (isFridayEvent(eventName) && guests.length > 0) {
    const hospitalitySection = document.createElement('div');
    hospitalitySection.className = 'hospitality-section';

    const hospitalityQuestion = document.createElement('p');
    hospitalityQuestion.className = 'hospitality-question';
    hospitalityQuestion.textContent = 'Would you like home hospitality within walking distance of the Kriegel/Butler home?';
    hospitalitySection.appendChild(hospitalityQuestion);

    const hospitalityToggle = document.createElement('div');
    hospitalityToggle.className = 'rsvp-toggle';

    ['Yes', 'No'].forEach((choice) => {
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'hospitality-needed';
      radio.value = choice;
      radio.required = true;
      label.appendChild(radio);
      label.appendChild(document.createTextNode(choice));
      hospitalityToggle.appendChild(label);
    });

    hospitalitySection.appendChild(hospitalityToggle);
    card.appendChild(hospitalitySection);
  }

  return card;
}

function isWeddingEvent(eventName) {
  const rawName = String(eventName || '').trim().toLowerCase();
  const displayName = displayEventName(eventName).toLowerCase();
  return rawName === 'sunday' || displayName.includes('wedding');
}

function isFridayEvent(eventName) {
  const rawName = String(eventName || '').trim().toLowerCase();
  return rawName === 'fri night';
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

async function handleSubmit(evt) {
  evt.preventDefault();
  if (!currentInvitation) return;

  const submittedEmail = emailInput.value.trim();
  if (!submittedEmail) {
    setMessage(submitMessage, 'Please enter an email address.', 'error');
    emailInput.focus();
    return;
  }

  submitButton.disabled = true;
  setMessage(submitMessage, 'Submitting…');

  const hospitalityChecked = guestsContainer.querySelector('input[name="hospitality-needed"]:checked');
  const hospitalityAnswer = hospitalityChecked ? hospitalityChecked.value : '';

  const guests = currentInvitation.guests.map((guestData) => {
    const guestId = guestData.guestId;
    const rsvps = {};

    guestData.events.forEach((eventName) => {
      const groupName = `rsvp-${guestId}-${slugify(eventName)}`;
      const checked = guestsContainer.querySelector(`input[name="${cssEscape(groupName)}"]:checked`);
      rsvps[eventName] = checked ? checked.value : '';
    });

    const mealSelect = guestsContainer.querySelector(`select[data-meal-guest-id="${cssEscape(String(guestId))}"]`);
    const invitedFriday = guestData.events.some((eventName) => isFridayEvent(eventName));

    return {
      guestId,
      guestName: guestData.guestName,
      rsvps,
      mealChoice: mealSelect ? mealSelect.value : '',
      hospitalityNeeded: invitedFriday ? hospitalityAnswer : ''
    };
  });

  const payload = {
    invitationGroup: currentInvitation.invitationGroup,
    email: submittedEmail,
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
    lastWebsitePassword = determinePassword(guests);
    const thankYouText = lastWebsitePassword
      ? `Thank you! Your RSVP has been recorded. Your wedding website password is: <strong>${lastWebsitePassword}</strong>`
      : 'Thank you! Your RSVP has been recorded.';
    setMessage(submitMessage, thankYouText, 'success', true);
    showRsvpSummary(guests);
    continueButton.classList.remove('hidden');
  } catch (err) {
    setMessage(submitMessage, 'Something went wrong submitting your RSVP. Please try again later.', 'error');
    submitButton.disabled = false;
  }
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

function showRsvpSummary(guests) {
  rsvpSummaryContent.innerHTML = '';

  guests.forEach((guest) => {
    const card = document.createElement('div');
    card.className = 'summary-card';

    const heading = document.createElement('h3');
    heading.textContent = guest.guestName;
    card.appendChild(heading);

    const list = document.createElement('ul');
    Object.entries(guest.rsvps).forEach(([eventName, response]) => {
      const li = document.createElement('li');
      li.textContent = `${displayEventName(eventName)}: ${response}`;
      list.appendChild(li);
    });

    if (guest.mealChoice) {
      const li = document.createElement('li');
      li.textContent = `Meal: ${guest.mealChoice}`;
      list.appendChild(li);
    }

    if (guest.hospitalityNeeded) {
      const li = document.createElement('li');
      li.textContent = `Home hospitality needed: ${guest.hospitalityNeeded}`;
      list.appendChild(li);
    }

    card.appendChild(list);
    rsvpSummaryContent.appendChild(card);
  });

  rsvpSummary.classList.remove('hidden');
}

function determinePassword(guests) {
  // Determine the password based on which events the guests are *invited to*
  // (not which they RSVP'd "Attending" to), using the current invitation data.
  let invitedFriday = false;
  let invitedSaturday = false;

  if (currentInvitation && currentInvitation.guests) {
    currentInvitation.guests.forEach((guest) => {
      guest.events.forEach((eventName) => {
        const lower = eventName.toLowerCase();
        if (lower.includes('fri')) invitedFriday = true;
        if (lower.includes('saturday')) invitedSaturday = true;
      });
    });
  }

  if (invitedFriday) return 'shippinguptoboston';
  if (invitedSaturday) return 'wearefamily';
  return 'beantown';
}

function postPasswordToParent(password) {
  window.parent.postMessage(
    { type: 'wedding-rsvp-continue', websitePassword: password },
    '*'
  );
}

function handleContinue() {
  // This widget is embedded in Wix via an HTML iframe element, so it can't
  // call Velo (site) code directly. Instead it posts a message to the
  // parent window; the Wix page code must listen for it with
  // $w('#htmlElementId').onMessage(...) and call submitPassword() itself.
  // See README.md "Embed in Wix" for the corresponding Velo snippet.
  postPasswordToParent(lastWebsitePassword);
}

function handleRsvpButton() {
  landingSection.classList.add('hidden');
  searchSection.classList.remove('hidden');
  nameInput.focus();
}

function handleLoginButton() {
  landingSection.classList.add('hidden');
  loginSection.classList.remove('hidden');
  loginPasswordInput.focus();
}

function handleLoginSubmit() {
  const password = loginPasswordInput.value.trim();
  if (!password) {
    setMessage(loginMessage, 'Please enter a password.', 'error');
    return;
  }
  postPasswordToParent(password);
}

rsvpButton.addEventListener('click', handleRsvpButton);
loginButton.addEventListener('click', handleLoginButton);
loginSubmitButton.addEventListener('click', handleLoginSubmit);
loginPasswordInput.addEventListener('keydown', (evt) => {
  if (evt.key === 'Enter') handleLoginSubmit();
});
searchButton.addEventListener('click', handleSearch);
nameInput.addEventListener('keydown', (evt) => {
  if (evt.key === 'Enter') handleSearch();
});
rsvpForm.addEventListener('submit', handleSubmit);
continueButton.addEventListener('click', handleContinue);
