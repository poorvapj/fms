PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS engineers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  email TEXT,
  specialization TEXT,
  is_external INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  engineer_id INTEGER REFERENCES engineers(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  code TEXT,
  type TEXT,
  address TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT,
  default_priority TEXT NOT NULL DEFAULT 'medium',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS closure_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS workflow_stages (
  key TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  stage_group TEXT NOT NULL,
  optional INTEGER NOT NULL DEFAULT 0,
  action_roles TEXT NOT NULL,
  responsible_label TEXT,
  sla_rule TEXT NOT NULL,
  requires_evidence INTEGER NOT NULL DEFAULT 0,
  decision INTEGER NOT NULL DEFAULT 0,
  legacy_name TEXT
);

CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_size INTEGER,
  export_at TEXT,
  mode TEXT NOT NULL,
  options TEXT,
  mapping TEXT,
  columns TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'committed',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  rolled_back_at TEXT
);

CREATE TABLE IF NOT EXISTS import_issues (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_no INTEGER,
  severity TEXT NOT NULL,
  field TEXT,
  message TEXT NOT NULL,
  value TEXT
);
CREATE INDEX IF NOT EXISTS ix_import_issues_batch ON import_issues(batch_id);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  request_no TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'ui',
  title TEXT NOT NULL,
  description TEXT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  category_id INTEGER NOT NULL REFERENCES work_categories(id),
  priority TEXT NOT NULL DEFAULT 'medium',
  location_detail TEXT,
  work_type TEXT,
  property_no TEXT,
  reason TEXT,
  requester_email TEXT,
  requested_at TEXT NOT NULL,
  requester_name TEXT,
  requester_contact TEXT,
  created_by INTEGER REFERENCES users(id),
  target_date TEXT,
  status TEXT NOT NULL,
  current_stage_key TEXT,
  current_stage_planned_at TEXT,
  site_engineer_id INTEGER REFERENCES engineers(id),
  assigned_engineer_id INTEGER REFERENCES engineers(id),
  requires_ph_discussion INTEGER,
  requires_material INTEGER,
  requires_permission INTEGER,
  hold_reason TEXT,
  held_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  completed_at TEXT,
  closed_at TEXT,
  closure_category TEXT,
  closure_note TEXT,
  verified_by_name TEXT,
  legacy_key TEXT UNIQUE,
  public_token TEXT UNIQUE,
  requester_ip TEXT,
  import_batch_id INTEGER REFERENCES import_batches(id),
  import_row_no INTEGER,
  modified_in_app INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS ix_requests_property ON requests(property_id);
CREATE INDEX IF NOT EXISTS ix_requests_category ON requests(category_id);
CREATE INDEX IF NOT EXISTS ix_requests_engineer ON requests(assigned_engineer_id);
CREATE INDEX IF NOT EXISTS ix_requests_site_engineer ON requests(site_engineer_id);
CREATE INDEX IF NOT EXISTS ix_requests_requested_at ON requests(requested_at);
CREATE INDEX IF NOT EXISTS ix_requests_stage ON requests(current_stage_key);
CREATE INDEX IF NOT EXISTS ix_requests_batch ON requests(import_batch_id);

CREATE TABLE IF NOT EXISTS request_stages (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  planned_at TEXT,
  actual_at TEXT,
  delay_minutes INTEGER,
  responsible_role TEXT,
  responsible_name TEXT,
  responsible_user_id INTEGER REFERENCES users(id),
  engineer_id INTEGER REFERENCES engineers(id),
  decision TEXT,
  comments TEXT,
  planned_inferred INTEGER NOT NULL DEFAULT 0,
  actual_inferred INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'ui',
  legacy TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  UNIQUE (request_id, stage_key)
);
CREATE INDEX IF NOT EXISTS ix_stages_key_status ON request_stages(stage_key, status);

CREATE TABLE IF NOT EXISTS request_events (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  stage_key TEXT,
  type TEXT NOT NULL,
  message TEXT,
  data TEXT,
  user_id INTEGER REFERENCES users(id),
  user_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_request ON request_events(request_id);
CREATE INDEX IF NOT EXISTS ix_events_created ON request_events(created_at);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  stage_key TEXT,
  kind TEXT NOT NULL,
  url TEXT,
  stored_name TEXT,
  file_name TEXT,
  mime TEXT,
  size INTEGER,
  caption TEXT,
  source TEXT NOT NULL DEFAULT 'ui',
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_attachments_request ON attachments(request_id);

CREATE TABLE IF NOT EXISTS legacy_rows (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  batch_id INTEGER NOT NULL REFERENCES import_batches(id),
  row_no INTEGER NOT NULL,
  cells TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
