# FMS Operations

FMS Operations is a standalone job card system that replaces the "FIR Card – Work Capture FMS" Google Sheet and Google Form.
It does not use or modify the ServiceDesk / Job Cards app.

It is two **separate projects**. Each has its own `package.json`, dependencies, configuration and start command.

```
fms-operations/
├── backend/    API only: Node 26 + Express 5 + SQLite (built-in node:sqlite)   → http://localhost:4600/api
├── frontend/   Web UI:  React 19 + Vite + TypeScript                           → http://localhost:5600
└── docs/DESIGN.md   Data model, import mapping, workflow, roles, screens, API
```

The frontend calls the backend over HTTP (`/api`). The two share no code. You can run and deploy them independently, on the same machine or on different servers.

## Requirements

Node.js **22.18 or later** (developed on 26). No database server or native builds are needed.

## Two databases: Local (testing) and Live (real data)

| | Local – for testing | Live – real data |
|---|---|---|
| Database | `backend/data/local/fms.db` | `backend/data/live/fms.db` |
| Backend | `npm start` → http://localhost:4600 | `npm run start:live` → http://localhost:4700 |
| Frontend | `npm run dev` → **http://localhost:5600** | `npm run dev:live` → **http://localhost:5700** |
| Badge in the app | yellow **LOCAL – test data** | none |

Each has its own job cards, photos, users and login secret, so nothing you do in Local reaches Live. You can run both at the same time.

To refresh Local with a fresh copy of Live, stop the local backend and run `npm run copy-live-to-local` in `backend`. Live is only read, never changed.

## Run

Start the backend first, then the frontend, each in its own terminal. Run `npm install` once in each folder the first time.

```powershell
# LOCAL (testing)
cd "C:\Users\my\service desk\fms-operations\backend";  npm start
cd "C:\Users\my\service desk\fms-operations\frontend"; npm run dev          # open http://localhost:5600

# LIVE (real data)
cd "C:\Users\my\service desk\fms-operations\backend";  npm run start:live
cd "C:\Users\my\service desk\fms-operations\frontend"; npm run dev:live     # open http://localhost:5700
```

- Staff sign in at `/login`.
- The public Job Card-Work Capture Form is at `/submit`.

**Logins:** `admin` / `Admin@12345` (you'll be asked to change it on first sign-in). The demo users `coordinator`, `projecthead`, `approver`, `store`, `kuldeep`, `viewer` and `requester` use `Welcome@123`. Passwords are stored per database: changing one in Local does not change it in Live.

## Backend commands (`backend/`)

| Command | What it does |
|---|---|
| `npm start` / `npm run start:live` | Start the API on Local (4600) / Live (4700) |
| `npm run dev` | Start the Local API and restart it when code changes |
| `npm test` | End-to-end tests on a temporary database (never touches Local or Live) |
| `npm run seed` / `npm run seed:live` | Create the demo users in Local / Live |
| `npm run import:cli -- "C:\path\file.tsv"` | Dry run in Local (use `import:cli:live` for Live) |
| `npm run import:cli -- "C:\path\file.tsv" --commit` | Import it (rows already imported are skipped) |
| `npm run copy-live-to-local` | Replace Local test data with a copy of Live |

To back up the real data, copy `backend/data/live/`.

## Frontend commands (`frontend/`)

| Command | What it does |
|---|---|
| `npm run dev` / `npm run dev:live` | UI for Local (5600 → API 4600) / Live (5700 → API 4700) |
| `npm run build` | Production build into `frontend/dist/` |
| `npm start` / `npm run start:live` | Build, then serve the production build for Local / Live |

## Deploying on separate servers

**Frontend.** Build it pointing at the API, then host `frontend/dist/` on any static web server. Configure the server to fall back to `index.html` for unknown paths, so app routes load.

```bash
VITE_API_URL=https://fms-api.example.com npm run build
```

**Backend.** Allow the frontend's origin. Cross-site cookies need HTTPS.

```bash
CORS_ORIGINS=https://fms.example.com COOKIE_SAMESITE=none SECURE_COOKIES=true FRONTEND_URL=https://fms.example.com npm start
```

If both are served under one domain through a reverse proxy (for example `/` → frontend and `/api` → backend), you need no CORS settings and can keep the default cookie settings.

| Backend env var | Default | Purpose |
|---|---|---|
| `PORT` | `4600` | API port |
| `FRONTEND_URL` | `http://localhost:5600` | Where the UI runs |
| `FMS_ENV` | `local` | `local` or `live` (set by the npm scripts) |
| `FMS_DATA_DIR` | `backend/data/<env>` | Database, uploads and import staging |
| `JWT_SECRET` | generated & stored in the data dir | Session signing key |
| `ADMIN_PASSWORD` | `Admin@12345` | Initial admin password (first start only) |
| `SESSION_HOURS` | `12` | Session length |
| `CORS_ORIGINS` | — | Comma-separated frontend origins when hosted on another domain |
| `COOKIE_SAMESITE` | `strict` | `none` for a cross-site frontend (requires HTTPS) |
| `SECURE_COOKIES` | `false` | `true` behind HTTPS |

| Frontend env var | Purpose |
|---|---|
| `VITE_API_PROXY` | Backend address used by `npm run dev` / `npm start` (default `http://localhost:4600`) |
| `VITE_API_URL` | Full API base URL baked into a production build hosted on a different domain |

## Workflow

```
Job Card raised (public form / app, image compulsory)
  → Triage & Approval (Process Coordinator) → Site Visit → [Project Head Discussion] → [Material] → Requester Informed
  → [Permission] → Engineer Assigned → Work Started → Work Completed (photo evidence compulsory)
  → Verification → Closed (Process Coordinator only)
```

Stages in `[ ]` are optional. The Process Coordinator decides whether they apply at Triage. The SLA rules follow the FMS sheet: Sunday is not a working day, and you can edit the rules in **Masters → Workflow & SLA**.
