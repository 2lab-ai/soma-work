import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../env-paths', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../env-paths')>();
  return {
    ...orig,
    CONFIG_FILE: '/tmp/__nonexistent_packages_srp_contract_config__.json',
    DATA_DIR: '/tmp/packages-srp-contract-data',
  };
});

import { type InternalMcpServerName, resolveInternalMcpServerCommand } from '../internal-mcp-server-resolver';
import { McpConfigBuilder } from '../mcp-config-builder';
import type { McpManager } from '../mcp-manager';

const repoRoot = path.resolve(__dirname, '..', '..');

const internalServers = [
  { id: 'agent', dir: 'agent', basename: 'agent-mcp-server' },
  { id: 'cron', dir: 'cron', basename: 'cron-mcp-server' },
  { id: 'llm', dir: 'llm', basename: 'llm-mcp-server' },
  { id: 'mcp-tool-permission', dir: 'mcp-tool-permission', basename: 'mcp-tool-permission-mcp-server' },
  { id: 'model-command', dir: 'model-command', basename: 'model-command-mcp-server' },
  { id: 'permission', dir: 'permission', basename: 'permission-mcp-server' },
  { id: 'server-tools', dir: 'server-tools', basename: 'server-tools-mcp-server' },
  { id: 'slack-mcp', dir: 'slack-mcp', basename: 'slack-mcp-server' },
] as const;

interface PackageJson {
  name?: string;
  main?: string;
  exports?: Record<string, string>;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  workspaces?: string[];
}

function createMockMcpManager(): McpManager {
  return {
    getServerConfiguration: vi.fn().mockResolvedValue({}),
    getDefaultAllowedTools: vi.fn().mockReturnValue([]),
  } as unknown as McpManager;
}

function readJson(filePath: string): PackageJson {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as PackageJson;
}

function listTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts')) {
      result.push(fullPath);
    }
  }
  return result;
}

function executablePath(server: { args?: string[] }): string {
  const args = server.args ?? [];
  return args[args.length - 1] ?? '';
}

describe('packages SRP Phase 0 package contract', () => {
  it('declares process-shared and every internal MCP server as workspace packages with bin exports', () => {
    const rootPackage = readJson(path.join(repoRoot, 'package.json'));
    expect(rootPackage.workspaces).toEqual(expect.arrayContaining(['packages/*', 'packages/mcp-servers/*']));

    const processSharedPackage = readJson(path.join(repoRoot, 'packages/process-shared/package.json'));
    expect(processSharedPackage.name).toBe('@soma/process-shared');
    expect(processSharedPackage.main).toBe('./dist/index.js');
    expect(processSharedPackage.exports).toMatchObject({
      '.': './dist/index.js',
      './*': './dist/*',
    });

    for (const server of internalServers) {
      const packageJson = readJson(path.join(repoRoot, 'packages/mcp-servers', server.dir, 'package.json'));
      expect(packageJson.name).toBe(`@soma/mcp-server-${server.id}`);
      expect(packageJson.exports).toMatchObject({
        './bin': `./dist/${server.basename}.js`,
      });
      expect(Object.values(packageJson.bin ?? {})).toContain(`./dist/${server.basename}.js`);
      expect(packageJson.dependencies).toHaveProperty('@soma/process-shared');
    }
  });

  it('keeps MCP server packages off legacy app/shared source paths', () => {
    const packageServerRoot = path.join(repoRoot, 'packages/mcp-servers');
    const offenders = listTsFiles(packageServerRoot).flatMap((filePath) => {
      const source = fs.readFileSync(filePath, 'utf8');
      const matches = source.match(/(\.\.\/\.\.\/src\/|\.\.\/_shared|somalib\/)/g) ?? [];
      return matches.map((match) => `${path.relative(repoRoot, filePath)} -> ${match}`);
    });

    expect(offenders).toEqual([]);
  });

  it('resolves package-mode internal MCP bins to built dist entrypoints', () => {
    for (const server of internalServers) {
      const command = resolveInternalMcpServerCommand(server.id as InternalMcpServerName, { mode: 'package' });

      expect(command.command).toBe('node');
      expect(command.args).toHaveLength(1);
      expect(command.resolvedPath).toBe(command.args[0]);
      expect(command.resolvedPath.split(path.sep).join('/')).toMatch(
        new RegExp(`/packages/mcp-servers/${server.dir}/dist/${server.basename}\\.js$`),
      );
      expect(fs.existsSync(command.resolvedPath)).toBe(true);
    }
  });

  it('builds internal MCP server configs from package paths instead of the legacy root mcp-servers tree', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    builder.setAgentConfigs({
      reviewer: {
        promptDir: '/tmp/prompts',
        persona: 'reviewer',
        description: 'Review agent',
        model: 'sonnet',
      },
    });

    const config = await builder.buildConfig({
      channel: 'C123',
      threadTs: '1700000000.000000',
      mentionTs: '1700000010.000000',
      user: 'U123',
    });

    for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
      if (name === 'filesystem') continue;
      const serverPath = executablePath(server);
      expect(serverPath).toContain(`${path.sep}packages${path.sep}mcp-servers${path.sep}`);
      expect(serverPath).not.toContain(`${repoRoot}${path.sep}mcp-servers${path.sep}`);
    }
  });
});
