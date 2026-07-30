# wedding-rsvps

An embeddable RSVP tool for a wedding website (e.g. Wix). Guests type their
name, it's matched against the invitation list, and they can RSVP per event
for everyone included on their invitation (e.g. searching "Aaron Butler"
also surfaces "Raquel Cohen" if the invite was addressed to both). Each
guest picks a meal option and the group can leave a shared message. All
responses are saved to a Google Sheet.

## How it works

- **Frontend**: `index.html` + `style.css` + `app.js` — a static page with
  no build step, hostable anywhere (e.g. GitHub Pages) and embeddable in
  Wix via an HTML iframe/embed element.
- **Backend**: `Code.gs` — a Google Apps Script Web App bound to a Google
  Sheet. It reads the guest list and writes RSVP responses, so there's no
  separate server to host or maintain.

## 1. Set up the Google Sheet

Create a new Google Sheet with two tabs:

### `Guests` tab

One row per invitation (household), covering one or more people:

| First Names      | Last Names          | Count | Fri night | Saturday | Sunday |
|-------------------|----------------------|-------|-----------|----------|--------|
| Raquel and Aaron  | Cohen and Butler     | 2     | 2         | 2        | 2      |
| Jane              | Smith                | 1     | 0         | 1        | 1      |

- **First Names**: everyone's first name on the invitation, joined with
  `and` (or commas), e.g. `Sharyn and Kenny`.
- **Second column** (title it however you like, e.g. the couple's own last
  names): last name(s) for the row. If there's a single last name, it's
  applied to everyone in the row (e.g. `Susan and Philip` / `Ben-Zvi` ->
  "Susan Ben-Zvi" and "Philip Ben-Zvi"). If there are multiple last names,
  they're paired positionally with the first names in the same order (e.g.
  `Sharyn and Kenny` / `Ben-Zvi and Unger` -> "Sharyn Ben-Zvi" and "Kenny
  Unger" — never a cross-product, so it won't also produce "Sharyn Unger").
- **Count**: total number of people on the invitation.
- Add one column per event after `Count`. Column headers become the event
  names shown to guests. Each cell holds the number of people from that row
  attending/invited to that event (`0` means nobody from the row).
- **Special case**: a `0` in the **Sunday** column means everyone on the
  invitation (the `Count` value) is invited/attending — Sunday is the main
  event and is assumed by default unless a different number is filled in.
  You can add more events to this "0 means everyone" list by editing
  `EVENTS_WHERE_ZERO_MEANS_EVERYONE` in `Code.gs`.
- If you need extra columns after the event columns for your own
  bookkeeping (e.g. `Zip Code`, `Invitation`), they won't be treated as
  events as long as their header is listed (case-insensitively) in
  `GUEST_LIST_NON_EVENT_COLUMNS` in `Code.gs`. This already includes common
  Google Forms address/bookkeeping columns (`Hospitality`, `Contact`,
  `First Line`, `Second Line`, `City/Town`, `State`,
  `And Family or Someone Else`, `Formatted Address`, `Print`, `Column 1`);
  add any others you use so they don't leak into the `Responses` tab.

### `Responses` tab

Leave this tab empty except you may optionally add a header row matching:
`Timestamp | GuestID | GuestName | InvitationGroup | <event columns...> | MealChoice | Message`.
The script creates this header automatically the first time someone
submits an RSVP if the tab is empty, and on every submission it removes any
column whose header isn't part of the expected list — so if a Guests-sheet
column ever gets mistakenly treated as an event (e.g. before it's added to
`GUEST_LIST_NON_EVENT_COLUMNS`), the stray column is cleaned up
automatically without editing the sheet by hand.

## 2. Add the Apps Script

1. In the Sheet, open **Extensions → Apps Script**.
2. Delete any starter code and paste the contents of [`Code.gs`](./Code.gs).
3. If you want different meal options, edit the `MEAL_OPTIONS` array at the
   top of the file (exactly two options are expected by the UI, but any
   number will render).
4. Click **Deploy → New deployment**.
   - Type: **Web app**.
   - Execute as: **Me**.
   - Who has access: **Anyone**.
5. Click **Deploy**, authorize the script when prompted, and copy the Web
   App URL (ends in `/exec`).

Whenever you edit `Code.gs`, create a **new deployment version** (or use
"Manage deployments → Edit → New version") for changes to take effect on
the existing URL.

## 3. Configure the frontend

Open `app.js` and set:

```js
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/XXXXXXX/exec';
```

to the URL you copied above.

## 4. Host the page

Any static host works. The simplest option is GitHub Pages:

1. Push this repo to GitHub (already done if you're reading this from the
   repo).
2. In the repo settings, enable **GitHub Pages** for the `main` branch
   (root folder).
3. Your page will be available at
   `https://<username>.github.io/wedding-rsvps/`.

## 5. Embed in Wix

1. In the Wix editor, add an **Embed → Embed a Widget → Custom Embed**
   (or "HTML iframe") element to your page.
2. Set the source to your hosted URL from step 4 (or paste the HTML/CSS/JS
   inline if Wix's embed only supports inline code — the page has no
   external dependencies besides `style.css` and `app.js`).
3. Resize the embed element to fit the widget (it's responsive, but give it
   enough height, e.g. 700–900px, to avoid internal scrollbars).

## Data flow summary

1. Guest types a name and clicks **Find My Invitation**.
2. The frontend calls the Apps Script `doGet` (`?action=search&name=...`),
   which token-matches the query against `GuestName` values and returns
   every guest sharing the same `InvitationGroup`. If the name matches more
   than one invitation, the guest is asked to disambiguate.
3. The frontend renders a card per guest with an Attending / Not Attending
   toggle for each event they're invited to, plus a meal dropdown, and one
   shared message box for the invitation.
4. On submit, the frontend `POST`s the responses (as `text/plain` to avoid
   a CORS preflight) to the Apps Script `doPost`, which upserts one row per
   guest into the `Responses` tab, keyed by `GuestID` — resubmitting
   updates the existing row instead of duplicating it.
