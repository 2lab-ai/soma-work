/**
 * Deploy lanes — fire the lanes that asked to run when a deploy lands.
 *
 * The deploy workflow runs in whoever asked for the deploy's session and emits a
 * `deploy_completed` directive per repo once the merge landed
 * (packages/slack/src/directives/deploy-completed-directive.ts); the stream
 * executor forwards it here only from a deploy-workflow session. A lane comes
 * from one of two places, both read on every signal:
 *
 *   - a cron job that opts in with `onDeploy: [{ repo, target }]`. That entry is
 *     the OWNER's consent, so the fire skips the run-allowlist / permission
 *     prompt that a non-owner `cron run` goes through. It is a real cron fire
 *     (`CronScheduler.runJobNow`): owner identity, the job's model, execution
 *     history attributed to the deployer.
 *   - an entry of DATA_DIR/deploy-lanes.json, a deploy-only lane: no schedule,
 *     not a cron job, so not in `cron list` and without cron history. The owner
 *     who wrote it into the file consented the same way. It fires through
 *     `CronScheduler.fireDeployLane`.
 *
 * Two things differ from a scheduled fire, on purpose:
 *   - it always opens a new thread in the lane's channel (`forceNewThread`):
 *     queued behind the owner's busy session it would be reported as started
 *     and might never run;
 *   - the prompt carries a note naming the deploy and its thread, so a lane
 *     registered for several repos knows which one it is checking, and can post
 *     its result back into the deploy thread itself (the harness does not post
 *     for it).
 *
 * Every outcome a lane owner would want to know about gets one line in the
 * deploy thread; every ⚠️ line ends with what the owner can do about it.
 *
 * The signal is model output: the lane must verify the deploy itself and be
 * idempotent. The dedupe below only stops a repeated directive for the same merge
 * commit; it lives in memory, so a restart forgets it.
 */

import type {
  DeployCompletedHookContext,
  DeployCompletedPayload,
  DeployCompletedRejection,
  DeployCompletedSignal,
} from '@soma/slack/directives/deploy-completed-directive';
import * as fs from 'fs';
import * as path from 'path';
import {
  type CronDeployTrigger,
  type CronJob,
  type CronModelConfig,
  CronStorage,
  jobMatchesDeploy,
  normalizeDeployTriggers,
} from 'somalib/cron/cron-storage';
import { type CronScheduler, type DeployLaneSpec, getActiveCronScheduler } from './cron-scheduler';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';

const logger = new Logger('DeployLanes');

/** A (lane, merge commit) pair fires at most once in this window. */
export const DEPLOY_LANE_DEDUPE_MS = 6 * 60 * 60 * 1000;

/**
 * How long to wait for a fire to report back. A fire resolves only when the
 * lane's turn ends on the new-thread path, which can take hours; every failure
 * before the lane's turn starts settles well inside this. Still running after it
 * = started; a failure after it is posted as a follow-up.
 */
const DEFAULT_SETTLE_MS = 5_000;

/** Recovery hint when the lane names are not known. */
const UNKNOWN_LANE = '레인 이름';

/** The deploy-only lane registry, in DATA_DIR. */
const REGISTRY_FILE = 'deploy-lanes.json';

/** Where lanes are read from. */
type Source = 'cron' | 'registry';

/** How the deploy thread names a source it could not read (never its path). */
const SOURCE_FILE: Record<Source, string> = { cron: 'cron 설정 파일', registry: REGISTRY_FILE };

/** Per source, what an owner can do when the lane is not known. */
const UNKNOWN_LANE_HINT: Record<Source, string> = {
  cron: `cron run ${UNKNOWN_LANE}`,
  registry: '레인 프롬프트 직접 실행',
};

/**
 * A deploy-only lane: one entry of deploy-lanes.json,
 * `{ name, owner, channel, prompt, modelConfig?, onDeploy: [{ repo, target }] }`.
 * (owner, name) is its identity.
 */
interface DeployLane extends DeployLaneSpec {
  onDeploy: CronDeployTrigger[];
}

type RegistryLane = DeployLane & { registry: true };

/** A lane a deploy can fire: a cron job that opted in with `onDeploy`, or a deploy-lanes.json entry. */
type Lane = (CronJob & { registry?: undefined }) | RegistryLane;

type LaneScheduler = Pick<CronScheduler, 'runJobNow' | 'fireDeployLane'>;

export interface DeployLaneTriggerOptions {
  /** Test seam — defaults to DATA_DIR/cron-jobs.json (same file the scheduler reads). */
  storagePath?: string;
  /** Test seam — defaults to DATA_DIR/deploy-lanes.json. */
  registryPath?: string;
  /** Test seam — defaults to the running scheduler. */
  getScheduler?: () => LaneScheduler | null;
  now?: () => number;
  settleMs?: number;
}

type FireOutcome = { lane: Lane; ok: boolean; detail?: string; running?: boolean };

type Unreadable = { source: Source; error: string };

export class DeployLaneTrigger {
  /** `dedupeKey(lane, after)` → when it fired. */
  private readonly fired = new Map<string, number>();

  constructor(private readonly opts: DeployLaneTriggerOptions = {}) {}

  /** Entry point for `StreamExecutor`'s `onDeployCompleted` hook. */
  async handle(signal: DeployCompletedSignal, ctx: DeployCompletedHookContext): Promise<void> {
    if (signal.kind === 'rejected') return this.handleRejected(signal.rejections, ctx);
    return this.handleCompleted(signal.payload, ctx);
  }

  private async handleCompleted(payload: DeployCompletedPayload, ctx: DeployCompletedHookContext): Promise<void> {
    const deploy = `${payload.repo} → ${payload.target} (${payload.after.slice(0, 7)})`;

    // Lanes are independent and deduped one by one, so a source that cannot be
    // read costs only its own lanes: it gets one ⚠️ line, the other source's
    // lanes still fire. Both unreadable = one line naming both, nothing fires.
    const { lanes, unreadable } = this.readLanes();
    if (unreadable.length > 0) {
      // The detail (it names the server's file path) goes to the log only.
      logger.error('deploy_completed: lane source unreadable — its lanes cannot be matched', { deploy, unreadable });
      const sources = unreadable.map((u) => u.source);
      await ctx.reply(
        `⚠️ 배포 레인 확인 불가 — ${deploy}: ${sources.map((s) => SOURCE_FILE[s]).join(', ')}을 읽지 못함 ${recovery([], sources)}`,
      );
    }

    const matched = lanes.filter((lane) => jobMatchesDeploy(lane, payload.repo, payload.target));
    if (matched.length === 0) {
      const registered = targetsForRepo(lanes, payload.repo);
      logger.info('deploy_completed matched no lane', { deploy, registered });
      // With a source unread, the registered targets would be half the list.
      if (registered.length > 0 && unreadable.length === 0) {
        await ctx.reply(`ℹ️ ${payload.repo} → ${payload.target}: 레인 없음 (등록: ${registered.join(', ')})`);
      }
      return;
    }

    if (!payload.confirmed) {
      logger.warn('deploy_completed unconfirmed — lanes not fired', { deploy, lanes: names(matched) });
      await ctx.reply(
        `⚠️ ${payload.repo} → ${payload.target} 머지됨, 배포 미확인 — 레인 미발동: ${bold(matched)} ${recovery(matched)}`,
      );
      return;
    }

    const scheduler = (this.opts.getScheduler ?? getActiveCronScheduler)();
    if (!scheduler) {
      logger.error('deploy_completed matched lanes but the cron scheduler is not running', {
        deploy,
        lanes: names(matched),
      });
      await ctx.reply(`⚠️ 배포 레인 미발동 — cron scheduler not running: ${bold(matched)} ${recovery(matched)}`);
      return;
    }

    const now = (this.opts.now ?? Date.now)();
    for (const [key, at] of this.fired) {
      if (now - at >= DEPLOY_LANE_DEDUPE_MS) this.fired.delete(key);
    }
    const after = payload.after.toLowerCase();
    const fresh: Lane[] = [];
    const already: Lane[] = [];
    let firstFiredAt = Number.POSITIVE_INFINITY;
    for (const lane of matched) {
      const at = this.fired.get(dedupeKey(lane, after));
      if (at === undefined) {
        this.fired.set(dedupeKey(lane, after), now);
        fresh.push(lane);
      } else {
        already.push(lane);
        firstFiredAt = Math.min(firstFiredAt, at);
      }
    }
    const alreadyText = already.length > 0 ? `이미 발동됨 ${formatKst(firstFiredAt)}` : '';
    if (fresh.length === 0) {
      logger.info('deploy_completed already fired these lanes for this commit', { deploy, lanes: names(already) });
      await ctx.reply(`ℹ️ 배포 레인 ${alreadyText} — ${deploy}: ${bold(already)}`);
      return;
    }

    const note = `\n\n[deploy_completed repo=${payload.repo} target=${payload.target} before=${payload.before ?? '-'} after=${payload.after} by=${ctx.user} channel=${ctx.channel} thread=${ctx.threadTs}]`;
    const outcomes = await Promise.all(fresh.map((lane) => this.fire(scheduler, lane, payload, deploy, note, ctx)));
    await ctx.reply(describeOutcomes(deploy, outcomes, already, alreadyText));
  }

  /**
   * Fire one lane. Resolves within the settle window: the fire's own result, or
   * "running" when its turn is still going. A failure — inside the window or
   * after it — frees the (lane, commit) pair so a re-sent signal can retry; a
   * late one is posted as a follow-up line.
   */
  private async fire(
    scheduler: LaneScheduler,
    lane: Lane,
    payload: DeployCompletedPayload,
    deploy: string,
    note: string,
    ctx: DeployCompletedHookContext,
  ): Promise<FireOutcome> {
    logger.info('deploy_completed firing lane', {
      name: lane.name,
      owner: lane.owner,
      registry: lane.registry === true,
      deploy,
      triggeredBy: ctx.user,
    });
    const key = dedupeKey(lane, payload.after.toLowerCase());
    // Set when the settle window closes with the fire still running: from then
    // on a failure is news the deploy thread has not heard yet.
    let reportedRunning = false;

    const triggeredBy = ctx.user || undefined;
    const run = Promise.resolve()
      .then(() =>
        lane.registry
          ? scheduler.fireDeployLane(lane, {
              triggeredBy,
              note,
              rootText: `▶ ${deploy} 배포 후 레인 *${lane.name}* — 배포 스레드: <#${ctx.channel}>`,
            })
          : scheduler.runJobNow(lane.owner, lane.name, { triggeredBy, forceNewThread: true, note }),
      )
      .then(
        (result): FireOutcome => ({ lane, ok: result.ok, detail: result.message }),
        (error): FireOutcome => ({ lane, ok: false, detail: (error as Error)?.message ?? String(error) }),
      );
    void run
      .then(async (outcome) => {
        if (outcome.ok) return;
        this.fired.delete(key);
        if (!reportedRunning) return;
        logger.error('deploy lane failed after it was reported started', {
          name: lane.name,
          owner: lane.owner,
          after: payload.after,
          detail: outcome.detail,
        });
        await ctx.reply(`⚠️ 배포 레인 실패 — ${deploy}: ${failureText([outcome])} ${recovery([lane])}`);
      })
      .catch((error) => {
        logger.error('deploy lane follow-up failed', { name: lane.name, error: (error as Error)?.message });
      });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = new Promise<FireOutcome>((resolve) => {
      timer = setTimeout(() => {
        reportedRunning = true;
        resolve({ lane, ok: true, running: true });
      }, this.opts.settleMs ?? DEFAULT_SETTLE_MS);
    });
    try {
      const outcome = await Promise.race([run, running]);
      if (!outcome.ok) {
        logger.warn('deploy lane did not start', { name: lane.name, after: payload.after, detail: outcome.detail });
      }
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  }

  /** An attempt that yielded no payload: say so, naming the lanes of its repo when it names one. */
  private async handleRejected(rejections: DeployCompletedRejection[], ctx: DeployCompletedHookContext): Promise<void> {
    const repos = new Set(rejections.map((r) => r.repo?.trim().toLowerCase()).filter(Boolean));
    const { lanes: all, unreadable } = this.readLanes();
    if (unreadable.length > 0) {
      // The line still goes out; the lanes of an unreadable source are just not named.
      logger.warn('deploy_completed rejected: lanes unreadable — their lanes not named', { unreadable });
    }
    const lanes = all.filter(
      (lane) => Array.isArray(lane.onDeploy) && lane.onDeploy.some((t) => repos.has(t?.repo?.toLowerCase())),
    );
    const problems = rejections.map((r) => (r.repo ? `${r.repo}: ${r.problem}` : r.problem)).join('; ');
    logger.warn('deploy_completed rejected — no lane fired', { rejections, lanes: names(lanes) });
    await ctx.reply(
      `⚠️ deploy_completed 무시됨 — ${problems}; 레인 미발동 ${recovery(lanes, sourcesOf(all, unreadable))}`,
    );
  }

  /**
   * Both sources, each read strictly. A source that cannot be read adds no
   * lanes and is named in `unreadable`, with its error for the log.
   */
  private readLanes(): { lanes: Lane[]; unreadable: Unreadable[] } {
    const lanes: Lane[] = [];
    const unreadable: Unreadable[] = [];
    const sources: Array<[Source, () => Lane[]]> = [
      ['cron', () => this.readJobs()],
      ['registry', () => this.readRegistry()],
    ];
    for (const [source, read] of sources) {
      try {
        lanes.push(...read());
      } catch (error) {
        unreadable.push({ source, error: (error as Error).message });
      }
    }
    return { lanes, unreadable };
  }

  /**
   * The scheduler's jobs, read strictly (an unreadable file throws). Entries
   * that are not objects — a hand edit — are skipped with a warning rather than
   * left to throw inside matching.
   */
  private readJobs(): CronJob[] {
    const jobs = new CronStorage(this.opts.storagePath ?? path.join(DATA_DIR, 'cron-jobs.json')).getAllStrict();
    const valid = jobs.filter((job): job is CronJob => !!job && typeof job === 'object' && !Array.isArray(job));
    if (valid.length !== jobs.length) {
      logger.warn('cron jobs file holds entries that are not jobs — skipped', { skipped: jobs.length - valid.length });
    }
    return valid;
  }

  /**
   * The deploy-only lanes, read strictly: no file (ENOENT) = no lanes; any other
   * read error, or a file that is not `{ lanes: [...] }`, throws. existsSync()
   * is not the test: it also says false when the lookup itself fails (EACCES,
   * ELOOP, ENOTDIR), which would read an inaccessible registry as an empty one.
   * An entry that is not a lane — not an object, a blank name/owner/channel/
   * prompt, an `onDeploy` that does not validate, a `modelConfig` the cron tool
   * would reject, or a second entry for the same (owner, name) — is skipped
   * with a warning rather than left to throw inside matching.
   */
  private readRegistry(): RegistryLane[] {
    const file = this.opts.registryPath ?? path.join(DATA_DIR, REGISTRY_FILE);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw error;
    }
    const parsed = JSON.parse(raw) as { lanes?: unknown } | null;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.lanes)) {
      throw new Error(`deploy lanes file has no lanes array: ${file}`);
    }
    const lanes: RegistryLane[] = [];
    parsed.lanes.forEach((entry: unknown, index: number) => {
      const lane = toRegistryLane(entry);
      if (typeof lane === 'string') {
        logger.warn('deploy-lanes.json entry skipped', { index, problem: lane });
      } else if (lanes.some((l) => l.owner === lane.owner && l.name === lane.name)) {
        logger.warn('deploy-lanes.json entry skipped', {
          index,
          problem: 'duplicate (owner, name)',
          owner: lane.owner,
          name: lane.name,
        });
      } else {
        lanes.push(lane);
      }
    });
    return lanes;
  }
}

/** A deploy-lanes.json entry as a lane, or why it is not one. */
function toRegistryLane(entry: unknown): RegistryLane | string {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'not an object';
  const e = entry as Record<string, unknown>;
  const missing = ['name', 'owner', 'channel', 'prompt'].filter(
    (key) => typeof e[key] !== 'string' || !(e[key] as string).trim(),
  );
  if (missing.length > 0) return `missing ${missing.join(', ')}`;
  const modelConfig = toModelConfig(e.modelConfig);
  if (typeof modelConfig === 'string') return modelConfig;
  let onDeploy: CronDeployTrigger[];
  try {
    onDeploy = normalizeDeployTriggers(e.onDeploy);
  } catch (error) {
    return (error as Error).message;
  }
  const lane: RegistryLane = {
    registry: true,
    name: e.name as string,
    owner: e.owner as string,
    channel: e.channel as string,
    prompt: e.prompt as string,
    onDeploy,
  };
  if (modelConfig) lane.modelConfig = modelConfig;
  return lane;
}

const MODEL_TYPES: ReadonlyArray<CronModelConfig['type']> = ['default', 'opus', 'fable', 'fast', 'custom'];

/**
 * A registry `modelConfig` held to the rules a cron job's is held to by the
 * cron MCP tool (`buildModelConfig` in packages/mcp-servers/cron/cron-mcp-server.ts):
 * one of the cron model types, `custom` with a non-empty `model`. Absent or
 * `default` = the session default (undefined); otherwise why it is not valid.
 */
function toModelConfig(value: unknown): CronModelConfig | undefined | string {
  if (value == null) return undefined;
  const { type, model } = (typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  if (!MODEL_TYPES.includes(type as CronModelConfig['type'])) {
    return `modelConfig.type must be one of ${MODEL_TYPES.join(', ')}`;
  }
  if (type === 'default') return undefined;
  if (type !== 'custom') return { type: type as CronModelConfig['type'] };
  if (typeof model !== 'string' || !model) return 'modelConfig.model is required when type is "custom"';
  return { type: 'custom', model };
}

/** A cron job is its id; a deploy-only lane has none, so it is its (owner, name). */
function dedupeKey(lane: Lane, after: string): string {
  return lane.registry ? `lane:${lane.owner}:${lane.name}:${after}` : `${lane.id}:${after}`;
}

function names(lanes: Lane[]): string[] {
  return lanes.map((lane) => lane.name);
}

function bold(lanes: Lane[]): string {
  return lanes.map((lane) => `*${lane.name}*`).join(', ');
}

/**
 * What the owner can do: run the lane by hand. Ends every ⚠️ line, and
 * mentions each lane's owner so they are notified, not just named. Without a
 * known lane it is the generic hint of each source in `unknown`.
 */
function recovery(lanes: Lane[], unknown: Source[] = ['cron']): string {
  if (lanes.length === 0) return `(owner: ${unknown.map((s) => UNKNOWN_LANE_HINT[s]).join(' · ')})`;
  const hints = [...new Set(lanes.map(laneHint))];
  return `(${hints.join(' · ')})`;
}

/**
 * One lane's hand run: `cron run` for a cron job; a deploy-only lane is no
 * cron job, so its prompt — flattened to one line, the deploy thread's lines
 * are one line each.
 */
function laneHint(lane: Lane): string {
  if (lane.registry) return `<@${lane.owner}> 직접 실행: \`${lane.prompt.replace(/\s+/g, ' ').trim()}\``;
  return `<@${lane.owner}> cron run ${lane.name}`;
}

/** The sources a generic hint must cover: those that hold a lane or could not be read; cron when none does. */
function sourcesOf(lanes: Lane[], unreadable: Unreadable[]): Source[] {
  const held = new Set<Source>(unreadable.map((u) => u.source));
  for (const lane of lanes) {
    if (Array.isArray(lane.onDeploy) && lane.onDeploy.length > 0) held.add(lane.registry ? 'registry' : 'cron');
  }
  const sources = (['cron', 'registry'] as const).filter((s) => held.has(s));
  return sources.length > 0 ? sources : ['cron'];
}

/** Distinct targets registered for `repo` across all lanes, for the near-miss reply. */
function targetsForRepo(lanes: Lane[], repo: string): string[] {
  const want = repo.trim().toLowerCase();
  const targets = new Set<string>();
  for (const lane of lanes) {
    if (!Array.isArray(lane.onDeploy)) continue;
    for (const t of lane.onDeploy) {
      if (typeof t?.repo === 'string' && typeof t?.target === 'string' && t.repo.toLowerCase() === want) {
        targets.add(t.target);
      }
    }
  }
  return [...targets];
}

function failureText(outcomes: FireOutcome[]): string {
  return outcomes.map((o) => `*${o.lane.name}* (${o.detail ?? 'unknown error'})`).join(', ');
}

/** HH:MM in KST, the team's clock (same default as format-rate-limited-at). */
function formatKst(epochMs: number): string {
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochMs));
  return `${hhmm} KST`;
}

/**
 * The deploy thread's one line. A deploy fire always opens a new thread in the
 * lane's channel, so that is where a started lane posts. Anything else that came
 * back ok (a queue) is named for what it is, never as started.
 */
function describeOutcomes(deploy: string, outcomes: FireOutcome[], already: Lane[], alreadyText: string): string {
  const started = outcomes.filter((o) => o.ok && (o.running || o.detail === 'new_thread'));
  const other = outcomes.filter((o) => o.ok && !started.includes(o));
  const failed = outcomes.filter((o) => !o.ok);

  const parts: string[] = [];
  if (started.length > 0) {
    parts.push(started.map((o) => `*${o.lane.name}* → <#${o.lane.channel}> 새 스레드`).join(', '));
  }
  if (other.length > 0) {
    parts.push(
      other
        .map((o) =>
          o.detail === 'busy_queue'
            ? `*${o.lane.name}* 대기열 등록(아직 시작 안 됨)`
            : `*${o.lane.name}* (${o.detail})`,
        )
        .join(', '),
    );
  }
  if (already.length > 0) parts.push(`${alreadyText}: ${bold(already)}`);

  const head = started.length > 0 ? `▶ 배포 레인 시작 — ${deploy}: ` : `ℹ️ 배포 레인 — ${deploy}: `;
  if (failed.length === 0) return `${head}${parts.join(' · ')}`;
  const failedText = `${failureText(failed)} ${recovery(failed.map((o) => o.lane))}`;
  if (parts.length === 0) return `⚠️ 배포 레인 미발동 — ${deploy}: ${failedText}`;
  return `${head}${parts.join(' · ')} · ⚠️ 미발동: ${failedText}`;
}
