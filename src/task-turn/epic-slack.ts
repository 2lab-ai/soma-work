/**
 * #854 — an epic and its children on the Slack path: the host behind the epic's tools
 * (`EpicHost`), what a child's chain end reports, and the epic's wake.
 *
 * One kind of work session: an epic is a Slack thread, each child its own thread in the epic's
 * channel. Everything the epic does to a child is a message into the child's thread as the
 * owner's — the normal Slack path, with its queue, steering, goals and compaction — and the
 * epic's own wake is a message into its thread. Nothing here runs a turn by itself.
 *
 * "Taken" (a message ran, or is stored in the durable follow-up queue) is the receipt every
 * send waits for (`SlackHandler.onTurnAccepted`): `handleMessage` itself resolves only after
 * the whole run.
 *
 * #1020 — the epic also finds its owner's existing sessions (`findTasks`) and adopts one as a
 * child (`adoptChild`, through `SessionRegistry.adoptEpicChild`): nothing is posted or sent then.
 */
import type { RunReport } from '@soma/slack/followup-dispatcher';
import type { WorkLogEntry, WorkLogPage } from '../conversation/work-log';
import { displayTitle } from '../format/display-title';
import { type SessionTheme, ThreadHeaderBuilder } from '../slack/thread-header-builder';
import type { ConversationSession, EpicPlan, TurnOutcomeRecord } from '../types';
import {
  EPIC_NODE_TITLE_MAX,
  type EpicAdoptResult,
  epicWakeText,
  isEpicDone,
  type PlanWriteInput,
  SLACK_WAKE_PREFIX,
  wakeableEpicEvents,
} from './epic-plan';
import type { EpicChildSpec, EpicHost, EpicTaskItem, EpicTaskQuery } from './epic-server';
import type { EpicTreeGate } from './epic-tree-gate';

type Logger = { info(msg: string, meta?: object): void; warn(msg: string, meta?: object): void };

/**
 * A chain's end as its epic hears it, from the last run's outcome — or undefined when nothing ran
 * (a refused, blocked or denied message) or the work goes on by itself (an auto-compact stop).
 */
export function chainEndOf(
  outcome: RunReport['outcome'],
): { outcome: TurnOutcomeRecord['outcome']; reason?: string } | undefined {
  switch (outcome.result) {
    case 'safe':
      return { outcome: 'completed' };
    case 'blocked':
      if (outcome.reason === 'awaiting user choice') return { outcome: 'waiting' };
      // The one block that comes after its turn ran: the handoff ceiling stopped the work (review #872 fable P2-1).
      if (outcome.reason.startsWith('auto-handoff budget exhausted'))
        return { outcome: 'failed', reason: outcome.reason };
      return undefined;
    case 'error':
      return { outcome: 'failed', reason: outcome.reason };
    case 'interrupted':
      if (outcome.reason === 'auto-compact') return undefined;
      return outcome.reason === 'shutdown'
        ? { outcome: 'interrupted', reason: 'shutdown' }
        : { outcome: 'cancelled', ...(outcome.reason ? { reason: outcome.reason } : {}) };
    default:
      return undefined;
  }
}

type ReadWorkLog = (
  conversationId: string,
  options: { beforeSeq?: number; limit?: number },
) => Promise<Pick<WorkLogPage, 'entries' | 'hasMore'>>;

/** A session's last answer: the main agent's last `final` in its work log (a few pages back at most). */
export async function readLatestFinal(
  readWorkLog: ReadWorkLog,
  conversationId: string,
): Promise<{ text: string; clipped: boolean } | undefined> {
  let beforeSeq: number | undefined;
  for (let page = 0; page < 5; page++) {
    const { entries, hasMore } = await readWorkLog(conversationId, {
      limit: 200,
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
    });
    for (let i = entries.length - 1; i >= 0; i--) {
      const e: WorkLogEntry = entries[i];
      if (e.kind === 'final' && !e.agentId) return { text: e.text, clipped: e.rawBytes !== undefined };
    }
    if (!hasMore || entries.length === 0) return undefined;
    beforeSeq = entries[0].seq;
  }
  return undefined;
}

/**
 * The root of a child's thread (#955): the thread header a dashboard or Slack-started task opens on —
 * titled with the node until the child's session names itself, owned by the epic's owner. The child's
 * session is born bot-initiated on it (`botThreadRoot`), so its panel is this root, updated in place.
 */
export function buildEpicChildHeader(
  epic: Pick<ConversationSession, 'ownerId' | 'ownerName'>,
  spec: Pick<EpicChildSpec, 'title'>,
  theme?: SessionTheme,
): { text: string; blocks: unknown[] } {
  const header = ThreadHeaderBuilder.build({
    title: spec.title,
    workflow: 'default',
    ownerId: epic.ownerId,
    ownerName: epic.ownerName,
    theme,
  });
  return { text: header.text, blocks: header.blocks ?? [] };
}

/** The first reply in a child's thread: which epic, which node, and the instruction it starts with. */
export function buildEpicChildInstructionMessage(
  epic: Pick<ConversationSession, 'title' | 'ownerId'>,
  spec: Pick<EpicChildSpec, 'title' | 'instruction' | 'planNodeId'>,
): { text: string; blocks: unknown[] } {
  const head = `🧩 *${(epic.title || '에픽').slice(0, 120)}* › ${spec.title} · <@${epic.ownerId}>의 에픽이 만든 작업`;
  const body = spec.instruction.length > 2900 ? `${spec.instruction.slice(0, 2900)}\n… (이하 생략)` : spec.instruction;
  return {
    text: `🧩 ${spec.title}`,
    blocks: [
      { type: 'context', elements: [{ type: 'mrkdwn', text: head }] },
      { type: 'section', text: { type: 'plain_text', text: body } },
    ],
  };
}

/**
 * Wait for a best-effort post at most `ms` (#955 review, astra P2): Slack's client has no request
 * timeout and retries rate limits, so an unbounded wait on an optional reply would hold back the
 * work it precedes. Never throws; the post may still land after the wait ends.
 */
function settleWithin(post: Promise<unknown>, ms: number): Promise<{ failed?: unknown; timedOut?: true }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms);
    timer.unref?.();
    post.then(
      () => {
        clearTimeout(timer);
        resolve({});
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ failed: error });
      },
    );
  });
}

/** What a send into a thread became: taken (ran or queued), refused (settled without), or no answer in time. */
type HandOver = 'taken' | 'refused' | 'timeout';

/** Run `send` and wait for its receipt: `onAccepted` fires (taken), or `send` settles first (refused). */
function handOver(
  send: (onAccepted: () => void) => Promise<unknown>,
  timeoutMs: number,
  logger: Logger,
): Promise<HandOver> {
  return new Promise<HandOver>((resolve) => {
    let done = false;
    const finish = (v: HandOver) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    timer.unref?.();
    send(() => finish('taken')).then(
      () => finish('refused'),
      (error) => {
        logger.warn('An epic message could not be sent', { error: (error as Error)?.message ?? String(error) });
        finish('refused');
      },
    );
  });
}

/** #1020 — `find_tasks` lists this many tasks unless asked for another number, and never more than the max. */
export const FIND_TASKS_DEFAULT = 20;
export const FIND_TASKS_MAX = 50;

/**
 * #1020 — the epic owner's live sessions as `find_tasks` shows them (`EpicHost.findTasks`): never the
 * epic itself, another owner's, a terminated or a trashed one; `query` words all in the display title
 * (any case); `day` (`today` or YYYY-MM-DD) the calendar day the session started or was last active in
 * `timezone`; newest activity first, `limit` of them (20 by default, 1–50).
 */
export function findEpicTasks(
  epic: ConversationSession,
  sessions: Iterable<ConversationSession>,
  query: EpicTaskQuery,
  ctx: { timezone: string; now: number; getSessionByTaskId(taskId: string): ConversationSession | undefined },
): EpicTaskItem[] {
  const calendar = new Intl.DateTimeFormat('en-CA', {
    timeZone: ctx.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dayOf = (ms: number | undefined) =>
    typeof ms === 'number' && Number.isFinite(ms) ? calendar.format(ms) : undefined;
  const day = query.day === 'today' ? dayOf(ctx.now) : query.day;
  const words = (query.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const wanted = Number.isFinite(query.limit) ? Math.floor(query.limit as number) : FIND_TASKS_DEFAULT;
  const limit = Math.min(FIND_TASKS_MAX, Math.max(1, wanted));
  /** Why a session cannot be adopted (the registry refuses it), or undefined. */
  const whyNot = (s: ConversationSession): string | undefined => {
    if (!s.taskId) return 'no task id';
    if (s.kind === 'epic') return 'is an epic';
    if (s.parentTaskId) {
      if (s.parentTaskId === epic.taskId) return 'already a child of this epic';
      const parent = ctx.getSessionByTaskId(s.parentTaskId);
      return parent ? `already a child of epic "${displayTitle(parent)}"` : 'already a child of another epic';
    }
    if (s.closing) return 'closing';
    return undefined;
  };
  const found: Array<{ at: number; item: EpicTaskItem }> = [];
  for (const s of sessions) {
    if (s === epic || (!!s.taskId && s.taskId === epic.taskId)) continue;
    if (s.ownerId !== epic.ownerId || s.terminated || s.trashed) continue;
    // The plan node it is adopted under carries this title: it fits a node's.
    const title = displayTitle(s).slice(0, EPIC_NODE_TITLE_MAX);
    const lower = title.toLowerCase();
    if (!words.every((w) => lower.includes(w))) continue;
    const last = new Date(s.lastActivity).getTime();
    if (day !== undefined && dayOf(s.startedAt) !== day && dayOf(last) !== day) continue;
    const reason = whyNot(s);
    found.push({
      at: Number.isFinite(last) ? last : 0,
      item: {
        ...(s.taskId ? { taskId: s.taskId } : {}),
        title,
        state: s.activityState ?? 'idle',
        channel: s.channelId,
        ...(dayOf(s.startedAt) ? { startedAt: new Date(s.startedAt as number).toISOString() } : {}),
        lastActivity: Number.isFinite(last) ? new Date(last).toISOString() : 'unknown',
        adoptable: reason === undefined,
        ...(reason ? { reason } : {}),
      },
    });
  }
  return found
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((f) => f.item);
}

export interface SlackEpicHostDeps {
  getSessionByTaskId(taskId: string): ConversationSession | undefined;
  getChildTasks(parentTaskId: string): ConversationSession[];
  /** #1020 — every session the registry holds, by key (`find_tasks` reads the epic owner's). */
  getAllSessions(): ReadonlyMap<string, ConversationSession>;
  /** #1020 — adopt the owner's session as the epic's child (`SessionRegistry.adoptEpicChild`). */
  adoptEpicChild(epicTaskId: string, childTaskId: string, planNodeId: string): EpicAdoptResult;
  /** #1020 — the calendar `find_tasks`' `day` is read in (REPORT_TIMEZONE, `getReportTimezone`). */
  timezone: string;
  /** The clock `today` is read from (default `Date.now`). */
  now?: () => number;
  setEpicPlan(taskId: string, input: PlanWriteInput, by: 'epic' | 'owner'): EpicPlan;
  reserveEpicChild(epicTaskId: string, planNodeId: string): string;
  unreserveEpicChild(epicTaskId: string, childId: string): void;
  /** The registry key of a Slack thread. */
  keyOf(session: ConversationSession): string | undefined;
  /** Post a child thread's root (the bot's header), or a reply in it when `threadTs` is given. */
  postMessage(
    channel: string,
    text: string,
    blocks: unknown[],
    threadTs?: string,
  ): Promise<{ ts?: string } | undefined>;
  /** The owner's thread header theme; absent = the server's. */
  getSessionTheme?(userId: string): SessionTheme | undefined;
  /** Hand a message to the Slack path (`handleMessage`); resolves when its run settled. */
  handleMessage(event: Record<string, unknown>): Promise<unknown>;
  onTurnAccepted(channel: string, ts: string, accepted: () => void): () => void;
  /**
   * Send `text` into a session's thread as its owner's message (the dashboard's instruction
   * path, with its own echo label); `onAccepted` fires once it is taken. Resolves when its run settled.
   */
  sendToThread(sessionKey: string, text: string, opts: { onAccepted: () => void; label: string }): Promise<unknown>;
  /** A turn of this session runs now. */
  isRunning(sessionKey: string): boolean;
  readWorkLog: ReadWorkLog;
  gate: EpicTreeGate;
  ensureDirectory(dir: string): string | undefined;
  logger: Logger;
  /** How long a send waits for its receipt (default two minutes). */
  acceptTimeoutMs?: number;
  /** How long a child's instruction reply is waited for before the child starts anyway (default 10 s). */
  replyTimeoutMs?: number;
}

export function createSlackEpicHost(deps: SlackEpicHostDeps): EpicHost {
  const timeoutMs = deps.acceptTimeoutMs ?? 120_000;
  const replyTimeoutMs = deps.replyTimeoutMs ?? 10_000;
  /**
   * Idle children an instruction is being handed to, per epic (review #872 R2 astra): from the
   * hand-over until it is taken (the echo posting, the slot not held yet). They count as running —
   * a parallel instruction or spawn sees their place and their folder taken.
   */
  const starting = new Map<string, Set<string>>();
  const isStarting = (s: ConversationSession) =>
    !!s.parentTaskId && !!s.taskId && !!starting.get(s.parentTaskId)?.has(s.taskId);
  /** Instructions to working children being handed over, per epic: starts in flight, no running place. */
  const handing = new Map<string, number>();
  const handingIn = (epicTaskId: string | undefined) => (epicTaskId ? (handing.get(epicTaskId) ?? 0) : 0);
  const startingIn = (epicTaskId: string | undefined, except?: string) =>
    epicTaskId ? [...(starting.get(epicTaskId) ?? [])].filter((id) => id !== except).length : 0;
  const running = (s: ConversationSession) => {
    const key = deps.keyOf(s);
    return (!!key && deps.isRunning(key)) || isStarting(s);
  };
  /**
   * The plan nodes whose child is being made, per epic, with the folder it is placed in (review #872):
   * from its reservation until its first instruction is handed over. Parallel `spawn_child` calls see
   * it — one child per node, no two in one folder, and each child being made takes a running place
   * before it is a session.
   */
  const making = new Map<string, Map<string, string | undefined>>();
  const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  const makingIn = (epicTaskId: string | undefined) => (epicTaskId ? (making.get(epicTaskId)?.size ?? 0) : 0);
  /** The child's thread and its first instruction, once its id is reserved (`spawnChild`). */
  const makeChild = async (
    epic: ConversationSession,
    epicTaskId: string,
    spec: Parameters<EpicHost['spawnChild']>[1],
    channel: string,
    childId: string,
  ): ReturnType<EpicHost['spawnChild']> => {
    const root = buildEpicChildHeader(epic, spec, epic.ownerId ? deps.getSessionTheme?.(epic.ownerId) : undefined);
    let rootTs: string | undefined;
    try {
      rootTs = (await deps.postMessage(channel, root.text, root.blocks))?.ts;
    } catch (error) {
      deps.logger.warn('Epic child: its thread could not be made', {
        epicTaskId: epicTaskId,
        error: (error as Error)?.message ?? String(error),
      });
    }
    if (!rootTs) {
      deps.unreserveEpicChild(epicTaskId, childId);
      return {
        ok: false,
        code: 'no-thread',
        error: "the child's thread could not be made — nothing changed; try again",
      };
    }
    // The instruction, with its epic, as the thread's first reply — the child runs without it (its
    // session gets the instruction; the epic's tree shows it).
    const instruction = buildEpicChildInstructionMessage(epic, spec);
    const reply = await settleWithin(
      Promise.resolve().then(() => deps.postMessage(channel, instruction.text, instruction.blocks, rootTs)),
      replyTimeoutMs,
    );
    if (reply.timedOut || reply.failed !== undefined) {
      deps.logger.warn(
        reply.timedOut
          ? 'Epic child: its instruction reply is still posting — the child starts without it'
          : 'Epic child: its instruction reply could not be posted',
        {
          epicTaskId: epicTaskId,
          childId,
          ...(reply.failed !== undefined
            ? { error: (reply.failed as Error)?.message ?? String(reply.failed) }
            : { waitedMs: replyTimeoutMs }),
        },
      );
    }
    const event: Record<string, unknown> = {
      type: 'message',
      user: epic.ownerId,
      channel,
      thread_ts: rootTs,
      ts: rootTs,
      // The root is the bot's header: the child's session is born bot-initiated on it (#955).
      botThreadRoot: true,
      text: spec.instruction,
      ...(epic.model ? { modelOverride: epic.model } : {}),
      // A child works its instruction; it is not a goal of its own unless its epic says so.
      autoGoalOverride: false,
      epicChild: { taskId: childId, parentTaskId: epicTaskId, planNodeId: spec.planNodeId, title: spec.title },
      ...(spec.workingDirectory ? { workingDirectoryOverride: spec.workingDirectory } : {}),
      // The epic's words as written: no command routing, never pushed into another turn. The owner's
      // word, delegated — as every later instruction to the child (only the epic's own wake is a host turn).
      routeContext: { skipAutoBotThread: true, verbatimPrompt: true },
    };
    const result = await handOver(
      (onAccepted) => {
        const unwatch = deps.onTurnAccepted(channel, rootTs as string, onAccepted);
        return deps.handleMessage(event).finally(unwatch);
      },
      timeoutMs,
      deps.logger,
    );
    if (result === 'taken') deps.gate.record(epic);
    // Not taken: no session took the id (a bind that failed after the thread was posted) — it is taken
    // back, so it does not count against the epic's children (review #872). A timeout may still bind.
    if (result === 'refused') deps.unreserveEpicChild(epicTaskId, childId);
    deps.logger.info('Epic child made in its own thread', {
      epicTaskId: epicTaskId,
      childId,
      planNodeId: spec.planNodeId,
      result,
    });
    return {
      ok: true,
      childId,
      started: result === 'taken',
      ...(result === 'taken'
        ? {}
        : {
            reason:
              result === 'timeout'
                ? 'no answer from its thread yet — read child_status before sending more'
                : 'its first instruction did not start — see its thread',
          }),
    };
  };
  return {
    getTask: (taskId) => deps.getSessionByTaskId(taskId),
    getChildTasks: (parentTaskId) => deps.getChildTasks(parentTaskId),
    setEpicPlan: (taskId, input, by) => deps.setEpicPlan(taskId, input, by),
    readChildFinal: async (child) =>
      child.conversationId ? readLatestFinal(deps.readWorkLog, child.conversationId) : undefined,
    isRunning: running,
    // A new child, or an idle one about to run, takes a running place: so do the children being made
    // and the idle ones being started (the gate counts only the ones already running).
    admit: (epic, start) => {
      const making = makingIn(epic.taskId) + startingIn(epic.taskId, start.child?.taskId);
      const pending = making + handingIn(epic.taskId);
      if (start.newChild || (start.child && !running(start.child))) {
        return deps.gate.refusal(epic, { ...start, making, ...(pending !== making ? { pending } : {}) });
      }
      return deps.gate.refusal(epic, pending > 0 ? { ...start, pending } : start);
    },
    ensureDirectory: (dir) => deps.ensureDirectory(dir),

    findTasks: (epic, query) =>
      findEpicTasks(epic, deps.getAllSessions().values(), query, {
        timezone: deps.timezone,
        now: (deps.now ?? Date.now)(),
        getSessionByTaskId: (id) => deps.getSessionByTaskId(id),
      }),

    adoptChild(epic, taskId, planNodeId) {
      if (!epic.taskId) return { ok: false, code: 'not-an-epic', error: 'this session is no longer a live epic' };
      // A node whose child is being made right now has it already (one per node).
      if (making.get(epic.taskId)?.has(planNodeId)) {
        return {
          ok: false,
          code: 'spawn-in-flight',
          error: 'a child for this node is being made right now — adopt the task under another node',
        };
      }
      let adopted: EpicAdoptResult;
      try {
        adopted = deps.adoptEpicChild(epic.taskId, taskId, planNodeId);
      } catch (error) {
        deps.logger.warn('Epic child: a task could not be adopted', {
          epicTaskId: epic.taskId,
          taskId,
          error: (error as Error)?.message ?? String(error),
        });
        return { ok: false, code: 'not-saved', error: 'the task could not be adopted — nothing changed; try again' };
      }
      return adopted;
    },

    async spawnChild(epic, spec) {
      const channel = epic.channelId;
      if (!channel || !epic.taskId) {
        return { ok: false, code: 'no-thread', error: 'the epic has no Slack thread to make a child next to' };
      }
      const epicTaskId = epic.taskId;
      const nodes = making.get(epicTaskId) ?? new Map<string, string | undefined>();
      if (nodes.has(spec.planNodeId)) {
        return {
          ok: false,
          code: 'spawn-in-flight',
          error: 'a child for this node is being made right now — look for it with child_status in a moment',
        };
      }
      const dir = spec.workingDirectory;
      if (dir && [...nodes.values()].some((other) => other && overlaps(other, dir))) {
        return { ok: false, code: 'folder-overlap', error: 'a child being made right now works in that folder' };
      }
      let childId: string;
      try {
        childId = deps.reserveEpicChild(epicTaskId, spec.planNodeId);
      } catch {
        return { ok: false, code: 'not-saved', error: 'the child could not be made — nothing changed; try again' };
      }
      nodes.set(spec.planNodeId, dir);
      making.set(epicTaskId, nodes);
      try {
        return await makeChild(epic, epicTaskId, spec, channel, childId);
      } finally {
        nodes.delete(spec.planNodeId);
        if (nodes.size === 0 && making.get(epicTaskId) === nodes) making.delete(epicTaskId);
      }
    },

    async instructChild(epic, child, instruction) {
      const key = deps.keyOf(child);
      if (!key) return { taken: false, queued: false, reason: 'the child has no Slack thread' };
      const queued = deps.isRunning(key);
      // An idle child in the folder a child being made takes does not start now: two running children
      // never share a folder (review #872 R2 astra — a spawn first, an instruction next).
      const theirs = child.sessionWorkingDir;
      if (!queued && theirs && child.parentTaskId) {
        const made = [...(making.get(child.parentTaskId)?.values() ?? [])];
        if (made.some((dir) => dir && overlaps(dir, theirs))) {
          return {
            taken: false,
            queued: false,
            reason: 'a child being made right now works in its folder — try again shortly',
          };
        }
      }
      // An idle child is being started until its instruction is taken.
      const epicTaskId = child.parentTaskId;
      const childId = child.taskId;
      const marks = !queued && epicTaskId && childId ? (starting.get(epicTaskId) ?? new Set<string>()) : undefined;
      if (marks && epicTaskId && childId) {
        marks.add(childId);
        starting.set(epicTaskId, marks);
      }
      // A working child's word: a start in flight for the window until it is taken.
      const hands = queued && epicTaskId ? epicTaskId : undefined;
      if (hands) handing.set(hands, handingIn(hands) + 1);
      let result: Awaited<ReturnType<typeof handOver>>;
      try {
        result = await handOver(
          (onAccepted) => deps.sendToThread(key, instruction, { onAccepted, label: '🧩 에픽의 지시' }),
          timeoutMs,
          deps.logger,
        );
      } finally {
        if (marks && epicTaskId && childId) {
          marks.delete(childId);
          if (marks.size === 0 && starting.get(epicTaskId) === marks) starting.delete(epicTaskId);
        }
        if (hands) {
          const left = handingIn(hands) - 1;
          if (left > 0) handing.set(hands, left);
          else handing.delete(hands);
        }
      }
      if (result === 'taken') {
        // A start in the tree's window, now or after the turn in flight (review #872 astra 7) — a queued
        // word takes no new running place, but it will start a turn.
        deps.gate.record(epic);
        return { taken: true, queued };
      }
      return {
        taken: false,
        queued: false,
        reason:
          result === 'timeout'
            ? 'no answer from its thread yet — read child_status before sending it again'
            : 'the instruction was not taken — see its thread',
      };
    },
  };
}

export interface SlackEpicWakerDeps {
  getSession(sessionKey: string): ConversationSession | undefined;
  /** A turn of this session runs, or its queue holds work: its own chain end wakes it later. */
  isBusy(sessionKey: string): boolean;
  gate: EpicTreeGate;
  /** Deliver the events to the wake `by` (strict save — throws when not saved). */
  consume(sessionKey: string, ids: readonly string[], by: string): void;
  /** A wake that was not sent: its events are pending again. */
  release(sessionKey: string, by: string): void;
  /** Send the wake into the epic's thread (its owner's, labelled); `onAccepted` once taken. */
  /** `hostTurn`: the wake is soma-work's word — it answers no question the epic asked its owner. */
  send(
    sessionKey: string,
    text: string,
    opts: { onAccepted: () => void; label: string; hostTurn: true },
  ): Promise<unknown>;
  logger: Logger;
  /** The delay of the one retry after a refusal (default one minute). */
  retryMs?: number;
  now?: () => number;
  acceptTimeoutMs?: number;
  /** Mark the wakes the epic's ended chain ran done — all but `keep` (`SessionRegistry.settleEpicWakes`). */
  settle?(sessionKey: string, keep: string | undefined): void;
}

export interface SlackEpicWaker {
  /** Wake this session if it is a live, idle Slack epic, not done, with pending events. Never throws. */
  wake(sessionKey: string): void;
  /**
   * The epic's chain ended: the wakes it ran are settled (`deps.settle`) — never the one still being
   * sent (consumed, not taken yet: a restart before it is taken must deliver it again) — and it may wake.
   */
  chainEnded(sessionKey: string): void;
}

/**
 * #854 — waking a Slack epic (.prd/19 D7 on the Slack path): when it is idle and its children's
 * ends are pending, one message into its thread with the fixed wake text. The events are
 * delivered to that wake first (saved); a wake that was not taken puts them back and arms one
 * retry — a refusal of that retry arms nothing more until a wake is taken or nothing waits.
 */
export function createSlackEpicWaker(deps: SlackEpicWakerDeps): SlackEpicWaker {
  const retryMs = deps.retryMs ?? 60_000;
  const now = deps.now ?? Date.now;
  const retries = new Map<string, ReturnType<typeof setTimeout>>();
  const spent = new Set<string>();
  /** Epics a wake is being sent to now (one at a time), with that wake's id until it is taken. */
  const sending = new Map<string, string | undefined>();

  function retryLater(sessionKey: string): void {
    if (retries.has(sessionKey) || spent.has(sessionKey)) return;
    const timer = setTimeout(() => {
      retries.delete(sessionKey);
      spent.add(sessionKey);
      wake(sessionKey);
    }, retryMs);
    timer.unref?.();
    retries.set(sessionKey, timer);
  }

  async function drain(sessionKey: string): Promise<void> {
    const epic = deps.getSession(sessionKey);
    if (!epic || epic.kind !== 'epic' || epic.terminated || epic.closing) {
      spent.delete(sessionKey);
      return;
    }
    if (sending.has(sessionKey) || deps.isBusy(sessionKey) || isEpicDone(epic.plan)) return;
    const events = wakeableEpicEvents(epic.epicEvents);
    if (events.length === 0) {
      spent.delete(sessionKey);
      return;
    }
    const refused = deps.gate.refusal(epic, {});
    if (refused) {
      deps.logger.info('Epic wake not started — its events stay pending', { sessionKey, refused });
      retryLater(sessionKey);
      return;
    }
    const by = `${SLACK_WAKE_PREFIX}${now()}`;
    deps.consume(
      sessionKey,
      events.map((e) => e.id),
      by,
    );
    deps.gate.record(epic);
    sending.set(sessionKey, by);
    try {
      const result = await handOver(
        (onAccepted) =>
          deps.send(sessionKey, epicWakeText(events), { onAccepted, label: '🧩 자식 작업 소식', hostTurn: true }),
        deps.acceptTimeoutMs ?? 120_000,
        deps.logger,
      );
      if (result === 'taken') {
        spent.delete(sessionKey);
        // Taken (running, or stored in its queue): no longer one being sent.
        sending.set(sessionKey, undefined);
        return;
      }
      deps.release(sessionKey, by);
      deps.logger.info('Epic wake not taken — its events are pending again', { sessionKey, result });
      retryLater(sessionKey);
    } finally {
      sending.delete(sessionKey);
    }
  }

  function wake(sessionKey: string): void {
    queueMicrotask(() => {
      drain(sessionKey).catch((error) => {
        deps.logger.warn('Epic wake failed — its events stay pending', {
          sessionKey,
          error: (error as Error)?.message ?? String(error),
        });
      });
    });
  }

  function chainEnded(sessionKey: string): void {
    try {
      deps.settle?.(sessionKey, sending.get(sessionKey));
    } catch (error) {
      deps.logger.warn('Epic wakes could not be settled — a restart delivers them again', {
        sessionKey,
        error: (error as Error)?.message ?? String(error),
      });
    }
    wake(sessionKey);
  }

  return { wake, chainEnded };
}
