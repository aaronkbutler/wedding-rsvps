/**
 * Wedding RSVP backend — Google Apps Script Web App
 *
 * Bind this script to the Google Sheet that contains a "Guests" tab and a
 * "Responses" tab (see README.md for the exact column layout). Deploy as a
 * Web App ("Execute as me", access "Anyone") and paste the resulting URL
 * into app.js as APPS_SCRIPT_URL.
 */

// The two meal options offered to every guest. Edit as needed.
var MEAL_OPTIONS = ['Chicken', 'Vegetarian'];

var GUESTS_SHEET_NAME = 'Guests';
var RESPONSES_SHEET_NAME = 'Responses';

var GUEST_FIXED_COLUMNS = ['GuestID', 'InvitationGroup', 'GuestName'];
var RESPONSE_FIXED_COLUMNS = ['Timestamp', 'GuestID', 'GuestName', 'InvitationGroup'];
var RESPONSE_TRAILING_COLUMNS = ['MealChoice', 'Message'];

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    var action = params.action;

    if (action === 'search') {
      return jsonResponse(searchGuests(params.name || ''));
    }

    if (action === 'byGroup') {
      return jsonResponse(getInvitationByGroup(params.group || ''));
    }

    return jsonResponse({ error: 'Unknown action' }, 400);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    submitRsvp(payload);
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Reads the Guests sheet and returns { header, rows } with rows as objects. */
function getGuestsData() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GUESTS_SHEET_NAME);
  if (!sheet) throw new Error('Missing "' + GUESTS_SHEET_NAME + '" sheet');

  var values = sheet.getDataRange().getValues();
  var header = values[0];
  var eventNames = header.slice(GUEST_FIXED_COLUMNS.length);

  var guests = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[0] && !row[2]) continue; // skip blank rows

    var guest = {
      guestId: String(row[0]),
      invitationGroup: row[1],
      guestName: row[2],
      events: []
    };

    for (var c = 0; c < eventNames.length; c++) {
      var invited = row[GUEST_FIXED_COLUMNS.length + c];
      if (invited === true || String(invited).toUpperCase() === 'TRUE') {
        guest.events.push(eventNames[c]);
      }
    }

    guests.push(guest);
  }

  return { eventNames: eventNames, guests: guests };
}

/** Normalizes a name for fuzzy matching: lowercase, strip accents/punctuation. */
function normalizeName(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenize(name) {
  var normalized = normalizeName(name);
  return normalized ? normalized.split(' ') : [];
}

/**
 * Matches the query against guest names using token overlap so a query like
 * "Aaron Butler" matches a guest named "Aaron Butler" even when the sheet
 * groups multiple people under a shared "InvitationGroup" like
 * "Raquel Cohen and Aaron Butler".
 */
function searchGuests(query) {
  var queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return { matches: [] };
  }

  var data = getGuestsData();
  var matchedGroups = {}; // invitationGroup -> best score

  data.guests.forEach(function (guest) {
    var guestTokens = tokenize(guest.guestName);
    var overlap = queryTokens.filter(function (t) {
      return guestTokens.indexOf(t) !== -1;
    }).length;

    if (overlap === 0) return;

    // Require every query token to be present, or an exact full-name match,
    // to avoid overly broad single-letter matches.
    var allTokensFound = queryTokens.every(function (t) {
      return guestTokens.indexOf(t) !== -1;
    });

    if (!allTokensFound) return;

    var score = overlap;
    if (!matchedGroups[guest.invitationGroup] || matchedGroups[guest.invitationGroup] < score) {
      matchedGroups[guest.invitationGroup] = score;
    }
  });

  var groupNames = Object.keys(matchedGroups);

  if (groupNames.length === 0) {
    return { matches: [] };
  }

  if (groupNames.length > 1) {
    // Ambiguous: let the client ask the user to pick one.
    return {
      ambiguous: true,
      options: groupNames
    };
  }

  return buildInvitationResponse(groupNames[0], data);
}

/** Builds the full RSVP payload for a given invitation group. */
function getInvitationByGroup(groupName) {
  var data = getGuestsData();
  return buildInvitationResponse(groupName, data);
}

function buildInvitationResponse(groupName, data) {
  var groupGuests = data.guests.filter(function (g) {
    return g.invitationGroup === groupName;
  });

  return {
    ambiguous: false,
    invitationGroup: groupName,
    eventNames: data.eventNames,
    mealOptions: MEAL_OPTIONS,
    guests: groupGuests
  };
}

/**
 * Expects payload:
 * {
 *   invitationGroup: string,
 *   message: string,
 *   guests: [{ guestId, guestName, rsvps: { [eventName]: 'Attending'|'Not Attending' }, mealChoice }]
 * }
 * Upserts one row per guest into Responses, keyed by GuestID.
 */
function submitRsvp(payload) {
  if (!payload || !Array.isArray(payload.guests) || payload.guests.length === 0) {
    throw new Error('No guest RSVPs provided');
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RESPONSES_SHEET_NAME);
  if (!sheet) throw new Error('Missing "' + RESPONSES_SHEET_NAME + '" sheet');

  var eventNames = getGuestsData().eventNames;
  var header = RESPONSE_FIXED_COLUMNS.concat(eventNames, RESPONSE_TRAILING_COLUMNS);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(header);
  }

  var existing = sheet.getDataRange().getValues();
  var existingHeader = existing[0];
  var guestIdCol = existingHeader.indexOf('GuestID');

  var now = new Date();
  var message = payload.message || '';

  payload.guests.forEach(function (guestRsvp) {
    var row = new Array(header.length).fill('');
    row[header.indexOf('Timestamp')] = now;
    row[header.indexOf('GuestID')] = guestRsvp.guestId;
    row[header.indexOf('GuestName')] = guestRsvp.guestName || '';
    row[header.indexOf('InvitationGroup')] = payload.invitationGroup || '';

    eventNames.forEach(function (eventName) {
      var response = (guestRsvp.rsvps && guestRsvp.rsvps[eventName]) || '';
      var colIndex = header.indexOf(eventName);
      if (colIndex !== -1) row[colIndex] = response;
    });

    row[header.indexOf('MealChoice')] = guestRsvp.mealChoice || '';
    row[header.indexOf('Message')] = message;

    var existingRowIndex = -1;
    for (var i = 1; i < existing.length; i++) {
      if (String(existing[i][guestIdCol]) === String(guestRsvp.guestId)) {
        existingRowIndex = i;
        break;
      }
    }

    if (existingRowIndex !== -1) {
      sheet.getRange(existingRowIndex + 1, 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
      existing.push(row); // keep local cache in sync for subsequent guests in this batch
    }
  });
}
