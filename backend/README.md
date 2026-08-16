# Cloud Run backend for wedding-rsvps

This service is a drop-in replacement for the Apps Script backend.
It keeps the same API shape used by app.js:

- GET /?action=search&name=...
- GET /?action=byGroup&group=...
- POST / with RSVP payload JSON (or text/plain JSON)

## 1) Prerequisites

- A Google Cloud project with billing enabled
- A Google Sheet with tabs named Guests and Responses
- A service account with access to the spreadsheet
- Node 20+

## 2) Service account and sheet access

1. Create a service account in your GCP project.
2. Share the RSVP Google Sheet with the service account email as Editor.
3. Copy the spreadsheet ID from the sheet URL.
4. Use this service account as the Cloud Run runtime identity.
5. For local dev only, you may optionally create a JSON key and set GOOGLE_APPLICATION_CREDENTIALS_JSON.

## 3) Local run

```bash
cd backend
cp .env.example .env
# fill in .env values
npm install
npm start
```

Health check:

```bash
curl http://localhost:8080/healthz
```

Test search:

```bash
curl "http://localhost:8080/?action=search&name=rita"
```

## 4) Deploy to Cloud Run

Set env vars in your shell first, then run:

```bash
cd backend
cp cloudrun.env.yaml.example cloudrun.env.yaml
# fill in cloudrun.env.yaml values
chmod +x deploy-cloud-run.sh
./deploy-cloud-run.sh
```

At minimum, set:

- GOOGLE_CLOUD_PROJECT
- CLOUD_RUN_SERVICE_ACCOUNT

In `cloudrun.env.yaml`, set at minimum:

- GOOGLE_SHEETS_SPREADSHEET_ID

Optional SMTP vars enable confirmation emails.

If you use a different env file path, run:

```bash
ENV_VARS_FILE=your-file.yaml ./deploy-cloud-run.sh
```

## 5) Wire frontend

In app.js, replace APPS_SCRIPT_URL with your Cloud Run URL.

Example:

```js
const APPS_SCRIPT_URL = 'https://wedding-rsvps-backend-xxxxx-uc.a.run.app';
```

No other frontend changes are required.
