/**
 * Smoke test — confirms the canonical move of slack-messenger to
 * somalib/permission/slack-messenger keeps the permission-mcp-server import
 * graph valid. If this file ever fails to type-check or import-resolve, the
 * dedup-744 mini-epic regressed.
 */
import { describe, it, expect } from 'vitest';

describe('permission-mcp-server import smoke', () => {
  it('resolves SlackPermissionMessenger from somalib/permission and constructs the server', async () => {
    process.env.SLACK_BOT_TOKEN ??= 'xoxb-smoke-test-token';
    const { getPermissionServer } = await import('./permission-mcp-server.js');
    const server = getPermissionServer();
    expect(typeof server.defineTools).toBe('function');
    const tools = server.defineTools();
    expect(tools.map((t) => t.name)).toContain('permission_prompt');
  });

  it('exposes PermissionRuleSummary-shaped overridableRules path on buildRequestBlocks', async () => {
    const { SlackPermissionMessenger } = await import(
      'somalib/permission/slack-messenger.js'
    );
    // WebClient is unused in buildRequestBlocks — pass a stub.
    const messenger = new SlackPermissionMessenger({} as never);
    const blocks = messenger.buildRequestBlocks('Bash', { command: 'rm -rf /' }, 'app-1', 'U1', [
      { id: 'rm-recursive', label: 'rm -rf', description: 'recursive delete' },
    ]);
    // 4 buttons (3 base + override) when overridableRules is non-empty
    const actions = blocks.find((b: { type: string }) => b.type === 'actions');
    expect(actions).toBeDefined();
    expect(actions.elements).toHaveLength(4);
    expect(actions.elements[3].action_id).toBe('approve_disable_rule_session');
  });
});
