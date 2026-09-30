/**
 * Contract: the `llm` internal MCP server is gone and every workflow gate that
 * used to call `mcp__llm__chat` now dispatches the trinity subagents directly.
 *
 * SSOT-TASK-TREE mapping (session 2026-09-30, "llm mcp 완전히 삭제"):
 *   T1 — llm MCP server package + runtime wiring removed
 *   T2 — trinity panel roster = astra-zhuge / grok-elon / fable-zhuge
 *   T3 — no zworkflow asset references the llm MCP tool or the retired agents
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../env-paths', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../env-paths')>();
  return {
    ...orig,
    CONFIG_FILE: '/tmp/__nonexistent_llm_mcp_removal_config__.json',
    DATA_DIR: '/tmp/llm-mcp-removal-contract-data',
  };
});

import { McpConfigBuilder } from '../mcp-config-builder';
import type { McpManager } from '../mcp-manager';

const repoRoot = path.resolve(__dirname, '..', '..');
const pluginRoot = path.join(repoRoot, 'src', 'local');
const agentsDir = path.join(pluginRoot, 'agents');

const THIS_FILE = path.resolve(__filename);

/** Every text asset under `dir`, recursively (md / ts / prompt / sh / json). */
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...walk(full));
    } else if (/\.(md|ts|js|prompt|sh|json)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function grepFiles(files: string[], pattern: RegExp): string[] {
  return files.filter((f) => path.resolve(f) !== THIS_FILE && pattern.test(fs.readFileSync(f, 'utf8')));
}

function frontmatterModel(agentFile: string): string | undefined {
  const text = fs.readFileSync(agentFile, 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return undefined;
  const model = fm[1].match(/^model:\s*["']?([^"'\n]+)["']?\s*$/m);
  return model?.[1]?.trim();
}

function createMockMcpManager(): McpManager {
  return {
    getServerConfiguration: vi.fn().mockResolvedValue({}),
    getDefaultAllowedTools: vi.fn().mockReturnValue([]),
  } as unknown as McpManager;
}

describe('T1 — llm MCP server is fully removed', () => {
  it('has no packages/mcp-servers/llm workspace', () => {
    expect(fs.existsSync(path.join(repoRoot, 'packages', 'mcp-servers', 'llm'))).toBe(false);
  });

  it('is not listed in package-lock workspaces', () => {
    const lock = fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8');
    expect(lock).not.toContain('packages/mcp-servers/llm');
    expect(lock).not.toContain('@soma/mcp-server-llm');
  });

  it('is not wired into the MCP config or allowed tools', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({
      channel: 'C123',
      threadTs: '1700000000.000000',
      mentionTs: '1700000010.000000',
      user: 'U123',
    });
    expect(Object.keys(config.mcpServers ?? {})).not.toContain('llm');
    expect(config.allowedTools ?? []).not.toContain('mcp__llm');
    expect((config.allowedTools ?? []).some((t) => t.startsWith('mcp__llm'))).toBe(false);
  });

  it('leaves no llm-mcp reference in runtime source, scripts, or the system prompt', () => {
    // The CI guard script legitimately spells the forbidden pattern out.
    const files = [
      ...walk(path.join(repoRoot, 'src')).filter((f) => !f.startsWith(pluginRoot)),
      ...walk(path.join(repoRoot, 'scripts')).filter((f) => path.basename(f) !== 'verify-no-removed-tools.sh'),
      ...walk(path.join(repoRoot, 'packages')),
    ];
    const offenders = grepFiles(files, /mcp__llm|llm_chat|llm-mcp-server|mcp-server-llm|buildLlmServer/);
    expect(offenders.map((f) => path.relative(repoRoot, f))).toEqual([]);
  });
});

describe('T2 — trinity panel roster is astra-zhuge / grok-elon / fable-zhuge', () => {
  it.each([
    ['astra-zhuge', 'astra'],
    ['grok-elon', 'grok'],
    ['fable-zhuge', 'fable'],
  ])('agent %s exists with model: %s', (agent, model) => {
    const file = path.join(agentsDir, `${agent}.md`);
    expect(fs.existsSync(file)).toBe(true);
    expect(frontmatterModel(file)).toBe(model);
  });

  it.each(['gpt56-zhuge', 'grok45-elon', 'gpt56-elon', 'codex-fallback'])('retired agent %s is gone', (agent) => {
    expect(fs.existsSync(path.join(agentsDir, `${agent}.md`))).toBe(false);
  });

  it('trinity SKILL.md dispatches exactly the three panel agents', () => {
    const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'trinity', 'SKILL.md'), 'utf8');
    const dispatched = [...skill.matchAll(/subagent_type:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(dispatched)).toEqual(new Set(['grok-elon', 'astra-zhuge', 'fable-zhuge']));
    // Panel table rows carry the agent id in backticks.
    for (const agent of ['astra-zhuge', 'grok-elon', 'fable-zhuge']) {
      expect(skill).toMatch(new RegExp(`^\\|[^\\n]*\`${agent}\`[^\\n]*\\|$`, 'm'));
    }
    expect(skill).not.toMatch(/gpt56-zhuge|grok45-elon|codex-fallback|mcp__llm__|llm_chat/);
  });
});

describe('T3 — zworkflow assets no longer call the llm MCP tool or retired agents', () => {
  it('has zero references across src/local', () => {
    const offenders = grepFiles(
      walk(pluginRoot),
      /mcp__llm__|llm_chat\(|llm_chat\b|gpt56-zhuge|grok45-elon|gpt56-elon|codex-fallback|codex exec|model:\s*"codex"/,
    );
    expect(offenders.map((f) => path.relative(repoRoot, f))).toEqual([]);
  });
});
