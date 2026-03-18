# DBVault

> ISO 9001 · Multi-project MySQL backup & restore standard  
> Google Apps Script · Railway · Google Drive · Aiven MySQL

---

## What this is

DBVault is a production-grade database backup system that:

- Dumps every configured MySQL database **3× per day** using `mysqldump` natively
- Stores compressed `.sql.gz` files in **Google Drive**, organised by project and database
- Restores the latest dump to a `*_backup` database **2× per day** automatically
- Exposes a **web restore panel** to manually restore any historical dump with one click
- Manages **unlimited projects** from a single Google Sheet registry

---

## Architecture

```
Google Sheet (config + registry)
        │
        │  schedule trigger
        ▼
Google Apps Script ──── POST /dump ──────► Railway Service
        │                                       │
        │  web UI                               │  mysqldump (native)
        ▼                                       │
  Restore Panel                                 ▼
                                        Google Drive
                                     /PROJECT/db/file.sql.gz
                                           │
                                    POST /restore
                                           │
                                           ▼
                                    MySQL *_backup DB
```

| Component | Technology | Role |
|-----------|-----------|------|
| Config & registry | Google Sheet | One row per project, one row per database |
| Scheduler | Apps Script time triggers | Fires at 04:00 / 12:00 / 20:00 |
| Dump & restore engine | **This repo** — Railway service | Runs `mysqldump` natively, no time limit |
| File storage | Google Drive | Auto-organised: `/PROJECT/db_name/file.sql.gz` |
| Secrets | Apps Script Properties + Railway env | AES-256, never in code |
| UI | Apps Script Web App | Dark restore panel — pick project, DB, dump |

---

## Repository structure

```
dbvault/
├── railway/              ← Node.js service deployed to Railway
│   ├── server.js         ← Express webhook (POST /dump, /restore, /list-dumps)
│   ├── dumper.js         ← mysqldump → gzip → Google Drive stream
│   ├── restorer.js       ← Drive download → gunzip → mysql stream
│   ├── drive.js          ← Google Drive API (service account)
│   ├── logger.js         ← Winston logger
│   ├── package.json
│   └── Dockerfile
├── apps-script/          ← Copy these files into Google Apps Script editor
│   ├── 00_Config.gs
│   ├── 01_SheetSetup.gs
│   ├── 02_Menu.gs
│   ├── 03_Init.gs
│   ├── 04_Dump.gs
│   ├── 05_Restore.gs
│   ├── 06_Triggers.gs
│   ├── 07_WebApp.gs
│   ├── 08_Utils.gs
│   └── RestoreUI.html
├── .github/
│   └── workflows/
│       └── deploy.yml    ← Auto-deploy to Railway on push to main
├── .env.example          ← Environment variable template
├── railway.toml          ← Railway deployment config
└── README.md
```

---

## Quick start

### 1 · Fork or clone this repo

```bash
git clone https://github.com/YOUR_ORG/dbvault.git
cd dbvault
```

### 2 · Set up Railway

1. Create a new project at [railway.app](https://railway.app)
2. Connect your GitHub repo — Railway auto-deploys on push to `main`
3. Set the required environment variables (see below)

### 3 · Set up Google Apps Script

1. Go to [script.google.com](https://script.google.com) → New project → name it `DBVault_Master`
2. Copy each file from `apps-script/` into a corresponding tab in the editor
3. Copy `RestoreUI.html` as an HTML file
4. Edit `00_Config.gs` — fill in `SHEET_ID`, `GDRIVE_ROOT_ID`, `ALERT_EMAIL`
5. Add Script Properties (editor → Project Settings → Script Properties):

| Property | Value |
|----------|-------|
| `RAILWAY_URL` | Your Railway app URL |
| `WEBHOOK_SECRET` | Same secret as Railway env var |

6. Run `setupSheets()` from the editor
7. Deploy as Web App (Deploy → New deployment → Web App)

### 4 · Add your first project

1. Add a row to the **Projects** sheet tab
2. Add rows to the **Databases** sheet tab
3. Click the row → `⚙️ DBVault` menu → **Init selected project row**
4. Run the generated SQL on your MySQL server
5. Set STATUS = `OK`
6. `⚙️ DBVault` → **Install / refresh triggers**

---

## Environment variables

### Railway service

Set these in your Railway project dashboard:

| Variable | Required | Description |
|----------|----------|-------------|
| `WEBHOOK_SECRET` | ✅ | Long random string — must match Apps Script property |
| `GOOGLE_SERVICE_ACCOUNT` | ✅ | Full JSON of a Google service account with Drive access |
| `PORT` | auto | Set automatically by Railway |
| `LOG_LEVEL` | optional | `info` (default) / `debug` / `warn` |

### Getting a Google service account

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project (or use existing)
3. Enable the **Google Drive API**
4. IAM & Admin → Service Accounts → Create service account
5. Create a JSON key → download it
6. Paste the **entire JSON content** as the `GOOGLE_SERVICE_ACCOUNT` env var on Railway
7. Share your Google Drive folder with the service account email (Editor access)

---

## Security model

| User | Pattern | Can do | Cannot do |
|------|---------|--------|-----------|
| Dump user | `PROJECT_DUMP_production` | SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES, REFERENCES, SHOW_ROUTINE, PROCESS | Write, modify, delete anything |
| Restore user | `PROJECT_RESTORE_backup` | ALL on `*_backup` databases | Touch any production database |

Passwords are generated randomly (24 chars) and stored encrypted in Apps Script Properties. Never in code, never in the Sheet.

---

## API endpoints

The Railway service exposes three endpoints, all protected by `x-dbvault-secret` header.

### `POST /dump`
Starts a dump job asynchronously. Returns immediately — dump runs in background.

```json
{
  "project":      "ACME",
  "dbName":       "catalog_db",
  "host":         "mysql-xxx.aivencloud.com",
  "port":         12345,
  "user":         "ACME_DUMP_production",
  "password":     "...",
  "gdriveRootId": "1A2B3C..."
}
```

### `POST /restore`
Restores a dump synchronously. Waits for completion before responding.

```json
{
  "project":      "ACME",
  "dbName":       "catalog_db",
  "host":         "mysql-xxx.aivencloud.com",
  "port":         12345,
  "user":         "ACME_RESTORE_backup",
  "password":     "...",
  "gdriveRootId": "1A2B3C...",
  "fileId":       "latest"
}
```

### `POST /list-dumps`
Returns available dump files for a project/database.

```json
{
  "project":      "ACME",
  "dbName":       "catalog_db",
  "gdriveRootId": "1A2B3C..."
}
```

### `GET /health`
Returns service status. No auth required.

---

## ISO 9001 onboarding checklist

### Master setup (once)
- [ ] Repo forked/cloned and Railway project created
- [ ] Railway environment variables set
- [ ] GitHub Actions workflow connected — auto-deploy working
- [ ] Apps Script project created, all files pasted in
- [ ] `00_Config.gs` filled in (SHEET_ID, GDRIVE_ROOT_ID, ALERT_EMAIL)
- [ ] Script Properties set (RAILWAY_URL, WEBHOOK_SECRET)
- [ ] `setupSheets()` run — three tabs created
- [ ] Web App deployed — URL shared with team
- [ ] `/health` endpoint verified

### Per project
- [ ] Row added to Projects tab
- [ ] Database rows added to Databases tab  
- [ ] `initProject()` run — SQL file in Drive
- [ ] SQL executed on MySQL server as root
- [ ] SQL file deleted from Drive
- [ ] Passwords saved in password manager
- [ ] STATUS set to OK
- [ ] Triggers installed/refreshed
- [ ] Manual dump tested — file appears in Drive
- [ ] Manual restore tested via Web UI
- [ ] Alert email verified

---

## License

MIT — see [LICENSE](LICENSE)
