/**
 * ClaudeHandler × system prompt cache freshness (#756 PR3a fix loop #1, P1-B).
 *
 * Codex review: the previous flow cached the FULL system prompt on
 * `session.systemPrompt` once per reset point and then reused it
 * verbatim on every subsequent turn. The `<current-user-instruction>`
 * block (active id, age, candidates, pending) became stale across
 * normal turns until the next reset / SSOT invalidation.
 *
 * Fix: bypass the cache for the current-instruction block. The cached
 * prefix is reused, but the block is re-derived from the user-scope
 * master + pending-confirm store on every turn — guaranteeing the
 * model sees fresh user-instruction state even between resets.
 *
 * This test pins the contract: pre-populate the cache, mutate the
 * user-scope master and pending store, call `assembleSystemPromptForTurn`
 * a SECOND time without clearing `session.systemPrompt`, and assert
 * the returned prompt reflects the mutated state.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs');
  const osh = require('node:os') as typeof import('node:os');
  const pathh = require('node:path') as typeof import('node:path');
  const dir = fsh.mkdtempSync(pathh.join(osh.tmpdir(), 'soma-claude-handler-cache-freshness-boot-'));
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
import { PendingInstructionConfirmStore } from '../slack/actions/pending-instruction-confirm-store';
import type { ConversationSession } from '../types';
import { getUserSessionStore, initUserSessionStore, type UserInstruction } from '../user-session-store';

let TEST_DIR: string;
const USER_ID = 'U_CACHE_FRESH_756';

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

function mkSession(partial: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ownerId: USER_ID,
    userId: USER_ID,
    channelId: 'C1',
    threadTs: 'T1',
    isActive: true,
    lastActivity: new Date(),
    workflow: 'default',
    currentInstructionId: 'inst_alpha',
    instructions: [],
    sessionId: 'sdk-session-already-initialized',
    ...partial,
  } as ConversationSession;
}

function writeMaster(instructions: UserInstruction[]): void {
  const userDir = path.join(TEST_DIR, 'users', USER_ID);
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDir, 'user-session.json'),
    JSON.stringify({ schemaVersion: 1, instructions, lifecycleEvents: [] }, null, 2),
  );
}

beforeEach(() => {
  TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-claude-handler-cache-freshness-'));
  state.dir = TEST_DIR;
  initUserSessionStore(TEST_DIR);
});

afterEach(() => {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('ClaudeHandler.assembleSystemPromptForTurn — P1-B cache freshness', () => {
  it('re-derives <current-user-instruction> per turn even when session.systemPrompt cache is hot', () => {
    writeMaster([
      mkInstr({
        id: 'inst_alpha',
        text: 'first instruction',
        createdAt: new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
        linkedSessionIds: ['C1-T1'],
      }),
    ]);

    const handler = new ClaudeHandler(new McpManager());
    const session = mkSession();

    // Turn 1 — populates `session.systemPrompt` (the cached prefix).
    const turn1 = (handler as any).assembleSystemPromptForTurn(session) as string | undefined;
    expect(turn1).toBeDefined();
    expect(turn1!).toContain('active: inst_alpha · first instruction');
    expect(typeof session.systemPrompt).toBe('string');
    expect(session.systemPrompt!.length).toBeGreaterThan(0);

    // Mutate the user-scope master AND switch the session pointer.
    // Invalidate the store's per-userId cache so the next `load()` reads
    // the freshly-written master from disk (mirrors what an SSOT mutator
    // does on commit).
    writeMaster([
      mkInstr({
        id: 'inst_beta',
        text: 'second instruction (after rename)',
        createdAt: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
        linkedSessionIds: ['C1-T1'],
      }),
    ]);
    getUserSessionStore().invalidateCache(USER_ID);
    session.currentInstructionId = 'inst_beta';

    // Turn 2 — must NOT clear `session.systemPrompt`. Cached prefix stays
    // hot (cheap rebuild gate is still satisfied), but the block must
    // reflect the mutated state.
    const turn2 = (handler as any).assembleSystemPromptForTurn(session) as string | undefined;
    expect(turn2).toBeDefined();
    expect(turn2!).toContain('active: inst_beta · second instruction (after rename)');
    expect(turn2!).not.toContain('active: inst_alpha · first instruction');
  });

  it('renders pending: line freshness — entry added after the cache is hot still surfaces on the next turn', () => {
    writeMaster([
      mkInstr({
        id: 'inst_p',
        text: 'with pending op',
        createdAt: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
        linkedSessionIds: ['C1-T1'],
      }),
    ]);

    const handler = new ClaudeHandler(new McpManager());
    const session = mkSession({ currentInstructionId: 'inst_p' });

    // Wire the pending store BEFORE building. Empty for the first turn.
    const pendingStore = new PendingInstructionConfirmStore();
    handler.setPendingInstructionConfirmStore(pendingStore);

    const turn1 = (handler as any).assembleSystemPromptForTurn(session) as string | undefined;
    expect(turn1).toBeDefined();
    expect(turn1!).not.toMatch(/pending: complete/);

    // Add a pending entry mid-conversation. The cache should NOT mask it.
    pendingStore.set({
      requestId: 'req_99',
      sessionKey: 'C1-T1',
      channelId: 'C1',
      threadTs: 'T1',
      payload: { instructionOperations: [{ action: 'complete', id: 'inst_p' }] } as unknown as Parameters<
        typeof pendingStore.set
      >[0]['payload'],
      createdAt: Date.now() - 60 * 1000,
      requesterId: 'U_REQ',
      type: 'complete',
      by: { type: 'slack-user', id: 'U_REQ' },
    });

    const turn2 = (handler as any).assembleSystemPromptForTurn(session) as string | undefined;
    expect(turn2).toBeDefined();
    expect(turn2!).toMatch(/pending: complete \(requested by slack-user:U_REQ at /);
  });
});
