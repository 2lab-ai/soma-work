/**
 * PromptBuilder × `<current-user-instruction>` block (#756 PR3a).
 *
 * The block must:
 *   1. Live at a fixed position in the system prompt every request.
 *   2. Be re-derived from the user-scope master (UserSessionStore) on
 *      every call to `buildSystemPrompt(userId, workflow, session)` —
 *      surviving compact / reset since the host re-runs the builder
 *      against the unchanged master.
 *   3. Surface the active instruction details when the session has a
 *      live pointer.
 *   4. Surface candidates + `active: null` for fresh sessions.
 *   5. Surface a `pending: <op>` line when a confirm entry exists for
 *      the session.
 *
 * The test wires the singletons via the standard `initUserSessionStore`
 * + per-test temp dir pattern used elsewhere in the suite (#754/#755),
 * so the prompt-builder consumes a real on-disk master.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs');
  const osh = require('node:os') as typeof import('node:os');
  const pathh = require('node:path') as typeof import('node:path');
  const dir = fsh.mkdtempSync(pathh.join(osh.tmpdir(), 'soma-prompt-builder-current-instr-boot-'));
  return { dir };
});

vi.mock('../env-paths', () => ({
  get DATA_DIR() {
    return state.dir;
  },
  get SYSTEM_PROMPT_FILE() {
    return path.join(state.dir, '.system.prompt');
  },
}));

vi.mock('../user-settings-store', () => ({
  userSettingsStore: {
    getUserPersona: vi.fn().mockReturnValue('default'),
    getUserSettings: vi.fn().mockReturnValue(undefined),
    getUserNetworkDisabled: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('../user-memory-store', () => ({
  formatMemoryForPrompt: vi.fn().mockReturnValue(''),
}));

import { CURRENT_INSTRUCTION_BLOCK_CLOSE, CURRENT_INSTRUCTION_BLOCK_OPEN } from '../prompt/current-instruction-block';
import { PromptBuilder } from '../prompt-builder';
import { PendingInstructionConfirmStore } from '../slack/actions/pending-instruction-confirm-store';
import type { ConversationSession } from '../types';
import { initUserSessionStore, type UserInstruction } from '../user-session-store';

let TEST_DIR: string;
const USER_ID = 'U_PROMPT_BUILDER_756';

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

function mkSession(currentInstructionId: string | null): ConversationSession {
  return {
    ownerId: USER_ID,
    userId: USER_ID,
    channelId: 'C1',
    threadTs: 'T1',
    isActive: true,
    lastActivity: new Date(),
    currentInstructionId,
    instructions: [], // legacy field, untouched by #756
  } as ConversationSession;
}

beforeEach(() => {
  TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-prompt-builder-current-instr-'));
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

describe('PromptBuilder.buildSystemPrompt — <current-user-instruction>', () => {
  it('always emits the block when a session is supplied', () => {
    const builder = new PromptBuilder();
    const prompt = builder.buildSystemPrompt(USER_ID, 'default', mkSession(null));
    expect(prompt).toBeDefined();
    expect(prompt!).toContain(CURRENT_INSTRUCTION_BLOCK_OPEN);
    expect(prompt!).toContain(CURRENT_INSTRUCTION_BLOCK_CLOSE);
    // Empty master + null pointer → just `active: null`, no candidates list.
    expect(prompt!).toContain('active: null');
  });

  it('renders the active instruction line when the master + pointer line up', () => {
    const userDir = path.join(TEST_DIR, 'users', USER_ID);
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDir, 'user-session.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          instructions: [
            mkInstr({
              id: 'inst_alpha',
              text: 'ship the dashboard',
              createdAt: new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
              linkedSessionIds: ['C1-T1'],
            }),
          ],
          lifecycleEvents: [],
        },
        null,
        2,
      ),
    );

    const builder = new PromptBuilder();
    const prompt = builder.buildSystemPrompt(USER_ID, 'default', mkSession('inst_alpha'));
    expect(prompt!).toContain('active: inst_alpha · ship the dashboard');
    expect(prompt!).toContain('linked sessions: [C1-T1]');
  });

  it('surfaces candidate instructions when the pointer is null and the user has active rows', () => {
    const userDir = path.join(TEST_DIR, 'users', USER_ID);
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDir, 'user-session.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          instructions: [
            mkInstr({
              id: 'cand_1',
              text: 'candidate one',
              createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
            }),
            mkInstr({
              id: 'cand_2',
              text: 'candidate two',
              createdAt: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
            }),
          ],
          lifecycleEvents: [],
        },
        null,
        2,
      ),
    );

    const builder = new PromptBuilder();
    const prompt = builder.buildSystemPrompt(USER_ID, 'default', mkSession(null));
    expect(prompt!).toContain('active: null');
    expect(prompt!).toContain('candidates');
    expect(prompt!).toContain('cand_1 · candidate one');
    expect(prompt!).toContain('cand_2 · candidate two');
  });

  it('survives compact/reset — re-deriving against the unchanged master yields the same block content', () => {
    const userDir = path.join(TEST_DIR, 'users', USER_ID);
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDir, 'user-session.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          instructions: [
            mkInstr({
              id: 'inst_persistent',
              text: 'survive compact',
              createdAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
              linkedSessionIds: ['C1-T1'],
            }),
          ],
          lifecycleEvents: [],
        },
        null,
        2,
      ),
    );

    const builder = new PromptBuilder();
    const session = mkSession('inst_persistent');

    const before = builder.buildSystemPrompt(USER_ID, 'default', session);
    // Simulate compact/reset: the host reruns buildSystemPrompt with the
    // same session + same master. The block must reappear identically.
    const after = builder.buildSystemPrompt(USER_ID, 'default', session);

    const extract = (s: string | undefined): string => {
      if (!s) return '';
      const i = s.indexOf(CURRENT_INSTRUCTION_BLOCK_OPEN);
      const j = s.indexOf(CURRENT_INSTRUCTION_BLOCK_CLOSE);
      return i >= 0 && j >= 0 ? s.slice(i, j + CURRENT_INSTRUCTION_BLOCK_CLOSE.length) : '';
    };
    expect(extract(before)).not.toBe('');
    expect(extract(after)).toBe(extract(before));
  });

  it('surfaces a pending: line when the pending-confirm store has an entry for this session', () => {
    const userDir = path.join(TEST_DIR, 'users', USER_ID);
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDir, 'user-session.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          instructions: [
            mkInstr({
              id: 'inst_p',
              text: 'with pending op',
              createdAt: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
              linkedSessionIds: ['C1-T1'],
            }),
          ],
          lifecycleEvents: [],
        },
        null,
        2,
      ),
    );

    const pendingStore = new PendingInstructionConfirmStore();
    pendingStore.set({
      requestId: 'req_42',
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

    const builder = new PromptBuilder({ pendingInstructionConfirmStore: pendingStore });
    const prompt = builder.buildSystemPrompt(USER_ID, 'default', mkSession('inst_p'));
    expect(prompt!).toMatch(/pending: complete \(requested by slack-user:U_REQ at /);
  });

  it('does not emit the block when no session is supplied (e.g. dispatch one-shot prompt build)', () => {
    const builder = new PromptBuilder();
    const prompt = builder.buildSystemPrompt(USER_ID, 'default');
    // Dispatch / classifier prompts are session-less and should not be
    // burdened with the per-session current-instruction block.
    expect(prompt!).not.toContain(CURRENT_INSTRUCTION_BLOCK_OPEN);
  });
});
