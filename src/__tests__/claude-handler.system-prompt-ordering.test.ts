/**
 * ClaudeHandler × system prompt ordering (#756 PR3a fix loop #1, P1-A).
 *
 * Codex review: the `<current-user-instruction>` block must be the LAST
 * non-whitespace section of the final system prompt the model sees.
 * `PromptBuilder.buildSystemPrompt` placed it at the end of its own output,
 * but `ClaudeHandler.streamQuery` then APPENDS `<channel-description>` and
 * `<channel-repository>` AFTER. Net effect — the block is no longer last.
 *
 * Fix: assembly happens in ClaudeHandler. The block is placed AFTER all
 * other suffixes (channel description / repo context) so it occupies the
 * tail slot of the final string.
 *
 * The assembly is now exposed as a public method
 * `ClaudeHandler.assembleSystemPromptForTurn` so we can verify ordering
 * without a live Claude SDK call.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs');
  const osh = require('node:os') as typeof import('node:os');
  const pathh = require('node:path') as typeof import('node:path');
  const dir = fsh.mkdtempSync(pathh.join(osh.tmpdir(), 'soma-claude-handler-ordering-boot-'));
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
import { CURRENT_INSTRUCTION_BLOCK_CLOSE, CURRENT_INSTRUCTION_BLOCK_OPEN } from '../prompt/current-instruction-block';
import type { ConversationSession } from '../types';
import { initUserSessionStore, type UserInstruction } from '../user-session-store';

let TEST_DIR: string;
const USER_ID = 'U_ORDERING_756';

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
    ...partial,
  } as ConversationSession;
}

beforeEach(() => {
  TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-claude-handler-ordering-'));
  state.dir = TEST_DIR;
  initUserSessionStore(TEST_DIR);

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
});

afterEach(() => {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('ClaudeHandler.assembleSystemPromptForTurn — ordering', () => {
  it('places <current-user-instruction> as the LAST non-whitespace section even when channel-description + repo context are appended', () => {
    const handler = new ClaudeHandler(new McpManager());
    const session = mkSession();

    const slackContext = {
      user: USER_ID,
      channel: 'C1',
      threadTs: 'T1',
      channelDescription: 'engineering channel — ship code',
      repos: ['2lab-ai/soma-work'],
      confluenceUrl: undefined,
    };

    const prompt = (handler as any).assembleSystemPromptForTurn(session, slackContext) as string;
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);

    // Confirm both upstream suffixes are still present so the regression
    // surfaces if someone deletes them by accident.
    expect(prompt).toContain('<channel-description');
    expect(prompt).toContain('<channel-repository>');
    expect(prompt).toContain(CURRENT_INSTRUCTION_BLOCK_OPEN);
    expect(prompt).toContain(CURRENT_INSTRUCTION_BLOCK_CLOSE);

    // Strip trailing whitespace, then assert the LAST non-whitespace
    // section is the closing tag of the current-user-instruction block.
    const trimmed = prompt.replace(/\s+$/, '');
    expect(trimmed.endsWith(CURRENT_INSTRUCTION_BLOCK_CLOSE)).toBe(true);

    // And the LAST occurrence of `<channel-description` and
    // `<channel-repository>` must come BEFORE the block open tag.
    const blockOpen = prompt.lastIndexOf(CURRENT_INSTRUCTION_BLOCK_OPEN);
    const lastChanDesc = prompt.lastIndexOf('<channel-description');
    const lastRepo = prompt.lastIndexOf('<channel-repository>');
    expect(lastChanDesc).toBeGreaterThanOrEqual(0);
    expect(lastRepo).toBeGreaterThanOrEqual(0);
    expect(lastChanDesc).toBeLessThan(blockOpen);
    expect(lastRepo).toBeLessThan(blockOpen);
  });
});
