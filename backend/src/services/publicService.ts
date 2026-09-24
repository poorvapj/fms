import { col } from '../db/mongo.ts';
import { REQUEST_STATUSES, WORK_TYPES } from '../domain/workflow.ts';
import { HttpError, notFound } from '../utils/http.ts';
import { createRequest, type UploadedImage } from './requests.ts';
import { stageName } from './stageDefs.ts';

const CI = { locale: 'en', strength: 2 } as const;

export async function publicFormOptions() {
  const opts = { projection: { name: 1 }, collation: CI };
  const [properties, categories] = await Promise.all([
    col.properties().find({ active: 1 }, opts).sort({ sort_order: 1, name: 1 }).toArray(),
    col.categories().find({ active: 1 }, opts).sort({ sort_order: 1, name: 1 }).toArray(),
  ]);
  return {
    properties: properties.map((p) => ({ id: p._id, name: p.name })),
    categories: categories.map((c) => ({ id: c._id, name: c.name })),
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

export async function submitPublicRequest(body: any, images: UploadedImage[], ip: string) {
  // Honeypot: real users never see or fill the "website" field.
  if (body.website) throw new HttpError(400, 'Submission rejected');
  throttle(ip);
  const r = await createRequest(body, null, images, { source: 'public', ip });
  return { request_no: r.request_no, tracking_token: r.tracking_token };
}

export async function trackPublicRequest(token: string) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) throw notFound('Job card');
  const r = await col.requests().findOne({ public_token: token });
  if (!r) throw notFound('Job card');
  const [property, category] = await Promise.all([
    col.properties().findOne({ _id: r.property_id }, { projection: { name: 1 } }),
    col.categories().findOne({ _id: r.category_id }, { projection: { name: 1 } }),
  ]);
  return {
    request_no: r.request_no,
    title: r.title,
    description: r.description,
    property: property?.name ?? '—',
    category: category?.name ?? '—',
    requested_at: r.requested_at,
    target_date: r.target_date,
    status: r.status,
    status_label: REQUEST_STATUSES.find((s) => s.key === r.status)?.label ?? r.status,
    current_stage: stageName(r.current_stage_key),
    closure_category: r.closure_category,
    closed_at: r.closed_at,
    rejection_reason: r.status === 'cancelled' ? r.cancel_reason : null,
    stages: (r.stages as { stage_key: string; status: string; actual_at: string | null }[])
      .filter((s) => s.status !== 'skipped')
      .map((s) => ({ name: stageName(s.stage_key), status: s.status, actual_at: s.actual_at })),
  };
}
