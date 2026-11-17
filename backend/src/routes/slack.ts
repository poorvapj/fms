import { timingSafeEqual, createHmac } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { config } from '../config.ts';
import { handleSlackInteraction } from '../services/slack.ts';

/** Slack signs the raw body; capture it before urlencoded parsing consumes the stream. */
function captureRawBody(req: Request, _res: Response, buf: Buffer) {
  (req as Request & { rawBody?: Buffer }).rawBody = buf;
}

function verifySlack(req: Request): boolean {
  const secret = config.slackSigningSecret;
  if (!secret) return false;
  const timestamp = req.get('X-Slack-Request-Timestamp');
  const signature = req.get('X-Slack-Signature');
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!timestamp || !signature || !raw) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const base = `v0:${timestamp}:${raw.toString('utf8')}`;
  const expected = `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const slackRoutes = express.Router();

slackRoutes.post('/interact', express.urlencoded({ extended: false, verify: captureRawBody }), (req, res) => {
  if (!verifySlack(req)) return res.status(401).send('Invalid signature');
  res.status(200).end();
  try {
    handleSlackInteraction(JSON.parse(req.body.payload)).catch((e) => console.error('Slack interaction failed:', e));
  } catch (e) {
    console.error('Slack payload parse failed:', e);
  }
});
