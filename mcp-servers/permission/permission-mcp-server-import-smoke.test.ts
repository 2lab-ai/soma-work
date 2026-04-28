import { afterEach, describe, expect, it, vi } from 'vitest';

describe('permission-mcp-server import smoke', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves SlackPermissionMessenger from somalib/permission and constructs the server', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-smoke-test-token');
    const { getPermissionServer } = await import('./permission-mcp-server.js');
    const server = getPermissionServer();
    expect(typeof server.defineTools).toBe('function');
    const tools = server.defineTools();
    expect(tools.map((t) => t.name)).toContain('permission_prompt');
  });

  it('exposes PermissionRuleSummary-shaped overridableRules path on buildRequestBlocks', async () => {
    const { SlackPermissionMessenger } = await import('somalib/permission/slack-messenger.js');
    // WebClient is unused in buildRequestBlocks — pass a stub.
    const messenger = new SlackPermissionMessenger({} as never);
    const blocks = messenger.buildRequestBlocks('Bash', { command: 'rm -rf /' }, 'app-1', 'U1', [
      { id: 'rm-recursive', label: 'rm -rf', description: 'recursive delete' },
    ]);
    interface ActionsBlock {
      type: 'actions';
      elements: ReadonlyArray<{ action_id: string }>;
    }
    const actions = blocks.find(
      (b: { type: string }): b is ActionsBlock => b.type === 'actions',
    );
    expect(actions).toBeDefined();
    if (!actions) return;
    // 3 base buttons + override button when overridableRules is non-empty
    expect(actions.elements).toHaveLength(4);
    expect(actions.elements[3].action_id).toBe('approve_disable_rule_session');
  });
});
