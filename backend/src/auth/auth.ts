import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.ts';
import { col } from '../db/mongo.ts';
import { can, ROLE_PERMISSIONS, type Permission, type Role } from '../domain/permissions.ts';
import { nowLocal } from '../utils/dates.ts';
import { HttpError, forbidden } from '../utils/http.ts';

export interface AuthUser {
  id: number;
  username: string;
  name: string;
  role: Role;
  engineer_id: number | null;
  must_change_password: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export const COOKIE = 'fms_session';

export function hashPassword(pw: string) {
  return bcrypt.hashSync(pw, 10);
}

export function validatePassword(pw: unknown): string {
  const s = typeof pw === 'string' ? pw : '';
  if (s.length < 8 || !/[A-Za-z]/.test(s) || !/\d/.test(s)) {
    throw new HttpError(400, 'Password must be at least 8 characters and contain letters and numbers');
  }
  return s;
}

async function loadUser(id: number): Promise<AuthUser | null> {
  const u = await col.users().findOne({ _id: id }, { projection: { password_hash: 0 } });
  if (!u || !u.active) return null;
  return { id: u._id, username: u.username, name: u.name, role: u.role, engineer_id: u.engineer_id ?? null, must_change_password: !!u.must_change_password };
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
    throw new HttpError(401, 'Invalid username or password');
  }
  failures.delete(key);
  // Not needed to complete sign-in — don't make the user wait on it.
  col.users().updateOne({ _id: row._id }, { $set: { last_login_at: nowLocal() } }).catch(() => {});
  const token = jwt.sign({ sub: String(row._id) }, config.jwtSecret, { expiresIn: `${config.sessionHours}h` });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: config.cookieSameSite,
    secure: config.secureCookies || config.cookieSameSite === 'none',
    maxAge: config.sessionHours * 3600000,
    path: '/',
  });
  return { id: row._id, username: row.username, name: row.name, role: row.role, engineer_id: row.engineer_id ?? null, must_change_password: !!row.must_change_password };
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
    next();
  } catch (err) {
    next(err);
  }
}

export function requirePermission(...perms: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const u = req.user!;
    if (!perms.some((p) => can(u.role, p))) return next(forbidden());
    next();
  };
}

export function userPermissions(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}
