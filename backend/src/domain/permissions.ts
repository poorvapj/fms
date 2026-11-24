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
  | 'request.manage'      // assign, hold, resume, cancel, close, reopen
  | 'request.comment'
  | 'stage.update'        // subject to stage-level role check
  | 'stage.edit_history'  // correct planned/actual/status on any stage
  | 'approvals.view'
  | 'masters.manage'
  | 'users.manage'
  | 'import.run'
  | 'reports.view'
  | 'dashboard.view'
  | 'audit.view'
  | 'page.job_cards'
  | 'page.my_jobs';

export const ALL_PERMISSIONS: Permission[] = [
  'request.view_all', 'request.create', 'request.edit', 'request.manage', 'request.comment', 'stage.update',
  'stage.edit_history', 'approvals.view', 'masters.manage', 'users.manage', 'import.run', 'reports.view', 'dashboard.view', 'audit.view',
  'page.job_cards', 'page.my_jobs',
];

export const PERMISSION_LABELS: Record<Permission, string> = {
  'request.view_all': 'View all job cards',
  'request.view_assigned': 'View job cards assigned to them',
  'request.view_own': 'View only their own job cards',
  'request.create': 'Create job cards',
  'request.edit': 'Edit job card details',
  'request.manage': 'Manage job cards (assign, hold, resume, cancel, close, reopen)',
  'request.comment': 'Add comments / evidence',
  'stage.update': 'Update workflow stages',
  'stage.edit_history': 'Correct stage history (admin override)',
  'approvals.view': 'View approvals queue',
  'masters.manage': 'Manage masters (properties, categories, engineers, etc.)',
  'users.manage': 'Manage users and logins',
  'import.run': 'Run legacy data imports',
  'reports.view': 'View reports',
  'dashboard.view': 'View dashboard',
  'audit.view': 'View audit log',
  'page.job_cards': 'View Job Cards page',
  'page.my_jobs': 'View My Jobs page',
};

/** The matrix as shipped — used to seed the DB-backed version (role_permissions service) the
 *  first time, and as a fallback until that cache loads. */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ALL_PERMISSIONS,
  coordinator: ALL_PERMISSIONS.filter((p) => p !== 'users.manage' && p !== 'stage.edit_history' && p !== 'audit.view'),
  project_head: ['request.view_all', 'request.create', 'request.comment', 'stage.update', 'approvals.view', 'reports.view', 'dashboard.view', 'page.job_cards', 'page.my_jobs'],
  approver: ['request.view_all', 'request.comment', 'stage.update', 'approvals.view', 'reports.view', 'dashboard.view', 'page.job_cards', 'page.my_jobs'],
  store: ['request.view_all', 'request.comment', 'stage.update', 'approvals.view', 'reports.view', 'dashboard.view', 'page.job_cards', 'page.my_jobs'],
  engineer: ['request.view_assigned', 'request.create', 'request.comment', 'stage.update', 'dashboard.view', 'page.job_cards', 'page.my_jobs'],
  requester: ['request.view_own', 'request.create', 'request.comment', 'page.job_cards', 'page.my_jobs'],
  viewer: ['request.view_all', 'reports.view', 'dashboard.view', 'page.job_cards', 'page.my_jobs'],
};

let cache: Record<Role, Permission[]> = DEFAULT_ROLE_PERMISSIONS;

/** Called by the role-permissions service once it's loaded the admin-edited matrix from the DB. */
export function setRolePermissionsCache(map: Record<Role, Permission[]>) {
  cache = map;
}

export function rolePermissions(role: Role): Permission[] {
  return cache[role] ?? [];
}

/** A role's default permissions (ignores any per-user override) — used by the role-permissions
 *  matrix itself and to compute a user's effective permissions before overrides are applied. */
export function roleCan(role: Role, permission: Permission): boolean {
  return cache[role]?.includes(permission) ?? false;
}

/** The main permission check, used everywhere a signed-in user acts — `user.permissions` is
 *  computed once at session-load time (role defaults merged with any per-user override). */
export function can(user: { permissions: Permission[] }, permission: Permission): boolean {
  return user.permissions.includes(permission);
}
