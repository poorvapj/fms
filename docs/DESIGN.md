# FMS Operations — Design

Standalone application for facility work requests. It replaces the Google-Sheet "FIR Card – Work Capture FMS".
It shares no code, database or runtime with the ServiceDesk / Job Cards application.

---

## 0. Findings from the supplied FMS export

File: `FIR  Card -Work Capture  FMS  - FMS.tsv` (tab separated, CRLF, 2,095 lines, 40 columns)

| Sheet row | Content |
|---|---|
| 1 | Export meta: `23/09/2026 10:31:19` (the "now" that the sheet used for running delays), plus helper numbers |
| 2 | Stage group names, placed over the first column of each stage block |
| 3 | **Who** is responsible for each stage |
| 4 | **How** it is done (Google Form, WhatsApp/Call, physically) |
| 5 | **When**, meaning the SLA rule |
| 6 | Step order (1st, 2nd, 3rd, 3rd(1), 4th … 7th) |
| 7 | Column headers |
| 8+ | 2,088 data rows (2022 → 2026) |

Stage blocks (1-based column numbers):

| # | Stage (sheet) | Cols | Who | When (SLA) | Verified against data |
|---|---|---|---|---|---|
| 1 | Site Visit | 7–11 (+Engg) | Site Engineer / Project Head | Next day 3 PM after request | ✔ 08/07 → 09/07 15:00 |
| 2 | Discussion with Project Head | 12–16 (+Engg) | Site Engineer | Same day 6 PM after Site Visit | ✔ |
| 3 | Material Update ("3rd(1)", optional) | 17–20 | Deepak Sir (Store) | +1 working day | ✔ Sunday skipped |
| 4 | Communicate to Problem Raised | 21–24 | PC Mam | Next day 10:00 AM | ✔ |
| 5 | Get Permission from Rahul Sir | 25–28 | PC Mam → Rahul Sir | Same day 11:00 AM | ✔ |
| 6 | Communicate to Engineer to Start | 29–32 | PC Mam | Same day 12:00 PM | ✔ |
| 7 | Work Completion | 33–36, **37 = Engg (no header)** | PC Mam | 7 working days after request | ✔ Sunday skipped |

Other columns: 1 Timestamp, 2 Property, 3 Work Category, 4 Work Completion Date (the requester's target date), 5 Image of Location (Drive URL, sometimes several URLs separated by commas), 6 Narration, 38 Image Link (completion evidence), 39 Remarks (Regarding Job Card), 40 Category By PC Mam (free-text closure note).

Data quality issues the importer handles:
* Status values `Yes / yes / YES / yee / yew / "Yes "` all mean done. A blank status next to a filled Actual is also treated as done, with a warning.
* Time Delay has the form `HHHH:MM:SS`. When Actual is blank, the sheet measured the delay up to the export time, so the value goes stale. It is **kept as raw legacy text**, and delay is recomputed from Planned and Actual.
* Recent rows often have blank Planned dates because the sheet formulas did not fill down. The importer can **derive them from the SLA rules**, and marks each derived date as *inferred*.
* Material Update has a Planned date in 499 rows but an Actual in only 1, even though later stages were completed. A stage like this, with no Actual while a later stage is done, is marked **Skipped (not recorded in FMS)** instead of being left pending.
* Engineer column values include `Hold` and `Other`, and names vary in case (`Kuldeep`/`kuldeep`). Names are normalised; `Hold` is recorded as a note, not as an engineer.
* `#VALUE!`, stray quote characters (line 1,735) and whitespace-only cells.
* "Category By PC Mam" holds a closure note ("Work done by Ritika", "Hold", "Wrong Complaint", "Service/Repair Complaint"). It maps to a closure category, and the original text is kept.
* Remarks such as "Confirm by Kuldeep Sir" mean the work was verified. They map to Verification, with the verifier's name.

---

## 1. Data model (MongoDB)

> Storage is MongoDB (Atlas). Each job card is one `requests` document with its workflow **stages embedded** (`requests.stages[]`); saves use optimistic concurrency (`version`). Other collections: `users`, `properties`, `work_categories`, `engineers`, `closure_categories`, `workflow_stages`, `request_events`, `attachments` (photos in GridFS bucket `uploads`), `legacy_rows`, `import_batches`, `import_issues`, `import_uploads` (auto-expire after 1 day), `counters` (numeric ids and JC numbers). The logical model below is unchanged; table names map to collection names.

```
users ─┐            properties   work_categories   engineers   closure_categories   workflow_stages
       │                 │              │               │
       └──< requests >───┴──────────────┘───────────────┘
               │ 1
               ├──< request_stages  (one row per workflow stage, UNIQUE(request_id, stage_key))
               ├──< request_events  (immutable activity log / audit trail)
               ├──< attachments     (URL or uploaded file, tagged with stage)
               └──1 legacy_rows     (raw FMS row values, never modified)
import_batches ──< import_issues
               └──< requests (import_batch_id)
```

| Table | Key columns |
|---|---|
| `users` | username, name, password_hash (bcrypt), role, engineer_id (links a login to an engineer), active, must_change_password |
| `properties` | name (unique, case-insensitive), code, type, address, active |
| `work_categories` | name, description, default_priority, active |
| `engineers` | name, phone, email, specialization, is_external, active |
| `closure_categories` | name, sort, active |
| `workflow_stages` | key, seq, name, stage_group, optional, action_roles (JSON), sla_rule (JSON), requires_evidence, legacy_name, active |
| `requests` | request_no (`WR-YYYY-NNNNN`), source (`ui` \| `fms_import`), title, description, property_id, category_id, priority, location_detail, requested_at, requester_name/contact, target_date, **status**, **current_stage_key**, **current_stage_planned_at** (denormalised for fast overdue filtering), site_engineer_id, assigned_engineer_id, requires_ph_discussion / requires_material / requires_permission, hold_reason, held_at, cancelled_at, completed_at, closed_at, closure_category, closure_note, verified_by_name, legacy_key (unique fingerprint for re-import), import_batch_id, import_row_no, modified_in_app |
| `request_stages` | stage_key, seq, status (`pending`,`active`,`completed`,`skipped`,`rejected`), planned_at, actual_at, delay_minutes, responsible_role, responsible_name, responsible_user_id, engineer_id, decision, comments, planned_inferred, actual_inferred, source (`ui`/`fms_import`/`system`), legacy (JSON of the raw Planned/Actual/Status/Delay/Engg text) |
| `request_events` | type (`created`,`stage_completed`,`stage_skipped`,`comment`,`attachment`,`assigned`,`hold`,`resume`,`cancel`,`reopen`,`imported`,`edited`), message, data JSON, user |
| `attachments` | stage_key, kind (`url`/`file`), url, stored_name, file_name, mime, size, caption, source |
| `import_batches` | file_name, export_at, mode, options, mapping, column layout, counts, summary, status (`committed`/`rolled_back`) |
| `import_issues` | batch_id, row_no, severity (`error`/`warning`), field, message, value |
| `legacy_rows` | request_id, batch_id, row_no, values (JSON array of all 40 source cells) |

Dates are stored as local wall-clock ISO strings (`YYYY-MM-DDTHH:mm:ss`). The business runs in a single time zone, which keeps SLA arithmetic identical to the sheet.

---

## 2. Import mapping

| FMS column | Target | Transform |
|---|---|---|
| 1 Timestamp | `requests.requested_at`, stage `created.actual_at` | `dd/mm/yyyy hh:mm:ss` → ISO. **Required** |
| 2 Property | `requests.property_id` | trim, match case-insensitively, auto-create if unknown (option) |
| 3 Work Category | `requests.category_id` | same |
| 4 Work Completion Date | `requests.target_date` | date |
| 5 Image of Location | `attachments` (stage `created`) | split on `,` into one URL attachment each |
| 6 Narration | `requests.description`; title = first 80 chars | |
| 7–10 | stage `site_visit` planned / actual / status / legacy delay | |
| 11 Engg Name | `site_visit.engineer_id`, `requests.site_engineer_id` | normalised name, auto-create engineer |
| 12–15, 16 | stage `ph_discussion` (+ engineer) | |
| 17–20 | stage `material` | optional stage |
| 21–24 | stage `communicate_requester` | |
| 25–28 | stage `permission` | |
| 29–32 | stage `engineer_assigned` | |
| 33–36 | stage `work_completed` | |
| 37 (unnamed) | `work_completed.engineer_id`, `requests.assigned_engineer_id` | detected by position and by values that look like names |
| 38 Image Link | `attachments` (stage `work_completed`) | `image not available` becomes a comment |
| 39 Remarks | stage `verification.comments`; `verified_by_name` from "Confirm by X" | |
| 40 Category By PC Mam | `requests.closure_note` + `closure_category` | keyword classification: done / hold / wrong / service-repair |
| *all* | `legacy_rows.values` | the raw row is preserved exactly |

Stages that do not exist in the FMS (Triage, Work Started) are marked `skipped – not tracked in legacy FMS` on completed rows. Verification and Closed are marked completed, with *inferred* dates taken from the Work Completion actual. On open rows, the first stage without an Actual becomes the **current** stage, so staff can continue it in the app.

Re-import: `legacy_key = sha1(timestamp|property|category|narration)`.
* Mode `skip` (default): rows already imported are skipped.
* Mode `update`: stage data is refreshed only for records that have **not** been modified in the app since import.

A batch can be rolled back only while none of its records have been modified in the app.

Wizard steps: **Upload → Preview → Detect → Map → Validate → Import → Summary**. The detector finds the header row (the row containing *Timestamp* and *Property*), the stage group row, and the Who/How/When rows. It proposes a target field for each column, and the user can override each proposal.

---

## 3. Workflow model

```
Created → Triage → Site Visit → [PH Discussion] → [Material] → Requester Informed → [Permission]
        → Engineer Assigned → Work Started → Work Completed → Verification → Closed
```
`[ ]` marks an optional stage, which is set during Triage. Each stage row tracks planned, actual, status, delay, responsible person, comments and evidence.

| Key | Stage | Group | Acts (roles) | SLA rule (anchor → rule) |
|---|---|---|---|---|
| created | Request Created | intake | system | = requested_at |
| triage | Triage | intake | coordinator | request + 4 h |
| site_visit | Site Visit | assessment | site engineer, project_head, coordinator | request → next working day 15:00 |
| ph_discussion | Project Head Discussion | dependency | project_head, coordinator | previous → same day 18:00 |
| material | Material / Dependency | dependency | store, coordinator | previous → +1 working day |
| communicate_requester | Requester Informed | coordination | coordinator | previous → next working day 10:00 |
| permission | Permission / Approval | dependency | approver, coordinator | previous → same day 11:00 |
| engineer_assigned | Engineer Assigned | coordination | coordinator | previous → same day 12:00 |
| work_started | Work Started | execution | assigned engineer, coordinator | previous → next working day 10:00 |
| work_completed | Work Completed | execution | assigned engineer, coordinator | request → +7 working days; **evidence required** |
| verification | Verification | closure | project_head, coordinator | previous → +1 working day |
| closed | Closed | closure | coordinator | previous → same day 18:00 |

Working days skip Sunday, as the sheet does. For new records, a "same day" rule whose time has already passed on the anchor day rolls to the next working day. The rules can be edited in **Masters → Workflow & SLA**.

**Stage actions:** complete, skip (optional stages only), approve or reject (dependency stages), reopen (verification failure sends the job back to Work Started), and edit (admin corrections to historical data).

**Request status** is derived from the current stage every time a stage changes:

| Status | When |
|---|---|
| Open | current stage is Created or Triage |
| In Progress | Site Visit, Work Started or Work Completed |
| Pending Approval | PH Discussion, Material or Permission |
| Pending Action | Requester Informed or Engineer Assigned (coordinator action) |
| Completed | work done; Verification or Close pending |
| Closed | Closed stage completed |
| On Hold / Cancelled | explicit actions, overriding the above |

**Delayed / overdue** means the request is not closed, cancelled or on hold, and `current_stage_planned_at < now`. Stage delay = `actual − planned` (positive means late).

---

## 4. Roles & permissions

| Permission | admin | coordinator | project_head | approver | store | engineer | requester | viewer |
|---|---|---|---|---|---|---|---|---|
| View all requests | ✔ | ✔ | ✔ | ✔ | ✔ | assigned only | own only | ✔ |
| Create request | ✔ | ✔ | ✔ | | | ✔ | ✔ | |
| Triage / assign / hold / cancel / close | ✔ | ✔ | | | | | | |
| Stage updates | all | all | site visit, PH, verification | permission | material | site visit (as site engineer), work started, work completed (as assigned engineer) | | |
| Approve / reject dependencies | ✔ | ✔ | PH | permission | material | | | |
| Comment / attach evidence | ✔ | ✔ | ✔ | ✔ | ✔ | on own jobs | on own requests | |
| Edit historical stage data | ✔ | | | | | | | |
| Masters (properties, categories, engineers, SLA) | ✔ | ✔ | | | | | | |
| Users | ✔ | | | | | | | |
| FMS import / rollback | ✔ | ✔ | | | | | | |
| Reports & dashboard | ✔ | ✔ | ✔ | ✔ | ✔ | own | | ✔ |

Authentication uses a bcrypt password hash and a JWT in an **httpOnly, SameSite=Strict cookie**. The same permission table (`shared permissions`) is enforced server-side on every route and used client-side only to hide controls.

---

## 5. Screens / modules

| Module | Route | Content |
|---|---|---|
| Login | `/login` | |
| Dashboard | `/` | 8 KPI tiles, monthly created-vs-closed trend, stage pipeline, property / category / engineer breakdowns, recent activity |
| Work Requests | `/requests` | filters (property, category, status, stage, engineer, priority, date range, overdue, source, search), paginated table, CSV export |
| New Request | `/requests/new` | form |
| Job / Work Card | `/requests/:id` | header card, current-stage action panel, **stage timeline** (Planned → Actual → Status → Delay → Person → Comments/Evidence), attachments, activity log, raw FMS row |
| My Jobs | `/my-jobs` | Today / Pending / Overdue / All / Completed tabs, quick stage update |
| Workflow Tracking | `/workflow` | stage pipeline board with counts, overdue per stage, drill-down list |
| Approvals | `/approvals` | pending PH discussion / material / permission, approve or reject |
| Properties, Work Categories, Engineers | `/masters/...` | CRUD, **merge duplicates** (e.g. `Nautre Park`), usage counts |
| Masters | `/masters` | Workflow & SLA rules, closure categories, users |
| Reports | `/reports/:type` | 9 reports + CSV export |
| FMS Import | `/import` | wizard, batch history, batch detail with issues, rollback |

---

## 6. API (all under `/api`, JSON)

```
POST   /auth/login | /auth/logout      GET /auth/me      POST /auth/change-password
GET    /dashboard?from&to&property_id
GET    /requests?property_id&category_id&status&stage&engineer_id&priority&from&to&overdue&source&q&page&page_size&sort
POST   /requests
GET    /requests/export.csv?…same filters
GET    /requests/:id                   → request, stages, attachments, events, legacy row
PATCH  /requests/:id                   → edit header fields
POST   /requests/:id/triage            → priority, flags, site engineer
POST   /requests/:id/stages/:key/complete   {actual_at?, comments, engineer_id?, attachments}
POST   /requests/:id/stages/:key/skip       {reason}
POST   /requests/:id/stages/:key/decision   {decision: approved|rejected, comments}
PATCH  /requests/:id/stages/:key            (admin: correct planned/actual/status)
POST   /requests/:id/assign | /hold | /resume | /cancel | /reopen | /close
POST   /requests/:id/comments
POST   /requests/:id/attachments       (multipart file or {url})
GET    /attachments/:id/file
GET    /my-jobs?bucket=today|pending|overdue|all|completed
GET    /workflow/board        GET /workflow/stages
GET    /approvals
GET|POST|PATCH /properties | /categories | /engineers | /closure-categories   POST /…/:id/merge
PATCH  /workflow/stages/:key  (SLA rule)
GET|POST|PATCH /users
GET    /reports/:type?from&to&property_id&category_id&engineer_id&format=csv
POST   /imports/upload        (multipart) → uploadId, preview rows, detected layout, proposed mapping
POST   /imports/:uploadId/validate   {mapping, options} → counts + issues + sample of mapped records
POST   /imports/:uploadId/commit     {mapping, options} → batch summary
GET    /imports    GET /imports/:batchId    POST /imports/:batchId/rollback
```

Code layout keeps import separate from operations:

```
backend/src/domain/       workflow definitions, SLA engine, status derivation (pure, shared)
backend/src/services/     operational services (requests, stages, masters, reports, dashboard)
backend/src/import/       parser, layout detector, mapper, validator, import service (only writes, never used by ops)
backend/src/routes/       thin HTTP layer
frontend/src/components/   reusable UI (DataTable, FilterBar, Timeline, Badges, Modal, KPI tiles …)
frontend/src/pages/        one folder per module
```
