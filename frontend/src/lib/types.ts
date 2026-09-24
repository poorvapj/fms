export type Role = 'admin' | 'coordinator' | 'project_head' | 'approver' | 'store' | 'engineer' | 'requester' | 'viewer';

export interface User {
  id: number;
  username: string;
  name: string;
  role: Role;
  engineer_id: number | null;
  must_change_password: boolean;
}

export interface Master {
  id: number;
  name: string;
  active: number;
  request_count?: number;
  open_count?: number;
  [k: string]: unknown;
}

export interface StageDef {
  key: string;
  seq: number;
  name: string;
  group: string;
  optional: boolean;
  roles: Role[];
  responsible_label: string;
  sla: { type: string; hours?: number; days?: number; time?: string; anchor?: string };
  sla_text: string;
  requires_evidence: boolean;
  decision: boolean;
  legacy_name: string | null;
}

export interface Meta {
  env: 'local' | 'live';
  statuses: { key: string; label: string }[];
  priorities: string[];
  work_types: { key: string; label: string }[];
  roles: { key: Role; label: string }[];
  stages: StageDef[];
  reports: { key: string; title: string; description: string }[];
  properties: Master[];
  categories: Master[];
  engineers: Master[];
  closure_categories: { id: number; name: string }[];
}

export interface RequestRow {
  id: number;
  request_no: string;
  source: string;
  title: string;
  priority: string;
  status: string;
  requested_at: string;
  target_date: string | null;
  current_stage_key: string | null;
  current_stage_name: string | null;
  current_stage_planned_at: string | null;
  completed_at: string | null;
  property_name: string;
  category_name: string;
  engineer_name: string | null;
  site_engineer_name: string | null;
  is_overdue: boolean;
  overdue_minutes: number | null;
  hold_reason: string | null;
  location_detail?: string | null;
  property_no?: string | null;
  work_type?: string | null;
}

export interface Stage {
  id: number;
  stage_key: string;
  seq: number;
  name: string;
  group: string;
  optional: boolean;
  decision_stage: boolean;
  requires_evidence: boolean;
  status: 'pending' | 'active' | 'completed' | 'skipped' | 'rejected';
  planned_at: string | null;
  actual_at: string | null;
  delay_minutes: number | null;
  running_delay_minutes: number | null;
  responsible_role: string | null;
  responsible_name: string | null;
  engineer_id: number | null;
  engineer_name: string | null;
  decision: string | null;
  comments: string | null;
  planned_inferred: boolean;
  actual_inferred: boolean;
  source: string;
  legacy: Record<string, string> | null;
  updated_by_name: string | null;
  updated_at: string;
}

export interface Attachment {
  id: number;
  stage_key: string | null;
  kind: 'url' | 'file';
  url: string | null;
  file_name: string | null;
  mime: string | null;
  size: number | null;
  caption: string | null;
  source: string;
  created_at: string;
  uploaded_by_name: string | null;
}

export interface RequestEvent {
  id: number;
  stage_key: string | null;
  type: string;
  message: string;
  user_name: string;
  created_at: string;
}

export interface RequestDetail {
  request: RequestRow & {
    description: string | null;
    location_detail: string | null;
    requester_name: string | null;
    requester_contact: string | null;
    requester_email: string | null;
    reason: string | null;
    created_by_name: string | null;
    property_id: number;
    category_id: number;
    site_engineer_id: number | null;
    assigned_engineer_id: number | null;
    requires_ph_discussion: number | null;
    requires_material: number | null;
    requires_permission: number | null;
    held_at: string | null;
    cancelled_at: string | null;
    cancel_reason: string | null;
    closure_category: string | null;
    closure_note: string | null;
    verified_by_name: string | null;
    closed_at: string | null;
    import_batch_id: number | null;
    import_row_no: number | null;
    location_detail_text?: string;
  };
  stages: Stage[];
  attachments: Attachment[];
  events: RequestEvent[];
  legacy: { batch_id: number; file_name: string; row_no: number; cells: { index: number; group: string; header: string; value: string }[] } | null;
}

export interface Paged<T> {
  total: number;
  page: number;
  page_size: number;
  rows: T[];
}
