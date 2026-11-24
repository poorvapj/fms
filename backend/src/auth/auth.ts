import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.ts';
import { col } from '../db/mongo.ts';
import { ALL_PERMISSIONS, can, rolePermissions, type Permission, type Role } from '../domain/permissions.ts';
import { logAudit } from '../services/audit.ts';
import { nowLocal } from '../utils/dates.ts';
import { HttpError, badRequest, forbidden, notFound } from '../utils/http.ts';

export interface AuthUser {
  id: number;
  username: string;
  name: string;
  role: Role;
  engineer_id: number | null;
  must_change_password: boolean;
  permissions: Permission[];
}

/** A user's own permission list, if an admin has customised it, overrides their role's defaults
 *  entirely (not merged) — "Reset to role default" just clears the override. */
export function effectivePermissions(role: Role, overrides: unknown): Permission[] {
  if (Array.isArray(overrides)) return overrides.filter((p): p is Permission => ALL_PERMISSIONS.includes(p));
  return rolePermissions(role);
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
    /** Set while this session is an admin impersonating another user ("Switch user") — the
     *  original admin's id, so they can be switched back to without re-entering a password. */
    impersonatorId?: number | null;
  }
}

export const COOKIE = 'fms_session';

export function hashPassword(pw: string) {
  return bcrypt.hashSync(pw, 10);
}

export function validatePassword(pw: unknown): string {
  const s = typeof pw === 'string' ? pw : '';
  if (!s) throw new HttpError(400, 'Password is required');
  return s;
}

export async function loadUser(id: number): Promise<AuthUser | null> {
  const u = await col.users().findOne({ _id: id }, { projection: { password_hash: 0 } });
  if (!u || !u.active) return null;
  return {
    id: u._id, username: u.username, name: u.name, role: u.role, engineer_id: u.engineer_id ?? null,
    must_change_password: !!u.must_change_password, permissions: effectivePermissions(u.role, u.permission_overrides),
  };
}

function setSessionCookie(res: Response, userId: number, impersonatorId?: number) {
  const token = jwt.sign({ sub: String(userId), ...(impersonatorId ? { imp: String(impersonatorId) } : {}) }, config.jwtSecret, { expiresIn: `${config.sessionHours}h` });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: config.cookieSameSite,
    secure: config.secureCookies || config.cookieSameSite === 'none',
    maxAge: config.sessionHours * 3600000,
    path: '/',
  });
}

// Simple in-memory login throttle: 10 failed attempts per username+ip per 15 minutes.
const failures = new Map<string, { count: number; until: number }>();

export async function login(username: string, password: string, ip: string, res: Response): Promise<AuthUser> {
  const key = `${username.toLowerCase()}|${ip}`;
  const f = failures.get(key);
  if (f && f.count >= 10 && f.until > Date.now()) throw new HttpError(429, 'Too many failed attempts. Try again later.');
  // Sign in with either the username or the email address (emails are unique across users) — one query, not two.
  const ci = { locale: 'en', strength: 2 } as const;
  const row = await col.users().findOne({ $or: [{ username }, { email: username }] }, { collation: ci });
  const ok = row && row.active && bcrypt.compareSync(password, row.password_hash);
  if (!ok) {
    failures.set(key, { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 15 * 60000 });
    logAudit('login_failed', `Failed login attempt for "${username}"`, { userName: username, data: { ip } }).catch(() => {});
    throw new HttpError(401, 'Invalid username or password');
  }
  failures.delete(key);
  // Not needed to complete sign-in — don't make the user wait on it.
  col.users().updateOne({ _id: row._id }, { $set: { last_login_at: nowLocal() } }).catch(() => {});
  logAudit('login', `${row.name} signed in`, { user: { id: row._id, name: row.name } as AuthUser, data: { ip } }).catch(() => {});
  setSessionCookie(res, row._id);
  return {
    id: row._id, username: row.username, name: row.name, role: row.role, engineer_id: row.engineer_id ?? null,
    must_change_password: !!row.must_change_password, permissions: effectivePermissions(row.role, row.permission_overrides),
  };
}

export function logout(res: Response) {
  res.clearCookie(COOKIE, { path: '/' });
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE];
  if (!token) return next(new HttpError(401, 'Not signed in'));
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
  } catch {
    return next(new HttpError(401, 'Session expired'));
  }
  try {
    const user = await loadUser(Number(payload.sub));
    if (!user) return next(new HttpError(401, 'Session expired'));
    req.user = user;
    req.impersonatorId = (payload as jwt.JwtPayload & { imp?: string }).imp ? Number((payload as jwt.JwtPayload & { imp?: string }).imp) : null;
    next();
  } catch (err) {
    next(err);
  }
}

export function requirePermission(...perms: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const u = req.user!;
    if (!perms.some((p) => can(u, p))) return next(forbidden());
    next();
  };
}

/** Admin "Switch user" — starts viewing the app as someone else without their password. Blocked
 *  while already impersonating (switch back first) and for other admins, to keep this strictly
 *  "see what a lower-privilege user sees" rather than a way to act as another admin. */
export async function impersonate(admin: AuthUser, req: Request, res: Response, targetId: number) {
  if (admin.role !== 'admin') throw forbidden();
  if (req.impersonatorId) throw badRequest('Already viewing as another user — switch back first');
  const target = await loadUser(targetId);
  if (!target) throw notFound('User');
  if (target.role === 'admin') throw badRequest('Cannot switch into another administrator');
  setSessionCookie(res, target.id, admin.id);
  logAudit('impersonate_start', `${admin.name} started viewing as "${target.username}"`, { user: admin, data: { target_user_id: target.id, target_username: target.username } }).catch(() => {});
  return target;
}

/** Switch back to the original admin session. */
export async function stopImpersonating(current: AuthUser, impersonatorId: number | null | undefined, res: Response) {
  if (!impersonatorId) throw badRequest('Not currently viewing as another user');
  const admin = await loadUser(impersonatorId);
  if (!admin) throw notFound('Original admin user');
  setSessionCookie(res, admin.id);
  logAudit('impersonate_stop', `${admin.name} stopped viewing as "${current.username}"`, { user: admin, data: { target_user_id: current.id, target_username: current.username } }).catch(() => {});
  return admin;
}
