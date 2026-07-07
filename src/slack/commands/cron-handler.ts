import * as path from 'path';
import { type CronJob, type CronJobPatch, CronStorage } from 'somalib/cron/cron-storage';
import { isAdminUser } from '../../admin-utils';
import { DATA_DIR } from '../../env-paths';
import { userSettingsStore } from '../../user-settings-store';
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
 * - `cron delete <name> [<@owner>]`
 * - `cron help`                                        → usage
 *
 * Admin scoping mirrors the cron MCP server: non-admins are locked to their
 * own jobs; admins address another user's job with an explicit owner mention;
 * admin name-only calls with a cross-owner name collision are rejected.
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

  private static readonly SUBCOMMANDS = new Set(['list', 'model', 'target', 'delete', 'remove', 'help']);

  private readonly storagePath: string;

  constructor(storagePath?: string) {
    this.storagePath = storagePath ?? path.join(DATA_DIR, 'cron-jobs.json');
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

    if (jobs.length === 0) {
      await ctx.say({
        text: `⏰ 등록된 크론잡이 없습니다.\n등록은 자연어로: "매일 아침 9시에 열린 PR 요약해줘, 크론으로 등록"\n\n${usageText()}`,
        thread_ts: ctx.threadTs,
      });
      return;
    }

    const lines = jobs.map((j) => {
      const ownerStr = admin ? ` | ${describeOwner(j)}` : '';
      const modeStr = j.mode === 'fastlane' ? ' | ⚡fastlane' : '';
      return (
        `• *${j.name}*${ownerStr} | \`${j.expression}\` | ch:<#${j.channel}>${modeStr}` +
        ` | model:${describeModel(j)} | target:${describeTarget(j)} | last: ${j.lastRunMinute || 'never'}\n` +
        `   ↳ ${j.prompt.substring(0, 100)}`
      );
    });

    const header = admin ? `⏰ *크론잡 (${jobs.length}) — admin view, 전체 유저*` : `⏰ *크론잡 (${jobs.length})*`;
    await ctx.say({
      text: `${header}\n${lines.join('\n')}\n\n${usageText()}`,
      thread_ts: ctx.threadTs,
    });
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
      const modelId = userSettingsStore.resolveModelInput(value);
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
      const ts = rest[1] ?? resolved.job.threadTs ?? ctx.threadTs;
      if (!ts) {
        await ctx.say({ text: '❌ thread 대상에는 threadTs가 필요합니다.', thread_ts: ctx.threadTs });
        return;
      }
      patch = { target: 'thread', threadTs: ts };
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

/** Parse trailing `<@U123>` / `<@U123|name>` / bare `U123...` as the owner argument. */
function splitOwnerArg(args: string[]): { name?: string; rest: string[]; owner?: string } {
  let owner: string | undefined;
  const rest = [...args];
  const last = rest[rest.length - 1];
  const mention = last?.match(/^<@([A-Z0-9_]+)(\|[^>]*)?>$/);
  if (mention) {
    owner = mention[1];
    rest.pop();
  } else if (last && /^U[A-Z0-9_]{4,}$/.test(last)) {
    owner = last;
    rest.pop();
  }
  const [name, ...remainder] = rest;
  return { name, rest: remainder, owner };
}

function usageText(): string {
  return [
    '수정 명령:',
    '• `cron model <name> <default|fast|모델>` — 모델 변경 (default = 만든 사람의 현재 모델)',
    '• `cron target <name> <channel|dm|thread>` — 출력 대상 변경',
    '• `cron delete <name>` — 삭제',
    '_admin은 명령 끝에 `<@owner>` 를 붙여 다른 유저 잡을 수정합니다._',
  ].join('\n');
}
