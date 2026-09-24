import bcrypt from 'bcryptjs';
import { hashPassword, validatePassword, type AuthUser } from '../auth/auth.ts';
import { col, isDuplicateKey, nextId } from '../db/mongo.ts';
import { ROLES } from '../domain/permissions.ts';
import { nowLocal } from '../utils/dates.ts';
import { badRequest, bool, conflict, int, notFound, oneOf, requiredStr, str } from '../utils/http.ts';

const CI = { locale: 'en', strength: 2 } as const;

export async function listUsers() {
  const [users, engineers] = await Promise.all([
    col.users().find({}, { projection: { password_hash: 0 } }).collation(CI).sort({ name: 1 }).toArray(),
    col.engineers().find({}, { projection: { name: 1 } }).toArray(),
  ]);
  const eng = new Map(engineers.map((e) => [e._id, e.name]));
  return users.map(({ _id, ...u }) => ({ id: _id, ...u, engineer_name: eng.get(u.engineer_id) ?? null }));
}

async function checkEngineerLink(engineerId: number | null, role: string, userId?: number) {
  if (role === 'engineer' && !engineerId) throw badRequest('Engineer logins must be linked to an engineer record');
  if (engineerId === null) return;
  if (!(await col.engineers().findOne({ _id: engineerId }))) throw badRequest('Engineer not found');
  const other = await col.users().findOne({ engineer_id: engineerId, _id: { $ne: userId ?? -1 } });
  if (other) throw conflict(`That engineer is already linked to login "${other.username}"`);
}

/** Emails double as login IDs, so they must be valid and unique. */
async function checkEmail(raw: unknown, userId?: number): Promise<string | null> {
  const email = str(raw, 200)?.toLowerCase() ?? null;
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Enter a valid email address');
  const other = await col.users().findOne({ email, _id: { $ne: userId ?? -1 } }, { collation: CI });
  if (other) throw conflict(`That email is already used by login "${other.username}"`);
  if (await col.users().findOne({ username: email, _id: { $ne: userId ?? -1 } }, { collation: CI })) throw conflict('That email matches another username');
  return email;
}

export async function createUser(body: any) {
  const username = requiredStr(body.username, 'Username', 60).toLowerCase();
  if (!/^[a-z0-9._-]{3,60}$/.test(username)) throw badRequest('Username may contain letters, numbers, dot, dash and underscore (min 3)');
  if (await col.users().findOne({ username }, { collation: CI })) throw conflict('Username already exists');
  const role = oneOf(body.role, ROLES, 'Role');
  const engineerId = int(body.engineer_id);
  await checkEngineerLink(engineerId, role);
  const email = await checkEmail(body.email);
  const password = validatePassword(body.password);
  const now = nowLocal();
  const id = await nextId('users');
  try {
    await col.users().insertOne({
      _id: id, username, name: requiredStr(body.name, 'Name', 120), email, phone: str(body.phone, 40), password_hash: hashPassword(password),
      role, engineer_id: engineerId, active: 1, must_change_password: 1, last_login_at: null, created_at: now, updated_at: now,
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw conflict('Username or email already exists');
    throw err;
  }
  return { id };
}

export async function updateUser(id: number, body: any, actor: AuthUser) {
  const u = await col.users().findOne({ _id: id });
  if (!u) throw notFound('User');
  const role = body.role === undefined ? u.role : oneOf(body.role, ROLES, 'Role');
  const engineerId = body.engineer_id === undefined ? u.engineer_id : int(body.engineer_id);
  await checkEngineerLink(engineerId, role, id);
  const active = body.active === undefined ? u.active : bool(body.active) ? 1 : 0;
  if (id === actor.id && (role !== 'admin' || !active)) throw badRequest('You cannot remove your own admin access');
  if (u.role === 'admin' && (role !== 'admin' || !active)) {
    if (!(await col.users().countDocuments({ role: 'admin', active: 1, _id: { $ne: id } }))) throw badRequest('At least one active administrator is required');
  }
  const set: Record<string, unknown> = {
    name: body.name === undefined ? u.name : requiredStr(body.name, 'Name', 120),
    email: body.email === undefined ? u.email : await checkEmail(body.email, id),
    phone: body.phone === undefined ? u.phone : str(body.phone, 40),
    role, engineer_id: engineerId, active, updated_at: nowLocal(),
  };
  if (body.password) Object.assign(set, { password_hash: hashPassword(validatePassword(body.password)), must_change_password: 1 });
  await col.users().updateOne({ _id: id }, { $set: set });
}

export async function changeOwnPassword(user: AuthUser, current: unknown, next: unknown) {
  const u = await col.users().findOne({ _id: user.id }, { projection: { password_hash: 1 } });
  if (!u || !bcrypt.compareSync(String(current ?? ''), u.password_hash)) throw badRequest('Current password is incorrect');
  const pw = validatePassword(next);
  if (pw === current) throw badRequest('New password must be different');
  await col.users().updateOne({ _id: user.id }, { $set: { password_hash: hashPassword(pw), must_change_password: 0, updated_at: nowLocal() } });
}
