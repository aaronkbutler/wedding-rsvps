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

| GuestID | InvitationGroup                | GuestName     | Welcome Party | Ceremony & Reception |
|---------|---------------------------------|---------------|---------------|-----------------------|
| 1       | Raquel Cohen and Aaron Butler    | Raquel Cohen  | TRUE          | TRUE                  |
| 2       | Raquel Cohen and Aaron Butler    | Aaron Butler  | TRUE          | TRUE                  |
| 3       | The Smith Family                 | Jane Smith    | FALSE         | TRUE                  |

- `GuestID` must be unique per guest (row).
- `InvitationGroup` should be identical for everyone on the same invitation
  — this is what ties Raquel and Aaron together.
- Add one column per event after `GuestName`. Column headers become the
  event names shown to guests. Use `TRUE`/`FALSE` to control who is invited
  to what. You can add or rename event columns at any time without touching
  the code.

### `Responses` tab

Leave this tab empty except you may optionally add a header row matching:
`Timestamp | GuestID | GuestName | InvitationGroup | <event columns...> | MealChoice | Message`.
The script will create this header automatically the first time someone
submits an RSVP if the tab is empty.

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
