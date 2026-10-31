/**
 * T9 (#598 ④b1, .prd/17): a Slack-less task's tool-using turn runs to the
 * end through the real task executor — the real registry, conversation store
 * and work-log store, with only the agent stream faked — and makes **zero
 * Slack calls**. Its outcome is committed once on the task and survives a
 * restart; its work log holds the instruction, the tool call and result, and
 * the final answer.
 *
 * Variants beyond the core path (compaction, directives, background work, MCP
 * status, …) are ④b2's; each will turn a recorded call here into zero.
 */
import { describe, expect, it, vi } from 'vitest';
import { createConversationDurable } from '../../conversation/recorder';
import { createSessionWorkLogAppender } from '../../conversation/session-work-log';
import { readWorkLog } from '../../conversation/work-log';
import { mcpCallTracker } from '../../mcp-call-tracker';
import { SessionRegistry } from '../../session-registry';
import { RequestCoordinator } from '../../slack';
import { TodoManager } from '../../todo-manager';
import { createTaskTurnExecutor } from '../task-turn-executor';

/** Every output flag on — the most verbose a user can make a session. */
const ALL_OUTPUT = 0x7fffffff;

const FINAL = 'The timeout is 30s; I raised it to 60s.';

type Stream = () => AsyncGenerator<unknown>;

const toolTurn: Stream = () =>
  (async function* () {
    yield { type: 'assistant_delta', text: 'Let me read the config first.' };
    yield { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: { file_path: '/repo/config.ts' } };
    yield { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'timeout = 30' }] };
    yield { type: 'assistant_delta', text: FINAL };
    yield { type: 'result', stopReason: 'end_turn', finalText: FINAL };
  })();

const failingTurn: Stream = () =>
  // biome-ignore lint/correctness/useYield: it fails before its first event
  (async function* () {
    throw new Error('upstream exploded');
  })();

/** The host's ClaudeHandler as the executor uses it on a task turn — over a real registry. */
function claudeHandlerOver(registry: SessionRegistry, stream: Stream) {
  const known: Record<string, unknown> = {
    getSessionRegistry: () => registry,
    getAllSessions: () => registry.getAllSessions(),
    getSessionByKey: (k: string) => registry.getSessionByKey(k),
    setActivityStateByKey: (k: string, s: 'working' | 'waiting' | 'idle') => registry.setActivityStateByKey(k, s),
    clearSessionIdByKey: (k: string) => registry.clearSessionIdByKey(k),
    setSessionLinksByKey: (k: string, l: never) => registry.setSessionLinksByKey(k, l),
    setSessionTitleByKey: (k: string, t: string) => registry.setSessionTitleByKey(k, t),
    addSourceWorkingDirByKey: (k: string, d: string) => registry.addSourceWorkingDirByKey(k, d),
    addMergeStatsByKey: (k: string, n: number, a: number, d: number) => registry.addMergeStatsByKey(k, n, a, d),
    streamAgentEvents: vi.fn(stream),
  };
  return new Proxy(known, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop in target) return target[prop as string];
      // A channel/thread form or anything this harness does not model: fail loudly.
      return () => {
        throw new Error(`unexpected claudeHandler.${String(prop)} on a task turn`);
      };
    },
  });
}

const QUESTION = {
  type: 'user_choice',
  question: 'Raise it to 60s or 90s?',
  choices: [
    { id: '60', label: '60s' },
    { id: '90', label: '90s' },
  ],
};

const askingTurn: Stream = () =>
  (async function* () {
    const text = ['Two options:', '```json', JSON.stringify(QUESTION), '```'].join('\n');
    yield { type: 'assistant_delta', text };
    yield { type: 'result', stopReason: 'end_turn', finalText: text };
  })();

function stoppedTurn(controller: AbortController): Stream {
  return () =>
    (async function* () {
      yield { type: 'assistant_delta', text: 'Reading the config…' };
      controller.abort('user-stop');
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    })();
}

async function setup(stream: Stream, abortController = new AbortController()) {
  const registry = new SessionRegistry();
  const task = registry.createTask({
    ownerId: 'U0T9OWNER',
    ownerName: 'T9',
    workingDirectory: '/tmp/U0T9OWNER/session_t9',
    title: 'T9',
  });
  const sessionKey = `task:${task.taskId}`;
  const claudeHandler = claudeHandlerOver(registry, stream);
  const executor = createTaskTurnExecutor({
    claudeHandler,
    requestCoordinator: new RequestCoordinator(),
    mcpCallTracker,
    todoManager: new TodoManager(),
    appendSessionWorkLog: createSessionWorkLogAppender({
      getAllSessions: () => registry.getAllSessions(),
      scheduleLiveSessionUpdate: () => {},
      refreshAgentSpend: () => {},
    }),
    createConversation: (s) => createConversationDurable('', '', s.ownerId, s.ownerName ?? '', s.title),
  });
  const executionContext = {
    origin: 'task',
    userId: 'U0T9OWNER',
    isAdmin: false,
    permissionMode: 'auto',
    sessionKey,
    taskId: task.taskId,
    workingDirectory: '/tmp/U0T9OWNER/session_t9',
  } as never;
  const run = () =>
    executor.runTaskTurn({
      sessionKey,
      executionContext,
      text: 'raise the request timeout',
      params: {
        userName: 'T9',
        workingDirectory: '/tmp/U0T9OWNER/session_t9',
        abortController,
        processedFiles: [],
        isUserInput: true,
        say: vi.fn(),
      },
    });
  return { registry, task, sessionKey, executor, run };
}

describe('T9 — a Slack-less task turn through the real task executor (#598 ④b1)', () => {
  it('runs a tool-using turn to the end with zero Slack calls; the outcome is committed once and the work log is complete', async () => {
    const { registry, task, sessionKey, executor, run } = await setup(toolTurn);
    const result = await run();

    expect(executor.slackCalls).toEqual([]);
    expect(result.outcome).toMatchObject({ outcome: 'completed', category: 'WorkflowComplete' });
    expect(registry.getSessionByKey(sessionKey)?.lastTurnOutcome?.turnId).toBe(result.turnId);
    expect(registry.getSessionByKey(sessionKey)?.activityState).toBe('idle');

    const page = await readWorkLog(task.conversationId!);
    const kinds = page.entries.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['instruction', 'tool', 'tool_result', 'final']));
    expect(page.entries.find((e) => e.kind === 'final')?.text).toContain('60s');

    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.getSessionByTaskId(task.taskId!)?.lastTurnOutcome?.outcome).toBe('completed');
  });

  it('a failing turn is recorded as failed with one error entry, and still makes zero Slack calls', async () => {
    const { task, executor, run } = await setup(failingTurn);
    const result = await run();

    expect(executor.slackCalls).toEqual([]);
    expect(result.outcome).toMatchObject({ outcome: 'failed', category: 'Exception' });
    const page = await readWorkLog(task.conversationId!);
    expect(page.entries.filter((e) => e.kind === 'error')).toHaveLength(1);
  });

  it('a turn that asks ends waiting — the question is on the task with the turn’s id, and waiting survives a restart (#626 R1)', async () => {
    const { registry, task, sessionKey, executor, run } = await setup(askingTurn);
    const result = await run();

    expect(executor.slackCalls).toEqual([]);
    expect(result.outcome).toMatchObject({ outcome: 'waiting', category: 'UIUserAskQuestion' });
    const live = registry.getSessionByKey(sessionKey)!;
    expect(live.activityState).toBe('waiting');
    expect(live.actionPanel?.pendingQuestion).toMatchObject({ turnId: result.turnId });
    expect(typeof (live.actionPanel?.pendingQuestion as { askId?: unknown } | undefined)?.askId).toBe('string');

    const reader = new SessionRegistry();
    reader.loadSessions();
    const reloaded = reader.getSessionByTaskId(task.taskId!);
    expect(reloaded?.lastTurnOutcome?.outcome).toBe('waiting');
    expect(reloaded?.activityState).toBe('waiting');
  });

  it('a turn the user stops is cancelled, posts nothing, and leaves the task idle (#626 R1)', async () => {
    const controller = new AbortController();
    const { registry, sessionKey, executor, run } = await setup(stoppedTurn(controller), controller);
    const result = await run();

    expect(executor.slackCalls).toEqual([]);
    expect(result.outcome).toMatchObject({ outcome: 'cancelled' });
    expect(registry.getSessionByKey(sessionKey)?.activityState).toBe('idle');
  });
});

/** ④b2 — the remaining Slack-bound branches: each must record zero Slack calls on a task turn. */
describe('T9 — remaining branches (#598 ④b2)', () => {
  const variant =
    (events: unknown[]): Stream =>
    () =>
      (async function* () {
        for (const e of events) yield e;
        yield { type: 'result', stopReason: 'end_turn', finalText: 'done' };
      })();

  it('a channel_message directive is not posted to Slack, and the task records that it was not', async () => {
    const text = ['done', '```json', JSON.stringify({ type: 'channel_message', text: 'hello channel' }), '```'].join(
      '\n',
    );
    const { executor, task, run } = await setup(variant([{ type: 'assistant_delta', text }]));
    await run();
    expect(executor.slackCalls).toEqual([]);
    const page = await readWorkLog(task.conversationId!);
    expect(page.entries.some((e) => e.kind === 'notice' && /channel message/i.test(e.text))).toBe(true);
  });

  it('a release_notes directive is not posted to Slack, and the task records that it was not', async () => {
    const directive = {
      type: 'release_notes',
      repo: 'acme/app',
      target: 'deploy/staging',
      version: '0.2.58 (c8a026e)',
      tldr: ['one'],
      text: 'notes',
    };
    const text = ['done', '```json', JSON.stringify(directive), '```'].join('\n');
    const { executor, task, run } = await setup(variant([{ type: 'assistant_delta', text }]));
    await run();
    expect(executor.slackCalls).toEqual([]);
    const page = await readWorkLog(task.conversationId!);
    expect(page.entries.some((e) => e.kind === 'notice' && /release notes/i.test(e.text))).toBe(true);
  });

  it('a compaction (status compacting + compact_boundary) posts nothing to Slack', async () => {
    const { executor, run } = await setup(
      variant([
        { type: 'status', status: 'compacting' },
        { type: 'compact_boundary', metadata: { trigger: 'auto', preTokens: 100000 } },
        { type: 'status', status: 'compact_done' },
        { type: 'assistant_delta', text: 'continuing' },
      ]),
    );
    await run();
    await new Promise((r) => setTimeout(r, 50));
    expect(executor.slackCalls).toEqual([]);
  });

  it('an MCP tool call posts no status to Slack', async () => {
    const { executor, run } = await setup(
      variant([
        { type: 'tool_call', toolCallId: 'mcp_1', name: 'mcp__github__get_issue', input: { n: 1 } },
        { type: 'tool_result', toolCallId: 'mcp_1', content: [{ type: 'text', text: 'ok' }] },
      ]),
    );
    await run();
    await new Promise((r) => setTimeout(r, 50));
    expect(executor.slackCalls).toEqual([]);
  });

  it('a background Bash and a subagent task post nothing to Slack', async () => {
    const { executor, run } = await setup(
      variant([
        {
          type: 'tool_call',
          toolCallId: 'bash_1',
          name: 'Bash',
          input: { command: 'sleep 1', run_in_background: true },
        },
        {
          type: 'tool_result',
          toolCallId: 'bash_1',
          content: [{ type: 'text', text: 'Command running in background with ID: bg-1' }],
        },
        {
          type: 'agent_task_lifecycle',
          phase: 'started',
          taskId: 'bg-1',
          taskType: 'bash',
          toolUseId: 'bash_1',
          background: true,
        },
        {
          type: 'tool_call',
          toolCallId: 'task_1',
          name: 'Task',
          input: { description: 'explore', prompt: 'look', subagent_type: 'Explore' },
        },
        {
          type: 'agent_task_lifecycle',
          phase: 'started',
          taskId: 'sub-1',
          taskType: 'local_agent',
          toolUseId: 'task_1',
          subagentType: 'Explore',
          description: 'explore',
        },
        { type: 'agent_task_lifecycle', phase: 'settled', taskId: 'sub-1', status: 'completed', toolUseId: 'task_1' },
        { type: 'tool_result', toolCallId: 'task_1', content: [{ type: 'text', text: 'found it' }] },
        { type: 'agent_task_lifecycle', phase: 'settled', taskId: 'bg-1', status: 'completed', toolUseId: 'bash_1' },
      ]),
    );
    await run();
    await new Promise((r) => setTimeout(r, 50));
    expect(executor.slackCalls).toEqual([]);
  });

  it('crossing the auto-compact threshold schedules compaction without a Slack announcement', async () => {
    const { executor, registry, sessionKey, run } = await setup(
      variant([{ type: 'assistant_delta', text: 'working' }]),
    );
    const task = registry.getSessionByKey(sessionKey)!;
    task.usage = {
      currentInputTokens: 190_000,
      currentCacheReadTokens: 0,
      currentCacheCreateTokens: 0,
      currentOutputTokens: 5_000,
      contextWindow: 200_000,
      totalInputTokens: 190_000,
      totalOutputTokens: 5_000,
      totalCostUsd: 0,
    } as never;
    // The most verbose setting, so every Slack-bound announcement would be attempted.
    task.logVerbosity = ALL_OUTPUT;
    await run();
    await new Promise((r) => setTimeout(r, 100));
    expect(executor.slackCalls).toEqual([]);
  });

  it('at the most verbose setting, a tool-using turn, an MCP call and a compaction still make zero Slack calls', async () => {
    const { executor, registry, sessionKey, run } = await setup(
      variant([
        { type: 'assistant_delta', text: 'reading' },
        { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: { file_path: '/repo/a.ts' } },
        { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'x' }] },
        { type: 'tool_call', toolCallId: 'mcp_1', name: 'mcp__github__get_issue', input: { n: 1 } },
        { type: 'tool_result', toolCallId: 'mcp_1', content: [{ type: 'text', text: 'ok' }] },
        { type: 'status', status: 'compacting' },
        { type: 'compact_boundary', metadata: { trigger: 'auto', preTokens: 100000 } },
        { type: 'status', status: 'compact_done' },
      ]),
    );
    registry.getSessionByKey(sessionKey)!.logVerbosity = ALL_OUTPUT;
    await run();
    await new Promise((r) => setTimeout(r, 100));
    expect(executor.slackCalls).toEqual([]);
  });
});
