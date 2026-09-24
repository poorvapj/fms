import multer from 'multer';
import { config } from '../config.ts';
import { MAX_IMPORT_MB } from '../import/importService.ts';
import { ALLOWED_MIME } from '../services/attachments.ts';
import { badRequest } from '../utils/http.ts';

/** Evidence / image uploads: held in memory, then stored in MongoDB (GridFS) — nothing touches the server disk. */
export const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => (ALLOWED_MIME.test(file.mimetype) ? cb(null, true) : cb(badRequest(`File type ${file.mimetype} is not allowed`))),
});

/** FMS import files kept in memory until parsed. */
export const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT_MB * 1024 * 1024, files: 1 } });
