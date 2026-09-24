# FMS Operations

FMS Operations is a standalone job card system that replaces the "FIR Card – Work Capture FMS" Google Sheet and Google Form.
It does not use or modify the ServiceDesk / Job Cards app.

It is two **separate projects**. Each has its own `package.json`, dependencies, configuration and start command.

```
fms-operations/
├── backend/    API only: Node 26 + Express 5 + MongoDB (Atlas)                 → http://localhost:4600/api
├── frontend/   Web UI:  React 19 + Vite + TypeScript                           → http://localhost:5600
└── docs/DESIGN.md   Data model, import mapping, workflow, roles, screens, API
```

The frontend calls the backend over HTTP (`/api`). The two share no code. You can run and deploy them independently, on the same machine or on different servers.

## Requirements

- Node.js **22.18 or later** (developed on 26).
- A **MongoDB Atlas** cluster for each environment. The free tier is enough.

Everything is stored in MongoDB: job cards with their stage history, users, masters, activity, import batches, and the **photos** (in GridFS). Nothing is kept on the server's disk, so it runs on hosts without persistent storage, such as Render's free plan.

## Two databases: Local (testing) and Live (real data)

| | Local – for testing | Live – real data |
|---|---|---|
| Database (in `backend/.env`) | `MONGODB_URI_LOCAL` | `MONGODB_URI_LIVE` |
| Backend | `npm start` → http://localhost:4600 | `npm run start:live` → http://localhost:4700 |
| Frontend | `npm run dev` → **http://localhost:5600** | `npm run dev:live` → **http://localhost:5700** |
| Badge in the app | yellow **LOCAL – test data** | none |

- Use a separate Atlas cluster for Local, or at least a separate database name, so nothing you do in Local reaches Live. You can run both at the same time.
- **Atlas setup:** under **Network Access**, allow your IP. For Render, allow `0.0.0.0/0`, because Render's free plan has no fixed IP.
- To refresh Local with a copy of Live, run `npm run copy-live-to-local` in `backend`. Live is only read, never changed.

### Moving the old SQLite data into MongoDB (one time)

Earlier versions stored data in `backend/data/<env>/fms.db`. To move it into MongoDB, including photos:

```powershell
cd "C:\Users\my\service desk\fms-operations\backend"
npm run migrate:sqlite:live     # data/live/fms.db  → Live cluster  (MONGODB_URI_LIVE)
npm run migrate:sqlite          # data/local/fms.db → Local cluster (MONGODB_URI_LOCAL)
```

The SQLite files are only read, so keep them as a backup. The migration refuses to overwrite a MongoDB database that already has data unless you add `-- --force`.

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
| `npm run migrate:sqlite` / `npm run migrate:sqlite:live` | One-time move of old SQLite data into MongoDB |

To back up the real data, use Atlas backups (cluster → **Backup**) or `mongodump` with the Live connection string.

## Frontend commands (`frontend/`)

| Command | What it does |
|---|---|
| `npm run dev` / `npm run dev:live` | UI for Local (5600 → API 4600) / Live (5700 → API 4700) |
| `npm run build` | Production build into `frontend/dist/` |
| `npm start` / `npm run start:live` | Build, then serve the production build for Local / Live |

## Settings: one file, `backend/.env`

All backend settings live in **`backend/.env`**. The file is git-ignored, so the passwords never reach GitHub.

```ini
MONGODB_URI_LIVE=mongodb+srv://…   # real data  (npm run start:live, …:live commands)
MONGODB_URI_LOCAL=mongodb+srv://…  # testing    (npm start, npm run dev, …)
JWT_SECRET=…                       # login session key
ADMIN_PASSWORD=…                   # first "admin" password (only used when the database has no users)
```

- The frontend needs no env file.
- Optional extras: `PORT`, `SESSION_HOURS`, `FRONTEND_URL`, `COOKIE_SAMESITE`, `SECURE_COOKIES`, `TRUST_PROXY`.

## Deploying: backend on Render, frontend on Vercel

**Render (backend).** Create a Web Service with these settings:
- Root Directory `backend`
- Build `npm ci`
- Start `npm run start:live`
- Environment: **Add from .env**, and paste `backend/.env`

No disk is needed. Render sets `RENDER=true`, so the app turns on secure cookies and the proxy settings by itself.

**Vercel (frontend).** Import the repo with Root Directory `frontend`; no environment variables are needed. [frontend/vercel.json](frontend/vercel.json) forwards `/api/*` to the Render backend, so the browser sees one site. Edit the backend URL in that file if your Render address differs.

**Atlas.** Under **Network Access**, allow `0.0.0.0/0`, because Render has no fixed IP on the free plan.

## Workflow

```
Job Card raised (public form / app, image compulsory)
  → Triage & Approval (Process Coordinator) → Site Visit → [Project Head Discussion] → [Material] → Requester Informed
  → [Permission] → Engineer Assigned → Work Started → Work Completed (photo evidence compulsory)
  → Verification → Closed (Process Coordinator only)
```

Stages in `[ ]` are optional. The Process Coordinator decides whether they apply at Triage. The SLA rules follow the FMS sheet: Sunday is not a working day, and you can edit the rules in **Masters → Workflow & SLA**.
