import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Environment: "local" (testing on this computer) or "live" (real data). Each has its own database,
 * uploads and session secret under data/<env>/, and its own default ports, so testing never touches live data.
 */
export type AppEnv = 'local' | 'live';
const envName = (process.env.FMS_ENV ?? 'local').toLowerCase();
export const APP_ENV: AppEnv = envName === 'live' || envName === 'production' ? 'live' : 'local';
const DEFAULT_PORTS = { local: { api: 4600, ui: 5600 }, live: { api: 4700, ui: 5700 } }[APP_ENV];

const dataDir = path.resolve(process.env.FMS_DATA_DIR ?? path.join(serverRoot, 'data', APP_ENV));
mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
mkdirSync(path.join(dataDir, 'imports'), { recursive: true });

// Persist a generated secret so sessions survive restarts when JWT_SECRET is not provided.
function loadSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(dataDir, '.jwt-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(48).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  env: APP_ENV,
  port: Number(process.env.PORT ?? DEFAULT_PORTS.api),
  /** Comma-separated origins allowed to call the API when the frontend is hosted separately. */
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  cookieSameSite: (process.env.COOKIE_SAMESITE ?? 'strict') as 'strict' | 'lax' | 'none',
  serverRoot,
  dataDir,
  dbFile: process.env.FMS_DB_FILE ?? path.join(dataDir, 'fms.db'),
  uploadsDir: path.join(dataDir, 'uploads'),
  importsDir: path.join(dataDir, 'imports'),
  /** Where the separately hosted frontend runs (used only for messages and CORS defaults). */
  frontendUrl: process.env.FRONTEND_URL ?? `http://localhost:${DEFAULT_PORTS.ui}`,
  jwtSecret: loadSecret(),
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  secureCookies: process.env.SECURE_COOKIES === 'true',
  maxUploadMb: 15,
};
