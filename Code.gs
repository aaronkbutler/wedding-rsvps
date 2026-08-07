/**
 * Wedding RSVP backend — Google Apps Script Web App
 *
 * Bind this script to the Google Sheet that contains a "Guests" tab and a
 * "Responses" tab (see README.md for the exact column layout). Deploy as a
 * Web App ("Execute as me", access "Anyone") and paste the resulting URL
 * into app.js as APPS_SCRIPT_URL.
 */

// The two meal options offered to every guest. Edit as needed.
var MEAL_OPTIONS = ['Apricot Glazed Salmon (gluten-free)', 'Wild Mushroom Strudel (dairy)'];

// Wedding website password is sent by the client in the RSVP payload.

// Enables/disables RSVP confirmation emails sent through GmailApp.
var SEND_CONFIRMATION_EMAILS = true;

// Confirmation email settings.
var CONFIRMATION_EMAIL_SUBJECT = 'Your Wedding RSVP Confirmation';
var CONFIRMATION_EMAIL_SENDER_NAME = 'Kriegel and Butler Wedding';
var WEDDING_WEBSITE_URL = 'https://raquelandaaron.com';

var EVENT_DISPLAY_NAMES = {
  'fri night': 'Kabbalat Shabbat and Dinner - Friday, October 23rd @ 6 pm',
  'saturday': 'Aufruf - Saturday, October 24th @ 9:30 am',
  'sunday': 'Wedding - Sunday, October 25th @ 3 pm'
};

// Optional fixed recipients who should always receive a copy.
// Example: ['you@example.com']
var CONFIRMATION_EMAIL_RECIPIENTS = [];

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
  'formatted address', 'print', 'column 1', 'additional guests'
];

// The column header in the Guests sheet that holds comma-separated full names
// of additional guests belonging to the same invitation row. These names are
// added to the group and are searchable. Compared case-insensitively.
var ADDITIONAL_GUESTS_COLUMN = 'additional guests';

var RESPONSE_FIXED_COLUMNS = ['Timestamp', 'GuestID', 'GuestName', 'InvitationGroup'];
var RESPONSE_EVENT_COLUMNS = ['Fri night', 'Saturday', 'Sunday'];
var RESPONSE_TRAILING_COLUMNS = ['MealChoice', 'HospitalityNeeded', 'Message'];

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
    var submittedEmail = normalizeSubmittedEmail(payload && payload.email);
    if (!submittedEmail) {
      throw new Error('A valid email address is required.');
    }
    var submittedWebsitePassword = String((payload && payload.websitePassword) || '').trim();
    if (!submittedWebsitePassword) {
      throw new Error('A website password is required.');
    }
    payload.email = submittedEmail;
    payload.websitePassword = submittedWebsitePassword;

    submitRsvp(payload);
    var emailStatus = trySendConfirmationEmails(payload);
    return jsonResponse({
      success: true,
      websitePassword: payload.websitePassword,
      emailStatus: emailStatus
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function trySendConfirmationEmails(payload) {
  if (!SEND_CONFIRMATION_EMAILS) {
    return { attempted: false, sent: 0, reason: 'disabled' };
  }

  try {
    return sendConfirmationEmails(payload);
  } catch (err) {
    Logger.log('Failed to send RSVP confirmation emails: ' + err);
    return { attempted: true, sent: 0, error: err.message };
  }
}

function sendConfirmationEmails(payload) {
  var recipients = getRecipientEmailsForPayload(payload);
  if (recipients.length === 0) {
    return { attempted: true, sent: 0, reason: 'no_recipients' };
  }

  var subject = CONFIRMATION_EMAIL_SUBJECT;
  var htmlBody = buildConfirmationEmailHtml(payload);
  var textBody = buildConfirmationEmailText(payload);

  recipients.forEach(function (recipient) {
    GmailApp.sendEmail(recipient, subject, textBody, {
      htmlBody: htmlBody,
      name: CONFIRMATION_EMAIL_SENDER_NAME
    });
  });

  return { attempted: true, sent: recipients.length };
}

function buildConfirmationEmailText(payload) {
  var lines = [];
  lines.push('Thank you for your RSVP!');
  lines.push('Wedding website: raquelandaaron.com (' + WEDDING_WEBSITE_URL + ')');

  if (payload && payload.invitationGroup) {
    lines.push('Invitation: ' + payload.invitationGroup);
  }

  if (payload && payload.websitePassword) {
    lines.push('Wedding website password: ' + payload.websitePassword);
  }

  var eventSummaries = buildEventSummaryForEmail(payload);
  if (eventSummaries.length > 0) {
    lines.push('');
    lines.push('RSVPs by event:');

    eventSummaries.forEach(function (eventSummary) {
      lines.push('');
      lines.push(eventSummary.displayName + ':');

      eventSummary.entries.forEach(function (entry) {
        var detail = entry.response;
        if (isWeddingEventName(eventSummary.eventName) && entry.mealChoice) {
          detail += ' | Meal: ' + entry.mealChoice;
        }
        if (isFridayEventName(eventSummary.eventName) && entry.hospitalityNeeded) {
          detail += ' | Home hospitality needed: ' + entry.hospitalityNeeded;
        }

        lines.push('- ' + entry.guestName + ': ' + detail);
      });
    });
  }

  if (payload && payload.message) {
    lines.push('');
    lines.push('Message: ' + payload.message);
  }

  lines.push('');
  lines.push(hasAnyAttendingResponse(payload)
    ? 'We look forward to celebrating with you.'
    : "We'll miss you but you'll be with us in spirit!");

  return lines.join('\n');
}

function buildConfirmationEmailHtml(payload) {
  var html = [];
  html.push('<!doctype html>');
  html.push('<html><body style="margin:0;padding:24px;background:#fffaf8;color:#33272a;font-family:\'Helvetica Neue\', Arial, sans-serif;">');
  html.push('<div style="max-width:700px;margin:0 auto;">');
  html.push('<p style="margin:0 0 12px;">Thank you for your RSVP!</p>');

  html.push('<div style="background:#ffffff;border:1px solid #ddd0cf;border-radius:8px;padding:16px;margin:0 0 16px;">');
  html.push('<p style="margin:0 0 10px;"><strong>Wedding website:</strong> <a href="' + escapeHtml(WEDDING_WEBSITE_URL) + '" style="color:#5f4448;text-decoration:underline;">raquelandaaron.com</a></p>');

  if (payload && payload.websitePassword) {
    html.push('<p style="margin:0 0 12px;"><strong>Website password:</strong> <span style="display:inline-block;background:#f3e9e8;border:1px solid #ddd0cf;border-radius:6px;padding:3px 8px;">' + escapeHtml(payload.websitePassword) + '</span></p>');
  }
  html.push('</div>');

  if (payload && payload.invitationGroup) {
    html.push('<p style="margin:0 0 16px;"><strong>Invitation:</strong> ' + escapeHtml(payload.invitationGroup) + '</p>');
  }

  var eventSummaries = buildEventSummaryForEmail(payload);
  eventSummaries.forEach(function (eventSummary) {
    html.push('<div style="border:1px solid #ddd0cf;border-radius:8px;padding:14px 16px;margin:0 0 12px;background:#ffffff;">');
    html.push('<h3 style="margin:0 0 10px;font-size:17px;font-weight:600;">' + escapeHtml(eventSummary.displayName) + '</h3>');
    html.push('<ul style="margin:0;padding-left:18px;">');

    eventSummary.entries.forEach(function (entry) {
      var details = [escapeHtml(entry.response)];
      if (isWeddingEventName(eventSummary.eventName) && entry.mealChoice) {
        details.push('Meal: ' + escapeHtml(entry.mealChoice));
      }
      if (isFridayEventName(eventSummary.eventName) && entry.hospitalityNeeded) {
        details.push('Home hospitality needed: ' + escapeHtml(entry.hospitalityNeeded));
      }

      html.push('<li style="margin:0 0 6px;"><strong>' + escapeHtml(entry.guestName) + ':</strong> ' + details.join(' | ') + '</li>');
    });

    html.push('</ul>');
    html.push('</div>');
  });

  if (payload && payload.message) {
    html.push('<div style="border:1px solid #ddd0cf;border-radius:8px;padding:14px 16px;margin:0 0 12px;background:#ffffff;">');
    html.push('<p style="margin:0 0 8px;font-weight:600;">Message or questions for the couple</p>');
    html.push('<p style="margin:0;white-space:pre-wrap;">' + escapeHtml(payload.message) + '</p>');
    html.push('</div>');
  }

  var closingMessage = hasAnyAttendingResponse(payload)
    ? 'We look forward to celebrating with you.'
    : "We'll miss you but you'll be with us in spirit!";
  html.push('<p style="margin:10px 0 0;color:#5f4448;">' + escapeHtml(closingMessage) + '</p>');
  html.push('</div>');
  html.push('</body></html>');
  return html.join('');
}

function displayEventNameForEmail(eventName) {
  var key = String(eventName || '').trim().toLowerCase();
  return EVENT_DISPLAY_NAMES[key] || String(eventName || '');
}

function buildEventSummaryForEmail(payload) {
  var guests = (payload && Array.isArray(payload.guests)) ? payload.guests : [];
  var groupedByEvent = {};

  RESPONSE_EVENT_COLUMNS.forEach(function (eventName) {
    groupedByEvent[eventName] = [];
  });

  guests.forEach(function (guest) {
    var guestName = (guest && guest.guestName) ? guest.guestName : 'Guest';
    var rsvps = (guest && guest.rsvps) ? guest.rsvps : {};

    RESPONSE_EVENT_COLUMNS.forEach(function (eventName) {
      var response = rsvps[eventName];
      if (!response) return;

      groupedByEvent[eventName].push({
        guestName: guestName,
        response: response,
        mealChoice: guest.mealChoice || '',
        hospitalityNeeded: guest.hospitalityNeeded || ''
      });
    });
  });

  var summaries = [];
  RESPONSE_EVENT_COLUMNS.forEach(function (eventName) {
    if (!groupedByEvent[eventName] || groupedByEvent[eventName].length === 0) return;

    summaries.push({
      eventName: eventName,
      displayName: displayEventNameForEmail(eventName),
      entries: groupedByEvent[eventName]
    });
  });

  return summaries;
}

function hasAnyAttendingResponse(payload) {
  var guests = (payload && Array.isArray(payload.guests)) ? payload.guests : [];

  for (var i = 0; i < guests.length; i++) {
    var rsvps = (guests[i] && guests[i].rsvps) ? guests[i].rsvps : {};
    for (var j = 0; j < RESPONSE_EVENT_COLUMNS.length; j++) {
      var eventName = RESPONSE_EVENT_COLUMNS[j];
      var response = String(rsvps[eventName] || '').trim().toLowerCase();
      if (response === 'attending') {
        return true;
      }
    }
  }

  return false;
}

function isWeddingEventName(eventName) {
  var key = String(eventName || '').trim().toLowerCase();
  return key === 'sunday' || key.indexOf('wedding') !== -1;
}

function isFridayEventName(eventName) {
  var key = String(eventName || '').trim().toLowerCase();
  return key === 'fri night' || key.indexOf('friday') !== -1 || key.indexOf('fri') !== -1;
}

function getRecipientEmailsForPayload(payload) {
  var recipients = Array.isArray(CONFIRMATION_EMAIL_RECIPIENTS)
    ? CONFIRMATION_EMAIL_RECIPIENTS.slice()
    : [];

  var submittedEmail = normalizeSubmittedEmail(payload && payload.email);
  if (submittedEmail) {
    recipients.unshift(submittedEmail);
  }

  return dedupeEmails(recipients);
}

function normalizeSubmittedEmail(email) {
  var value = String(email || '').trim().toLowerCase();
  if (!value) return '';
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) ? value : '';
}

function dedupeEmails(emails) {
  var result = [];
  var seen = {};

  (emails || []).forEach(function (email) {
    var normalized = String(email || '').trim().toLowerCase();
    if (!normalized) return;
    if (seen[normalized]) return;
    seen[normalized] = true;
    result.push(normalized);
  });

  return result;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function splitAdditionalGuestNames(raw) {
  return String(raw || '')
    .split(/\s*,\s*/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

function formatGuestList(names) {
  if (!Array.isArray(names) || names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return names[0] + ' and ' + names[1];
  return names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
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
  var additionalGuestsColIndex = -1;
  allColumnNames.forEach(function (name, idx) {
    var normalized = String(name || '').trim().toLowerCase();
    if (normalized === ADDITIONAL_GUESTS_COLUMN.toLowerCase()) {
      additionalGuestsColIndex = GUEST_LIST_FIXED_COLUMNS_COUNT + idx;
    }
    if (GUEST_LIST_NON_EVENT_COLUMNS.indexOf(normalized) === -1) {
      eventColumns.push({ name: name, colIndex: GUEST_LIST_FIXED_COLUMNS_COUNT + idx });
    }
  });

  // Fallback: if no column header matched the additional-guests name, try the
  // last column in the sheet provided it is a known non-event column (so we
  // never accidentally steal a real event column on a minimal sheet).
  if (additionalGuestsColIndex === -1 && allColumnNames.length > 0) {
    var lastColName = String(allColumnNames[allColumnNames.length - 1] || '').trim().toLowerCase();
    if (GUEST_LIST_NON_EVENT_COLUMNS.indexOf(lastColName) !== -1) {
      additionalGuestsColIndex = GUEST_LIST_FIXED_COLUMNS_COUNT + (allColumnNames.length - 1);
    }
  }

  var eventNames = eventColumns.map(function (c) { return c.name; });

  // First pass: collect all names listed in the Additional Guests column
  // across every row so that standalone rows for those people can be
  // suppressed (they'll be represented via their parent row instead).
  var additionalGuestNamesSet = {};
  if (additionalGuestsColIndex !== -1) {
    for (var pre = 1; pre < values.length; pre++) {
      var rawCell = String(values[pre][additionalGuestsColIndex] || '').trim();
      if (rawCell) {
        rawCell.split(/\s*,\s*/).forEach(function (n) {
          if (n) additionalGuestNamesSet[normalizeName(n)] = true;
        });
      }
    }
  }

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

    // If every full name from this row appears in another row's Additional
    // Guests column, skip the entire row — those people will be represented
    // via the parent row's additional-guests parsing instead.
    var allClaimedByAnother = fullNames.every(function (fn) {
      return !!additionalGuestNamesSet[normalizeName(fn)];
    });

    // Only skip if this row does NOT itself have its own Additional Guests
    // (i.e. it's purely a "child" row, not itself a parent).
    var rowHasOwnAdditional = false;
    if (additionalGuestsColIndex !== -1) {
      rowHasOwnAdditional = String(row[additionalGuestsColIndex] || '').trim().length > 0;
    }

    if (allClaimedByAnother && !rowHasOwnAdditional) {
      continue;
    }

    var additionalNames = [];
    if (additionalGuestsColIndex !== -1) {
      additionalNames = splitAdditionalGuestNames(row[additionalGuestsColIndex]);
    }

    // Built from the same first/last name pairing used for each guest's
    // name, so e.g. "Faria and Shana" / "Ali Chaudhry and Salzberg" becomes
    // "Faria Ali Chaudhry and Shana Salzberg" rather than the raw,
    // unpaired cell text. Named additional guests are appended so the
    // invitation title reflects everyone on the invite.
    var invitationGroup = formatGuestList(fullNames.concat(additionalNames));

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

    // Parse additional guests from the dedicated column (comma-separated
    // full names). They join the same invitation group and inherit the same
    // events as the primary guests.
    if (additionalNames.length > 0) {
        additionalNames.forEach(function (name, extraIdx) {
          var extraGuest = {
            guestId: i + '-extra-' + extraIdx,
            invitationGroup: invitationGroup,
            guestName: name,
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
              extraGuest.events.push(eventColumn.name);
            }
          });

          guests.push(extraGuest);
        });
    }
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
 *   email: string,
 *   message: string,
 *   guests: [{ guestId, guestName, rsvps: { [eventName]: 'Attending'|'Not Attending' }, mealChoice, hospitalityNeeded }]
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
    row[header.indexOf('HospitalityNeeded')] = guestRsvp.hospitalityNeeded || '';
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
