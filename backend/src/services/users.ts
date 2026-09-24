import bcrypt from 'bcryptjs';
import { hashPassword, validatePassword, type AuthUser } from '../auth/auth.ts';
import { all, get, run } from '../db/db.ts';
import { ROLES } from '../domain/permissions.ts';
import { nowLocal } from '../utils/dates.ts';
import { badRequest, bool, conflict, int, notFound, oneOf, requiredStr, str } from '../utils/http.ts';

const PUBLIC = `u.id, u.username, u.name, u.email, u.phone, u.role, u.engineer_id, e.name AS engineer_name, u.active, u.must_change_password, u.last_login_at, u.created_at`;

export function listUsers() {
  return all(`SELECT ${PUBLIC} FROM users u LEFT JOIN engineers e ON e.id = u.engineer_id ORDER BY u.name COLLATE NOCASE`);
}

function checkEngineerLink(engineerId: number | null, role: string, userId?: number) {
  if (role === 'engineer' && !engineerId) throw badRequest('Engineer logins must be linked to an engineer record');
  if (engineerId === null) return;
  if (!get('SELECT 1 FROM engineers WHERE id = ?', [engineerId])) throw badRequest('Engineer not found');
  const other = get('SELECT username FROM users WHERE engineer_id = ? AND id <> ?', [engineerId, userId ?? -1]);
  if (other) throw conflict(`That engineer is already linked to login "${other.username}"`);
}

export function createUser(body: any) {
  const username = requiredStr(body.username, 'Username', 60).toLowerCase();
  if (!/^[a-z0-9._-]{3,60}$/.test(username)) throw badRequest('Username may contain letters, numbers, dot, dash and underscore (min 3)');
  if (get('SELECT 1 FROM users WHERE username = ?', [username])) throw conflict('Username already exists');
  const role = oneOf(body.role, ROLES, 'Role');
  const engineerId = int(body.engineer_id);
  checkEngineerLink(engineerId, role);
  const password = validatePassword(body.password);
  const now = nowLocal();
  const { lastInsertRowid } = run(
    `INSERT INTO users (username, name, email, phone, password_hash, role, engineer_id, active, must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    [username, requiredStr(body.name, 'Name', 120), str(body.email, 200), str(body.phone, 40), hashPassword(password), role, engineerId, now, now],
  );
  return { id: lastInsertRowid };
}

export function updateUser(id: number, body: any, actor: AuthUser) {
  const u = get('SELECT * FROM users WHERE id = ?', [id]);
  if (!u) throw notFound('User');
  const role = body.role === undefined ? u.role : oneOf(body.role, ROLES, 'Role');
  const engineerId = body.engineer_id === undefined ? u.engineer_id : int(body.engineer_id);
  checkEngineerLink(engineerId, role, id);
  const active = body.active === undefined ? u.active : bool(body.active) ? 1 : 0;
  if (id === actor.id && (role !== 'admin' || !active)) throw badRequest('You cannot remove your own admin access');
  if (u.role === 'admin' && (role !== 'admin' || !active)) {
    const admins = get<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?`, [id])!.n;
    if (!admins) throw badRequest('At least one active administrator is required');
  }
  run(
    `UPDATE users SET name = ?, email = ?, phone = ?, role = ?, engineer_id = ?, active = ?, updated_at = ? WHERE id = ?`,
    [body.name === undefined ? u.name : requiredStr(body.name, 'Name', 120), body.email === undefined ? u.email : str(body.email, 200),
      body.phone === undefined ? u.phone : str(body.phone, 40), role, engineerId, active, nowLocal(), id],
  );
  if (body.password) {
    run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [hashPassword(validatePassword(body.password)), id]);
  }
}

export function changeOwnPassword(user: AuthUser, current: unknown, next: unknown) {
  const u = get('SELECT password_hash FROM users WHERE id = ?', [user.id]);
  if (!u || !bcrypt.compareSync(String(current ?? ''), u.password_hash)) throw badRequest('Current password is incorrect');
  const pw = validatePassword(next);
  if (pw === current) throw badRequest('New password must be different');
  run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?', [hashPassword(pw), nowLocal(), user.id]);
}
