import * as path from 'path';
import {
  type CronJob,
  type CronJobPatch,
  CronStorage,
  isRunAllowed,
  isValidCronExpression,
  isValidCronName,
} from 'somalib/cron/cron-storage';
import { isAdminUser } from '../../admin-utils';
import { getActiveCronScheduler } from '../../cron-scheduler';
import { DATA_DIR } from '../../env-paths';
import { userSettingsStore } from '../../user-settings-store';
import { buildCronCard } from '../cron-blocks';
import {
  type CronRunPermissionSlackApi,
  describeDelivery,
  requestCronRunPermission,
} from '../cron-run-permission-request';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * CronCommandHandler — `cron` / `schedule` as a first-class user command.
 *
 * Why a command and not (only) a skill: plain text goes through the model
 * dispatch path where autogoal can promote it to a session goal before the
 * model ever sees it (observed live: typing `cron` produced
 * "Autogoal: 이 지시를 goal로 설정했습니다 — cron"). Commands are routed in
 * slack-handler BEFORE dispatch/autogoal, so `cron` here always lists jobs
 * and can never be swallowed as a goal.
 *
 * Forms (bare keyword lists; unknown tails fall through to the model so
 * natural sentences like "크론 잡 하나 만들어줘" still reach the LLM flow):
 * - `cron` | `schedule` | `크론` | `스케줄` | ...      → list (admin: all users + owner)
 * - `cron list`                                        → same as bare
 * - `cron model <name> <default|fast|모델|별칭> [<@owner>]`
 * - `cron target <name> <channel|dm|thread> [threadTs] [<@owner>]`
 * - `cron run <name> [<@owner>]`                       → fire now (see below)
 * - `cron allow|revoke <name> <@user> [<@owner>]`      → run allowlist
 * - `cron delete <name> [<@owner>]`
 * - `cron help`                                        → usage
 *
 * Admin scoping mirrors the cron MCP server: non-admins are locked to their
 * own jobs; admins address another user's job with an explicit owner mention;
 * admin name-only calls with a cross-owner name collision are rejected.
 *
 * `run` is the one exception to that lock, because firing someone's job is a
 * request, not a mutation: a non-owner may address any job by name, and is
 * gated by the job's `runAllowlist`. Not on it → the owner is DM'd a 3-button
 * prompt (`src/slack/cron-run-permission-blocks.ts`) and, on approval, the job
 * fires with the OWNER's identity. "항상 허용" persists the requester on the
 * job's allowlist so the next `cron run` fires immediately.
 */
export class CronCommandHandler implements CommandHandler {
  private static readonly BARE_FORMS = new Set([
    'cron',
    'crons',
    'schedule',
    'scheduler',
    '크론',
    '스케줄',
    '스케쥴',
    '스케줄러',
    '스케쥴러',
  ]);

  private static readonly SUBCOMMANDS = new Set([
    'list',
    'model',
    'target',
    'mode',
    'rename',
    'prompt',
    'channel',
    'schedule',
    'expr',
    'run',
    'allow',
    'revoke',
    'delete',
    'remove',
    'help',
  ]);

  private readonly storagePath: string;
  /** Needed to DM a job owner a run-permission prompt; absent in unit tests. */
  private readonly slackApi?: CronRunPermissionSlackApi;

  constructor(storagePath?: string, deps?: { slackApi?: CronRunPermissionSlackApi }) {
    this.storagePath = storagePath ?? path.join(DATA_DIR, 'cron-jobs.json');
    this.slackApi = deps?.slackApi;
  }

  /** Fresh instance per call — CronStorage reads from disk on every op. */
  private storage(): CronStorage {
    return new CronStorage(this.storagePath);
  }

  canHandle(text: string): boolean {
    const tokens = text.trim().replace(/^\//, '').split(/\s+/);
    const head = tokens[0]?.toLowerCase() ?? '';
    if (!CronCommandHandler.BARE_FORMS.has(head)) return false;
    if (tokens.length === 1) return true;
    return CronCommandHandler.SUBCOMMANDS.has(tokens[1].toLowerCase());
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const tokens = ctx.text.trim().replace(/^\//, '').split(/\s+/);
    const sub = tokens[1]?.toLowerCase();

    if (!sub || sub === 'list') {
      await this.list(ctx);
    } else if (sub === 'help') {
      await ctx.say({ text: usageText(), thread_ts: ctx.threadTs });
    } else if (sub === 'model') {
      await this.changeModel(ctx, tokens.slice(2));
    } else if (sub === 'target') {
      await this.changeTarget(ctx, tokens.slice(2));
    } else if (sub === 'mode') {
      await this.changeMode(ctx, tokens.slice(2));
    } else if (sub === 'rename') {
      await this.renameJob(ctx, tokens.slice(2));
    } else if (sub === 'prompt') {
      await this.changePrompt(ctx, tokens.slice(2));
    } else if (sub === 'channel') {
      await this.changeChannel(ctx, tokens.slice(2));
    } else if (sub === 'schedule' || sub === 'expr') {
      await this.changeSchedule(ctx, tokens.slice(2));
    } else if (sub === 'run') {
      await this.runNow(ctx, tokens.slice(2));
    } else if (sub === 'allow' || sub === 'revoke') {
      await this.changeRunAllowlist(ctx, tokens.slice(2), sub === 'allow');
    } else if (sub === 'delete' || sub === 'remove') {
      await this.deleteJob(ctx, tokens.slice(2));
    }
    return { handled: true };
  }

  // --- list ---

  private async list(ctx: CommandContext): Promise<void> {
    const admin = isAdminUser(ctx.user);
    const storage = this.storage();
    const jobs = admin ? storage.getAll() : storage.getJobsByOwner(ctx.user);

    // Interactive Block Kit card: per-job model/target dropdowns + delete
    // button (src/slack/cron-blocks.ts); mutations land in
    // src/slack/actions/cron-action-handler.ts. `text` stays as the plain
    // fallback for notifications/clients without Block Kit.
    const card = buildCronCard({ jobs, isAdmin: admin });
    await ctx.say({ text: card.text, blocks: card.blocks, thread_ts: ctx.threadTs });
  }

  // --- model ---

  private async changeModel(ctx: CommandContext, args: string[]): Promise<void> {
    const { name, rest, owner } = splitOwnerArg(args);
    const value = rest[0];
    if (!name || !value) {
      await ctx.say({
        text: `사용법: \`cron model <name> <default|fast|모델>\`\n${usageText()}`,
        thread_ts: ctx.threadTs,
      });
      return;
    }

    const resolved = this.resolveJob(ctx, name, owner);
    if ('error' in resolved) {
      await ctx.say({ text: resolved.error, thread_ts: ctx.threadTs });
      return;
    }

    let patch: CronJobPatch;
    let desc: string;
    const lower = value.toLowerCase();
    if (lower === 'default') {
      patch = { modelConfig: null };
      desc = 'default — 만든 사람의 현재 기본 모델을 실행 시점에 사용';
    } else if (lower === 'fast') {
      patch = { modelConfig: { type: 'fast' } };
      desc = 'fast (sonnet)';
    } else {
      // Cache miss → forced llmux catalog re-fetch + one retry before erroring.
      const modelId = await userSettingsStore.resolveModelInputWithRefresh(value);
      if (!modelId) {
        await ctx.say({
          text: `❌ 알 수 없는 모델: \`${value}\`\n\`default\` / \`fast\` / 모델 별칭(예: fable, opus, sonnet, haiku, gpt) 또는 canonical id를 쓰세요.`,
          thread_ts: ctx.threadTs,
        });
        return;
      }
      patch = { modelConfig: { type: 'custom', model: modelId } };
      desc = `custom(${modelId})`;
    }

    const updated = this.storage().updateJob(resolved.owner, name, patch);
    if (!updated) {
      await ctx.say({ text: `❌ 크론잡 \`${name}\` 을 찾을 수 없습니다.`, thread_ts: ctx.threadTs });
      return;
    }
    await ctx.say({
      text: `✅ *${updated.name}* 모델 변경 → ${desc}${ownerSuffix(ctx, resolved.owner)}`,
      thread_ts: ctx.threadTs,
    });
  }

  // --- target ---

  private async changeTarget(ctx: CommandContext, args: string[]): Promise<void> {
    const { name, rest, owner } = splitOwnerArg(args);
    const value = rest[0]?.toLowerCase();
    if (!name || !value || !['channel', 'thread', 'dm'].includes(value)) {
      await ctx.say({
        text: `사용법: \`cron target <name> <channel|dm|thread> [threadTs]\`\n${usageText()}`,
        thread_ts: ctx.threadTs,
      });
      return;
    }

    const resolved = this.resolveJob(ctx, name, owner);
    if ('error' in resolved) {
      await ctx.say({ text: resolved.error, thread_ts: ctx.threadTs });
      return;
    }

    let patch: CronJobPatch;
    let desc: string;
    if (value === 'channel') {
      patch = { target: null, threadTs: null };
      desc = 'channel — 채널에 새 메시지';
    } else if (value === 'dm') {
      patch = { target: 'dm', threadTs: null };
      desc = 'dm — 잡 오너에게 DM';
    } else {
      // thread: explicit ts arg > existing job ts > the thread this command ran in
      const explicitTs = rest[1];
      const ts = explicitTs ?? resolved.job.threadTs ?? ctx.threadTs;
      if (!ts) {
        await ctx.say({ text: '❌ thread 대상에는 threadTs가 필요합니다.', thread_ts: ctx.threadTs });
        return;
      }
      patch = { target: 'thread', threadTs: ts };
      // Anchoring to the CURRENT thread must also repoint the job channel —
      // the scheduler replies via threadReplier(job.channel, job.threadTs),
      // so a ts from this channel with the old job.channel would miss.
      if (!explicitTs && !resolved.job.threadTs) {
        patch.channel = ctx.channel;
      }
      desc = `thread(ts:${ts}) — 해당 스레드에 답글`;
    }

    const updated = this.storage().updateJob(resolved.owner, name, patch);
    if (!updated) {
      await ctx.say({ text: `❌ 크론잡 \`${name}\` 을 찾을 수 없습니다.`, thread_ts: ctx.threadTs });
      return;
    }
    await ctx.say({
      text: `✅ *${updated.name}* 출력 대상 변경 → ${desc}${ownerSuffix(ctx, resolved.owner)}`,
      thread_ts: ctx.threadTs,
    });
  }

  // --- mode / rename / prompt / channel / schedule / run ---

  private async changeMode(ctx: CommandContext, args: string[]): Promise<void> {
    const { name, rest, owner } = splitOwnerArg(args);
    const value = rest[0]?.toLowerCase();
    if (!name || !value || !['default', 'fastlane'].includes(value)) {
      await ctx.say({ text: '사용법: `cron mode <name> <default|fastlane>`', thread_ts: ctx.threadTs });
      return;
    }
    const resolved = this.resolveJob(ctx, name, owner);
    if ('error' in resolved) {
      await ctx.say({ text: resolved.error, thread_ts: ctx.threadTs });
      return;
    }
    const updated = this.storage().updateJob(resolved.owner, name, {
      mode: value === 'default' ? null : 'fastlane',
    });
    await ctx.say({
      text: updated
        ? `✅ *${name}* 실행 모드 → ${value === 'fastlane' ? '⚡fastlane (항상 새 스레드 즉시)' : 'default (대기열)'}${ownerSuffix(ctx, resolved.owner)}`
        : `❌ 크론잡 \`${name}\` 을 찾을 수 없습니다.`,
      thread_ts: ctx.threadTs,
    });
  }

  private async renameJob(ctx: CommandContext, args: string[]): Promise<void> {
    const { name, rest, owner } = splitOwnerArg(args);
    const newName = rest[0];
    if (!name || !newName || !isValidCronName(newName)) {
      await ctx.say({
        text: '사용법: `cron rename <name> <새이름>` (영문/숫자/하이픈/언더스코어 1-64자)',
        thread_ts: ctx.threadTs,
      });
      return;
    }
    const resolved = this.resolveJob(ctx, name, owner);
    if ('error' in resolved) {
      await ctx.say({ text: resolved.error, thread_ts: ctx.threadTs });
      return;
    }
    try {
      const updated = this.storage().updateJob(resolved.owner, name, { name: newName });
      await ctx.say({
        text: updated
          ? `✅ *${name}* → *${newName}* 이름 변경${ownerSuffix(ctx, resolved.owner)}`
          : `❌ 크론잡 \`${name}\` 을 찾을 수 없습니다.`,
        thread_ts: ctx.threadTs,
      });
    } catch (error: any) {
      if (error?.message?.startsWith('DUPLICATE_NAME')) {
        await ctx.say({ text: `❌ 이미 같은 이름의 잡이 있습니다: \`${newName}\``, thread_ts: ctx.threadTs });
        return;
      }
      throw error;
    }
  }

  private async changePrompt(ctx: CommandContext, args: string[]): Promise<void> {
    const { name, rest, owner } = splitOwnerArg(args);
    const prompt = rest.join(' ').trim();
    if (!name || !prompt || prompt.length > 4000) {
      await ctx.say({ text: '사용법: `cron prompt <name> <새 프롬프트…>` (1-4000자)', thread_ts: ctx.threadTs });
      return;
    }
    const resolved = this.resolveJob(ctx, name, owner);
    if ('error' in resolved) {
      await ctx.say({ text: resolved.error, thread_ts: ctx.threadTs });
      return;
    }
    const updated = this.storage().updateJob(resolved.owner, name, { prompt });
    await ctx.say({
      text: updated
        ? `✅ *${name}* 프롬프트 변경 → ${prompt.substring(0, 120)}${ownerSuffix(ctx, resolved.owner)}`
        : `❌ 크론잡 \`${name}\` 을 찾을 수 없습니다.`,
      thread_ts: ctx.threadTs,
    });
  }

  private async changeChannel(ctx: CommandContext, args: string[]): Promise<void> {
    const { name, rest, owner } = splitOwnerArg(args);
    const raw = rest[0] ?? '';
    // Accept <#C123|name>, <#C123>, or bare C…/G…/D… ids (G = private channel).
    const mention = raw.match(/^<#([CDG][A-Z0-9_]+)(\|[^>]*)?>$/);
    const channel = mention ? mention[1] : raw;
    if (!name || !channel || !/^[CDG]/.test(channel)) {
      await ctx.say({ text: '사용법: `cron channel <name> <#채널>` (또는 채널 ID)', thread_ts: ctx.threadTs });
      return;
    }
    const resolved = this.resolveJob(ctx, name, owner);
    if ('error' in resolved) {
      await ctx.say({ text: resolved.error, thread_ts: ctx.threadTs });
      return;
    }
    // Repointing the channel invalidates a thread anchor from the old channel
    // (scheduler posts threadReplier(job.channel, job.threadTs)) — clear it.
    const patch: CronJobPatch = { channel };
    let anchorNote = '';
    if (channel !== resolved.job.channel && (resolved.job.target === 'thread' || resolved.job.threadTs)) {
      patch.target = null;
      patch.threadTs = null;
      anchorNote = ' (이전 채널의 thread anchor 해제 → 채널 새 메시지)';
    }
    const updated = this.storage().updateJob(resolved.owner, name, patch);
    await ctx.say({
      text: updated
        ? `✅ *${name}* 출력 채널 → <#${channel}>${anchorNote}${ownerSuffix(ctx, resolved.owner)}`
        : `❌ 크론잡 \`${name}\` 을 찾을 수 없습니다.`,
      thread_ts: ctx.threadTs,
    });
  }

  private async changeSchedule(ctx: CommandContext, args: string[]): Promise<void> {
    const { name, rest, owner } = splitOwnerArg(args);
    const expression = rest.join(' ').trim();
    if (!name || !isValidCronExpression(expression)) {
      await ctx.say({
        text: '사용법: `cron schedule <name> <분 시 일 월 요일>` — 예: `cron schedule daily 0 9 * * 1-5` (UTC)',
        thread_ts: ctx.threadTs,
      });
      return;
    }
    const resolved = this.resolveJob(ctx, name, owner);
    if ('error' in resolved) {
      await ctx.say({ text: resolved.error, thread_ts: ctx.threadTs });
      return;
    }
    const updated = this.storage().updateJob(resolved.owner, name, { expression });
    await ctx.say({
      text: updated
        ? `✅ *${name}* 스케줄 → \`${expression}\` (UTC)${ownerSuffix(ctx, resolved.owner)}`
        : `❌ 크론잡 \`${name}\` 을 찾을 수 없습니다.`,
      thread_ts: ctx.threadTs,
    });
  }

  private async runNow(ctx: CommandContext, args: string[]): Promise<void> {
    const { name, owner } = splitOwnerArg(args);
    if (!name) {
      await ctx.say({ text: '사용법: `cron run <name>`', thread_ts: ctx.threadTs });
      return;
    }
    const resolved = this.resolveRunTarget(ctx, name, owner);
    if ('error' in resolved) {
      await ctx.say({ text: resolved.error, thread_ts: ctx.threadTs });
      return;
    }

    // Cross-user run without a grant: ask the owner instead of refusing.
    // A granted run still fires with the OWNER's identity (runJobNow(owner,…)).
    if (!isRunAllowed(resolved.job, ctx.user) && !isAdminUser(ctx.user)) {
      const { delivered } = await requestCronRunPermission({
        slackApi: this.slackApi,
        requesterId: ctx.user,
        ownerId: resolved.owner,
        jobId: resolved.job.id,
        jobName: name,
        channel: ctx.channel,
        threadTs: ctx.threadTs,
        postFallback: (msg) => ctx.say({ text: msg.text, blocks: msg.blocks, thread_ts: ctx.threadTs }),
      });
      await ctx.say({ text: describeDelivery(delivered, resolved.owner, name), thread_ts: ctx.threadTs });
      return;
    }

    const scheduler = getActiveCronScheduler();
    if (!scheduler) {
      await ctx.say({ text: '⚠️ 크론 스케줄러가 아직 기동되지 않았습니다.', thread_ts: ctx.threadTs });
      return;
    }
    const result = await scheduler.runJobNow(resolved.owner, name, { triggeredBy: ctx.user });
    await ctx.say({
      text: result.ok
        ? `▶ *${name}* 실행 트리거됨 — 실제 크론 경로로 발동${ownerSuffix(ctx, resolved.owner)}`
        : `⚠️ *${name}* 실행 실패: ${result.message}`,
      thread_ts: ctx.threadTs,
    });
  }

  // --- run allowlist (allow / revoke) ---

  /**
   * `cron allow <name> <@user> [<@owner>]` / `cron revoke …` — the owner-side
   * inverse of the grant prompt: grant up front without waiting to be asked,
   * and take a grant back. Owner/admin only (this IS the permission surface),
   * so it goes through {@link resolveJob}, not the run-specific addressing.
   */
  private async changeRunAllowlist(ctx: CommandContext, args: string[], grant: boolean): Promise<void> {
    const verb = grant ? 'allow' : 'revoke';
    const name = args[0];
    const targetUser = parseUserRef(args[1]);
    const owner = parseUserRef(args[2]);
    if (!name || !targetUser) {
      await ctx.say({
        text: `사용법: \`cron ${verb} <name> <@user>\` — 해당 유저의 \`cron run\` 실행 권한을 ${grant ? '부여' : '회수'}합니다.`,
        thread_ts: ctx.threadTs,
      });
      return;
    }

    const resolved = this.resolveJob(ctx, name, owner);
    if ('error' in resolved) {
      await ctx.say({ text: resolved.error, thread_ts: ctx.threadTs });
      return;
    }

    // allowRun/revokeRun re-read immediately before writing, so a concurrent
    // writer loses at most this one entry — never a whole stale list.
    const storage = this.storage();
    const updated = grant
      ? storage.allowRun(resolved.owner, name, targetUser)
      : storage.revokeRun(resolved.owner, name, targetUser);
    if (!updated) {
      await ctx.say({ text: `❌ 크론잡 \`${name}\` 을 찾을 수 없습니다.`, thread_ts: ctx.threadTs });
      return;
    }
    await ctx.say({
      text: grant
        ? `✅ <@${targetUser}>님에게 *${name}* 즉시 실행을 허용했습니다 — 실행은 오너 권한으로 발동합니다.${ownerSuffix(ctx, resolved.owner)}`
        : `🚫 <@${targetUser}>님의 *${name}* 즉시 실행 권한을 회수했습니다.${ownerSuffix(ctx, resolved.owner)}`,
      thread_ts: ctx.threadTs,
    });
  }

  // --- delete ---

  private async deleteJob(ctx: CommandContext, args: string[]): Promise<void> {
    const { name, owner } = splitOwnerArg(args);
    if (!name) {
      await ctx.say({ text: `사용법: \`cron delete <name>\``, thread_ts: ctx.threadTs });
      return;
    }

    const resolved = this.resolveJob(ctx, name, owner);
    if ('error' in resolved) {
      await ctx.say({ text: resolved.error, thread_ts: ctx.threadTs });
      return;
    }

    const removed = this.storage().removeJob(resolved.owner, name);
    if (!removed) {
      await ctx.say({ text: `❌ 크론잡 \`${name}\` 이 없습니다.`, thread_ts: ctx.threadTs });
      return;
    }
    await ctx.say({ text: `🗑️ *${name}* 삭제됨${ownerSuffix(ctx, resolved.owner)}`, thread_ts: ctx.threadTs });
  }

  /**
   * Address a job for `cron run` — the ONLY subcommand a non-owner may target.
   * Mutations stay owner/admin-scoped via {@link resolveJob}; running is gated
   * afterwards by the job's allowlist (grant flow), not by addressing. Resolves
   * to the job itself so the caller can consult `isRunAllowed`.
   *
   * Addressing is identical for admins and everyone else — only the gate that
   * follows differs — so a name that exists for exactly one owner resolves, and
   * a name shared by several owners demands an explicit `<@owner>`.
   */
  private resolveRunTarget(
    ctx: CommandContext,
    name: string,
    requestedOwner: string | undefined,
  ): { owner: string; job: CronJob } | { error: string } {
    const storage = this.storage();

    // Own job (or an explicit self-mention) — no cross-user question at all.
    if (!requestedOwner || requestedOwner === ctx.user) {
      const own = storage.getJobsByOwner(ctx.user).find((j) => j.name === name);
      if (own) return { owner: ctx.user, job: own };
    }

    if (requestedOwner) {
      const job = storage.getJobsByOwner(requestedOwner).find((j) => j.name === name);
      if (!job) return { error: `❌ <@${requestedOwner}> 의 크론잡 \`${name}\` 을 찾을 수 없습니다.` };
      return { owner: requestedOwner, job };
    }

    const candidates = storage.getAll().filter((j) => j.name === name);
    if (candidates.length === 0) {
      return { error: `❌ 크론잡 \`${name}\` 을 찾을 수 없습니다. \`cron\` 으로 목록을 확인하세요.` };
    }
    if (candidates.length > 1) {
      // Deliberately does NOT list the owners: to a non-owner that would be a
      // free directory of who runs what. The asker knows whose job they want.
      return {
        error: `❌ \`${name}\` 이름의 잡이 여러 유저에게 있습니다. 실행할 오너를 지정하세요: \`cron run ${name} <@owner>\``,
      };
    }
    return { owner: candidates[0].owner, job: candidates[0] };
  }

  // --- shared job addressing (mirrors cron MCP server's resolveTargetOwner) ---

  private resolveJob(
    ctx: CommandContext,
    name: string,
    requestedOwner: string | undefined,
  ): { owner: string; job: CronJob } | { error: string } {
    const admin = isAdminUser(ctx.user);
    const storage = this.storage();

    if (requestedOwner && requestedOwner !== ctx.user) {
      if (!admin) {
        return { error: '❌ 다른 유저의 크론잡 수정은 admin만 가능합니다.' };
      }
      const job = storage.getJobsByOwner(requestedOwner).find((j) => j.name === name);
      if (!job) return { error: `❌ <@${requestedOwner}> 의 크론잡 \`${name}\` 을 찾을 수 없습니다.` };
      return { owner: requestedOwner, job };
    }

    // Ambiguity guard applies only when NO owner was requested — an explicit
    // self-mention (`... <@me>`) is already a disambiguation, same contract as
    // the cron MCP server's resolveTargetOwner.
    if (admin && !requestedOwner) {
      const others = storage.getAll().filter((j) => j.name === name && j.owner !== ctx.user);
      if (others.length > 0) {
        const own = storage.getJobsByOwner(ctx.user).some((j) => j.name === name);
        const candidates = [...(own ? [ctx.user] : []), ...others.map((j) => j.owner)];
        return {
          error: `❌ \`${name}\` 이름의 잡이 여러 유저에게 있습니다: ${candidates.map((o) => `<@${o}>`).join(', ')}\n뒤에 오너를 지정하세요: \`cron model ${name} <값> <@owner>\``,
        };
      }
    }

    const job = storage.getJobsByOwner(ctx.user).find((j) => j.name === name);
    if (!job) return { error: `❌ 크론잡 \`${name}\` 을 찾을 수 없습니다. \`cron\` 으로 목록을 확인하세요.` };
    return { owner: ctx.user, job };
  }
}

// --- helpers ---

function describeOwner(job: CronJob): string {
  return `owner:<@${job.owner}>`;
}

function describeModel(job: CronJob): string {
  const c = job.modelConfig;
  if (!c || c.type === 'default') return 'default(만든 사람의 현재 모델)';
  if (c.type === 'fast') return 'fast';
  return `custom(${c.model ?? '?'})`;
}

function describeTarget(job: CronJob): string {
  const target = job.target ?? 'channel';
  return job.threadTs ? `${target}(ts:${job.threadTs})` : target;
}

function ownerSuffix(ctx: CommandContext, owner: string): string {
  return owner !== ctx.user ? ` (owner: <@${owner}>)` : '';
}

/** Parse `<@U123>` / `<@U123|name>` / bare `U123...` as a user id. */
function parseUserRef(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const mention = token.match(/^<@([A-Z0-9_]+)(\|[^>]*)?>$/);
  if (mention) return mention[1];
  return /^U[A-Z0-9_]{4,}$/.test(token) ? token : undefined;
}

/** Parse trailing `<@U123>` / `<@U123|name>` / bare `U123...` as the owner argument. */
function splitOwnerArg(args: string[]): { name?: string; rest: string[]; owner?: string } {
  const rest = [...args];
  const owner = parseUserRef(rest[rest.length - 1]);
  if (owner) rest.pop();
  const [name, ...remainder] = rest;
  return { name, rest: remainder, owner };
}

function usageText(): string {
  return [
    '수정 명령 (카드 버튼/드롭다운 또는 텍스트):',
    '• `cron model <name> <default|fast|모델>` — 모델 (default = 만든 사람의 현재 모델)',
    '• `cron target <name> <channel|dm|thread>` — 출력 대상',
    '• `cron mode <name> <default|fastlane>` — 실행 모드',
    '• `cron channel <name> <#채널>` · `cron schedule <name> <5-field cron>` · `cron prompt <name> <텍스트>` · `cron rename <name> <새이름>`',
    '• `cron run <name>` — 지금 즉시 실행 (실제 크론 경로)',
    '• `cron allow <name> <@user>` / `cron revoke <name> <@user>` — 다른 유저의 즉시 실행 허용/회수',
    '• `cron delete <name>` — 삭제',
    '_다른 유저의 잡에 `cron run` 을 치면 오너에게 DM으로 승인 요청이 갑니다. 승인되면 오너 권한으로 실행되고, "항상 허용" 시 다음부터는 바로 실행됩니다._',
    '_admin은 명령 끝에 `<@owner>` 를 붙여 다른 유저 잡을 수정합니다._',
  ].join('\n');
}
