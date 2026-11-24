import { col } from '../db/mongo.ts';
import {
  ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, PERMISSION_LABELS, ROLES, ROLE_LABELS, rolePermissions,
  setRolePermissionsCache, type Permission, type Role,
} from '../domain/permissions.ts';
import { badRequest } from '../utils/http.ts';

/** Permissions introduced after role_permissions docs already existed in the DB — $setOnInsert
 *  only seeds a brand-new doc, so an existing role would otherwise silently lose access to
 *  whatever a newly-added permission gates (e.g. a page that used to have no gate at all) until
 *  an admin notices and re-grants it. Since these keys didn't exist before, nobody could have
 *  deliberately revoked them, so it's safe to backfill them once into every existing role doc
 *  that's missing them (and still within that role's shipped defaults). */
const BACKFILL_PERMISSIONS: Permission[] = ['page.job_cards', 'page.my_jobs'];

/** Ensure every role has a DB row (keeps admin edits) and load the in-memory cache. Call at startup. */
export async function loadRolePermissions() {
  for (const role of ROLES) {
    await col.rolePermissions().updateOne(
      { _id: role },
      { $setOnInsert: { permissions: DEFAULT_ROLE_PERMISSIONS[role] } },
      { upsert: true },
    );
    const toAdd = BACKFILL_PERMISSIONS.filter((p) => DEFAULT_ROLE_PERMISSIONS[role].includes(p));
    if (toAdd.length) await col.rolePermissions().updateOne({ _id: role }, { $addToSet: { permissions: { $each: toAdd } } });
  }
  const rows = await col.rolePermissions().find().toArray();
  const byRole = new Map(rows.map((r) => [r._id as Role, r.permissions as string[]]));
  const map = Object.fromEntries(ROLES.map((role) => {
    const stored = byRole.get(role);
    const perms = Array.isArray(stored) ? stored.filter((p): p is Permission => ALL_PERMISSIONS.includes(p as Permission)) : DEFAULT_ROLE_PERMISSIONS[role];
    return [role, perms];
  })) as Record<Role, Permission[]>;
  setRolePermissionsCache(map);
}

export function publicRolePermissions() {
  return {
    roles: ROLES.map((role) => ({ role, label: ROLE_LABELS[role], permissions: rolePermissions(role) })),
    all_permissions: ALL_PERMISSIONS.map((p) => ({ key: p, label: PERMISSION_LABELS[p] })),
  };
}

export async function updateRolePermissions(role: string, permissions: unknown) {
  if (!ROLES.includes(role as Role)) throw badRequest('Unknown role');
  // Admin always keeps every permission — a few places construct a synthetic admin AuthUser
  // (Slack flows, imports) by reading this role's permissions directly, so it must never be
  // anything less than ALL_PERMISSIONS.
  if (role === 'admin') throw badRequest('Administrator permissions cannot be changed');
  if (!Array.isArray(permissions)) throw badRequest('permissions must be an array');
  const clean = Array.from(new Set(permissions.filter((p): p is Permission => ALL_PERMISSIONS.includes(p))));
  await col.rolePermissions().updateOne({ _id: role }, { $set: { permissions: clean } }, { upsert: true });
  await loadRolePermissions();
}
