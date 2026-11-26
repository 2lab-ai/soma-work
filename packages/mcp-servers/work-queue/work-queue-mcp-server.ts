#!/usr/bin/env node

/**
 * work-queue MCP server (.prd/36 v2 §4.1, .prd/37 §3) — the one way a model lines up for a lane.
 *
 * A lane is named by the work that uses it (`qa-dev2`, `deploy-stage0`) and exists from its first entry: nothing is
 * configured first (`config.json#workQueues` only pins lanes so they show while empty). The server knows nothing about
 * what a lane means: deploy and QA use the same tools. `queue_try` takes a free lane or says what is ahead without
 * lining up; `queue_enter` lines up and the host wakes the thread when its turn comes. Every change is one SQLite
 * transaction on the shared ledger (`DATA_DIR/work-queues.sqlite3`, `@soma/process-shared/work-queue`) and is
 * answered on the spot — a conflict comes back in the same call, so the model never waits to learn it.
 *
 * The thread (holder) comes from `SOMA_WORK_QUEUE_CONTEXT`, which the host writes when it starts this process — the
 * model cannot name another thread.
 */

import path from 'node:path';
import type { ToolDefinition, ToolResult } from '@soma/process-shared/mcp/base-mcp-server.js';
import { BaseMcpServer } from '@soma/process-shared/mcp/base-mcp-server.js';
import { StderrLogger } from '@soma/process-shared/stderr-logger.js';
import { normalizeQueueName, readPinnedQueuesFromConfigFile } from '@soma/process-shared/work-queue/config.js';
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

const KEYS_RULE =
  'Name the work by keys — Jira keys (ABC-1234) or GitHub keys (owner/repo#123; issues and PRs share the form): the ' +
  'PRs a deploy ships, the issues a QA run checks. A key that already runs or waits in that lane refuses the whole ' +
  'entry (CONFLICT, naming who has it and which keys are free): someone else does that work — drop those keys and ' +
  'call again with the free ones; if none is free the work is not needed: say so and stop.';

const LANE_NAME =
  'The lane, named by the work and its environment, e.g. "qa-dev2", "deploy-stage0" (lower case, - . _). Use the ' +
  'name others use (queue_list) — a new name makes a new lane.';

type WorkQueueToolDefinition = ToolDefinition & {
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
};

const ENTER_PROPS = {
  queue: { type: 'string', description: LANE_NAME },
  keys: {
    type: 'array',
    items: { type: 'string' },
    description: 'The work this entry is for: Jira keys or GitHub owner/repo#number. At least one.',
  },
  note: { type: 'string', description: 'One line for people reading the queue (what runs).' },
};

export const WORK_QUEUE_TOOLS: WorkQueueToolDefinition[] = [
  {
    name: 'queue_list',
    description:
      'Show the lanes of this host (e.g. qa-dev2, deploy-stage0): per lane the entry that runs, the entries that wait ' +
      '(in order) and what recently left — each with its keys and the thread that holds it — plus the entries this ' +
      'thread holds.',
    inputSchema: {
      type: 'object',
      properties: { queue: { type: 'string', description: 'One lane only (e.g. "qa-dev2").' } },
      additionalProperties: false,
    },
  },
  {
    name: 'queue_try',
    description:
      'Take a lane only if it is free, without lining up: "running" = it is yours now, do the work and call ' +
      'queue_done when it ends; "busy" = nothing was added — the answer says what runs and waits ahead, so you can ' +
      'decide: do other work first, or queue_enter to wait for your turn. Use it where a lock or "is the lane free?" ' +
      `check would go. ${KEYS_RULE}`,
    inputSchema: { type: 'object', properties: ENTER_PROPS, required: ['queue', 'keys'], additionalProperties: false },
  },
  {
    name: 'queue_enter',
    description:
      'Line up for a lane before doing its work (a deploy, a QA run): one entry runs per lane at a time, the rest wait ' +
      'in order. "running" = start now and call queue_done when the work ends. "queued" = end your turn now; the host ' +
      'wakes this thread when its turn comes and you carry on then. This replaces any lock a skill tells you to take ' +
      `for the lane: a lane that is busy is a wait, never a reason to stop or to ask. ${KEYS_RULE} ${NOT_A_PERSON}`,
    inputSchema: { type: 'object', properties: ENTER_PROPS, required: ['queue', 'keys'], additionalProperties: false },
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
  /** The lanes `config.json` pins (listed even while empty). Never throws: an unreadable config pins nothing. */
  pinned: () => readonly string[];
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

  const pinnedSafe = (): readonly string[] => {
    try {
      return deps.pinned();
    } catch {
      return [];
    }
  };

  const list = (args: Record<string, unknown>): WorkQueueAnswer => {
    const ledger = deps.store.read();
    const all = queueViews(ledger, pinnedSafe(), 5);
    const only = typeof args.queue === 'string' && args.queue.trim() ? normalizeQueueName(args.queue) : undefined;
    const shown = only ? all.filter((q) => q.id === only) : all;
    const mine = deps.context
      ? entriesOfHolder(ledger, deps.context).map((e) => ({ ...briefOf(e), position: queuePosition(ledger, e) }))
      : [];
    return { ok: true, queues: shown, mine };
  };

  const enter = (args: Record<string, unknown>, holder: WorkQueueHolder, mode: 'wait' | 'try') => {
    if (typeof args.queue !== 'string' || !args.queue.trim()) {
      return fail('INVALID_ARGS', '`queue` is required (e.g. "qa-dev2").');
    }
    const result = deps.store.mutate((ledger) =>
      enterQueue(ledger, { queue: args.queue as string, keys: args.keys, holder, note: args.note, mode }, deps.now()),
    );
    if (!result.ok) {
      const next =
        result.code === 'CONFLICT'
          ? result.free.length > 0
            ? `Those keys are already handled in this lane — call ${mode === 'try' ? 'queue_try' : 'queue_enter'} again with only: ${result.free.join(', ')}.`
            : 'Every key is already handled in this lane by someone else — the work is not needed: say so and stop.'
          : result.code === 'ALREADY_IN_QUEUE'
            ? 'Use the entry this thread already holds, or queue_cancel it first.'
            : 'Fix the call and try again.';
      return { ...result, next };
    }
    if (result.status === 'busy') {
      const { queue, position, ahead } = result;
      return {
        ok: true,
        status: 'busy',
        queue,
        position,
        ahead,
        next:
          `${queue} is in use (${ahead.length} ahead) and nothing was added. Do other work first, or queue_enter to ` +
          `wait for your turn (the host wakes this thread). ${NOT_A_PERSON}`,
      };
    }
    const { entry, position, ahead, created } = result;
    const fresh = created
      ? ` ${entry.queue} is a new lane (nobody used that name before) — if others use another name for the same lane, queue_cancel and enter that one.`
      : '';
    const next =
      entry.state === 'running'
        ? `Start the work now. When it ends call queue_done {"entry": "${entry.id}"}.${fresh}`
        : `End your turn now: ${position === 1 ? 'one entry runs' : `${ahead.length} entries run or wait`} before it. ` +
          `The host wakes this thread when ${entry.id} runs; then do the work and call queue_done. ${NOT_A_PERSON}${fresh}`;
    return {
      ok: true,
      status: entry.state === 'running' ? 'running' : 'queued',
      entry: briefOf(entry),
      position,
      ahead,
      ...(created ? { created: true } : {}),
      next,
    };
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
      ended: result.ended,
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
      if (name === 'queue_list') return list(args);
      const holder = deps.context;
      if (!holder?.channel || !holder.threadTs) {
        return fail('NO_THREAD', 'This session has no thread to hold an entry.');
      }
      if (name === 'queue_enter') return enter(args, holder, 'wait');
      if (name === 'queue_try') return enter(args, holder, 'try');
      if (name === 'queue_done' || name === 'queue_cancel') return end(name, args, holder);
      throw new Error(`Unknown tool: ${name}`);
    },
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
      pinned: readPinnedQueuesFromConfigFile(process.env.SOMA_CONFIG_FILE, (message) => logger.warn(message)),
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
