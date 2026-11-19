#!/usr/bin/env node

/**
 * work-queue MCP server (.prd/36 §4.1, .prd/37 §3) — the one way a model lines up for a lane.
 *
 * A queue is `<lane>:<env>` (`deploy:dev2`, `qa:stage0`), configured in `config.json#workQueues`. The server knows
 * nothing about what a lane means: deploy and QA use the same four tools. It changes the shared ledger
 * (`DATA_DIR/work-queues.sqlite3`, `@soma/process-shared/work-queue`) in one SQLite transaction and answers on the
 * spot — a conflict comes back in the same call, so the model never waits to learn it. The host reads the same
 * ledger: it wakes the thread whose turn came and gives back a turn its thread stopped working on.
 *
 * The thread (holder) comes from `SOMA_WORK_QUEUE_CONTEXT`, which the host writes when it starts this process — the
 * model cannot name another thread.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition, ToolResult } from '@soma/process-shared/mcp/base-mcp-server.js';
import { BaseMcpServer } from '@soma/process-shared/mcp/base-mcp-server.js';
import { StderrLogger } from '@soma/process-shared/stderr-logger.js';
import { parseWorkQueuesConfig, type WorkQueueDef } from '@soma/process-shared/work-queue/config.js';
import {
  briefOf,
  endEntry,
  enterQueue,
  entriesOfHolder,
  queuePosition,
  queueViews,
  type WorkQueueHolder,
} from '@soma/process-shared/work-queue/ledger.js';
import { WORK_QUEUE_FILE, WorkQueueStore, workQueueStoreAvailable } from '@soma/process-shared/work-queue/store.js';

const logger = new StderrLogger('WorkQueueMCP');

const NOT_A_PERSON =
  'Never poll the queue, sleep, arm a cron or ask the user about the wait — waiting in line is not a question.';

type WorkQueueToolDefinition = ToolDefinition & {
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
};

export const WORK_QUEUE_TOOLS: WorkQueueToolDefinition[] = [
  {
    name: 'queue_list',
    description:
      'Show the work queues of this host (`<lane>:<env>`, e.g. deploy:dev2, qa:stage0): per queue the entry that runs, ' +
      'the entries that wait (in order) and what recently ended — each with its keys and the thread that holds it — ' +
      'plus the entries this thread holds.',
    inputSchema: {
      type: 'object',
      properties: { queue: { type: 'string', description: 'One queue only (e.g. "qa:dev2").' } },
      additionalProperties: false,
    },
  },
  {
    name: 'queue_enter',
    description:
      'Line up for a lane before doing its work (a deploy, a QA run): one entry runs per queue at a time. Name the work ' +
      'by keys — Jira keys (ABC-1234) or GitHub keys (owner/repo#123; issues and PRs share the form): the PRs a deploy ' +
      'ships, the issues a QA run checks. If any key already runs or waits in that queue the whole entry is refused ' +
      '(CONFLICT) with who holds it: someone else does that work — drop those keys and enter again with the rest; if ' +
      'none is left the work is not needed, say so and stop. "running" = start now and call queue_done when the work ' +
      'ends. "queued" = end your turn now; the host wakes this thread when its turn comes. ' +
      NOT_A_PERSON,
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', description: 'The queue, `<lane>:<env>` (see queue_list), e.g. "qa:dev2".' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'The work this entry is for: Jira keys or GitHub owner/repo#number. At least one.',
        },
        note: { type: 'string', description: 'One line for people reading the queue (what runs).' },
      },
      required: ['queue', 'keys'],
      additionalProperties: false,
    },
  },
  {
    name: 'queue_done',
    description:
      'The work of your running entry ended (passed or failed): free the lane. The next waiting entry starts at once ' +
      'and its thread is woken. Call it as soon as the work ends — a turn that ends holding the lane gets it taken back.',
    inputSchema: {
      type: 'object',
      properties: { entry: { type: 'string', description: 'Your entry id (wq-…).' } },
      required: ['entry'],
      additionalProperties: false,
    },
  },
  {
    name: 'queue_cancel',
    description:
      'Leave the line (a waiting entry) or give the lane back without doing the work (a running entry) — e.g. the work ' +
      'is no longer needed.',
    inputSchema: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'Your entry id (wq-…).' },
        reason: { type: 'string', description: 'Why, in one line.' },
      },
      required: ['entry'],
      additionalProperties: false,
    },
  },
];

export interface WorkQueueToolsDeps {
  store: Pick<WorkQueueStore, 'read' | 'mutate'>;
  queues: () => readonly WorkQueueDef[];
  /** The calling thread; undefined when the host gave none. */
  context: WorkQueueHolder | undefined;
  now: () => number;
  /** False when this runtime cannot keep the ledger (no `node:sqlite`): the queue is off. Default: available. */
  available?: () => boolean;
}

/** Every answer: JSON with `ok`, and `next` — what the model does now, in one line. */
export type WorkQueueAnswer = { ok: boolean; next?: string; [field: string]: unknown };

function fail(code: string, message: string, next?: string, extra: Record<string, unknown> = {}): WorkQueueAnswer {
  return { ok: false, code, message, ...extra, ...(next ? { next } : {}) };
}

export function createWorkQueueTools(deps: WorkQueueToolsDeps): {
  call: (name: string, args: Record<string, unknown>) => WorkQueueAnswer;
} {
  const entryArg = (args: Record<string, unknown>): string | undefined =>
    typeof args.entry === 'string' && /^wq-\d+$/.test(args.entry.trim()) ? args.entry.trim() : undefined;

  const list = (args: Record<string, unknown>, queues: readonly WorkQueueDef[]): WorkQueueAnswer => {
    const only = typeof args.queue === 'string' && args.queue.trim() ? args.queue.trim() : undefined;
    const shown = only ? queues.filter((q) => q.id === only) : queues;
    if (only && shown.length === 0) {
      return fail('UNKNOWN_QUEUE', `No queue "${only}" on this host.`, undefined, { queues: queues.map((q) => q.id) });
    }
    const ledger = deps.store.read();
    const mine = deps.context
      ? entriesOfHolder(ledger, deps.context).map((e) => ({ ...briefOf(e), position: queuePosition(ledger, e) }))
      : [];
    return { ok: true, queues: queueViews(ledger, shown), mine };
  };

  const enter = (args: Record<string, unknown>, queues: readonly WorkQueueDef[], holder: WorkQueueHolder) => {
    if (typeof args.queue !== 'string' || !args.queue.trim()) {
      return fail('INVALID_ARGS', '`queue` is required (e.g. "qa:dev2").');
    }
    const result = deps.store.mutate((ledger) =>
      enterQueue(ledger, { queue: args.queue as string, keys: args.keys, holder, note: args.note }, queues, deps.now()),
    );
    if (!result.ok) {
      const next =
        result.code === 'CONFLICT'
          ? 'Those keys are already handled in this queue — drop them and call queue_enter again with the rest; if none is left, the work is not needed: say so and stop.'
          : result.code === 'ALREADY_IN_QUEUE'
            ? 'Use the entry this thread already holds, or queue_cancel it first.'
            : 'Fix the call and try again.';
      return { ...result, next };
    }
    const { entry, position, ahead } = result;
    const next =
      entry.state === 'running'
        ? `Start the work now. When it ends call queue_done {"entry": "${entry.id}"}.`
        : `End your turn now: ${position === 1 ? 'one entry runs' : `${ahead.length} entries run or wait`} before it. ` +
          `The host wakes this thread when ${entry.id} runs; then do the work and call queue_done. ${NOT_A_PERSON}`;
    return { ok: true, status: entry.state, entry: briefOf(entry), position, ahead, next };
  };

  const end = (
    name: 'queue_done' | 'queue_cancel',
    args: Record<string, unknown>,
    holder: WorkQueueHolder,
  ): WorkQueueAnswer => {
    const id = entryArg(args);
    if (!id) return fail('INVALID_ARGS', '`entry` is required (the wq-… id queue_enter returned).');
    const result = deps.store.mutate((ledger) =>
      endEntry(
        ledger,
        {
          id,
          end: name === 'queue_done' ? 'done' : 'cancelled',
          actor: holder,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
        },
        deps.now(),
      ),
    );
    if (!result.ok) return { ...result };
    return {
      ok: true,
      ended: {
        ...briefOf(result.ended),
        end: result.ended.end,
        ...(result.ended.reason ? { reason: result.ended.reason } : {}),
      },
      ...(result.granted ? { next_entry: briefOf(result.granted) } : {}),
    };
  };

  return {
    call(name, args) {
      if (deps.available && !deps.available()) {
        return fail(
          'QUEUE_UNAVAILABLE',
          "This host's runtime cannot keep the work queue (its Node has no node:sqlite).",
          'Go on without a line: this host keeps no work queue.',
        );
      }
      let queues: readonly WorkQueueDef[];
      try {
        queues = deps.queues();
      } catch (error) {
        return fail(
          'CONFIG_UNREADABLE',
          `The host's queue configuration cannot be read now: ${(error as Error)?.message ?? String(error)}.`,
          'Call again in a moment; until it answers, do not start the lane work.',
        );
      }
      if (queues.length === 0) {
        return fail(
          'NO_QUEUES',
          'This host has no work queues (config.json workQueues).',
          'Go on without a line: this host does not queue lanes.',
        );
      }
      if (name === 'queue_list') return list(args, queues);
      const holder = deps.context;
      if (!holder?.channel || !holder.threadTs) {
        return fail('NO_THREAD', 'This session has no thread to hold an entry.');
      }
      if (name === 'queue_enter') return enter(args, queues, holder);
      if (name === 'queue_done' || name === 'queue_cancel') return end(name, args, holder);
      throw new Error(`Unknown tool: ${name}`);
    },
  };
}

/**
 * `config.json#workQueues`, re-read when the file changes (no restart needed to add a queue). A config that cannot be
 * read or parsed — or whose `workQueues` holds no valid queue — keeps the last good queues and is tried again on the
 * next call (never cached as "no queues": that
 * would tell a model to go on without a line while another thread holds the lane); with no good read yet it throws,
 * which the tools answer as `CONFIG_UNREADABLE`. A missing file is no queues.
 */
export function readWorkQueuesFromConfigFile(configFile: string | undefined): () => readonly WorkQueueDef[] {
  let good: { mtimeMs: number; queues: WorkQueueDef[] } | undefined;
  return () => {
    if (!configFile) return [];
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(configFile).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      if (good) return good.queues;
      throw new Error(`config.json cannot be read: ${(error as Error)?.message}`);
    }
    if (good?.mtimeMs === mtimeMs) return good.queues;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('the config root is not an object');
      }
      const parsed = parseWorkQueuesConfig((raw as Record<string, unknown>).workQueues);
      for (const warning of parsed.warnings) logger.warn(`config.json ${warning}`);
      // A key whose every definition is invalid is a broken config, not a host without queues.
      if (parsed.queues.length === 0 && parsed.warnings.length > 0) {
        throw new Error(`workQueues has no valid queue (${parsed.warnings.join('; ')})`);
      }
      good = { mtimeMs, queues: parsed.queues };
      return parsed.queues;
    } catch (error) {
      logger.warn('config.json unreadable — keeping the last good work queues', { error: (error as Error)?.message });
      if (good) return good.queues;
      throw new Error(`config.json cannot be read: ${(error as Error)?.message}`);
    }
  };
}

function parseContext(raw: string | undefined): WorkQueueHolder | undefined {
  if (!raw) return undefined;
  try {
    const c = JSON.parse(raw) as Partial<WorkQueueHolder>;
    if (typeof c.channel !== 'string' || typeof c.threadTs !== 'string') return undefined;
    return { user: typeof c.user === 'string' ? c.user : 'unknown', channel: c.channel, threadTs: c.threadTs };
  } catch {
    logger.warn('SOMA_WORK_QUEUE_CONTEXT unreadable');
    return undefined;
  }
}

class WorkQueueMcpServer extends BaseMcpServer {
  private readonly tools: ReturnType<typeof createWorkQueueTools>;

  constructor() {
    super('work-queue');
    const dataDir = process.env.SOMA_DATA_DIR || path.join(process.cwd(), 'data');
    this.tools = createWorkQueueTools({
      store: new WorkQueueStore(path.join(dataDir, WORK_QUEUE_FILE)),
      queues: readWorkQueuesFromConfigFile(process.env.SOMA_CONFIG_FILE),
      context: parseContext(process.env.SOMA_WORK_QUEUE_CONTEXT),
      now: () => Date.now(),
      available: workQueueStoreAvailable,
    });
  }

  defineTools(): ToolDefinition[] {
    return WORK_QUEUE_TOOLS;
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const answer = this.tools.call(name, args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(answer) }], isError: !answer.ok };
  }
}

const invokedDirectly =
  require.main === module ||
  ['work-queue-mcp-server.ts', 'work-queue-mcp-server.js'].includes(path.basename(process.argv[1] ?? ''));

if (invokedDirectly) {
  new WorkQueueMcpServer().run().catch((error) => {
    logger.error('work-queue MCP server error', error);
    process.stderr.write('', () => process.exit(1));
  });
}
