import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 8080);

const GUESTS_SHEET_NAME = 'Guests';
const RESPONSES_SHEET_NAME = 'Responses';
const GUEST_LIST_FIXED_COLUMNS_COUNT = 3;
const RESPONSE_FIXED_COLUMNS = ['Timestamp', 'GuestID', 'GuestName', 'InvitationGroup'];
const RESPONSE_EVENT_COLUMNS = ['Fri night', 'Saturday', 'Sunday'];
const RESPONSE_TRAILING_COLUMNS = ['Email', 'MealChoice', 'HospitalityNeeded', 'Message'];

const MEAL_OPTIONS = (process.env.MEAL_OPTIONS || 'Apricot Glazed Salmon (gluten-free)|Wild Mushroom Strudel (dairy)')
  .split('|')
  .map((x) => x.trim())
  .filter(Boolean);

const EVENTS_WHERE_ZERO_MEANS_EVERYONE = (process.env.EVENTS_WHERE_ZERO_MEANS_EVERYONE || 'sunday')
  .split(',')
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

const GUEST_LIST_NON_EVENT_COLUMNS = (process.env.GUEST_LIST_NON_EVENT_COLUMNS ||
  'zip code,invitation,hospitality,contact,first line,second line,city/town,state,and family or someone else,formatted address,print,column 1,additional guests')
  .split(',')
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

const ADDITIONAL_GUESTS_COLUMN = String(process.env.ADDITIONAL_GUESTS_COLUMN || 'additional guests').trim().toLowerCase();

const EVENT_DISPLAY_NAMES = {
  'fri night': 'Kabbalat Shabbat and Dinner - Friday, October 23rd @ 6 pm',
  saturday: 'Aufruf - Saturday, October 24th @ 9:30 am',
  sunday: 'Wedding - Sunday, October 25th @ 3 pm'
};

const SEND_CONFIRMATION_EMAILS = String(process.env.SEND_CONFIRMATION_EMAILS || 'true').toLowerCase() === 'true';
const CONFIRMATION_EMAIL_SUBJECT = process.env.CONFIRMATION_EMAIL_SUBJECT || "Raquel and Aaron's Wedding RSVP Confirmation";
const CONFIRMATION_EMAIL_SENDER_NAME = process.env.CONFIRMATION_EMAIL_SENDER_NAME || 'Raquel and Aaron';
const WEDDING_WEBSITE_URL = process.env.WEDDING_WEBSITE_URL || 'https://raquelandaaron.com';
const CONFIRMATION_EMAIL_RECIPIENTS = (process.env.CONFIRMATION_EMAIL_RECIPIENTS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
if (!spreadsheetId) {
  throw new Error('Missing GOOGLE_SHEETS_SPREADSHEET_ID');
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(new Error('Not allowed by CORS'));
    }
  })
);

app.use(express.text({ type: 'text/plain' }));
app.use(express.json());

function getSheetsClient() {
  const rawCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  let auth;

  if (rawCredentials) {
    let credentials;
    try {
      credentials = JSON.parse(rawCredentials);
    } catch (err) {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON');
    }

    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  } else {
    // On Cloud Run, this uses the runtime service account (ADC).
    auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  }

  return google.sheets({ version: 'v4', auth });
}

let cachedMailer;
function getMailer() {
  if (cachedMailer) return cachedMailer;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  cachedMailer = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true',
    auth: { user, pass }
  });

  return cachedMailer;
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenize(name) {
  const normalized = normalizeName(name);
  return normalized ? normalized.split(' ') : [];
}

function splitNames(raw) {
  return String(raw || '')
    .split(/\s*,\s*|\s+and\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitAdditionalGuestNames(raw) {
  return String(raw || '')
    .split(/\s*,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatGuestList(names) {
  if (!Array.isArray(names) || names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function normalizeSubmittedEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value) return '';
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) ? value : '';
}

function dedupeEmails(emails) {
  const seen = new Set();
  const out = [];
  for (const email of emails || []) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function isWeddingEventName(eventName) {
  const key = String(eventName || '').trim().toLowerCase();
  return key === 'sunday' || key.includes('wedding');
}

function isFridayEventName(eventName) {
  const key = String(eventName || '').trim().toLowerCase();
  return key === 'fri night' || key.includes('friday') || key.includes('fri');
}

function displayEventNameForEmail(eventName) {
  const key = String(eventName || '').trim().toLowerCase();
  return EVENT_DISPLAY_NAMES[key] || String(eventName || '');
}

async function readRange(sheets, range) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  });
  return response.data.values || [];
}

async function ensureResponsesHeader(sheets, expectedHeader) {
  const rows = await readRange(sheets, `${RESPONSES_SHEET_NAME}!1:1`);
  const currentHeader = rows[0] || [];

  if (currentHeader.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${RESPONSES_SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [expectedHeader]
      }
    });
    return expectedHeader;
  }

  const prunedHeader = currentHeader.filter((h) => expectedHeader.includes(h));
  const missing = expectedHeader.filter((h) => !prunedHeader.includes(h));
  const finalHeader = prunedHeader.concat(missing);

  if (finalHeader.length !== currentHeader.length || finalHeader.some((h, i) => h !== currentHeader[i])) {
    const allRows = await readRange(sheets, `${RESPONSES_SHEET_NAME}!A:ZZ`);
    const remap = allRows.map((row, rowIndex) => {
      if (rowIndex === 0) return finalHeader;
      const out = new Array(finalHeader.length).fill('');
      finalHeader.forEach((col, i) => {
        const oldIndex = currentHeader.indexOf(col);
        if (oldIndex !== -1 && oldIndex < row.length) out[i] = row[oldIndex];
      });
      return out;
    });

    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${RESPONSES_SHEET_NAME}!A:ZZ`
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${RESPONSES_SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: remap }
    });
  }

  return finalHeader;
}

async function getGuestsData(sheets) {
  const rows = await readRange(sheets, `${GUESTS_SHEET_NAME}!A:ZZ`);
  if (rows.length === 0) {
    throw new Error(`Missing data in ${GUESTS_SHEET_NAME}`);
  }

  const header = rows[0];
  const allColumnNames = header.slice(GUEST_LIST_FIXED_COLUMNS_COUNT);

  const eventColumns = [];
  let additionalGuestsColIndex = -1;

  allColumnNames.forEach((name, idx) => {
    const normalized = String(name || '').trim().toLowerCase();
    const absoluteColIndex = GUEST_LIST_FIXED_COLUMNS_COUNT + idx;

    if (normalized === ADDITIONAL_GUESTS_COLUMN) {
      additionalGuestsColIndex = absoluteColIndex;
    }

    if (!GUEST_LIST_NON_EVENT_COLUMNS.includes(normalized)) {
      eventColumns.push({ name, colIndex: absoluteColIndex });
    }
  });

  if (additionalGuestsColIndex === -1 && allColumnNames.length > 0) {
    const lastColName = String(allColumnNames[allColumnNames.length - 1] || '').trim().toLowerCase();
    if (GUEST_LIST_NON_EVENT_COLUMNS.includes(lastColName)) {
      additionalGuestsColIndex = GUEST_LIST_FIXED_COLUMNS_COUNT + (allColumnNames.length - 1);
    }
  }

  const eventNames = eventColumns.map((c) => c.name);

  const additionalGuestNamesSet = new Set();
  if (additionalGuestsColIndex !== -1) {
    for (let i = 1; i < rows.length; i += 1) {
      const rawCell = String(rows[i][additionalGuestsColIndex] || '').trim();
      if (!rawCell) continue;
      rawCell.split(/\s*,\s*/).forEach((name) => {
        if (name) additionalGuestNamesSet.add(normalizeName(name));
      });
    }
  }

  const guests = [];

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const firstNamesRaw = row[0];
    const lastNamesRaw = row[1];
    if (!firstNamesRaw && !lastNamesRaw) continue;

    const firstNames = splitNames(firstNamesRaw);
    const lastNames = splitNames(lastNamesRaw);
    if (firstNames.length === 0) continue;

    const count = Number(row[2]) || firstNames.length;

    const fullNames = firstNames.map((firstName, idx) => {
      let lastName;
      if (lastNames.length === 1) {
        lastName = lastNames[0];
      } else if (lastNames.length === firstNames.length) {
        lastName = lastNames[idx];
      } else {
        lastName = lastNames[Math.min(idx, lastNames.length - 1)] || '';
      }
      return `${firstName} ${lastName}`.trim();
    });

    const allClaimedByAnother = fullNames.every((fn) => additionalGuestNamesSet.has(normalizeName(fn)));

    let rowHasOwnAdditional = false;
    if (additionalGuestsColIndex !== -1) {
      rowHasOwnAdditional = String(row[additionalGuestsColIndex] || '').trim().length > 0;
    }

    if (allClaimedByAnother && !rowHasOwnAdditional) {
      continue;
    }

    const additionalNames = additionalGuestsColIndex !== -1
      ? splitAdditionalGuestNames(row[additionalGuestsColIndex])
      : [];

    const invitationGroup = formatGuestList(fullNames.concat(additionalNames));

    firstNames.forEach((_, idx) => {
      const guest = {
        guestId: `${i}-${idx}`,
        invitationGroup,
        guestName: fullNames[idx],
        events: []
      };

      eventColumns.forEach((eventColumn) => {
        const rawValue = row[eventColumn.colIndex];
        let numericValue = Number(rawValue) || 0;
        const eventName = String(eventColumn.name || '').trim().toLowerCase();

        if (numericValue === 0 && EVENTS_WHERE_ZERO_MEANS_EVERYONE.includes(eventName)) {
          numericValue = count;
        }

        if (numericValue > 0) {
          guest.events.push(eventColumn.name);
        }
      });

      guests.push(guest);
    });

    additionalNames.forEach((name, extraIdx) => {
      const extraGuest = {
        guestId: `${i}-extra-${extraIdx}`,
        invitationGroup,
        guestName: name,
        events: []
      };

      eventColumns.forEach((eventColumn) => {
        const rawValue = row[eventColumn.colIndex];
        let numericValue = Number(rawValue) || 0;
        const eventName = String(eventColumn.name || '').trim().toLowerCase();

        if (numericValue === 0 && EVENTS_WHERE_ZERO_MEANS_EVERYONE.includes(eventName)) {
          numericValue = count;
        }

        if (numericValue > 0) {
          extraGuest.events.push(eventColumn.name);
        }
      });

      guests.push(extraGuest);
    });
  }

  return { eventNames, guests };
}

function buildInvitationResponse(groupName, data) {
  const groupGuests = data.guests.filter((g) => g.invitationGroup === groupName);

  return {
    ambiguous: false,
    invitationGroup: groupName,
    eventNames: data.eventNames,
    mealOptions: MEAL_OPTIONS,
    guests: groupGuests
  };
}

async function searchGuests(sheets, query) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return { matches: [] };
  }

  const data = await getGuestsData(sheets);
  const matchedGroups = new Map();

  data.guests.forEach((guest) => {
    const guestTokens = tokenize(guest.guestName);
    const overlap = queryTokens.filter((t) => guestTokens.includes(t)).length;

    if (overlap === 0) return;

    const allTokensFound = queryTokens.every((t) => guestTokens.includes(t));
    if (!allTokensFound) return;

    const currentScore = matchedGroups.get(guest.invitationGroup) || 0;
    if (overlap > currentScore) {
      matchedGroups.set(guest.invitationGroup, overlap);
    }
  });

  const groupNames = [...matchedGroups.keys()];

  if (groupNames.length === 0) {
    return { matches: [] };
  }

  if (groupNames.length > 1) {
    return {
      ambiguous: true,
      options: groupNames
    };
  }

  return buildInvitationResponse(groupNames[0], data);
}

async function getInvitationByGroup(sheets, groupName) {
  const data = await getGuestsData(sheets);
  return buildInvitationResponse(groupName, data);
}

function buildEventSummaryForEmail(payload) {
  const guests = payload && Array.isArray(payload.guests) ? payload.guests : [];
  const groupedByEvent = {};

  RESPONSE_EVENT_COLUMNS.forEach((eventName) => {
    groupedByEvent[eventName] = [];
  });

  guests.forEach((guest) => {
    const guestName = guest && guest.guestName ? guest.guestName : 'Guest';
    const rsvps = guest && guest.rsvps ? guest.rsvps : {};

    RESPONSE_EVENT_COLUMNS.forEach((eventName) => {
      const response = rsvps[eventName];
      if (!response) return;

      groupedByEvent[eventName].push({
        guestName,
        response,
        mealChoice: guest.mealChoice || '',
        hospitalityNeeded: guest.hospitalityNeeded || ''
      });
    });
  });

  return RESPONSE_EVENT_COLUMNS
    .filter((eventName) => groupedByEvent[eventName] && groupedByEvent[eventName].length > 0)
    .map((eventName) => ({
      eventName,
      displayName: displayEventNameForEmail(eventName),
      entries: groupedByEvent[eventName]
    }));
}

function buildConfirmationEmailText(payload) {
  const lines = [];
  lines.push('Thank you for your RSVP!');
  lines.push(`Wedding website: raquelandaaron.com (${WEDDING_WEBSITE_URL})`);

  if (payload && payload.invitationGroup) {
    lines.push(`Invitation: ${payload.invitationGroup}`);
  }

  if (payload && payload.websitePassword) {
    lines.push(`Wedding website password: ${payload.websitePassword}`);
  }

  const eventSummaries = buildEventSummaryForEmail(payload);
  if (eventSummaries.length > 0) {
    lines.push('');
    lines.push('RSVPs by event:');

    eventSummaries.forEach((eventSummary) => {
      lines.push('');
      lines.push(`${eventSummary.displayName}:`);

      eventSummary.entries.forEach((entry) => {
        let detail = entry.response;
        if (isWeddingEventName(eventSummary.eventName) && entry.response === 'Attending' && entry.mealChoice) {
          detail += ` | Meal: ${entry.mealChoice}`;
        }
        if (isFridayEventName(eventSummary.eventName) && entry.hospitalityNeeded) {
          detail += ` | Home hospitality needed: ${entry.hospitalityNeeded}`;
        }

        lines.push(`- ${entry.guestName}: ${detail}`);
      });
    });
  }

  if (payload && payload.message) {
    lines.push('');
    lines.push(`Message: ${payload.message}`);
  }

  return lines.join('\n');
}

function buildConfirmationEmailHtml(payload) {
  const html = [];
  html.push('<!doctype html>');
  html.push("<html><body style=\"margin:0;padding:24px;background:#fffaf8;color:#33272a;font-family:'Helvetica Neue', Arial, sans-serif;\">");
  html.push('<div style="max-width:700px;margin:0 auto;">');
  html.push('<p style="margin:0 0 12px;">Thank you for your RSVP!</p>');

  html.push('<div style="background:#ffffff;border:1px solid #ddd0cf;border-radius:8px;padding:16px;margin:0 0 16px;">');
  html.push(`<p style="margin:0 0 10px;"><strong>Wedding website:</strong> <a href="${WEDDING_WEBSITE_URL}" style="color:#5f4448;text-decoration:underline;">raquelandaaron.com</a></p>`);

  if (payload && payload.websitePassword) {
    html.push(`<p style="margin:0 0 12px;"><strong>Website password:</strong> <span style="display:inline-block;background:#f3e9e8;border:1px solid #ddd0cf;border-radius:6px;padding:3px 8px;">${payload.websitePassword}</span></p>`);
  }

  html.push('</div>');

  if (payload && payload.invitationGroup) {
    html.push(`<p style="margin:0 0 16px;"><strong>Invitation:</strong> ${payload.invitationGroup}</p>`);
  }

  buildEventSummaryForEmail(payload).forEach((eventSummary) => {
    html.push('<div style="border:1px solid #ddd0cf;border-radius:8px;padding:14px 16px;margin:0 0 12px;background:#ffffff;">');
    html.push(`<h3 style="margin:0 0 10px;font-size:17px;font-weight:600;">${eventSummary.displayName}</h3>`);
    html.push('<ul style="margin:0;padding-left:18px;">');

    eventSummary.entries.forEach((entry) => {
      const details = [entry.response];
      if (isWeddingEventName(eventSummary.eventName) && entry.response === 'Attending' && entry.mealChoice) {
        details.push(`Meal: ${entry.mealChoice}`);
      }
      if (isFridayEventName(eventSummary.eventName) && entry.hospitalityNeeded) {
        details.push(`Home hospitality needed: ${entry.hospitalityNeeded}`);
      }
      html.push(`<li style="margin:0 0 6px;"><strong>${entry.guestName}:</strong> ${details.join(' | ')}</li>`);
    });

    html.push('</ul>');
    html.push('</div>');
  });

  if (payload && payload.message) {
    html.push('<div style="border:1px solid #ddd0cf;border-radius:8px;padding:14px 16px;margin:0 0 12px;background:#ffffff;">');
    html.push('<p style="margin:0 0 8px;font-weight:600;">Message or questions for the couple</p>');
    html.push(`<p style="margin:0;white-space:pre-wrap;">${payload.message}</p>`);
    html.push('</div>');
  }

  html.push('</div>');
  html.push('</body></html>');
  return html.join('');
}

async function trySendConfirmationEmails(payload) {
  if (!SEND_CONFIRMATION_EMAILS) {
    return { attempted: false, sent: 0, reason: 'disabled' };
  }

  const mailer = getMailer();
  if (!mailer) {
    return { attempted: true, sent: 0, reason: 'smtp_not_configured' };
  }

  const submittedEmail = normalizeSubmittedEmail(payload && payload.email);
  const recipients = dedupeEmails([submittedEmail, ...CONFIRMATION_EMAIL_RECIPIENTS]);

  if (recipients.length === 0) {
    return { attempted: true, sent: 0, reason: 'no_recipients' };
  }

  try {
    const subject = CONFIRMATION_EMAIL_SUBJECT;
    const html = buildConfirmationEmailHtml(payload);
    const text = buildConfirmationEmailText(payload);

    await Promise.all(
      recipients.map((to) =>
        mailer.sendMail({
          from: `${CONFIRMATION_EMAIL_SENDER_NAME} <${process.env.SMTP_USER}>`,
          to,
          subject,
          text,
          html
        })
      )
    );

    return { attempted: true, sent: recipients.length };
  } catch (err) {
    console.error('Failed to send RSVP confirmation emails', err);
    return { attempted: true, sent: 0, error: err.message };
  }
}

async function submitRsvp(sheets, payload) {
  if (!payload || !Array.isArray(payload.guests) || payload.guests.length === 0) {
    throw new Error('No guest RSVPs provided');
  }

  const expectedHeader = RESPONSE_FIXED_COLUMNS.concat(RESPONSE_EVENT_COLUMNS, RESPONSE_TRAILING_COLUMNS);
  const header = await ensureResponsesHeader(sheets, expectedHeader);

  const allRows = await readRange(sheets, `${RESPONSES_SHEET_NAME}!A:ZZ`);
  const guestIdCol = header.indexOf('GuestID');

  const existingRowByGuestId = new Map();
  for (let i = 1; i < allRows.length; i += 1) {
    const row = allRows[i];
    const guestId = String(row[guestIdCol] || '');
    if (guestId) {
      existingRowByGuestId.set(guestId, i + 1);
    }
  }

  const now = new Date().toISOString();
  const submittedEmail = payload.email || '';
  const message = payload.message || '';

  for (const guestRsvp of payload.guests) {
    const row = new Array(header.length).fill('');
    row[header.indexOf('Timestamp')] = now;
    row[header.indexOf('GuestID')] = guestRsvp.guestId;
    row[header.indexOf('GuestName')] = guestRsvp.guestName || '';
    row[header.indexOf('InvitationGroup')] = payload.invitationGroup || '';

    RESPONSE_EVENT_COLUMNS.forEach((eventName) => {
      const response = (guestRsvp.rsvps && guestRsvp.rsvps[eventName]) || '';
      const colIndex = header.indexOf(eventName);
      if (colIndex !== -1) {
        row[colIndex] = response;
      }
    });

    row[header.indexOf('Email')] = submittedEmail;
    row[header.indexOf('MealChoice')] = guestRsvp.mealChoice || '';
    row[header.indexOf('HospitalityNeeded')] = guestRsvp.hospitalityNeeded || '';
    row[header.indexOf('Message')] = message;

    const existingRowNumber = existingRowByGuestId.get(String(guestRsvp.guestId));

    if (existingRowNumber) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${RESPONSES_SHEET_NAME}!A${existingRowNumber}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [row]
        }
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${RESPONSES_SHEET_NAME}!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [row]
        }
      });
    }
  }
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/', async (req, res) => {
  try {
    const action = req.query.action;
    const sheets = getSheetsClient();

    if (action === 'search') {
      const response = await searchGuests(sheets, req.query.name || '');
      res.json(response);
      return;
    }

    if (action === 'byGroup') {
      const response = await getInvitationByGroup(sheets, req.query.group || '');
      res.json(response);
      return;
    }

    res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('GET failed', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.post('/', async (req, res) => {
  try {
    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const submittedEmail = normalizeSubmittedEmail(payload && payload.email);
    if (!submittedEmail) {
      throw new Error('A valid email address is required.');
    }

    const submittedWebsitePassword = String((payload && payload.websitePassword) || '').trim();
    if (!submittedWebsitePassword) {
      throw new Error('A website password is required.');
    }

    payload.email = submittedEmail;
    payload.websitePassword = submittedWebsitePassword;

    const sheets = getSheetsClient();
    await submitRsvp(sheets, payload);
    const emailStatus = await trySendConfirmationEmails(payload);

    res.json({
      success: true,
      websitePassword: payload.websitePassword,
      emailStatus
    });
  } catch (err) {
    console.error('POST failed', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`wedding-rsvps-backend listening on ${port}`);
});
