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

export type CronActionKind = 'model' | 'target' | 'mode' | 'edit' | 'run' | 'delete';

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
  const m = actionId.match(/^cron_(model|target|mode|edit|run|delete)::([^:]+)::(.+)$/);
  if (!m) return null;
  return { kind: m[1] as CronActionKind, owner: m[2], name: m[3] };
}

/** static_select option values for the model select. */
export const CRON_MODEL_DEFAULT = 'default';
export const CRON_MODEL_FAST = 'fast';

/** Slack plain_text_input.max_length hard cap (1..3000). */
const MODAL_PROMPT_MAX = 3000;

/** view callback_id for the per-job edit modal submit. */
export const CRON_EDIT_MODAL_CALLBACK_ID = 'cron_edit_modal_submit';
/** input block_ids / action_ids inside the edit modal. */
export const CRON_EDIT_NAME_BLOCK = 'cron_edit_name';
export const CRON_EDIT_EXPR_BLOCK = 'cron_edit_expr';
export const CRON_EDIT_CHANNEL_BLOCK = 'cron_edit_channel';
export const CRON_EDIT_PROMPT_BLOCK = 'cron_edit_prompt';
export const CRON_EDIT_INPUT_ACTION = 'value';

export interface CronEditModalMetadata {
  /** Job addressing at open time (rename changes name on submit). */
  owner: string;
  name: string;
  /** Card message to re-render after submit. */
  cardChannelId: string;
  cardMessageTs: string;
  /** The user who opened the modal — only they may submit it. */
  requesterId: string;
}

export function parseCronEditModalMetadata(raw: unknown): CronEditModalMetadata | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v = JSON.parse(raw);
    if (typeof v?.owner === 'string' && typeof v?.name === 'string' && typeof v?.requesterId === 'string') {
      return v as CronEditModalMetadata;
    }
  } catch {
    // fall through
  }
  return null;
}

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

function modeOptions(): { text: { type: 'plain_text'; text: string }; value: string }[] {
  return [
    { text: { type: 'plain_text' as const, text: 'default — 대기열 사용' }, value: 'default' },
    { text: { type: 'plain_text' as const, text: '⚡ fastlane — 항상 새 스레드 즉시' }, value: 'fastlane' },
  ];
}

function describeModelShort(job: CronJob): string {
  const c = job.modelConfig;
  if (!c || c.type === 'default') return 'default(만든 사람의 현재 모델)';
  if (c.type === 'fast') return 'fast';
  return `custom(${c.model ?? '?'})`;
}

function describeTargetShort(job: CronJob): string {
  const target = job.target ?? 'channel';
  if (target === 'channel') return `채널(<#${job.channel}>)`;
  if (target === 'dm') return 'DM(오너)';
  return `스레드(<#${job.channel}> ts:${job.threadTs ?? '?'})`;
}

/**
 * Current-settings line is the single source the user reads to confirm a
 * change: every dropdown mutation re-renders the card, so the new value MUST
 * be visible here as text (initial_option alone is too subtle to notice).
 */
function jobSection(job: CronJob, showOwner: boolean): Record<string, any> {
  const ownerStr = showOwner ? ` · owner <@${job.owner}>` : '';
  const last = job.lastRunMinute || 'never';
  const prompt = job.prompt.length > 80 ? `${job.prompt.substring(0, 80)}…` : job.prompt;
  const settings = `현재 설정 → 모델: *${describeModelShort(job)}* · 출력: *${describeTargetShort(job)}* · 모드: *${job.mode === 'fastlane' ? '⚡fastlane' : 'default'}*`;
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${job.name}*${ownerStr} · \`${job.expression}\` · last: ${last}\n${settings}\n↳ _${prompt}_`,
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

  const mOpts = modeOptions();
  const initialMode = mOpts.find((o) => o.value === (job.mode ?? 'default'));

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
        type: 'static_select',
        action_id: cronActionId('mode', job.owner, job.name),
        placeholder: { type: 'plain_text', text: '실행 모드' },
        options: mOpts,
        ...(initialMode ? { initial_option: initialMode } : {}),
      },
      {
        type: 'button',
        action_id: cronActionId('run', job.owner, job.name),
        text: { type: 'plain_text', text: '▶ 지금 실행' },
        style: 'primary',
        // Fires through CronScheduler.runJobNow — the REAL cron execution path.
      },
      {
        type: 'button',
        action_id: cronActionId('edit', job.owner, job.name),
        text: { type: 'plain_text', text: '✏️ 편집' },
        // Opens the edit modal: name / schedule / channel / prompt.
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
 * Per-job edit modal: rename, 5-field schedule, target channel (native
 * channel picker — searchable), and the prompt (multiline). Model/target/mode
 * stay on the card dropdowns; this modal covers the free-form fields.
 */
export function buildCronEditModal(args: { job: CronJob; metadata: CronEditModalMetadata }): Record<string, any> {
  const { job, metadata } = args;
  return {
    type: 'modal',
    callback_id: CRON_EDIT_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(metadata),
    title: { type: 'plain_text', text: '크론잡 편집' },
    submit: { type: 'plain_text', text: '저장' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      {
        type: 'input',
        block_id: CRON_EDIT_NAME_BLOCK,
        label: { type: 'plain_text', text: '이름' },
        element: {
          type: 'plain_text_input',
          action_id: CRON_EDIT_INPUT_ACTION,
          initial_value: job.name,
          max_length: 64,
        },
        hint: { type: 'plain_text', text: '영문/숫자/하이픈/언더스코어, 1-64자' },
      },
      {
        type: 'input',
        block_id: CRON_EDIT_EXPR_BLOCK,
        label: { type: 'plain_text', text: '스케줄 (5-field cron, UTC)' },
        element: {
          type: 'plain_text_input',
          action_id: CRON_EDIT_INPUT_ACTION,
          initial_value: job.expression,
        },
        hint: { type: 'plain_text', text: '예: 0 9 * * 1-5 (평일 09:00 UTC = 18:00 KST)' },
      },
      {
        type: 'input',
        block_id: CRON_EDIT_CHANNEL_BLOCK,
        label: { type: 'plain_text', text: '출력 채널' },
        element: {
          type: 'channels_select',
          action_id: CRON_EDIT_INPUT_ACTION,
          ...(job.channel?.startsWith('C') ? { initial_channel: job.channel } : {}),
        },
      },
      {
        type: 'input',
        block_id: CRON_EDIT_PROMPT_BLOCK,
        label: { type: 'plain_text', text: '작업 프롬프트' },
        element: {
          type: 'plain_text_input',
          action_id: CRON_EDIT_INPUT_ACTION,
          multiline: true,
          // Slack caps plain_text_input.max_length at 3000 (1..3000) — a
          // larger value makes views.open reject the whole modal. Storage
          // allows 4000, so longer prompts are truncated here for display and
          // must be edited via the text command instead.
          initial_value: job.prompt.length > MODAL_PROMPT_MAX ? job.prompt.substring(0, MODAL_PROMPT_MAX) : job.prompt,
          max_length: MODAL_PROMPT_MAX,
        },
        hint: {
          type: 'plain_text',
          text:
            job.prompt.length > MODAL_PROMPT_MAX
              ? `⚠️ 기존 프롬프트가 ${job.prompt.length}자라 ${MODAL_PROMPT_MAX}자로 잘려 표시됩니다 — 긴 프롬프트는 \`cron prompt <name> <텍스트>\` 명령을 쓰세요.`
              : `최대 ${MODAL_PROMPT_MAX}자 (Slack 입력 한도). 더 길게는 cron prompt 명령 사용.`,
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
