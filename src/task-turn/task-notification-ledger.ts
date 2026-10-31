import * as path from 'node:path';
import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import { DATA_DIR } from '../env-paths';
import { Logger } from '../logger';
import type { TaskNoticeIntent, TaskNoticeKind } from '../types';

/**
 * E2 ④ — delivery state for the notices a Slack-less task owes its
 * instruction thread (.prd/18 D7, §6.1).
 *
 * What a task owes is written on the task record with the state it describes
 * (`notices`, E2 ③). Whether Slack has it is written here, in a file of its
 * own: tying "Slack accepted the post" to "the session was saved" would lose a
 * posted message id when a session save fails, and the retry would post again.
 *
 * Contract (at least once):
 *  - `register` is idempotent by intent id — the id is deterministic, so a
 *    notice produced twice is one entry.
 *  - `claim` writes `unknown` **before** the post. A crash between the post
 *    and `markPosted` leaves `unknown`, which may be claimed again after a
 *    restart: one duplicate per such crash, no global cap.
 *  - `posted` is never claimed again. `resolved` / `superseded` close an entry
 *    that no longer needs sending (answered, expired, replaced).
 *  - Every change is one atomic write (`@soma/common/atomic-json`); a failed
 *    write leaves memory and disk as they were and throws.
 *
 * Not the thread-panel outbox: that store refuses to re-post an ambiguous
 * `pending` (a card that may already exist); a notice policy is the opposite.
 * Separate file, separate key space.
 *
 * No Slack calls, no message text: addressing and state only.
 */

export const TASK_NOTIFICATION_LEDGER_FILENAME = 'task-notification-ledger.json';

export type TaskNotificationLedgerState = 'pending' | 'unknown' | 'posted' | 'failed' | 'resolved' | 'superseded';

/** What the deliverer needs to render the notice without the task (it may be closed by then). */
export type TaskNotificationLedgerIntent = Partial<Omit<TaskNoticeIntent, 'id' | 'kind'>> & {
  approvalId?: string;
  toolName?: string;
  expiresAt?: number;
  /** E2 ⑤ — what rendering needs after the task may be gone: its conversation, owner and key. */
  conversationId?: string;
  ownerId?: string;
  sessionKey?: string;
};

export interface TaskNotificationLedgerEntry {
  /** The notice intent id (deterministic). */
  id: string;
  taskId: string;
  kind: TaskNoticeKind | 'approval';
  /** The instruction thread: channel and root thread ts. */
  channel: string;
  threadTs: string;
  state: TaskNotificationLedgerState;
  /** Claims so far (each one may have posted). */
  attempts: number;
  messageTs?: string;
  /** The last delivery failure. */
  error?: string;
  intent: TaskNotificationLedgerIntent;
  createdAt: number;
  updatedAt: number;
}

export interface RegisterTaskNotice {
  id: string;
  taskId: string;
  kind: TaskNotificationLedgerEntry['kind'];
  channel: string;
  threadTs: string;
  intent?: TaskNotificationLedgerIntent;
}

/** A transition the state machine does not allow, or an unknown id. Nothing changed. */
export class LedgerTransitionError extends Error {
  constructor(id: string, from: TaskNotificationLedgerState | 'missing', to: string) {
    super(`task notification ledger: ${id} cannot go ${from} → ${to}`);
    this.name = 'LedgerTransitionError';
  }
}

const STATES: readonly TaskNotificationLedgerState[] = [
  'pending',
  'unknown',
  'posted',
  'failed',
  'resolved',
  'superseded',
];
const KINDS: readonly TaskNotificationLedgerEntry['kind'][] = [
  'link',
  'result',
  'question',
  'failure',
  'interrupted',
  'approval',
];
/** Still owed: not delivered and not closed. */
const OWED: readonly TaskNotificationLedgerState[] = ['pending', 'unknown', 'failed'];
const CLOSABLE: readonly TaskNotificationLedgerState[] = ['pending', 'unknown', 'failed'];

interface LedgerFile {
  version: 1;
  entries: TaskNotificationLedgerEntry[];
}

function validateFile(raw: unknown): LedgerFile {
  if (typeof raw !== 'object' || raw === null) throw new Error('not an object');
  const v = raw as { version?: unknown; entries?: unknown };
  if (v.version !== 1 || !Array.isArray(v.entries)) throw new Error('not a version 1 ledger');
  for (const e of v.entries as Array<Record<string, unknown>>) {
    if (typeof e !== 'object' || e === null) throw new Error('an entry is not an object');
    if (typeof e.id !== 'string' || e.id === '') throw new Error('an entry has no id');
    if (!STATES.includes(e.state as TaskNotificationLedgerState)) throw new Error(`entry ${e.id}: bad state`);
    if (!KINDS.includes(e.kind as TaskNotificationLedgerEntry['kind'])) throw new Error(`entry ${e.id}: bad kind`);
    if (typeof e.taskId !== 'string' || typeof e.channel !== 'string' || typeof e.threadTs !== 'string') {
      throw new Error(`entry ${e.id}: bad target`);
    }
    if (![e.attempts, e.createdAt, e.updatedAt].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error(`entry ${e.id}: bad counts or times`);
    }
    if (typeof e.intent !== 'object' || e.intent === null || Array.isArray(e.intent)) {
      throw new Error(`entry ${e.id}: bad intent`);
    }
  }
  return v as LedgerFile;
}

const logger = new Logger('task-notification-ledger');

export class TaskNotificationLedger {
  private entries = new Map<string, TaskNotificationLedgerEntry>();
  /** Writes wait for the file to be read: a write before it would replace the live file with less. */
  private loaded = false;

  constructor(
    private readonly filePath: string = path.join(DATA_DIR, TASK_NOTIFICATION_LEDGER_FILENAME),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Read the file (falling back to its backup), once, before any write. No
   * file is an empty ledger; an unusable one throws, and the ledger stays
   * unwritable rather than start empty and lose or re-send what it owed.
   */
  load(): void {
    if (this.loaded) throw new Error('task notification ledger: already loaded');
    const file = readJsonWithBackup(this.filePath, validateFile, { warn: (m) => logger.warn(m) });
    this.entries = new Map((file?.entries ?? []).map((e) => [e.id, e]));
    this.loaded = true;
  }

  get(id: string): TaskNotificationLedgerEntry | undefined {
    return this.entries.get(id);
  }

  /** Add an entry as `pending`, saved before it returns. An id already here is returned as it is. */
  register(input: RegisterTaskNotice): TaskNotificationLedgerEntry {
    const existing = this.entries.get(input.id);
    if (existing) return existing;
    const at = this.now();
    const entry: TaskNotificationLedgerEntry = {
      id: input.id,
      taskId: input.taskId,
      kind: input.kind,
      channel: input.channel,
      threadTs: input.threadTs,
      state: 'pending',
      attempts: 0,
      intent: { ...(input.intent ?? {}) },
      createdAt: at,
      updatedAt: at,
    };
    this.commit(input.id, entry);
    return entry;
  }

  /**
   * Before the post: `pending`, `unknown` or `failed` → `unknown`, one more
   * attempt. `failed` is still owed (D7, D13): the deliverer leaves it alone
   * within a process and claims it again after a restart.
   */
  claim(id: string): TaskNotificationLedgerEntry {
    return this.transition(id, ['pending', 'unknown', 'failed'], 'unknown', (e) => ({
      ...e,
      attempts: e.attempts + 1,
    }));
  }

  /**
   * Slack has it: `unknown` → `posted` with its message ts. Refused if the
   * entry was closed while its post was in flight — the message is in Slack,
   * its ts is not kept (the caller logs it; it is not a failed post).
   */
  markPosted(id: string, messageTs: string): TaskNotificationLedgerEntry {
    return this.transition(id, ['unknown'], 'posted', (e) => ({ ...e, messageTs, error: undefined }));
  }

  /** The post failed: back to `pending` to retry, or `failed` when retries are spent. */
  markFailed(id: string, error: string, options: { final: boolean }): TaskNotificationLedgerEntry {
    return this.transition(id, ['unknown'], options.final ? 'failed' : 'pending', (e) => ({ ...e, error }));
  }

  /** Every entry, in no particular order. */
  list(): TaskNotificationLedgerEntry[] {
    return [...this.entries.values()];
  }

  /** No longer worth sending (answered, expired, replaced). */
  close(id: string, as: 'resolved' | 'superseded'): TaskNotificationLedgerEntry {
    return this.transition(id, CLOSABLE, as, (e) => e);
  }

  /** What is still owed — pending, unknown or failed — a task's link first, then by creation. */
  owed(): TaskNotificationLedgerEntry[] {
    const owed = [...this.entries.values()].filter((e) => OWED.includes(e.state));
    // Tasks in the order their first owed entry was created.
    const firstAt = new Map<string, number>();
    for (const e of owed) firstAt.set(e.taskId, Math.min(firstAt.get(e.taskId) ?? e.createdAt, e.createdAt));
    return owed.sort((a, b) => {
      if (a.taskId !== b.taskId) {
        return (firstAt.get(a.taskId) ?? 0) - (firstAt.get(b.taskId) ?? 0) || a.taskId.localeCompare(b.taskId);
      }
      const link = Number(b.kind === 'link') - Number(a.kind === 'link');
      return link || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
    });
  }

  private transition(
    id: string,
    from: readonly TaskNotificationLedgerState[],
    to: TaskNotificationLedgerState,
    change: (e: TaskNotificationLedgerEntry) => TaskNotificationLedgerEntry,
  ): TaskNotificationLedgerEntry {
    const current = this.entries.get(id);
    if (!current) throw new LedgerTransitionError(id, 'missing', to);
    if (!from.includes(current.state)) throw new LedgerTransitionError(id, current.state, to);
    const next = { ...change(current), state: to, updatedAt: this.now() };
    this.commit(id, next);
    return next;
  }

  /** One atomic write with `entry` in place; on failure memory is put back and the error thrown. */
  private commit(id: string, entry: TaskNotificationLedgerEntry): void {
    if (!this.loaded) throw new Error('task notification ledger: written before it was loaded');
    const previous = this.entries.get(id);
    this.entries.set(id, entry);
    try {
      atomicWriteJson(this.filePath, { version: 1, entries: [...this.entries.values()] } satisfies LedgerFile, {
        validatePrevious: (raw) => {
          try {
            validateFile(raw);
            return true;
          } catch {
            return false;
          }
        },
        warn: (m) => logger.warn(m),
      });
    } catch (error) {
      if (previous) this.entries.set(id, previous);
      else this.entries.delete(id);
      throw error;
    }
  }
}
