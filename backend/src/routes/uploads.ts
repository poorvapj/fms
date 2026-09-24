import { randomBytes } from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { config } from '../config.ts';
import { ALLOWED_MIME } from '../services/attachments.ts';
import { badRequest } from '../utils/http.ts';

const storage = multer.diskStorage({
  destination: config.uploadsDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
    cb(null, `${randomBytes(16).toString('hex')}${ext}`);
  },
});

/** Evidence / image uploads stored on disk. */
export const evidenceUpload = multer({
  storage,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => (ALLOWED_MIME.test(file.mimetype) ? cb(null, true) : cb(badRequest(`File type ${file.mimetype} is not allowed`))),
});

/** FMS import files kept in memory until parsed. */
export const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
