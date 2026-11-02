/**
 * SSOT 2026-11-02 T2 — the daemon's wiring: `ClaudeHandler` gives its config
 * builder the advisor every permission prompt asks. The advisor returns the
 * advice the policy hook left for the call (no second guardian call).
 */
import { describe, expect, it } from 'vitest';
import { permissionAdviceBoard } from '../agent-runtime/policy/permission-advice';
import { ClaudeHandler } from '../claude-handler';
import type { McpManager } from '../mcp-manager';

describe('ClaudeHandler — permission advice wiring', () => {
  it('sets the config builder advisor, which hands over the advice the escalation left', async () => {
    const handler = new ClaudeHandler({ getPluginManager: () => null } as unknown as McpManager);
    const advisor = (
      handler as unknown as { mcpConfigBuilder: { permissionAdvisor?: (r: unknown) => Promise<unknown> } }
    ).mcpConfigBuilder.permissionAdvisor;
    expect(advisor).toBeTypeOf('function');
    const advice = { recommendation: 'deny' as const, summary: 's', risk: 'r' };
    permissionAdviceBoard.put('work:CADV:1.0', 'Bash', { command: 'rm -rf /' }, advice);
    await expect(
      advisor?.({ scope: 'work:CADV:1.0', user: 'U1', toolName: 'Bash', input: { command: 'rm -rf /' }, ruleIds: [] }),
    ).resolves.toEqual(advice);
  });
});
