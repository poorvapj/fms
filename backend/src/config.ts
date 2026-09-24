import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Environment: "local" (testing on this computer) or "live" (real data). Each has its own MongoDB cluster
 * (MONGODB_URI_LOCAL / MONGODB_URI_LIVE in backend/.env) and its own default ports, so testing never touches live data.
 * data/<env>/ only holds the generated session secret when JWT_SECRET is not set.
 */
export type AppEnv = 'local' | 'live';
const envName = (process.env.FMS_ENV ?? 'local').toLowerCase();
export const APP_ENV: AppEnv = envName === 'live' || envName === 'production' ? 'live' : 'local';
/** Render sets RENDER=true: HTTPS behind Vercel → Render proxies is assumed there (secure cookie, 2 trusted proxies). */
const ON_RENDER = !!process.env.RENDER;
const DEFAULT_PORTS = { local: { api: 4600, ui: 5600 }, live: { api: 4700, ui: 5700 } }[APP_ENV];

const dataDir = path.resolve(process.env.FMS_DATA_DIR ?? path.join(serverRoot, 'data', APP_ENV));
mkdirSync(dataDir, { recursive: true });

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
  cookieSameSite: (process.env.COOKIE_SAMESITE ?? (ON_RENDER ? 'lax' : 'strict')) as 'strict' | 'lax' | 'none',
  serverRoot,
  dataDir,
  /** MongoDB connection (Atlas). Each environment points at its own cluster/database. */
  mongoUri: process.env.MONGODB_URI ?? (APP_ENV === 'live' ? process.env.MONGODB_URI_LIVE : process.env.MONGODB_URI_LOCAL) ?? '',
  mongoDb: process.env.MONGODB_DB ?? (APP_ENV === 'live' ? 'fms_live' : 'fms_local'),
  /** Where the separately hosted frontend runs (used only for messages and CORS defaults). */
  frontendUrl: process.env.FRONTEND_URL ?? `http://localhost:${DEFAULT_PORTS.ui}`,
  jwtSecret: loadSecret(),
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  secureCookies: process.env.SECURE_COOKIES ? process.env.SECURE_COOKIES === 'true' : ON_RENDER,
  /**
   * How many proxies sit in front of the app (Express "trust proxy"), so req.ip is the real visitor.
   * Local: loopback only. Vercel -> Render: 2.
   */
  trustProxy: /^\d+$/.test(process.env.TRUST_PROXY ?? '') ? Number(process.env.TRUST_PROXY) : (process.env.TRUST_PROXY || (ON_RENDER ? 2 : 'loopback')),
  maxUploadMb: 15,
  /** Slack bot for site-visit Yes/No notifications (backend/.env). Unset disables the feature entirely. */
  slackBotToken: process.env.SLACK_BOT_TOKEN ?? '',
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET ?? '',
};
