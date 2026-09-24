import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { config } from './config.ts';
import './db/db.ts';
import { ensureBaseData } from './db/seed.ts';
import { api } from './routes/api.ts';
import { HttpError } from './utils/http.ts';

ensureBaseData();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
// Separately hosted frontend: allow only configured origins, with credentials.
app.use('/api', (req, res, next) => {
  const origin = req.get('Origin');
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(cookieParser());

// CSRF defence for cookie auth: state-changing API calls must be same-origin JSON/multipart with a custom header.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'fms') return next(new HttpError(403, 'Missing request header'));
  next();
});
app.use('/api', api);
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

// The backend is API-only; the web UI is the separate frontend project.
app.get('/', (_req, res) => res.json({ service: 'FMS Operations API', api: '/api', frontend: config.frontendUrl }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is too large (max ${config.maxUploadMb} MB)` : err.message;
    return res.status(400).json({ error: msg });
  }
  if ((err as any)?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error' });
});

app.listen(config.port, () => {
  console.log(`FMS Operations API listening on http://localhost:${config.port}  (frontend: ${config.frontendUrl})`);
});
