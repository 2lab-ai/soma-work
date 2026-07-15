/**
 * `buildStreamOptions` × llmux model catalog overlay.
 *
 * Two catalog-driven behaviors:
 *   1. SDK context-window workaround env injection for non-claude catalog
 *      models (grok-4.5 → 500k window → blocking limit 477000).
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
  it('injects DISABLE_AUTO_COMPACT + BLOCKING_LIMIT_OVERRIDE=477000 for grok-4.5', async () => {
    modelCatalog.__testSeed([GROK]);
    const queryEnv: Record<string, string | undefined> = { CLAUDE_CODE_OAUTH_TOKEN: 'lease' };
    const session = { model: 'grok-4.5', systemPrompt: 'x', sessionId: 's1' } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv, session }, makeDeps());

    expect(options.env).toBe(queryEnv);
    expect(options.env?.DISABLE_AUTO_COMPACT).toBe('1');
    expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBe('477000');
  });

  it('does NOT inject for grok-4.5 when the catalog is empty (unknown id)', async () => {
    const session = { model: 'grok-4.5', systemPrompt: 'x', sessionId: 's2' } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv: {}, session }, makeDeps());
    expect(options.env?.DISABLE_AUTO_COMPACT).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBeUndefined();
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

  it('never injects for a claude-group catalog entry (bare claude id stays SDK-managed)', async () => {
    modelCatalog.__testSeed([
      GROK,
      { id: 'claude-opus-4-7', aliases: [], name: 'Opus 4.7', efforts: [], max_context: 1_000_000, group: 'claude' },
    ]);
    const session = { model: 'claude-opus-4-7', systemPrompt: 'x', sessionId: 's4' } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv: {}, session }, makeDeps());
    expect(options.env?.DISABLE_AUTO_COMPACT).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBeUndefined();
  });

  it('respects operator-provided env values for grok-4.5 (no clobbering)', async () => {
    modelCatalog.__testSeed([GROK]);
    const queryEnv: Record<string, string | undefined> = {
      DISABLE_AUTO_COMPACT: 'false',
      CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: '123456',
    };
    const session = { model: 'grok-4.5', systemPrompt: 'x', sessionId: 's5' } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv, session }, makeDeps());
    expect(options.env?.DISABLE_AUTO_COMPACT).toBe('false');
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
