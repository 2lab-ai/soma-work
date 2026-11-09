/**
 * The dashboard's cron editor (#1080): a job's whole content for the cron
 * drawer's 내용 보기, and the change its 편집 form sends.
 *
 * The CRON lane (cron-view.ts) never carries a job's prompt. This detail does,
 * so the route serves it only to whoever may change the job — its owner, or an
 * admin with Admin mode on (the #716 write gate).
 *
 * The rules are the ones the Slack edit modal (cron-edit-view-submission-handler.ts)
 * and the cron MCP server's cron_update (buildUpdatePatch) apply, so a job
 * edited here could have been edited there. That validator lives inside the
 * MCP server package and reads its own argument names (model_type, model_name,
 * clear_threadTs), so the dashboard's form gets its own small copy of the rules:
 *   - name: isValidCronName; a clash with another job of the same owner is the
 *     storage's DUPLICATE_NAME (the route answers 409);
 *   - expression: a 5-field cron expression, read in UTC (isValidCronExpression);
 *   - prompt: 1–4000 characters;
 *   - channel: a Slack channel (C…) or DM (D…) id; moving the job drops a
 *     thread anchor from the old channel, as the Slack modal does;
 *   - mode: default | fastlane — 'default' is stored as no override;
 *   - target: channel | thread | dm, mapped as cron_update maps them. A thread
 *     reply goes to the thread the job is anchored to, and the dashboard cannot
 *     pick a Slack thread, so it needs the anchor the job already has;
 *   - model: default | opus | fable | fast | custom (custom pins a model id).
 * The refusals are in the reader's language (t()): the drawer shows them as they are.
 */

import { t, tr } from '@soma/common/i18n';
import {
  type CronJob,
  type CronJobPatch,
  type CronMode,
  type CronModelConfig,
  type CronTarget,
  isValidCronExpression,
  isValidCronName,
} from 'somalib/cron/cron-storage';
import { nextCronFire } from './cron-view';

/** The prompt cap of the text command and cron_update (the Slack modal stops at its own 3000). */
export const CRON_PROMPT_MAX = 4000;
/** A model id longer than this is no model id. */
const MODEL_ID_MAX = 200;

/** A job as the drawer's 내용 보기 shows it — times in epoch ms. */
export interface CronJobDetail {
  id: string;
  name: string;
  /** 5-field cron, UTC. */
  expression: string;
  prompt: string;
  owner: string;
  channel: string;
  /** The thread the job replies in or runs in, when it is anchored to one. */
  threadTs: string | null;
  mode: CronMode;
  target: CronTarget;
  /** `{ type: 'default' }` when the job has no override (the creator's current model at fire time). */
  model: CronModelConfig;
  /** Who besides the owner may fire it on demand. */
  runAllowlist: string[];
  createdAt: number | null;
  scheduleChangedAt: number | null;
  lastRunAt: number | null;
  /** The next scheduled fire, or null when none within 8 days. */
  nextRunAt: number | null;
}

function epoch(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function cronJobDetail(job: CronJob, nowMs: number): CronJobDetail {
  const model: CronModelConfig =
    job.modelConfig?.type === 'custom'
      ? { type: 'custom', ...(job.modelConfig.model ? { model: job.modelConfig.model } : {}) }
      : { type: job.modelConfig?.type ?? 'default' };
  return {
    id: job.id,
    name: job.name,
    expression: job.expression,
    prompt: job.prompt,
    owner: job.owner,
    channel: job.channel,
    threadTs: job.threadTs ?? null,
    mode: job.mode ?? 'default',
    target: job.target ?? 'channel',
    model,
    runAllowlist: [...(job.runAllowlist ?? [])],
    createdAt: epoch(job.createdAt),
    scheduleChangedAt: epoch(job.scheduleChangedAt),
    lastRunAt: epoch(job.lastRunAt),
    nextRunAt: nextCronFire(job.expression, nowMs),
  };
}

export type CronEditResult = { ok: true; patch: CronJobPatch } | { ok: false; error: string; field?: string };

const EDIT_FIELDS = new Set(['name', 'expression', 'prompt', 'channel', 'mode', 'target', 'model']);

function refuse(field: string | undefined, error: string): CronEditResult {
  return { ok: false, error, ...(field ? { field } : {}) };
}

/**
 * The storage patch for the form's body, or why not. Every field is optional;
 * a field the form never sends (owner, threadTs, …) is refused rather than
 * ignored, so a caller never believes it changed something it did not.
 */
export function buildCronEditPatch(body: unknown, job: CronJob): CronEditResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return refuse(undefined, t('보낸 내용이 올바른 형식이 아니에요'));
  }
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length === 0) return refuse(undefined, t('바꿀 내용이 없어요'));
  for (const key of keys) {
    if (!EDIT_FIELDS.has(key)) return refuse(key, tr`대시보드에서 바꿀 수 없는 항목이에요: ${key}`);
  }

  const patch: CronJobPatch = {};

  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!isValidCronName(name)) return refuse('name', t('이름은 영문, 숫자, 하이픈(-), 밑줄(_)로 1–64자여야 해요'));
    patch.name = name;
  }

  if (input.expression !== undefined) {
    // One space apart, as the lane's schedule words read it.
    const expression = typeof input.expression === 'string' ? input.expression.trim().split(/\s+/).join(' ') : '';
    if (!isValidCronExpression(expression)) {
      return refuse('expression', t('스케줄은 5칸 cron 식이어야 해요: 분 시 일 월 요일, UTC 기준 (예: 0 0 * * 1-5)'));
    }
    patch.expression = expression;
  }

  if (input.prompt !== undefined) {
    const prompt = input.prompt;
    if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > CRON_PROMPT_MAX) {
      return refuse('prompt', t('프롬프트는 1–4,000자여야 해요'));
    }
    patch.prompt = prompt;
  }

  if (input.channel !== undefined) {
    const channel = typeof input.channel === 'string' ? input.channel.trim() : '';
    if (!/^[CD][A-Z0-9]+$/.test(channel)) {
      return refuse('channel', t('채널은 C(채널)나 D(DM)로 시작하는 Slack ID여야 해요'));
    }
    patch.channel = channel;
    // The scheduler replies in (channel, threadTs): an anchor from the old channel names a
    // thread the new one does not have. Back to channel delivery, as the Slack modal does.
    if (channel !== job.channel && (job.target === 'thread' || job.threadTs)) {
      patch.target = null;
      patch.threadTs = null;
    }
  }

  if (input.mode !== undefined) {
    if (input.mode !== 'default' && input.mode !== 'fastlane') {
      return refuse('mode', t('실행 방식은 default나 fastlane이어야 해요'));
    }
    patch.mode = input.mode === 'default' ? null : 'fastlane';
  }

  if (input.target !== undefined) {
    if (input.target === 'thread') {
      patch.target = 'thread';
    } else if (input.target === 'dm') {
      patch.target = 'dm';
      patch.threadTs = null;
    } else if (input.target === 'channel') {
      // cron_update's mapping: a new channel message, no thread anchor. The target the job
      // already has changes nothing — a channel job's anchor is the thread whose session it runs in.
      if ((job.target ?? 'channel') !== 'channel') {
        patch.target = null;
        patch.threadTs = null;
      }
    } else {
      return refuse('target', t('출력은 channel, thread, dm 중 하나여야 해요'));
    }
  }

  if (input.model !== undefined) {
    const model = input.model && typeof input.model === 'object' ? (input.model as Record<string, unknown>) : null;
    const type = model?.type;
    if (type === 'default') {
      // No override: the creator's current default model at fire time.
      patch.modelConfig = null;
    } else if (type === 'opus' || type === 'fable' || type === 'fast') {
      // Floating aliases — the scheduler resolves them at fire time.
      patch.modelConfig = { type };
    } else if (type === 'custom') {
      const id = typeof model?.model === 'string' ? model.model.trim() : '';
      if (!id || id.length > MODEL_ID_MAX || /\s/.test(id)) {
        return refuse('model', t('직접 입력한 모델 ID가 비었거나 올바르지 않아요'));
      }
      patch.modelConfig = { type: 'custom', model: id };
    } else {
      return refuse('model', t('모델은 default, opus, fable, fast, custom 중 하나여야 해요'));
    }
  }

  // Thread delivery always has a thread anchor (cron_update's invariant).
  const target = patch.target !== undefined ? patch.target : job.target;
  const threadTs = patch.threadTs !== undefined ? patch.threadTs : job.threadTs;
  if (target === 'thread' && !threadTs) {
    return refuse(
      'target',
      t('스레드 답글은 잡에 연결된 스레드가 있어야 해요. 대시보드에서는 스레드를 고를 수 없어요'),
    );
  }

  return { ok: true, patch };
}
