/**
 * Pin: bypass=ON users get every native non-Bash tool listed in `allowedTools`
 * so the SDK short-circuits the prompt-tool path before invoking
 * `permissionPromptToolName` (and before any PreToolUse hook callback can
 * lose its decision due to stream-closed transport errors).
 *
 * Field evidence motivating this layer (in addition to PR #880's PreToolUse
 * hook): on iq-64 dev 2026-05-13 ~07:53:37 UTC, `Write` tool_use
 * `toolu_013AWy39iYXE5NtzEAJrHWyR` triggered Slack permission UI for a
 * `/tmp/<self>/...` file path even though buildConfig logged
 * `userBypass:true`. SDK semantics codex check (cli.js:8643:4
 * `BY8.sendRequest` throws on `inputClosed`, `createHookCallback` catches and
 * returns `{}`, merge then has no `permissionBehavior` to act on) confirm a
 * single stream-closed hook callback silently elides our `'allow'` decision.
 * `allowedTools` is the SDK-level short-circuit that does NOT depend on hook
 * callback transport (cli.js:5172:2098 `CkY` → `hkY` → `behavior:"allow"`,
 * and cli.js:18223:13164 prompt-tool wrapper returns early on allow before
 * `q.call(...)` at :13559).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock env-paths and user-settings-store BEFORE importing the builder so the
// mocks bind to the module under test.
vi.mock('../env-paths', () => ({
  DATA_DIR: '/tmp/mcp-config-bypass-allowed-test',
  CONFIG_FILE: '/tmp/mcp-config-bypass-allowed-test/config.json',
  SYSTEM_PROMPT_FILE: '/tmp/mcp-config-bypass-allowed-test/.system.prompt',
  PLUGINS_DIR: '/tmp/mcp-config-bypass-allowed-test/plugins',
  IS_DEV: false,
}));

// vi.mock factory is hoisted; use vi.hoisted to define the spy in the same phase.
const { bypassMock } = vi.hoisted(() => ({ bypassMock: vi.fn().mockReturnValue(false) }));
vi.mock('../user-settings-store', () => ({
  userSettingsStore: {
    getUserBypassPermission: bypassMock,
    getUserDefaultModel: vi.fn().mockReturnValue('claude-sonnet-4-20250514'),
  },
}));

import { NATIVE_BYPASS_TOOLS } from '../hooks/bypass-permission-guard';
import { McpConfigBuilder } from '../mcp-config-builder';

function createMockMcpManager() {
  return {
    getServerConfiguration: vi.fn().mockResolvedValue({}),
    getDefaultAllowedTools: vi.fn().mockReturnValue([]),
  } as any;
}

describe('McpConfigBuilder — bypass allowedTools coverage', () => {
  beforeEach(() => {
    bypassMock.mockReset();
  });

  it('lists every native non-Bash tool in allowedTools when slackContext + userBypass=true', async () => {
    bypassMock.mockReturnValue(true);
    const builder = new McpConfigBuilder(createMockMcpManager());

    const config = await builder.buildConfig({ channel: 'C001', user: 'U_SELF' });

    expect(config.permissionMode).toBe('bypassPermissions');
    expect(config.userBypass).toBe(true);
    for (const tool of NATIVE_BYPASS_TOOLS) {
      expect(config.allowedTools).toContain(tool);
    }
  });

  it('does NOT include Bash in the allowedTools native set (bypass-Bash-gate owns escalation)', async () => {
    bypassMock.mockReturnValue(true);
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C001', user: 'U_SELF' });

    expect(config.allowedTools).not.toContain('Bash');
  });

  it('does NOT add the native non-Bash tools when userBypass=false (SDK default permission flow runs)', async () => {
    bypassMock.mockReturnValue(false);
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C001', user: 'U_SELF' });

    expect(config.userBypass).toBe(false);
    for (const tool of NATIVE_BYPASS_TOOLS) {
      expect(config.allowedTools).not.toContain(tool);
    }
  });

  it('keeps EnterPlanMode/ExitPlanMode/Skill listed alongside the bypass native set', async () => {
    bypassMock.mockReturnValue(true);
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C001', user: 'U_SELF' });

    expect(config.allowedTools).toContain('EnterPlanMode');
    expect(config.allowedTools).toContain('ExitPlanMode');
    expect(config.allowedTools).toContain('Skill');
  });
});
