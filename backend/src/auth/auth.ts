import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.ts';
import { get, run } from '../db/db.ts';
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

function loadUser(id: number): AuthUser | null {
  const u = get('SELECT id, username, name, role, engineer_id, must_change_password, active FROM users WHERE id = ?', [id]);
  if (!u || !u.active) return null;
  return { id: u.id, username: u.username, name: u.name, role: u.role, engineer_id: u.engineer_id, must_change_password: !!u.must_change_password };
}

// Simple in-memory login throttle: 10 failed attempts per username+ip per 15 minutes.
const failures = new Map<string, { count: number; until: number }>();

export function login(username: string, password: string, ip: string, res: Response): AuthUser {
  const key = `${username.toLowerCase()}|${ip}`;
  const f = failures.get(key);
  if (f && f.count >= 10 && f.until > Date.now()) throw new HttpError(429, 'Too many failed attempts. Try again later.');
  // Sign in with either the username or the email address (emails are unique across users).
  const row = get(
    `SELECT id, password_hash, active FROM users WHERE username = ? COLLATE NOCASE OR (email IS NOT NULL AND lower(email) = lower(?))
     ORDER BY username = ? COLLATE NOCASE DESC LIMIT 1`,
    [username, username, username],
  );
  const ok = row && row.active && bcrypt.compareSync(password, row.password_hash);
  if (!ok) {
    failures.set(key, { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 15 * 60000 });
    throw new HttpError(401, 'Invalid username or password');
  }
  failures.delete(key);
  run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowLocal(), row.id]);
  const token = jwt.sign({ sub: String(row.id) }, config.jwtSecret, { expiresIn: `${config.sessionHours}h` });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: config.cookieSameSite,
    secure: config.secureCookies || config.cookieSameSite === 'none',
    maxAge: config.sessionHours * 3600000,
    path: '/',
  });
  return loadUser(row.id)!;
}

export function logout(res: Response) {
  res.clearCookie(COOKIE, { path: '/' });
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE];
  if (!token) return next(new HttpError(401, 'Not signed in'));
  try {
    const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    const user = loadUser(Number(payload.sub));
    if (!user) return next(new HttpError(401, 'Session expired'));
    req.user = user;
    next();
  } catch {
    next(new HttpError(401, 'Session expired'));
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
