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

## Run (two terminals)

**Terminal 1 – backend**

```powershell
cd "C:\Users\my\service desk\fms-operations\backend"
npm install          # first time only
npm start            # API on http://localhost:4600
```

**Terminal 2 – frontend**

```powershell
cd "C:\Users\my\service desk\fms-operations\frontend"
npm install          # first time only
npm run dev          # UI on http://localhost:5600  (auto-reloads on code changes)
```

Open **http://localhost:5600**.

- Staff sign in at `/login`.
- The public Job Card-Work Capture Form is at `/submit`.

**Logins:** `admin` / `Admin@12345` (you'll be asked to change it on first sign-in). The demo users `coordinator`, `projecthead`, `approver`, `store`, `kuldeep`, `viewer` and `requester` use `Welcome@123`. They are created by `npm run seed` in `backend`.

## Backend commands (`backend/`)

| Command | What it does |
|---|---|
| `npm start` | Start the API (port 4600) |
| `npm run dev` | Start the API and restart it when code changes |
| `npm test` | End-to-end tests: full lifecycle, permissions, reports, FMS import |
| `npm run seed` | Create the demo users |
| `npm run import:cli -- "C:\path\file.tsv"` | Dry run: validate an FMS / Google Form export |
| `npm run import:cli -- "C:\path\file.tsv" --commit` | Import it (rows already imported are skipped) |

To back up, copy `backend/data/`. It holds `fms.db` and `uploads/`.

## Frontend commands (`frontend/`)

| Command | What it does |
|---|---|
| `npm run dev` | Development server on port 5600 (forwards `/api` to the backend) |
| `npm run build` | Production build into `frontend/dist/` |
| `npm start` | Build, then serve the production build on port 5600 (forwards `/api` to the backend) |

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
| `FMS_DATA_DIR` | `backend/data` | Database, uploads and import staging |
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
