/**
 * `buildStreamOptions` × llmux model catalog overlay.
 *
 * Two catalog-driven behaviors:
 *   1. SDK context-window workaround env injection for non-claude catalog
 *      models (grok-4.5 → 500k window → blocking limit 477000). SDK-native
 *      autocompact is off for every session (`DISABLE_AUTO_COMPACT=1`) — the
 *      harness turn-end scheduler is the sole compaction authority.
 *   2. Effort clamping to the model's catalog effort menu (grok has no
 *      xhigh/max — clamp to high) without mutating the saved session.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpConfig } from '../../mcp-config-builder';
import { modelCatalog } from '../../model-catalog';
import type { ConversationSession } from '../../types';
import { type BuildStreamOptionsDeps, buildStreamOptions } from '../claude-code/build-stream-options';

const GROK = {
  id: 'grok-4.5',
  aliases: ['grok'],
  name: 'Grok 4.5',
  efforts: ['low', 'medium', 'high'],
  max_context: 500_000,
  group: 'grok',
};

function makeMcpConfig(): McpConfig {
  return {
    permissionMode: 'bypassPermissions',
    userBypass: true,
    somaPermissionMode: 'bypass',
    allowDangerouslySkipPermissions: true,
    mcpServers: {},
    allowedTools: [],
    disallowedTools: [],
    permissionPromptToolName: 'mcp__permission-prompt__permission_prompt',
  } as unknown as McpConfig;
}

function makeDeps(): BuildStreamOptionsDeps {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    logger,
    getEffectivePluginPaths: () => [],
    buildModelCommandContext: () => undefined,
    mcpConfigBuilder: { buildConfig: vi.fn(async () => makeMcpConfig()) },
    compactHookBuilder: undefined,
    promptBuilder: { buildSystemPrompt: vi.fn(() => 'PROMPT') },
    sessionRegistry: {
      getSessionKey: vi.fn(() => 'chan:thread'),
      isDangerousRuleDisabled: vi.fn(() => false),
      getSession: vi.fn(() => undefined),
    },
    checkMcpToolPermission: vi.fn(() => null),
  } as unknown as BuildStreamOptionsDeps;
}

afterEach(() => {
  modelCatalog.__testReset();
});

describe('buildStreamOptions — catalog window workaround (grok-4.5)', () => {
  it('injects BLOCKING_LIMIT_OVERRIDE=477000 + DISABLE_AUTO_COMPACT=1 for grok-4.5', async () => {
    modelCatalog.__testSeed([GROK]);
    const queryEnv: Record<string, string | undefined> = { CLAUDE_CODE_OAUTH_TOKEN: 'lease' };
    const session = { model: 'grok-4.5', systemPrompt: 'x', sessionId: 's1' } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv, session }, makeDeps());

    expect(options.env).toBe(queryEnv);
    expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBe('477000');
    // Compaction authority is the harness scheduler (ruling 2026-08-26).
    expect(options.env?.DISABLE_AUTO_COMPACT).toBe('1');
    expect(options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });

  it('falls back to the 200k-window limit for grok-4.5 with an empty catalog', async () => {
    const session = { model: 'grok-4.5', systemPrompt: 'x', sessionId: 's2' } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv: {}, session }, makeDeps());
    expect(options.env?.DISABLE_AUTO_COMPACT).toBe('1');
    expect(options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBe('177000');
  });

  it('keeps gpt-5.6-sol on its hardcoded 349000 limit (catalog seeded)', async () => {
    modelCatalog.__testSeed([
      GROK,
      { id: 'gpt-5.6', aliases: [], name: 'GPT-5.6', efforts: [], max_context: 400_000, group: 'codex' },
    ]);
    const session = { model: 'gpt-5.6-sol', systemPrompt: 'x', sessionId: 's3' } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv: {}, session }, makeDeps());
    expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBe('349000');
  });

  it('grok-4.6 uses the policy overlay blocking limit (477000) with an empty catalog', async () => {
    // grok-4.6 is a canonical policy id — its window is declared, not fetched,
    // so a cold start with no catalog snapshot must not fall back to 200k. The
    // 450k trigger lives in the harness scheduler, never in the SDK env.
    const session = { model: 'grok-4.6', systemPrompt: 'x', sessionId: 's3b' } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv: {}, session }, makeDeps());
    expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBe('477000');
    expect(options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(options.env?.DISABLE_AUTO_COMPACT).toBe('1');
  });

  it('ignores a claude-group catalog window (bare claude id keeps the 200k contract → 177000)', async () => {
    modelCatalog.__testSeed([
      GROK,
      { id: 'claude-opus-4-7', aliases: [], name: 'Opus 4.7', efforts: [], max_context: 1_000_000, group: 'claude' },
    ]);
    const session = { model: 'claude-opus-4-7', systemPrompt: 'x', sessionId: 's4' } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv: {}, session }, makeDeps());
    expect(options.env?.DISABLE_AUTO_COMPACT).toBe('1');
    expect(options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBe('177000');
  });

  it('respects operator-provided env values for grok-4.5 (no clobbering)', async () => {
    modelCatalog.__testSeed([GROK]);
    const queryEnv: Record<string, string | undefined> = {
      CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: '123456',
    };
    const session = { model: 'grok-4.5', systemPrompt: 'x', sessionId: 's5' } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv, session }, makeDeps());
    expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBe('123456');
  });
});

describe('buildStreamOptions — effort clamp to catalog menu', () => {
  it('clamps session.effort xhigh → high for grok-4.5', async () => {
    modelCatalog.__testSeed([GROK]);
    const session = { model: 'grok-4.5', systemPrompt: 'x', sessionId: 's6', effort: 'xhigh' } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv: {}, session }, makeDeps());
    expect(options.effort).toBe('high');
    // The saved session value must NOT be mutated.
    expect(session.effort).toBe('xhigh');
  });

  it('passes a supported effort through unchanged (grok low)', async () => {
    modelCatalog.__testSeed([GROK]);
    const session = { model: 'grok-4.5', systemPrompt: 'x', sessionId: 's7', effort: 'low' } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv: {}, session }, makeDeps());
    expect(options.effort).toBe('low');
  });

  it('leaves effort untouched for models unknown to the catalog', async () => {
    modelCatalog.__testSeed([GROK]);
    const session = {
      model: 'claude-opus-4-7',
      systemPrompt: 'x',
      sessionId: 's8',
      effort: 'xhigh',
    } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv: {}, session }, makeDeps());
    expect(options.effort).toBe('xhigh');
  });
});
