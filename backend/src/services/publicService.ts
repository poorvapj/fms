import { all, get } from '../db/db.ts';
import { REQUEST_STATUSES, WORK_TYPES } from '../domain/workflow.ts';
import { HttpError, notFound } from '../utils/http.ts';
import { createRequest, type UploadedImage } from './requests.ts';
import { stageName } from './stageDefs.ts';

export function publicFormOptions() {
  return {
    properties: all('SELECT id, name FROM properties WHERE active = 1 ORDER BY name COLLATE NOCASE'),
    categories: all('SELECT id, name FROM work_categories WHERE active = 1 ORDER BY name COLLATE NOCASE'),
    work_types: WORK_TYPES,
  };
}

// Throttle anonymous submissions: 5 per IP per 10 minutes, 30 per IP per day.
const hits = new Map<string, number[]>();
function throttle(ip: string) {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 86400000);
  if (list.filter((t) => now - t < 600000).length >= 5 || list.length >= 30) {
    throw new HttpError(429, 'Too many requests submitted from this device. Please try again later.');
  }
  list.push(now);
  hits.set(ip, list);
}

export function submitPublicRequest(body: any, images: UploadedImage[], ip: string) {
  // Honeypot: real users never see or fill the "website" field.
  if (body.website) throw new HttpError(400, 'Submission rejected');
  throttle(ip);
  const r = createRequest(body, null, images, { source: 'public', ip });
  return { request_no: r.request_no, tracking_token: r.tracking_token };
}

export function trackPublicRequest(token: string) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) throw notFound('Job card');
  const r = get(
    `SELECT r.id, r.request_no, r.title, r.description, r.status, r.requested_at, r.target_date, r.current_stage_key,
            r.closure_category, r.closed_at, r.cancel_reason, p.name AS property_name, c.name AS category_name
     FROM requests r JOIN properties p ON p.id = r.property_id JOIN work_categories c ON c.id = r.category_id
     WHERE r.public_token = ?`,
    [token],
  );
  if (!r) throw notFound('Job card');
  const stages = all(`SELECT stage_key, status, actual_at FROM request_stages WHERE request_id = ? AND status <> 'skipped' ORDER BY seq`, [r.id])
    .map((s) => ({ name: stageName(s.stage_key), status: s.status, actual_at: s.actual_at }));
  return {
    request_no: r.request_no,
    title: r.title,
    description: r.description,
    property: r.property_name,
    category: r.category_name,
    requested_at: r.requested_at,
    target_date: r.target_date,
    status: r.status,
    status_label: REQUEST_STATUSES.find((s) => s.key === r.status)?.label ?? r.status,
    current_stage: stageName(r.current_stage_key),
    closure_category: r.closure_category,
    closed_at: r.closed_at,
    rejection_reason: r.status === 'cancelled' ? r.cancel_reason : null,
    stages,
  };
}
