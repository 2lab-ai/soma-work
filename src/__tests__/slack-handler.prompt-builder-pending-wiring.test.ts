/**
 * SlackHandler × PromptBuilder pending-store wiring (#756 PR3a fix loop #1, P1-C).
 *
 * Codex review: `SlackHandler` constructs the singleton
 * `PendingInstructionConfirmStore` and threads it into `ActionHandlers`
 * (button click reader) and `StreamExecutor` (write producer), but
 * never into the production `PromptBuilder` owned by `ClaudeHandler`.
 * Net effect — the `<current-user-instruction>` block's
 * `pending: <op>` line never renders in prod despite the
 * `prompt-builder.current-instruction.test.ts` suite covering the
 * happy path (those tests inject the store directly into the builder
 * constructor).
 *
 * Fix: SlackHandler must call
 * `claudeHandler.setPendingInstructionConfirmStore(store)` during
 * bootstrap so the production `PromptBuilder` sees the same singleton
 * that `ActionHandlers` / `StreamExecutor` reference.
 *
 * This test exercises the production wiring end-to-end:
 *   1. Construct `SlackHandler(app, ClaudeHandler(...), McpManager())`.
 *   2. Use the `claudeHandler` reference to call
 *      `assembleSystemPromptForTurn` for a session that has a pending
 *      entry in the SlackHandler-owned store.
 *   3. Assert the assembled prompt contains the `pending: <op>` line.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs');
  const osh = require('node:os') as typeof import('node:os');
  const pathh = require('node:path') as typeof import('node:path');
  const dir = fsh.mkdtempSync(pathh.join(osh.tmpdir(), 'soma-slack-handler-pending-wire-boot-'));
  return { dir };
});

vi.mock('../env-paths', () => ({
  get DATA_DIR() {
    return state.dir;
  },
  get SYSTEM_PROMPT_FILE() {
    return path.join(state.dir, '.system.prompt');
  },
  get MCP_CONFIG_FILE() {
    return path.join(state.dir, 'mcp-servers.json');
  },
}));

vi.mock('../user-settings-store', () => ({
  userSettingsStore: {
    getUserPersona: vi.fn().mockReturnValue('default'),
    getUserSettings: vi.fn().mockReturnValue(undefined),
    getUserNetworkDisabled: vi.fn().mockReturnValue(false),
    getUserSandboxDisabled: vi.fn().mockReturnValue(false),
  },
  DEFAULT_SHOW_THINKING: true,
  DEFAULT_THINKING_ENABLED: true,
}));

vi.mock('../user-memory-store', () => ({
  formatMemoryForPrompt: vi.fn().mockReturnValue(''),
}));

import { ClaudeHandler } from '../claude-handler';
import { McpManager } from '../mcp-manager';
import { SlackHandler } from '../slack-handler';
import type { ConversationSession } from '../types';
import { initUserSessionStore, type UserInstruction } from '../user-session-store';

let TEST_DIR: string;
const USER_ID = 'U_PROD_WIRE_756';

function mkInstr(partial: Partial<UserInstruction> & Pick<UserInstruction, 'id' | 'text'>): UserInstruction {
  return {
    id: partial.id,
    text: partial.text,
    status: partial.status ?? 'active',
    source: partial.source ?? 'model',
    createdAt: partial.createdAt ?? new Date(0).toISOString(),
    completedAt: partial.completedAt,
    cancelledAt: partial.cancelledAt,
    linkedSessionIds: partial.linkedSessionIds ?? [],
    sourceRawInputIds: partial.sourceRawInputIds ?? [],
  };
}

beforeEach(() => {
  TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-slack-handler-pending-wire-'));
  state.dir = TEST_DIR;
  initUserSessionStore(TEST_DIR);

  // Master with one active instruction the session points at.
  const userDir = path.join(TEST_DIR, 'users', USER_ID);
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDir, 'user-session.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        instructions: [
          mkInstr({
            id: 'inst_prod',
            text: 'production wiring fixture',
            createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
            linkedSessionIds: ['C1-T1'],
          }),
        ],
        lifecycleEvents: [],
      },
      null,
      2,
    ),
  );
});

afterEach(() => {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('SlackHandler × PromptBuilder pending-store wiring (P1-C)', () => {
  it('threads the SlackHandler-owned PendingInstructionConfirmStore into the production PromptBuilder so `pending:` lines render', () => {
    const app = { client: {}, assistant: vi.fn() } as any;
    const mcpManager = new McpManager();
    const claudeHandler = new ClaudeHandler(mcpManager);

    // Construct SlackHandler — this is where the wiring must happen.
    const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);

    // Recover the SlackHandler-owned pending store via the handler's
    // ActionHandlers context (it shares the same singleton ActionHandlers
    // and StreamExecutor see — production invariant from PLAN §7).
    const handlerAny = handler as any;
    const pendingStore =
      handlerAny.actionHandlers?.context?.pendingInstructionConfirmStore ??
      handlerAny.actionHandlers?.deps?.pendingInstructionConfirmStore ??
      handlerAny.actionHandlers?.pendingInstructionConfirmStore ??
      handlerAny.streamExecutor?.deps?.pendingInstructionConfirmStore ??
      handlerAny.streamExecutor?.pendingInstructionConfirmStore;

    expect(pendingStore, 'SlackHandler must own a PendingInstructionConfirmStore singleton').toBeDefined();

    // Stage a pending entry for the session.
    pendingStore.set({
      requestId: 'req_prod',
      sessionKey: 'C1-T1',
      channelId: 'C1',
      threadTs: 'T1',
      payload: { instructionOperations: [{ action: 'complete', id: 'inst_prod' }] },
      createdAt: Date.now() - 30 * 1000,
      requesterId: 'U_REQ',
      type: 'complete',
      by: { type: 'slack-user', id: 'U_REQ' },
    });

    // Drive a turn through the production seam.
    const session: ConversationSession = {
      ownerId: USER_ID,
      userId: USER_ID,
      channelId: 'C1',
      threadTs: 'T1',
      isActive: true,
      lastActivity: new Date(),
      workflow: 'default',
      currentInstructionId: 'inst_prod',
      instructions: [],
    } as ConversationSession;

    const prompt = (claudeHandler as any).assembleSystemPromptForTurn(session, {
      user: USER_ID,
      channel: 'C1',
      threadTs: 'T1',
    }) as string | undefined;

    expect(prompt, 'production system prompt should not be empty').toBeDefined();
    expect(prompt!).toMatch(/pending: complete \(requested by slack-user:U_REQ at /);
  });
});
