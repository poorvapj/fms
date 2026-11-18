import type { AuthUser } from '../auth/auth.ts';
import { config } from '../config.ts';
import { col } from '../db/mongo.ts';
import { WORK_TYPES } from '../domain/workflow.ts';
import { addAttachment } from './attachments.ts';
import { masterNames } from './masters.ts';
import { completeStage } from './stages.ts';
import { logEvent } from './events.ts';
import { loadRequest } from './requests.ts';
import { nowLocal } from '../utils/dates.ts';
import { refreshState, saveRequest, stageOf, type RequestDoc } from './workflowEngine.ts';

const SLACK_API = 'https://slack.com/api';

export function slackEnabled() {
  return !!config.slackBotToken;
}

async function slackApi(method: string, body: Record<string, unknown>) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${config.slackBotToken}` },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) console.error(`Slack ${method} failed:`, json.error);
  return json;
}

async function postToUrl(url: string, body: Record<string, unknown>) {
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}

/** Finds the Slack user whose workspace account uses this email — null if there's no match
 *  (e.g. an outside vendor/tenant with no Slack account), which callers should treat as "skip". */
async function lookupSlackUserByEmail(email: string): Promise<string | null> {
  const res = await fetch(`${SLACK_API}/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${config.slackBotToken}` },
  });
  const json = await res.json();
  if (!json.ok) {
    if (json.error !== 'users_not_found') console.error('Slack users.lookupByEmail failed:', json.error);
    return null;
  }
  return json.user?.id ?? null;
}

/** Replaces the original Yes/No message with the final result (no more buttons, so it can't be
 *  clicked again) and never expires, unlike `response_url`. Falls back to a fresh DM, then to
 *  `response_url`, if we don't have the original message's channel/ts (e.g. very old flows). */
async function confirmToUser(
  target: { channel?: string; ts?: string; slackUserId?: string; responseUrl?: string },
  text: string,
) {
  if (target.channel && target.ts) {
    const updated = await slackApi('chat.update', { channel: target.channel, ts: target.ts, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
    if (updated.ok) return;
  }
  if (target.slackUserId) await slackApi('chat.postMessage', { channel: target.slackUserId, text });
  else if (target.responseUrl) await postToUrl(target.responseUrl, { replace_original: true, text });
}

const FORM_INTAKE_CHANNEL = 'C0AVD30QM33';

/** "2026-11-13T18:25:31" -> "11/13/2026 18:25:31" (mirrors the Google Form's own Sheet timestamp format). */
function fmtUs(iso: string | null): string {
  if (!iso) return '';
  const [d, t] = iso.split('T');
  const [y, m, day] = d.split('-');
  return t ? `${m}/${day}/${y} ${t.slice(0, 8)}` : `${m}/${day}/${y}`;
}

/** Posts an already-downloaded image (bytes) into Slack as an actual photo. */
async function uploadImageBytesToSlack(bytes: Buffer, channel: string, title: string): Promise<boolean> {
  if (!bytes.length) return false;
  const filename = `${title}.jpg`;

  const urlForm = new URLSearchParams({ filename, length: String(bytes.length) });
  const urlRes = await (await fetch(`${SLACK_API}/files.getUploadURLExternal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${config.slackBotToken}` },
    body: urlForm,
  })).json();
  if (!urlRes.ok) { console.error('Slack files.getUploadURLExternal failed:', urlRes.error); return false; }
  const uploadRes = await fetch(urlRes.upload_url, { method: 'POST', body: new Uint8Array(bytes) });
  if (!uploadRes.ok) return false;
  const complete = await slackApi('files.completeUploadExternal', {
    files: [{ id: urlRes.file_id, title }], channel_id: channel,
  });
  if (!complete.ok) console.error('Slack files.completeUploadExternal response:', JSON.stringify(complete));
  return !!complete.ok;
}

/** A new pending job card was auto-created from a Google Form submission — post it in the same
 *  layout the "New Work Report" n8n notification uses, so both look the same in Slack. */
export async function notifyFormIntake(r: RequestDoc, extra: { image_url?: string | null; image_base64?: string | null; channel?: string } = {}) {
  if (!slackEnabled()) return;
  const names = await masterNames();
  const property = names.properties.get(r.property_id) ?? '—';
  const category = names.categories.get(r.category_id) ?? '—';
  const work = WORK_TYPES.find((w) => w.key === r.work_type)?.label ?? r.work_type ?? '';
  const lines = [
    '🏢 *New Work Report*',
    `🏠 *Property:* ${property}`,
    r.property_no ? `🔢 *Property No:* ${r.property_no}` : null,
    `🔧 *Work Category:* ${category}`,
    work ? `🛠️ *Work:* ${work}` : null,
    `🕐 *Timestamp:* ${fmtUs(r.requested_at)}`,
    `🗓️ *Work Completion Date:* ${fmtUs(r.target_date)}`,
    `📝 *Narration:* ${r.description}`,
    extra.image_url ? `📍 *Image of Location:* ${extra.image_url}` : null,
    r.requester_email ? `📧 *Email Address:* ${r.requester_email}` : null,
    r.reason ? `❓ *Reason:* ${r.reason}` : null,
  ].filter((l): l is string => !!l);
  const channel = extra.channel ?? FORM_INTAKE_CHANNEL;
  await slackApi('chat.postMessage', { channel, text: lines.join('\n'), unfurl_links: true });
  if (extra.image_base64) await uploadImageBytesToSlack(Buffer.from(extra.image_base64, 'base64'), channel, r.request_no);
}

/** A new pending job card was just raised through the public complaint form (fms-iota-ten.vercel.app/submit). */
export async function notifyPublicSubmission(r: RequestDoc, images: { buffer: Buffer }[] = []) {
  if (!slackEnabled()) return;
  const names = await masterNames();
  const property = names.properties.get(r.property_id) ?? '—';
  const category = names.categories.get(r.category_id) ?? '—';
  const work = WORK_TYPES.find((w) => w.key === r.work_type)?.label ?? r.work_type ?? '';
  const lines = [
    '🏢 *New Work Report (Public Form)*',
    `🏠 *Property:* ${property}`,
    r.property_no ? `🔢 *Property No:* ${r.property_no}` : null,
    `🔧 *Work Category:* ${category}`,
    work ? `🛠️ *Work:* ${work}` : null,
    `🕐 *Timestamp:* ${fmtUs(r.requested_at)}`,
    `🗓️ *Work Completion Date:* ${fmtUs(r.target_date)}`,
    `📝 *Narration:* ${r.description}`,
    r.requester_name ? `👤 *Requester:* ${r.requester_name}` : null,
    r.requester_contact ? `📞 *Contact:* ${r.requester_contact}` : null,
    r.requester_email ? `📧 *Email Address:* ${r.requester_email}` : null,
    r.reason ? `❓ *Reason:* ${r.reason}` : null,
  ].filter((l): l is string => !!l);
  const channel = FORM_INTAKE_CHANNEL;
  await slackApi('chat.postMessage', { channel, text: lines.join('\n'), unfurl_links: true });
  for (const img of images) await uploadImageBytesToSlack(img.buffer, channel, r.request_no);
}

/** Names of the engineers who should always get the Site Visit Yes/No DM, whether or not a
 *  site engineer has been formally assigned on the job card yet. */
const SITE_VISIT_NOTIFY = ['Kuldeep', 'Arun Batham'];
/** Additional people (not engineer records) who should get the same DM, just to stay in the loop —
 *  Poorva isn't a field engineer, so she's listed by Slack user ID directly instead. */
const SITE_VISIT_NOTIFY_EXTRA = [{ name: 'Poorva Jain', slack_user_id: 'U0BSHH0PJN5' }];

/** Site visit stage just went active — DM Kuldeep and Arun (whoever actually goes does the visit),
 *  once per job card, regardless of whether a site engineer has been assigned on the record. */
export async function notifySiteVisitIfNeeded(r: RequestDoc) {
  if (!slackEnabled()) return;
  const stage = r.stages.find((s) => s.stage_key === 'site_visit');
  if (!stage || stage.status !== 'active') return;
  const already = await col.events().findOne({ request_id: r._id, type: 'slack_notified', stage_key: 'site_visit' });
  if (already) return;
  const engineers = await col.engineers().find({ name: { $in: SITE_VISIT_NOTIFY }, slack_user_id: { $nin: [null, ''] } }).toArray();
  const recipients = [...engineers, ...SITE_VISIT_NOTIFY_EXTRA];
  if (!recipients.length) return;

  const names = await masterNames();
  const property = names.properties.get(r.property_id) ?? '—';
  const text = `*Site visit requested*\n*Job:* ${r.request_no}\n*Location:* ${property}\n*Details:* ${r.description}`;
  for (const eng of recipients) {
    await slackApi('chat.postMessage', {
      channel: eng.slack_user_id,
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: '✅ Yes, visited' }, style: 'primary', action_id: 'site_visit_yes', value: String(r._id) },
            { type: 'button', text: { type: 'plain_text', text: '❌ No' }, style: 'danger', action_id: 'site_visit_no', value: String(r._id) },
          ],
        },
      ],
    });
  }
  await logEvent(r._id, 'slack_notified', `Slack notification sent to ${recipients.map((e) => e.name).join(', ')} for Site Visit`, { stageKey: 'site_visit', userName: 'Slack' });
}

/** Job card just closed — DM the requester (matched by email to a Slack account in this
 *  workspace) asking them to confirm the work is actually done, once per job card. If their
 *  email doesn't match anyone in the workspace (e.g. an outside vendor/tenant), skip quietly. */
export async function notifyRequesterOnCloseIfNeeded(r: RequestDoc) {
  if (!slackEnabled() || r.status !== 'closed' || !r.requester_email) return;
  const already = await col.events().findOne({ request_id: r._id, type: 'slack_notified', stage_key: 'closure_confirm' });
  if (already) return;
  const slackUserId = await lookupSlackUserByEmail(r.requester_email);
  if (!slackUserId) return;

  const text = `*Your job card has been closed*\n*Job:* ${r.request_no}\n*Work:* ${r.description}\n\nIs the work actually done?`;
  await slackApi('chat.postMessage', {
    channel: slackUserId,
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: '✅ Yes, done' }, style: 'primary', action_id: 'closure_yes', value: String(r._id) },
          { type: 'button', text: { type: 'plain_text', text: '❌ No, not done' }, style: 'danger', action_id: 'closure_no', value: String(r._id) },
        ],
      },
    ],
  });
  await logEvent(r._id, 'slack_notified', `Slack closure-confirmation sent to requester (${r.requester_email})`, { stageKey: 'closure_confirm', userName: 'Slack' });
}

/** Body of a Slack interactivity POST (verified caller): block_actions or view_submission. */
export async function handleSlackInteraction(payload: any) {
  if (payload.type === 'block_actions') {
    const action = payload.actions?.[0];
    const requestId = Number(action?.value);
    if (!requestId) return;
    if (action.action_id === 'site_visit_yes') return handleYes(requestId, payload);
    if (action.action_id === 'site_visit_no') return handleNo(requestId, payload);
    if (action.action_id === 'closure_yes') return handleClosureYes(requestId, payload);
    if (action.action_id === 'closure_no') return handleClosureNo(requestId, payload);
  }
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'site_visit_no_reason') {
    return handleNoSubmit(payload);
  }
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'site_visit_yes_confirm') {
    return handleYesSubmit(payload);
  }
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'closure_no_reason') {
    return handleClosureNoSubmit(payload);
  }
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'closure_yes_confirm') {
    return handleClosureYesSubmit(payload);
  }
}

/** Resolves to whichever engineer actually clicked the Slack button — not necessarily the job
 *  card's assigned site engineer, since the Yes/No DM goes to Kuldeep and Arun either way. */
async function siteVisitUser(requestId: number, slackUserId: string | undefined): Promise<{ user: AuthUser; r: RequestDoc } | null> {
  const r = await loadRequest(requestId);
  const eng = slackUserId ? await col.engineers().findOne({ slack_user_id: slackUserId }) : null;
  const extra = !eng && slackUserId ? SITE_VISIT_NOTIFY_EXTRA.find((p) => p.slack_user_id === slackUserId) : null;
  // 'admin' (not 'engineer') so this isn't blocked by the assigned-site-engineer binding check —
  // the Yes/No DM goes to Kuldeep and Arun regardless of who's formally assigned on the record.
  const user: AuthUser = { id: 0, username: 'slack', name: eng?.name ?? extra?.name ?? 'Slack', role: 'admin', engineer_id: eng?._id ?? null, must_change_password: false };
  return { user, r };
}

/** "Yes, visited" opens a small modal offering an optional proof photo — never blocks on it.
 *  If the modal itself fails to open (e.g. a Slack API/permission hiccup), fall back to marking
 *  the stage done immediately, same as before the photo option existed, instead of doing nothing. */
async function handleYes(requestId: number, payload: any) {
  const opened = await slackApi('views.open', {
    trigger_id: payload.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'site_visit_yes_confirm',
      private_metadata: JSON.stringify({ requestId, responseUrl: payload.response_url, slackUserId: payload.user?.id, channel: payload.channel?.id, ts: payload.message?.ts }),
      title: { type: 'plain_text', text: 'Site visit done' },
      submit: { type: 'plain_text', text: 'Mark Done' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'photo_block',
          optional: true,
          label: { type: 'plain_text', text: 'Photo link (optional, as proof — paste a Google Drive / image URL)' },
          element: { type: 'plain_text_input', action_id: 'photo' },
        },
      ],
    },
  });
  if (opened.ok) return;
  console.error('views.open failed, falling back to direct complete:', opened.error);
  const slackUserId: string | undefined = payload.user?.id;
  const target = { channel: payload.channel?.id, ts: payload.message?.ts, slackUserId, responseUrl: payload.response_url };
  const found = await siteVisitUser(requestId, slackUserId);
  if (!found) return confirmToUser(target, 'This job card could not be updated.');
  try {
    await completeStage(requestId, 'site_visit', {}, found.user);
    await confirmToUser(target, `✅ Marked *Site Visit* as done for ${found.r.request_no} by ${found.user.name}. Thanks!`);
  } catch (err) {
    await confirmToUser(target, `Could not update: ${(err as Error).message}`);
  }
}

async function handleYesSubmit(payload: any) {
  const { requestId, responseUrl, slackUserId, channel, ts } = JSON.parse(payload.view.private_metadata);
  const target = { channel, ts, slackUserId, responseUrl };
  try {
    const found = await siteVisitUser(requestId, slackUserId);
    if (!found) return confirmToUser(target, 'This job card could not be updated.');
    await completeStage(requestId, 'site_visit', {}, found.user);
    const link = (payload.view.state.values.photo_block?.photo?.value as string | null)?.trim();
    if (link && /^https?:\/\//i.test(link)) {
      await addAttachment(requestId, { stage_key: 'site_visit', url: link }, found.user);
    }
    await confirmToUser(target, `✅ Marked *Site Visit* as done for ${found.r.request_no} by ${found.user.name}${link ? ' (with photo link)' : ''}. Thanks!`);
  } catch (err) {
    await confirmToUser(target, `Could not update: ${(err as Error).message}`);
  }
}

async function handleNo(requestId: number, payload: any) {
  await slackApi('views.open', {
    trigger_id: payload.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'site_visit_no_reason',
      private_metadata: JSON.stringify({ requestId, responseUrl: payload.response_url, slackUserId: payload.user?.id, channel: payload.channel?.id, ts: payload.message?.ts }),
      title: { type: 'plain_text', text: 'Site visit not done' },
      submit: { type: 'plain_text', text: 'Send' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'reason_block',
          label: { type: 'plain_text', text: 'Why not?' },
          element: { type: 'plain_text_input', action_id: 'reason', multiline: true },
        },
      ],
    },
  });
}

async function handleNoSubmit(payload: any) {
  const { requestId, responseUrl, slackUserId, channel, ts } = JSON.parse(payload.view.private_metadata);
  const target = { channel, ts, slackUserId, responseUrl };
  const reason = payload.view.state.values.reason_block.reason.value as string;
  try {
    const r = await loadRequest(requestId);
    const eng = slackUserId ? await col.engineers().findOne({ slack_user_id: slackUserId }) : null;
    const stage = stageOf(r, 'site_visit');
    Object.assign(stage, { attention: true, comments: `Not visited (Slack): ${reason}`, updated_at: nowLocal() });
    refreshState(r);
    await saveRequest(r);
    await logEvent(requestId, 'comment', `Site visit not done (via Slack) — ${reason}`, { stageKey: 'site_visit', userName: eng?.name ?? 'Slack' });
    await confirmToUser(target, `❌ Marked *Site Visit* not done for ${r.request_no} by ${eng?.name ?? 'Slack'}.\nReason: ${reason}`);
  } catch (err) {
    await confirmToUser(target, `Could not update: ${(err as Error).message}`);
  }
}

/** "Yes, done" (requester confirming a closed job card) opens a small modal offering an optional
 *  proof photo, then posts the result into the job-card channel — never changes the job card's
 *  own status, this is just the requester's feedback on record. */
async function handleClosureYes(requestId: number, payload: any) {
  await slackApi('views.open', {
    trigger_id: payload.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'closure_yes_confirm',
      private_metadata: JSON.stringify({ requestId, responseUrl: payload.response_url, slackUserId: payload.user?.id, channel: payload.channel?.id, ts: payload.message?.ts }),
      title: { type: 'plain_text', text: 'Work done' },
      submit: { type: 'plain_text', text: 'Confirm' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'photo_block',
          optional: true,
          label: { type: 'plain_text', text: 'Photo of completed work (optional — paste a Google Drive / image URL)' },
          element: { type: 'plain_text_input', action_id: 'photo' },
        },
      ],
    },
  });
}

async function handleClosureYesSubmit(payload: any) {
  const { requestId, responseUrl, slackUserId, channel, ts } = JSON.parse(payload.view.private_metadata);
  const target = { channel, ts, slackUserId, responseUrl };
  try {
    const r = await loadRequest(requestId);
    const link = (payload.view.state.values.photo_block?.photo?.value as string | null)?.trim();
    if (link && /^https?:\/\//i.test(link)) {
      await addAttachment(requestId, { stage_key: 'closed', url: link }, { id: 0, username: 'slack', name: r.requester_name ?? 'Requester', role: 'admin', engineer_id: null, must_change_password: false });
    }
    await logEvent(requestId, 'comment', `Requester confirmed work done${link ? ' (with photo)' : ''}`, { stageKey: 'closed', userName: r.requester_name ?? 'Requester' });
    await slackApi('chat.postMessage', { channel: FORM_INTAKE_CHANNEL, text: `✅ *Work done* confirmed by requester for ${r.request_no}${link ? ` (photo: ${link})` : ''}.` });
    await confirmToUser(target, `✅ Thanks! Marked as done for ${r.request_no}.`);
  } catch (err) {
    await confirmToUser(target, `Could not record this: ${(err as Error).message}`);
  }
}

/** "No, not done" — same shape as "Yes" but asks for a reason and posts a not-done flag instead. */
async function handleClosureNo(requestId: number, payload: any) {
  await slackApi('views.open', {
    trigger_id: payload.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'closure_no_reason',
      private_metadata: JSON.stringify({ requestId, responseUrl: payload.response_url, slackUserId: payload.user?.id, channel: payload.channel?.id, ts: payload.message?.ts }),
      title: { type: 'plain_text', text: 'Work not done' },
      submit: { type: 'plain_text', text: 'Send' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'reason_block',
          label: { type: 'plain_text', text: "What's still pending?" },
          element: { type: 'plain_text_input', action_id: 'reason', multiline: true },
        },
      ],
    },
  });
}

async function handleClosureNoSubmit(payload: any) {
  const { requestId, responseUrl, slackUserId, channel, ts } = JSON.parse(payload.view.private_metadata);
  const target = { channel, ts, slackUserId, responseUrl };
  const reason = payload.view.state.values.reason_block.reason.value as string;
  try {
    const r = await loadRequest(requestId);
    await logEvent(requestId, 'comment', `Requester says work not done — ${reason}`, { stageKey: 'closed', userName: r.requester_name ?? 'Requester' });
    await slackApi('chat.postMessage', { channel: FORM_INTAKE_CHANNEL, text: `❌ *Work NOT done* — requester on ${r.request_no} says:\n${reason}` });
    await confirmToUser(target, `Got it — marked as not done for ${r.request_no}. The team will follow up.`);
  } catch (err) {
    await confirmToUser(target, `Could not record this: ${(err as Error).message}`);
  }
}
