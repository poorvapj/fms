import type { AuthUser } from '../auth/auth.ts';
import { config } from '../config.ts';
import { col } from '../db/mongo.ts';
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

/** Site visit stage just went active — DM the assigned site engineer if we have their Slack ID, once. */
export async function notifySiteVisitIfNeeded(r: RequestDoc) {
  if (!slackEnabled()) return;
  const stage = r.stages.find((s) => s.stage_key === 'site_visit');
  if (!stage || stage.status !== 'active' || !r.site_engineer_id) return;
  const already = await col.events().findOne({ request_id: r._id, type: 'slack_notified', stage_key: 'site_visit' });
  if (already) return;
  const eng = await col.engineers().findOne({ _id: r.site_engineer_id });
  if (!eng?.slack_user_id) return;

  const names = await masterNames();
  const property = names.properties.get(r.property_id) ?? '—';
  const text = `*Site visit requested*\n*Job:* ${r.request_no}\n*Location:* ${property}\n*Details:* ${r.description}`;
  const res = await slackApi('chat.postMessage', {
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
  await logEvent(r._id, 'slack_notified', `Slack notification sent to ${eng.name} for Site Visit`, { stageKey: 'site_visit', userName: 'Slack' });
  return res;
}

/** Body of a Slack interactivity POST (verified caller): block_actions or view_submission. */
export async function handleSlackInteraction(payload: any) {
  if (payload.type === 'block_actions') {
    const action = payload.actions?.[0];
    const requestId = Number(action?.value);
    if (!requestId) return;
    if (action.action_id === 'site_visit_yes') return handleYes(requestId, payload);
    if (action.action_id === 'site_visit_no') return handleNo(requestId, payload);
  }
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'site_visit_no_reason') {
    return handleNoSubmit(payload);
  }
}

async function siteVisitUser(requestId: number): Promise<{ user: AuthUser; r: RequestDoc } | null> {
  const r = await loadRequest(requestId);
  if (!r.site_engineer_id) return null;
  const eng = await col.engineers().findOne({ _id: r.site_engineer_id });
  if (!eng) return null;
  const user: AuthUser = { id: 0, username: 'slack', name: eng.name, role: 'engineer', engineer_id: eng._id, must_change_password: false };
  return { user, r };
}

async function handleYes(requestId: number, payload: any) {
  const found = await siteVisitUser(requestId);
  const responseUrl = payload.response_url;
  if (!found) return postToUrl(responseUrl, { replace_original: true, text: 'This job card could not be updated.' });
  try {
    await completeStage(requestId, 'site_visit', {}, found.user);
    await postToUrl(responseUrl, { replace_original: true, text: `✅ Marked *Site Visit* as done for ${found.r.request_no}. Thanks!` });
  } catch (err) {
    await postToUrl(responseUrl, { replace_original: true, text: `Could not update: ${(err as Error).message}` });
  }
}

async function handleNo(requestId: number, payload: any) {
  await slackApi('views.open', {
    trigger_id: payload.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'site_visit_no_reason',
      private_metadata: JSON.stringify({ requestId, responseUrl: payload.response_url }),
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
  const { requestId, responseUrl } = JSON.parse(payload.view.private_metadata);
  const reason = payload.view.state.values.reason_block.reason.value as string;
  const r = await loadRequest(requestId);
  const eng = r.site_engineer_id ? await col.engineers().findOne({ _id: r.site_engineer_id }) : null;
  const stage = stageOf(r, 'site_visit');
  Object.assign(stage, { attention: true, comments: `Not visited (Slack): ${reason}`, updated_at: nowLocal() });
  refreshState(r);
  await saveRequest(r);
  await logEvent(requestId, 'comment', `Site visit not done (via Slack) — ${reason}`, { stageKey: 'site_visit', userName: eng?.name ?? 'Slack' });
  await postToUrl(responseUrl, { replace_original: true, text: `❌ Marked *Site Visit* not done for ${r.request_no}.\nReason: ${reason}` });
}
