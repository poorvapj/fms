import { GridFSBucket, MongoClient, ServerApiVersion, type Collection, type Db } from 'mongodb';
import { config } from '../config.ts';

/**
 * MongoDB access. Documents keep numeric `_id`s (from the `counters` collection) so URLs and the
 * API stay exactly as before; dates are local wall-clock strings "YYYY-MM-DDTHH:mm:ss".
 */

/** Loose document type: numeric (or string) `_id`s, any other fields. */
export type Doc = Record<string, any>;

let client: MongoClient | null = null;
let database: Db | null = null;
let bucket: GridFSBucket | null = null;

export async function connect(uri = config.mongoUri, dbName = config.mongoDb): Promise<Db> {
  if (database) return database;
  if (!uri) {
    throw new Error(
      `No MongoDB address for the ${config.env.toUpperCase()} environment. ` +
      `Set ${config.env === 'live' ? 'MONGODB_URI_LIVE' : 'MONGODB_URI_LOCAL'} in backend/.env (or in the host's environment settings).`,
    );
  }
  // Atlas Stable API v1 (not strict: the app uses distinct/collation, which strict mode rejects).
  client = new MongoClient(uri, { serverApi: { version: ServerApiVersion.v1, deprecationErrors: true }, serverSelectionTimeoutMS: 15000, appName: 'fms-operations' });
  await client.connect();
  database = client.db(dbName);
  bucket = new GridFSBucket(database, { bucketName: 'uploads' });
  await ensureIndexes(database);
  return database;
}

export async function disconnect() {
  await client?.close();
  client = null;
  database = null;
  bucket = null;
}

function db(): Db {
  if (!database) throw new Error('Database not connected');
  return database;
}

export const col = {
  counters: () => db().collection<{ _id: string; seq: number }>('counters'),
  users: () => db().collection<any>('users'),
  properties: () => db().collection<any>('properties'),
  categories: () => db().collection<any>('work_categories'),
  engineers: () => db().collection<any>('engineers'),
  closureCategories: () => db().collection<any>('closure_categories'),
  workflowStages: () => db().collection<any>('workflow_stages'),
  requests: () => db().collection<any>('requests'),
  events: () => db().collection<any>('request_events'),
  attachments: () => db().collection<any>('attachments'),
  legacyRows: () => db().collection<any>('legacy_rows'),
  batches: () => db().collection<any>('import_batches'),
  issues: () => db().collection<any>('import_issues'),
  importUploads: () => db().collection<any>('import_uploads'),
};

export type MasterTable = 'properties' | 'work_categories' | 'engineers';
export function masterCol(table: MasterTable): Collection<any> {
  return table === 'properties' ? col.properties() : table === 'work_categories' ? col.categories() : col.engineers();
}

export function files(): GridFSBucket {
  if (!bucket) throw new Error('Database not connected');
  return bucket;
}

/** Reserve `count` consecutive values of a named sequence; returns the first one. */
export async function nextSequence(name: string, count = 1): Promise<number> {
  const r = await col.counters().findOneAndUpdate({ _id: name }, { $inc: { seq: count } }, { upsert: true, returnDocument: 'after' });
  return r!.seq - count + 1;
}

/** Numeric id for a new document in a collection. */
export function nextId(collection: string, count = 1): Promise<number> {
  return nextSequence(`id:${collection}`, count);
}

const CI = { locale: 'en', strength: 2 } as const; // case-insensitive

async function ensureIndexes(d: Db) {
  await Promise.all([
    d.collection('users').createIndex({ username: 1 }, { unique: true, collation: CI }),
    d.collection('users').createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } }, collation: CI }),
    d.collection('properties').createIndex({ name: 1 }, { unique: true, collation: CI }),
    d.collection('work_categories').createIndex({ name: 1 }, { unique: true, collation: CI }),
    d.collection('engineers').createIndex({ name: 1 }, { unique: true, collation: CI }),
    d.collection('closure_categories').createIndex({ name: 1 }, { unique: true, collation: CI }),
    d.collection('requests').createIndex({ request_no: 1 }, { unique: true }),
    d.collection('requests').createIndex({ legacy_key: 1 }, { unique: true, partialFilterExpression: { legacy_key: { $type: 'string' } } }),
    d.collection('requests').createIndex({ public_token: 1 }, { unique: true, partialFilterExpression: { public_token: { $type: 'string' } } }),
    d.collection('requests').createIndex({ status: 1, current_stage_key: 1 }),
    d.collection('requests').createIndex({ requested_at: -1 }),
    d.collection('requests').createIndex({ property_id: 1 }),
    d.collection('requests').createIndex({ assigned_engineer_id: 1 }),
    d.collection('requests').createIndex({ site_engineer_id: 1 }),
    d.collection('requests').createIndex({ import_batch_id: 1 }),
    d.collection('request_events').createIndex({ request_id: 1, created_at: -1 }),
    d.collection('request_events').createIndex({ created_at: -1 }),
    d.collection('attachments').createIndex({ request_id: 1 }),
    d.collection('legacy_rows').createIndex({ request_id: 1 }, { unique: true }),
    d.collection('import_issues').createIndex({ batch_id: 1, row_no: 1 }),
    // Wizard uploads are temporary: removed automatically after a day.
    d.collection('import_uploads').createIndex({ created_at_date: 1 }, { expireAfterSeconds: 86400 }),
  ]);
}

/** Strip Mongo's `_id` into `id` for API responses. */
export function withId<T extends Doc>(d: T | null | undefined): (Omit<T, '_id'> & { id: any }) | null {
  if (!d) return null;
  const { _id, ...rest } = d;
  return { id: _id, ...rest } as any;
}

export function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}
