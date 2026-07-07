/**
 * Block Kit builders + action_id helpers for the `cron` management card.
 *
 * Leaf module (no handler imports) so the command handler that renders the
 * card and the action handler that mutates it share the exact same block
 * shapes and action_ids without an import cycle.
 * Pattern: src/slack/autoskill-blocks.ts
 *
 * Card layout — per job:
 *   section  (name · schedule · channel · last run · prompt preview)
 *   actions  [모델 static_select] [출력 대상 static_select] [🗑 삭제 button]
 *
 * Authorization model: unlike the autoskill card (requester-locked), the cron
 * card is job-owner-scoped — the CLICKER must be the job's owner or an admin.
 * The action handler enforces this; the blocks only carry addressing.
 */

import type { CronJob } from 'somalib/cron/cron-storage';
import { AVAILABLE_MODELS } from '../user-settings-store';

/** action_id prefix routed by `app.action(/^cron_/)`. */
export const CRON_ACTION_PREFIX = 'cron_';

export type CronActionKind = 'model' | 'target' | 'delete';

/**
 * Encode job addressing into the element action_id: `cron_<kind>::<owner>::<name>`.
 * Safe separator: cron names are [a-zA-Z0-9_-]{1,64} and Slack user IDs never
 * contain ':'. Slack caps action_id at 255 chars — 5+11+64+4 fits easily.
 * Per-job action_ids also satisfy Slack's uniqueness-per-message guidance.
 */
export function cronActionId(kind: CronActionKind, owner: string, name: string): string {
  return `cron_${kind}::${owner}::${name}`;
}

export function parseCronActionId(actionId: string): { kind: CronActionKind; owner: string; name: string } | null {
  const m = actionId.match(/^cron_(model|target|delete)::([^:]+)::(.+)$/);
  if (!m) return null;
  return { kind: m[1] as CronActionKind, owner: m[2], name: m[3] };
}

/** static_select option values for the model select. */
export const CRON_MODEL_DEFAULT = 'default';
export const CRON_MODEL_FAST = 'fast';

/**
 * Slack caps a message at 50 blocks. Each job renders 3 blocks
 * (divider + section + actions); 15×3 + header + 2 context = 48.
 */
const MAX_CARD_JOBS = 15;

function modelOptions(): { text: { type: 'plain_text'; text: string }; value: string }[] {
  return [
    { text: { type: 'plain_text' as const, text: 'default — 만든 사람의 현재 모델' }, value: CRON_MODEL_DEFAULT },
    { text: { type: 'plain_text' as const, text: 'fast — sonnet' }, value: CRON_MODEL_FAST },
    ...AVAILABLE_MODELS.map((m) => ({ text: { type: 'plain_text' as const, text: m }, value: `custom:${m}` })),
  ];
}

function currentModelValue(job: CronJob): string {
  const c = job.modelConfig;
  if (!c || c.type === 'default') return CRON_MODEL_DEFAULT;
  if (c.type === 'fast') return CRON_MODEL_FAST;
  return `custom:${c.model ?? ''}`;
}

function targetOptions(): { text: { type: 'plain_text'; text: string }; value: string }[] {
  return [
    { text: { type: 'plain_text' as const, text: '채널 새 메시지' }, value: 'channel' },
    { text: { type: 'plain_text' as const, text: '스레드 답글' }, value: 'thread' },
    { text: { type: 'plain_text' as const, text: '오너에게 DM' }, value: 'dm' },
  ];
}

function describeModelShort(job: CronJob): string {
  const c = job.modelConfig;
  if (!c || c.type === 'default') return 'default(만든 사람의 현재 모델)';
  if (c.type === 'fast') return 'fast';
  return `custom(${c.model ?? '?'})`;
}

function jobSection(job: CronJob, showOwner: boolean): Record<string, any> {
  const ownerStr = showOwner ? ` · owner <@${job.owner}>` : '';
  const modeStr = job.mode === 'fastlane' ? ' · ⚡fastlane' : '';
  const last = job.lastRunMinute || 'never';
  const prompt = job.prompt.length > 80 ? `${job.prompt.substring(0, 80)}…` : job.prompt;
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${job.name}*${ownerStr}\n\`${job.expression}\` · <#${job.channel}>${modeStr} · last: ${last}\n↳ _${prompt}_`,
    },
  };
}

function jobActions(job: CronJob): Record<string, any> {
  const current = currentModelValue(job);
  const opts = modelOptions();
  // initial_option must be byte-identical to one of the options; a custom
  // model outside AVAILABLE_MODELS (legacy data) simply renders unselected.
  const initialModel = opts.find((o) => o.value === current);
  const tOpts = targetOptions();
  const initialTarget = tOpts.find((o) => o.value === (job.target ?? 'channel'));

  return {
    type: 'actions',
    elements: [
      {
        type: 'static_select',
        action_id: cronActionId('model', job.owner, job.name),
        placeholder: { type: 'plain_text', text: '모델' },
        options: opts,
        ...(initialModel ? { initial_option: initialModel } : {}),
      },
      {
        type: 'static_select',
        action_id: cronActionId('target', job.owner, job.name),
        placeholder: { type: 'plain_text', text: '출력 대상' },
        options: tOpts,
        ...(initialTarget ? { initial_option: initialTarget } : {}),
      },
      {
        type: 'button',
        action_id: cronActionId('delete', job.owner, job.name),
        text: { type: 'plain_text', text: '🗑 삭제' },
        style: 'danger',
        confirm: {
          title: { type: 'plain_text', text: '크론잡 삭제' },
          text: { type: 'mrkdwn', text: `*${job.name}* 을 삭제할까요? 실행 이력과 함께 되돌릴 수 없습니다.` },
          confirm: { type: 'plain_text', text: '삭제' },
          deny: { type: 'plain_text', text: '취소' },
        },
      },
    ],
  };
}

/**
 * Build the cron management card. `jobs` is already scoped by the caller
 * (admin = all users' jobs, non-admin = own jobs only).
 */
export function buildCronCard(args: { jobs: CronJob[]; isAdmin: boolean }): { text: string; blocks: any[] } {
  const { jobs, isAdmin } = args;

  const header = isAdmin ? `⏰ *크론잡 (${jobs.length})* — admin view, 전체 유저` : `⏰ *크론잡 (${jobs.length})*`;
  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: header } }];

  if (jobs.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '_등록된 크론잡이 없습니다._\n등록은 자연어로: "매일 아침 9시에 열린 PR 요약해줘, 크론으로 등록"',
      },
    });
    return { text: '⏰ 등록된 크론잡이 없습니다.', blocks };
  }

  for (const job of jobs.slice(0, MAX_CARD_JOBS)) {
    blocks.push({ type: 'divider' });
    blocks.push(jobSection(job, isAdmin));
    blocks.push(jobActions(job));
  }

  if (jobs.length > MAX_CARD_JOBS) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `⚠️ ${jobs.length - MAX_CARD_JOBS}개 잡은 블록 한도로 생략 — \`cron model <name> …\` 텍스트 명령으로 수정하세요.`,
        },
      ],
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text:
          '드롭다운으로 모델/출력 대상을 바로 변경합니다. 텍스트 명령: `cron model <name> <default|fast|모델>` · `cron target <name> <channel|dm|thread>` · `cron delete <name>`' +
          (isAdmin ? ' (admin: 끝에 `<@owner>`)' : ''),
      },
    ],
  });

  const text = jobs
    .map((j) => `${j.name} | ${j.expression} | model:${describeModelShort(j)} | target:${j.target ?? 'channel'}`)
    .join('\n');
  return { text: `⏰ 크론잡 (${jobs.length})\n${text}`, blocks };
}
