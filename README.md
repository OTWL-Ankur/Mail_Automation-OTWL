# Mail-to-Job Backend (Gmail + PostgreSQL)

Backend-only starter for a dedicated Google Workspace mailbox. It polls Gmail history, creates one Job per distinct incoming inbox email, parses `Label: value` lines from the email body, saves every supported attachment to local server storage, and records file paths in PostgreSQL. OCR is intentionally not included yet.

## Important behavior

- The first run establishes a Gmail history checkpoint. By default, existing mail is **not imported** (`GMAIL_IMPORT_EXISTING=false`); new messages after startup are processed. Set it to `true` to import the current inbox on first startup.
- Local development uses Gmail API history polling every 60 seconds, not Pub/Sub. This avoids requiring a public HTTPS endpoint while developing on Windows. Later, deploy to a reachable server and switch to Gmail push notifications + Pub/Sub if desired. The history checkpoint and duplicate constraint are retained for recovery.
- The OAuth user must be the dedicated mailbox itself. Super Admin access alone does not automatically authorize the application to read a different user's Gmail. For one mailbox, local OAuth is simpler and least-privilege. Do not set up domain-wide delegation unless there is a clear need to impersonate users.
- Attachments are stored under `STORAGE_ROOT/<year>/<month>/<JobId>/`. PostgreSQL stores relative paths, not public filesystem paths.
- This is a development starter. Before production, add authenticated API access, HTTPS, stricter attachment MIME/size policy, backup/retention policy, and deployment-grade secret management.

## 1. Prerequisites

- Node.js 22 LTS (or a currently supported LTS version) and npm.
- PostgreSQL running locally or reachable from this computer.
- Permission to create the `MailToJob` database and tables, or a DBA who can create the database and run `sql/schema.sql`.
- Google Workspace access to the dedicated mailbox.
- Google Workspace Super Admin access for setting up the Cloud project if organization policy requires admin approval.

## 2. Create the Google Cloud project

1. Open https://console.cloud.google.com/ and sign in with your company Google Workspace administrator account.
2. Create a project, for example `mail-to-job-dev`.
3. Select the project from the project selector.
4. Go to **APIs & Services → Library** and enable **Gmail API**.
5. Open **Google Auth Platform**. If prompted, click **Get started**.
6. Set an app name such as `Mail-to-Job Local Development`, add a support email and developer contact email.
7. Because this is for your own Workspace organization, select **Internal** audience if that option is available. If Google does not offer Internal, stop and check with your Workspace admin before choosing External.
8. Go to **Google Auth Platform → Clients → Create Client**.
9. Choose **Desktop app**, create the OAuth client, and download its JSON file.
10. Put that file in this project root and name it `credentials.json`. Do not commit it or share it in chat.
11. If Workspace app access controls block the OAuth client, have the Workspace administrator review/allow the internal app under **Security → Access and data control → API controls → App access control**.

Official guide: https://developers.google.com/workspace/gmail/api/quickstart/nodejs

## 3. Set up PostgreSQL

1. Create a PostgreSQL database named `MailToJob` (or choose another name and set `DB_DATABASE` accordingly).
2. Connect to that database with `psql` or a PostgreSQL client and execute `sql/schema.sql`.
3. Create a dedicated database role for this application and grant it access to the database and tables. Do not use a superuser in `.env`.
4. Copy `.env.example` to `.env` and fill `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USER`, and `DB_PASSWORD`. Alternatively, set `DATABASE_URL` to a PostgreSQL connection URL.

Set `DB_SSL=true` when the PostgreSQL server requires TLS. The application verifies the server certificate. If you use `DATABASE_URL`, PostgreSQL connection URL SSL settings are also supported.

## 4. Configure environment

In PowerShell, from the project directory:

```powershell
Copy-Item .env.example .env
```

Edit `.env`:

- `GMAIL_MAILBOX`: exact primary email address of the dedicated mailbox.
- `GMAIL_IMPORT_EXISTING=false`: process only emails arriving after the first baseline. Set to `true` only if you intentionally want to import all current Inbox messages on the first run.
- `STORAGE_ROOT=./storage`: attachment root directory. The app creates it automatically.
- PostgreSQL variables: use your real connection settings. The default port is `5432`.

The Gmail account authorized in the browser must exactly match `GMAIL_MAILBOX`.

## 5. Install and authorize Gmail

```powershell
npm install
npm run auth:gmail
```

A browser window opens. Sign in as the dedicated mailbox and approve read-only Gmail access. The app writes `token.json`. Keep `credentials.json`, `token.json`, and `.env` private; they are excluded by `.gitignore`.

The application uses the read-only Gmail scope and does not send, delete, label, or modify messages.

## 6. Run the backend

```powershell
npm run dev
```

Expected behavior:
- Express listens on `http://localhost:3000`.
- Gmail sync runs immediately and then every `GMAIL_POLL_INTERVAL_MS` (default 60 seconds).
- First startup saves a history baseline. Unless `GMAIL_IMPORT_EXISTING=true`, existing messages are not imported.
- New Inbox messages create a Job and EmailMessages record. Attachments are saved to disk and indexed in DocumentFiles.

Test health:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

List jobs:

```powershell
Invoke-RestMethod 'http://localhost:3000/api/jobs?limit=50&offset=0'
```

Get a job and its email fields/documents:

```powershell
Invoke-RestMethod http://localhost:3000/api/jobs/1
```

Preview/download a stored document in a browser:

`http://localhost:3000/api/documents/1/content`

These endpoints are not authenticated in this development starter. Do not expose the service to the internet before adding authentication and HTTPS.

## 7. Email format parsing

The starter recognizes simple `Label: value` lines and stores each parsed line in `EmailFields`. It maps common aliases into the Jobs table, including:

```text
Shipment Type: Sea Freight
Client Name: ABC Imports
Client Reference: ABC-2026-1042
Invoice Number: INV-1042
Origin: Shanghai
Destination: Mumbai
```

The original body is retained in `EmailMessages`. If a field is not recognized or is missing, the original email is still retained; update `mapJobFields` in `src/services/ingestion.service.ts` when the agreed email template is finalized.

## 8. Reliability notes

- Gmail history is used to discover messages. The sync checkpoint advances only after discovered messages are processed successfully.
- Gmail message ID is unique in PostgreSQL, and attachment records are idempotent by email + Gmail attachment ID.
- If Gmail history expires, the app reconciles the full Inbox. This can take time for a large mailbox.
- File writes use a temporary `.part` file and rename before the DB metadata insert.
- If metadata insertion fails, the newly written file is removed. If the process crashes between file write and DB insert, a possible orphan file may remain; a production cleanup job should reconcile files against PostgreSQL.
- Only Inbox messages are processed. Messages outside Inbox are ignored even if Gmail sends a history notification for them.
- No OCR is implemented. Each attachment starts with `OcrStatus = NotProcessed`.

## 9. Useful commands

```powershell
npm run typecheck
npm run build
npm start
```
