import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// devops-tools wiring (.prd/16-devops-tools-architecture.md §2 "설정 빌더", §3, §8): the server is
// registered only from a config.json `devops-tools` section, carries no secret in its env, and every
// one of its tools sits behind the generic MCP grant gate.

vi.mock('../env-paths', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../env-paths')>();
  const fsMod = require('node:fs');
  const osMod = require('node:os');
  const pathMod = require('node:path');
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'devops-tools-wiring-'));
  const dataDir = pathMod.join(dir, 'data');
  fsMod.mkdirSync(dataDir, { recursive: true });
  return { ...orig, CONFIG_FILE: pathMod.join(dir, 'config.json'), DATA_DIR: dataDir };
});

vi.mock('../admin-utils', () => ({
  isAdminUser: vi.fn((userId: string) => userId === 'U000ADMIN'),
  getAdminUsers: vi.fn(() => new Set(['U000ADMIN'])),
  resetAdminUsersCache: vi.fn(),
}));

import { evaluateToolPolicy } from '../agent-runtime/policy/tool-policy';
import { ClaudeHandler } from '../claude-handler';
import { CONFIG_FILE, DATA_DIR } from '../env-paths';
import { McpConfigBuilder, type SlackContext } from '../mcp-config-builder';
import type { McpManager } from '../mcp-manager';
import { getPermissionGatedServers, loadMcpToolPermissions } from '../mcp-tool-permission-config';

const DEVOPS_TOOLS = [
  'list',
  'gh_read',
  'gh_write',
  'gh_org_member',
  'gh_repo_access',
  'cf_lease_request',
  'cf_api',
  'cf_lease_revoke',
] as const;

const ALL_READ = Object.fromEntries(DEVOPS_TOOLS.map((t) => [t, 'read']));
const SLACK: SlackContext = { channel: 'C000TEST', threadTs: '1700000000.000000', user: 'U000ALICE' };
const GRANT_FILE = () => path.join(DATA_DIR, 'mcp-tool-grants.json');
// The grant store keeps its cache when the file is deleted, so each grant test uses its own user and
// U000ALICE never holds a grant.

function createMockMcpManager(): McpManager {
  return {
    getServerConfiguration: vi.fn().mockResolvedValue({}),
    getDefaultAllowedTools: vi.fn().mockReturnValue([]),
    getPluginManager: () => null,
  } as unknown as McpManager;
}

function writeConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config));
}

function writeReadGrant(user: string): void {
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  fs.writeFileSync(
    GRANT_FILE(),
    JSON.stringify({
      [user]: { 'devops-tools': { read: { grantedAt: new Date().toISOString(), expiresAt, grantedBy: 'U000ADMIN' } } },
    }),
  );
}

async function build(slack: SlackContext = SLACK) {
  return new McpConfigBuilder(createMockMcpManager()).buildConfig(slack);
}

const ORIGINAL_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

beforeEach(() => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-placeholder-must-not-leak';
});

afterEach(() => {
  if (ORIGINAL_BOT_TOKEN === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = ORIGINAL_BOT_TOKEN;
  if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
  if (fs.existsSync(GRANT_FILE())) fs.unlinkSync(GRANT_FILE());
});

describe('McpConfigBuilder devops-tools registration', () => {
  it('does not register devops-tools when config.json has no devops-tools section', async () => {
    writeConfig({ 'server-tools': { permission: { logs: 'read' }, dev2: { ssh: { host: 'example.com' } } } });
    const config = await build();
    expect(config.mcpServers?.['devops-tools']).toBeUndefined();
    expect(config.allowedTools?.some((t) => t.startsWith('mcp__devops-tools'))).toBe(false);
  });

  it('registers devops-tools with only SLACK_CONTEXT in its env when the section is present', async () => {
    writeConfig({ 'devops-tools': { permission: ALL_READ } });
    const config = await build();
    const server = config.mcpServers?.['devops-tools'];
    expect(server).toBeDefined();
    expect(path.basename(server.args[server.args.length - 1])).toMatch(/^devops-tools-mcp-server\.(ts|js)$/);
    expect(server.env).toEqual({ SLACK_CONTEXT: JSON.stringify(SLACK) });
    expect(server.env).not.toHaveProperty('SLACK_BOT_TOKEN');
    // Outlasts the MCP server's 5 min approval wait + 30 s grace (SDK per-server stdio `timeout`).
    expect(server.timeout).toBe(360_000);
    expect(JSON.stringify(server)).not.toContain('xoxb-placeholder-must-not-leak');
  });

  it('passes an absolute socketPath as SOMA_DEVOPS_BROKER_SOCKET', async () => {
    writeConfig({ 'devops-tools': { permission: ALL_READ, socketPath: '/tmp/U000ALICE/broker.sock' } });
    const server = (await build()).mcpServers?.['devops-tools'];
    expect(server.env).toEqual({
      SLACK_CONTEXT: JSON.stringify(SLACK),
      SOMA_DEVOPS_BROKER_SOCKET: '/tmp/U000ALICE/broker.sock',
    });
  });

  it('omits SOMA_DEVOPS_BROKER_SOCKET for a relative or non-string socketPath', async () => {
    for (const socketPath of ['run/broker.sock', 42, '']) {
      writeConfig({ 'devops-tools': { permission: ALL_READ, socketPath } });
      const server = (await build()).mcpServers?.['devops-tools'];
      expect(Object.keys(server.env)).toEqual(['SLACK_CONTEXT']);
    }
  });

  it('keeps the env var name in step with the broker protocol constant', () => {
    const protocol = fs.readFileSync(
      path.resolve(__dirname, '../../packages/process-shared/src/devops/protocol.ts'),
      'utf8',
    );
    expect(protocol).toContain("export const BROKER_SOCKET_ENV = 'SOMA_DEVOPS_BROKER_SOCKET';");
  });

  it('does not register devops-tools without a permission map (it would run ungated)', async () => {
    for (const section of [{}, { permission: {} }, { permission: 'read' }, { socketPath: '/tmp/x.sock' }]) {
      writeConfig({ 'devops-tools': section });
      expect((await build()).mcpServers?.['devops-tools']).toBeUndefined();
    }
  });

  it('does not register devops-tools without a Slack context (no requester to put on a card)', async () => {
    writeConfig({ 'devops-tools': { permission: ALL_READ } });
    const config = await new McpConfigBuilder(createMockMcpManager()).buildConfig();
    expect(config.mcpServers?.['devops-tools']).toBeUndefined();
  });
});

describe('devops-tools grant gate — query-start allowedTools', () => {
  beforeEach(() => writeConfig({ 'devops-tools': { permission: ALL_READ } }));

  it('admin gets the blanket mcp__devops-tools prefix', async () => {
    const config = await build({ ...SLACK, user: 'U000ADMIN' });
    expect(config.allowedTools).toContain('mcp__devops-tools');
  });

  it('non-admin without a grant gets no devops-tools tool', async () => {
    const config = await build();
    expect(config.allowedTools?.some((t) => t.startsWith('mcp__devops-tools'))).toBe(false);
  });

  it('non-admin with a read grant gets each of the eight tools by name, not the blanket prefix', async () => {
    writeReadGrant('U000BOB');
    const config = await build({ ...SLACK, user: 'U000BOB' });
    for (const tool of DEVOPS_TOOLS) {
      expect(config.allowedTools).toContain(`mcp__devops-tools__${tool}`);
    }
    expect(config.allowedTools).not.toContain('mcp__devops-tools');
  });
});

describe('devops-tools grant gate — PreToolUse deny tier (real ClaudeHandler.checkMcpToolPermission)', () => {
  type Check = (tool: string, user: string, cfg: unknown, gated: string[]) => string | null;

  /** The policy context's MCP check, wired exactly as build-stream-options.ts wires it. */
  function policyCheck(user: string): (name: string) => string | null {
    const handler = new ClaudeHandler(createMockMcpManager());
    const check = (handler as unknown as { checkMcpToolPermission: Check }).checkMcpToolPermission.bind(handler);
    const cachedPermConfig = loadMcpToolPermissions(CONFIG_FILE);
    const gatedServerNames = getPermissionGatedServers(cachedPermConfig);
    return (name) =>
      gatedServerNames.length > 0 ? (check(name, user, cachedPermConfig, gatedServerNames) ?? null) : null;
  }

  function decide(tool: string, user: string, isAdmin = false) {
    return evaluateToolPolicy(
      `mcp__devops-tools__${tool}`,
      {},
      {
        user,
        isAdmin,
        mode: 'bypass',
        aborted: false,
        isDangerousRuleDisabled: () => false,
        checkMcpToolPermission: policyCheck(user),
      },
    );
  }

  it('denies every devops tool to a non-admin without a grant, even in bypass mode', () => {
    writeConfig({ 'devops-tools': { permission: ALL_READ } });
    for (const tool of DEVOPS_TOOLS) {
      const result = decide(tool, 'U000ALICE');
      expect(result.decision, tool).toBe('deny');
      expect(result.reason, tool).toContain('No active grant for devops-tools. Required: read');
    }
  });

  it('allows the listed tools once the user holds the grant', () => {
    writeConfig({ 'devops-tools': { permission: ALL_READ } });
    writeReadGrant('U000CAROL');
    for (const tool of DEVOPS_TOOLS) {
      expect(decide(tool, 'U000CAROL').decision, tool).not.toBe('deny');
    }
  });

  it('denies a tool missing from the permission map even with a grant (deny-by-default)', () => {
    const { gh_write: _omitted, ...withoutGhWrite } = ALL_READ;
    writeConfig({ 'devops-tools': { permission: withoutGhWrite } });
    writeReadGrant('U000DAVE');
    const result = decide('gh_write', 'U000DAVE');
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Tool gh_write on gated server devops-tools is not listed in permission config');
    expect(decide('gh_read', 'U000DAVE').decision).not.toBe('deny');
  });

  it('requires a write grant for a tool the map marks write', () => {
    writeConfig({ 'devops-tools': { permission: { ...ALL_READ, gh_write: 'write' } } });
    writeReadGrant('U000ERIN');
    const result = decide('gh_write', 'U000ERIN');
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Insufficient grant level for devops-tools/gh_write');
  });
});
