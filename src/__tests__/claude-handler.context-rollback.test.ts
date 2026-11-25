/**
 * Context rollback (#743) at the SDK boundary: a waiting rollback becomes the
 * turn's `resumeSessionAt` exactly once, and every safe chain point the CLI
 * streams moves the session's anchor. The SDK is mocked at the module
 * boundary like `claude-handler.turn-attribution.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));
vi.mock('../credentials-manager', () => ({
  ensureActiveSlotAuth: vi.fn(async () => ({ heartbeat: async () => {}, release: async () => {} })),
  getCredentialStatus: () => ({}),
  NoHealthySlotError: class NoHealthySlotError extends Error {},
}));
vi.mock('../credential-alert', () => ({ sendCredentialAlert: vi.fn(async () => {}) }));
vi.mock('../token-manager', () => ({ getTokenManager: () => ({}) }));
vi.mock('../auth/llmux-tenant-keys', () => ({ ensureTenantKey: vi.fn(async () => null) }));
vi.mock('../auth/query-env-builder', () => ({ buildQueryEnv: () => ({ env: {} }) }));
const { markRewoundTurnsMock } = vi.hoisted(() => ({ markRewoundTurnsMock: vi.fn(async () => 0) }));
vi.mock('../conversation/recorder', () => ({ markRewoundTurns: markRewoundTurnsMock }));
vi.mock('../agent-runtime/claude-code/build-stream-options', () => ({
  buildStreamOptions: vi.fn(async ({ session }: { session?: { sessionId?: string } }) => ({
    options: { model: 'claude-test', ...(session?.sessionId ? { resume: session.sessionId } : {}) },
    getStderrBuffer: () => '',
  })),
}));

import { decodeContextAnchor, encodeContextAnchor } from '@soma/slack/context-anchor';
import { ClaudeHandler } from '../claude-handler';
import type { McpManager } from '../mcp-manager';
import { asSdkQuery } from '../test-utils/fake-sdk-query';

const SID = 'a1b2c3d4-0000-4000-8000-000000000001';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SLACK = { user: 'U1', channel: 'C1', threadTs: '1.1' } as never;

function installTurn(frames: (opening: Record<string, unknown>) => Record<string, unknown>[]): void {
  queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const inputs = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    const gen = (async function* () {
      const opening = (await inputs.next()).value as Record<string, unknown>;
      for (const f of frames(opening)) yield f;
    })();
    return asSdkQuery(gen, {
      interrupt: vi.fn(async () => ({ still_queued: [], cancelled: [] })),
      cancelAsyncMessage: vi.fn(async () => true),
    });
  });
}

const result = (opening: Record<string, unknown>) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  num_turns: 1,
  session_id: SID,
  uuid: U(99),
  user_message_uuid: opening.uuid,
});

async function drain(handler: ClaudeHandler, session: any): Promise<void> {
  for await (const _ of handler.streamQuery('hi', session, undefined, undefined, SLACK, 'C1:1.1')) {
    // consume
  }
}

describe('ClaudeHandler — context rollback', () => {
  afterEach(() => {
    queryMock.mockReset();
    markRewoundTurnsMock.mockClear();
  });

  // SSOT 2026-11-25: what a rollback dropped is stamped on the conversation record (`rewoundAt`) so the dashboard
  // chat leaves it out for good — the session keeps only its latest 10 spans and new/renew clears them.
  const anchorOf = (n: number) => encodeContextAnchor({ sid: SID, epoch: 0, uuid: U(n) });
  const rollingBack = (over: Record<string, unknown> = {}): any => ({
    sessionId: SID,
    compactionCount: 0,
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: '1.1',
    conversationId: 'conv-1',
    contextAnchor: anchorOf(9),
    pendingRewind: {
      anchor: anchorOf(3),
      label: '입력 직전: 배포해',
      requestedAt: 500,
      requestedBy: 'U1',
      source: 'input',
      keptUntil: 199,
    },
    ...over,
  });
  const opened = (opening: Record<string, unknown>, n: number) => [
    { type: 'system', subtype: 'init', session_id: SID, model: 'claude-test', tools: [] },
    { type: 'assistant', uuid: U(n), message: { content: [{ type: 'text', text: 'ok' }] } },
    result(opening),
  ];

  it('stamps once the CLI opens the resumed turn — the applied span and the spans the session already had', async () => {
    // A span applied before stamps existed is stamped too, before the cap or new/renew can drop it.
    const session = rollingBack({ contextRewinds: [{ from: 10, to: 20, label: '입력 직전: 옛 지시', at: 21 }] });
    installTurn((opening) => opened(opening, 10));
    const handler = new ClaudeHandler({ getPluginManager: () => null } as unknown as McpManager);
    await drain(handler, session);
    expect(queryMock.mock.calls[0][0].options.resumeSessionAt).toBe(U(3));
    expect(markRewoundTurnsMock.mock.calls).toEqual([
      ['conv-1', { from: 10, to: 20, at: 21, keepsFinalReply: false }],
      ['conv-1', { from: 199, to: 500, at: expect.any(Number), keepsFinalReply: false }],
    ]);
  });

  it('a resume the CLI refuses (it never opens the turn) stamps nothing', async () => {
    const session = rollingBack();
    // The CLI fails the resume while loading the transcript ("No message found with message.uuid"): no system/init.
    installTurn((opening) => [{ ...result(opening), subtype: 'error_during_execution', is_error: true }]);
    const handler = new ClaudeHandler({ getPluginManager: () => null } as unknown as McpManager);
    await drain(handler, session).catch(() => undefined);
    expect(queryMock.mock.calls[0][0].options.resumeSessionAt).toBe(U(3));
    expect(markRewoundTurnsMock).not.toHaveBeenCalled();
  });

  it('an older request with no kept point is applied but marks nothing; no conversation, nothing to stamp', async () => {
    const legacy = rollingBack();
    delete legacy.pendingRewind.keptUntil;
    installTurn((opening) => opened(opening, 10));
    const handler = new ClaudeHandler({ getPluginManager: () => null } as unknown as McpManager);
    await drain(handler, legacy);
    expect(queryMock.mock.calls[0][0].options.resumeSessionAt).toBe(U(3));
    expect(markRewoundTurnsMock).not.toHaveBeenCalled();

    const noConversation = rollingBack({ conversationId: undefined });
    installTurn((opening) => opened(opening, 11));
    await drain(handler, noConversation);
    expect(queryMock.mock.calls[1][0].options.resumeSessionAt).toBe(U(3));
    expect(markRewoundTurnsMock).not.toHaveBeenCalled();
  });

  it('a span kept up to a final reply says so (an older one kept up to the reply’s entry, before its answer)', async () => {
    const final = { from: 30, to: 40, label: '최종 답까지: 배포했어요', at: 41 };
    const session = rollingBack({ contextRewinds: [final] });
    installTurn((opening) => opened(opening, 10));
    const handler = new ClaudeHandler({ getPluginManager: () => null } as unknown as McpManager);
    await drain(handler, session);
    expect(markRewoundTurnsMock.mock.calls[0]).toEqual(['conv-1', { from: 30, to: 40, at: 41, keepsFinalReply: true }]);
  });

  it('the span the cap of 10 lets go is stamped with the rest', async () => {
    const old = Array.from({ length: 10 }, (_, i) => ({
      from: i * 10,
      to: i * 10 + 5,
      label: `p${i}`,
      at: i * 10 + 6,
    }));
    const session = rollingBack({ contextRewinds: [...old] });
    installTurn((opening) => opened(opening, 10));
    const handler = new ClaudeHandler({ getPluginManager: () => null } as unknown as McpManager);
    await drain(handler, session);
    expect(session.contextRewinds).toHaveLength(10);
    expect(session.contextRewinds[0]).toEqual(old[1]);
    const stamped = markRewoundTurnsMock.mock.calls.map((c: any[]) => c[1].from);
    expect(stamped).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 199]);
  });

  it('a rollback the CLI never opened is undone: no span, the old anchor — nothing to stamp later', async () => {
    const earlier = { from: 10, to: 20, label: '입력 직전: 옛 지시', at: 21 };
    const session = rollingBack({ contextRewinds: [earlier] });
    installTurn((opening) => [{ ...result(opening), subtype: 'error_during_execution', is_error: true }]);
    const handler = new ClaudeHandler({ getPluginManager: () => null } as unknown as McpManager);
    await drain(handler, session).catch(() => undefined);
    expect(session.contextRewinds).toEqual([earlier]);
    expect(session.contextAnchor).toBe(anchorOf(9));
    expect(markRewoundTurnsMock).not.toHaveBeenCalled();
  });

  it('a waiting rollback becomes resumeSessionAt once, and the anchor follows the new chain', async () => {
    const session: any = {
      sessionId: SID,
      compactionCount: 0,
      ownerId: 'U1',
      channelId: 'C1',
      threadTs: '1.1',
      contextAnchor: encodeContextAnchor({ sid: SID, epoch: 0, uuid: U(9) }),
      pendingRewind: {
        anchor: encodeContextAnchor({ sid: SID, epoch: 0, uuid: U(3) }),
        label: 'x',
        requestedAt: 1,
        requestedBy: 'U1',
        source: 'input',
      },
      // Redo ends when the turn runs: the rollback it would take back is applied now.
      rewindRedo: [null],
      // The goal's first failure belongs to the dropped branch once the rollback runs.
      goal: { goalId: 'g1', status: 'active', firstFailure: { anchor: 'x', at: 1, turns: 2, progressed: false } },
    };
    installTurn((opening) => [
      { type: 'system', subtype: 'init', session_id: SID, model: 'claude-test', tools: [] },
      {
        type: 'assistant',
        uuid: U(10),
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      },
      { type: 'user', uuid: U(11), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'assistant', uuid: U(12), message: { content: [{ type: 'text', text: 'done' }] } },
      result(opening),
    ]);
    const handler = new ClaudeHandler({ getPluginManager: () => null } as unknown as McpManager);
    await drain(handler, session);

    expect(queryMock.mock.calls[0][0].options.resumeSessionAt).toBe(U(3));
    expect(session.pendingRewind).toBeUndefined();
    expect(session.rewindRedo).toBeUndefined();
    expect(session.goal.firstFailure).toBeUndefined();
    expect(decodeContextAnchor(session.contextAnchor)?.uuid).toBe(U(12));

    // The next turn resumes plainly.
    installTurn((opening) => [
      { type: 'system', subtype: 'init', session_id: SID, model: 'claude-test', tools: [] },
      { type: 'assistant', uuid: U(13), message: { content: [{ type: 'text', text: 'ok' }] } },
      result(opening),
    ]);
    await drain(handler, session);
    expect(queryMock.mock.calls).toHaveLength(2);
    expect(queryMock.mock.calls[1][0].options.resumeSessionAt).toBeUndefined();
  });
});
