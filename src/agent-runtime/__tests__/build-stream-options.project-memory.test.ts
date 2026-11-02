/**
 * SSOT 2026-10-23 T4 — a session in a channel mapped to a repo gets that
 * repo's shared project memory in its system prompt, right after the
 * `<channel-repository>` block. Real store (vitest setup pins DATA_DIR).
 */

import { describe, expect, it, vi } from 'vitest';
import type { SlackContext } from '../../mcp-config-builder';
import { getProjectMemoryStore } from '../../project-memory-store';
import { type BuildStreamOptionsDeps, buildStreamOptions } from '../claude-code/build-stream-options';

function deps(): BuildStreamOptionsDeps {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    logger,
    getEffectivePluginPaths: () => [],
    buildModelCommandContext: () => undefined,
    mcpConfigBuilder: {
      buildConfig: vi.fn(async () => ({
        permissionMode: 'default',
        userBypass: false,
        somaPermissionMode: 'auto',
        allowDangerouslySkipPermissions: false,
        mcpServers: {},
        allowedTools: [],
        disallowedTools: [],
      })),
    },
    compactHookBuilder: undefined,
    promptBuilder: { buildSystemPrompt: vi.fn(() => 'BUILT-PROMPT') },
    sessionRegistry: {
      getSessionKey: vi.fn(() => 'chan:thread'),
      isDangerousRuleDisabled: vi.fn(() => false),
      getSession: vi.fn(() => undefined),
    } as unknown as BuildStreamOptionsDeps['sessionRegistry'],
    checkMcpToolPermission: vi.fn(() => null),
  } as unknown as BuildStreamOptionsDeps;
}

function ctx(repos: string[]): SlackContext {
  return { user: 'U0PROJMEM1', channel: 'C1', threadTs: '1.1', repos } as SlackContext;
}

describe('buildStreamOptions — shared project memory', () => {
  it('injects the notes of the channel repo after the repo block', async () => {
    const store = getProjectMemoryStore();
    const r = store.edit(
      '2lab-ai/soma-work',
      store.get('2lab-ai/soma-work').revision,
      { kind: 'add', text: 'CI 러너는 1대' },
      'U_ADMIN',
    );
    expect(r.ok).toBe(true);
    const { options } = await buildStreamOptions({ queryEnv: {}, slackContext: ctx(['2lab-ai/soma-work']) }, deps());
    const prompt = String(options.systemPrompt);
    expect(prompt).toContain('<project-memory project="2lab-ai/soma-work" curated-by="admins">');
    expect(prompt).toContain('CI 러너는 1대');
    expect(prompt.indexOf('</channel-repository>')).toBeLessThan(prompt.indexOf('<project-memory'));
  });

  it('adds nothing for a repo without notes or a channel without repos', async () => {
    const a = await buildStreamOptions({ queryEnv: {}, slackContext: ctx(['someone/else']) }, deps());
    expect(String(a.options.systemPrompt)).not.toContain('<project-memory');
    const b = await buildStreamOptions({ queryEnv: {}, slackContext: ctx([]) }, deps());
    expect(String(b.options.systemPrompt)).not.toContain('<project-memory');
  });
});
