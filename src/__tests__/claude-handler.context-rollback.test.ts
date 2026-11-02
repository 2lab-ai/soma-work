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
vi.mock('../agent-runtime/claude-code/build-stream-options', () => ({
  buildStreamOptions: vi.fn(async ({ session }: { session?: { sessionId?: string } }) => ({
    options: { model: 'claude-test', ...(session?.sessionId ? { resume: session.sessionId } : {}) },
    getStderrBuffer: () => '',
  })),
}));

import { decodeContextAnchor, encodeContextAnchor } from '@soma/slack/context-anchor';
import { ClaudeHandler } from '../claude-handler';
import type { McpManager } from '../mcp-manager';

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
    return Object.assign(gen, {
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
  afterEach(() => queryMock.mockReset());

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
