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

// Password shown to guests after they submit their RSVP, so they can access
// the wedding website. Edit as needed.
var WEBSITE_PASSWORD = 'REPLACE_WITH_WEBSITE_PASSWORD';

var GUESTS_SHEET_NAME = 'Guests';
var RESPONSES_SHEET_NAME = 'Responses';

// The Guests sheet has three fixed leading columns (First Names, Last
// Names, Count) followed by one column per event.
var GUEST_LIST_FIXED_COLUMNS_COUNT = 3;

// Event columns listed here treat a 0 as a placeholder meaning "everyone in
// the row" (i.e. use the row's Count) rather than "nobody". Compared
// case-insensitively against the event column header.
var EVENTS_WHERE_ZERO_MEANS_EVERYONE = ['sunday'];

// Columns after the event columns that hold extra per-invitation data (not
// events guests RSVP to) and should be ignored when building the RSVP form.
// Compared case-insensitively against the column header.
var GUEST_LIST_NON_EVENT_COLUMNS = [
  'zip code', 'invitation', 'hospitality', 'contact', 'first line',
  'second line', 'city/town', 'state', 'and family or someone else',
  'formatted address', 'print', 'column 1'
];

var RESPONSE_FIXED_COLUMNS = ['Timestamp', 'GuestID', 'GuestName', 'InvitationGroup'];
var RESPONSE_EVENT_COLUMNS = ['Fri night', 'Saturday', 'Sunday'];
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
    return jsonResponse({ success: true, websitePassword: WEBSITE_PASSWORD });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Splits a "First and Second and Third" (or comma-separated) cell into an
 * array of individual trimmed name parts.
 */
function splitNames(raw) {
  return String(raw || '')
    .split(/\s*,\s*|\s+and\s+/i)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

/**
 * Reads the Guests sheet and returns { eventNames, guests }. Each row
 * represents one invitation covering one or more people: a "First Names"
 * column (e.g. "Sharyn and Kenny"), a last-name column (e.g. "Ben-Zvi and
 * Unger"), a "Count" of total people, and one column per event holding the
 * number of people from the row attending/invited to that event.
 *
 * First and last names are paired positionally so "Sharyn and Kenny" /
 * "Ben-Zvi and Unger" becomes "Sharyn Ben-Zvi" and "Kenny Unger" — never a
 * cross-product that would also produce "Sharyn Unger" or "Kenny Ben-Zvi".
 * If there's a single last name, every first name uses it (e.g. "Susan and
 * Philip" / "Ben-Zvi" -> "Susan Ben-Zvi" and "Philip Ben-Zvi").
 */
function getGuestsData() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GUESTS_SHEET_NAME);
  if (!sheet) throw new Error('Missing "' + GUESTS_SHEET_NAME + '" sheet');

  var values = sheet.getDataRange().getValues();
  var header = values[0];
  var allColumnNames = header.slice(GUEST_LIST_FIXED_COLUMNS_COUNT);

  // Only the columns that aren't listed in GUEST_LIST_NON_EVENT_COLUMNS are
  // treated as events; keep track of each event's original column index so
  // values can still be read from the right place in each row.
  var eventColumns = [];
  allColumnNames.forEach(function (name, idx) {
    var normalized = String(name || '').trim().toLowerCase();
    if (GUEST_LIST_NON_EVENT_COLUMNS.indexOf(normalized) === -1) {
      eventColumns.push({ name: name, colIndex: GUEST_LIST_FIXED_COLUMNS_COUNT + idx });
    }
  });
  var eventNames = eventColumns.map(function (c) { return c.name; });

  var guests = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var firstNamesRaw = row[0];
    var lastNamesRaw = row[1];
    if (!firstNamesRaw && !lastNamesRaw) continue; // skip blank rows

    var firstNames = splitNames(firstNamesRaw);
    var lastNames = splitNames(lastNamesRaw);
    if (firstNames.length === 0) continue;

    var count = Number(row[2]) || firstNames.length;

    var fullNames = firstNames.map(function (firstName, idx) {
      var lastName;
      if (lastNames.length === 1) {
        lastName = lastNames[0];
      } else if (lastNames.length === firstNames.length) {
        lastName = lastNames[idx];
      } else {
        // Mismatched counts: pair positionally as far as possible, reusing
        // the final last name for any extra first names.
        lastName = lastNames[Math.min(idx, lastNames.length - 1)] || '';
      }
      return (firstName + ' ' + lastName).trim();
    });

    // Built from the same first/last name pairing used for each guest's
    // name, so e.g. "Faria and Shana" / "Ali Chaudhry and Salzberg" becomes
    // "Faria Ali Chaudhry and Shana Salzberg" rather than the raw,
    // unpaired cell text.
    var invitationGroup = fullNames.join(' and ');

    firstNames.forEach(function (firstName, idx) {
      var guest = {
        guestId: i + '-' + idx,
        invitationGroup: invitationGroup,
        guestName: fullNames[idx],
        events: []
      };

      eventColumns.forEach(function (eventColumn) {
        var rawValue = row[eventColumn.colIndex];
        var numericValue = Number(rawValue) || 0;
        var eventName = String(eventColumn.name || '').trim().toLowerCase();
        if (numericValue === 0 && EVENTS_WHERE_ZERO_MEANS_EVERYONE.indexOf(eventName) !== -1) {
          numericValue = count;
        }
        if (numericValue > 0) {
          guest.events.push(eventColumn.name);
        }
      });

      guests.push(guest);
    });
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
 * Removes any existing Responses columns whose header isn't part of the
 * expected header (e.g. stray columns auto-created before extra Guests
 * columns were added to GUEST_LIST_NON_EVENT_COLUMNS), so the sheet stays
 * clean without manual editing. No-op if the sheet is empty.
 */
function pruneUnexpectedResponseColumns(sheet, expectedHeader) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return;

  var currentHeader = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  for (var col = lastCol; col >= 1; col--) {
    var name = currentHeader[col - 1];
    if (expectedHeader.indexOf(name) === -1) {
      sheet.deleteColumn(col);
    }
  }
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

  var header = RESPONSE_FIXED_COLUMNS.concat(RESPONSE_EVENT_COLUMNS, RESPONSE_TRAILING_COLUMNS);

  pruneUnexpectedResponseColumns(sheet, header);

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

    RESPONSE_EVENT_COLUMNS.forEach(function (eventName) {
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
