export const ROLES = ['admin', 'coordinator', 'project_head', 'approver', 'store', 'engineer', 'requester', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  coordinator: 'Operations Coordinator',
  project_head: 'Project Head',
  approver: 'Approver (Management)',
  store: 'Store / Material',
  engineer: 'Engineer',
  requester: 'Requester',
  viewer: 'Viewer',
};

export type Permission =
  | 'request.view_all'
  | 'request.view_assigned'
  | 'request.view_own'
  | 'request.create'
  | 'request.edit'
  | 'request.manage'      // triage, assign, hold, resume, cancel, close, reopen
  | 'request.comment'
  | 'stage.update'        // subject to stage-level role check
  | 'stage.edit_history'  // correct planned/actual/status on any stage
  | 'approvals.view'
  | 'masters.manage'
  | 'users.manage'
  | 'import.run'
  | 'reports.view'
  | 'dashboard.view';

const ALL: Permission[] = [
  'request.view_all', 'request.create', 'request.edit', 'request.manage', 'request.comment', 'stage.update',
  'stage.edit_history', 'approvals.view', 'masters.manage', 'users.manage', 'import.run', 'reports.view', 'dashboard.view',
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ALL,
  coordinator: ALL.filter((p) => p !== 'users.manage' && p !== 'stage.edit_history'),
  project_head: ['request.view_all', 'request.create', 'request.comment', 'stage.update', 'approvals.view', 'reports.view', 'dashboard.view'],
  approver: ['request.view_all', 'request.comment', 'stage.update', 'approvals.view', 'reports.view', 'dashboard.view'],
  store: ['request.view_all', 'request.comment', 'stage.update', 'approvals.view', 'reports.view', 'dashboard.view'],
  engineer: ['request.view_assigned', 'request.create', 'request.comment', 'stage.update', 'dashboard.view'],
  requester: ['request.view_own', 'request.create', 'request.comment'],
  viewer: ['request.view_all', 'reports.view', 'dashboard.view'],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
