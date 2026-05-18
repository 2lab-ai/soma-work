import * as fs from 'node:fs';
import * as path from 'node:path';

export type InternalMcpServerName =
  | 'agent'
  | 'cron'
  | 'llm'
  | 'mcp-tool-permission'
  | 'model-command'
  | 'permission'
  | 'server-tools'
  | 'slack-mcp';

export type InternalMcpServerMode = 'source' | 'package';

interface InternalMcpServerSpec {
  dir: string;
  basename: string;
  packageBinSpecifier: string;
}

export const INTERNAL_MCP_SERVER_SPECS: Record<InternalMcpServerName, InternalMcpServerSpec> = {
  agent: {
    dir: 'agent',
    basename: 'agent-mcp-server',
    packageBinSpecifier: '@soma/mcp-server-agent/bin',
  },
  cron: {
    dir: 'cron',
    basename: 'cron-mcp-server',
    packageBinSpecifier: '@soma/mcp-server-cron/bin',
  },
  llm: {
    dir: 'llm',
    basename: 'llm-mcp-server',
    packageBinSpecifier: '@soma/mcp-server-llm/bin',
  },
  'mcp-tool-permission': {
    dir: 'mcp-tool-permission',
    basename: 'mcp-tool-permission-mcp-server',
    packageBinSpecifier: '@soma/mcp-server-mcp-tool-permission/bin',
  },
  'model-command': {
    dir: 'model-command',
    basename: 'model-command-mcp-server',
    packageBinSpecifier: '@soma/mcp-server-model-command/bin',
  },
  permission: {
    dir: 'permission',
    basename: 'permission-mcp-server',
    packageBinSpecifier: '@soma/mcp-server-permission/bin',
  },
  'server-tools': {
    dir: 'server-tools',
    basename: 'server-tools-mcp-server',
    packageBinSpecifier: '@soma/mcp-server-server-tools/bin',
  },
  'slack-mcp': {
    dir: 'slack-mcp',
    basename: 'slack-mcp-server',
    packageBinSpecifier: '@soma/mcp-server-slack-mcp/bin',
  },
};

export interface InternalMcpServerCommand {
  command: 'node' | 'npx';
  args: string[];
  mode: InternalMcpServerMode;
  resolvedPath: string;
  triedPaths: string[];
}

export interface InternalMcpServerResolveOptions {
  existsSync?: (candidate: string) => boolean;
  projectRoot?: string;
  requireResolve?: (specifier: string) => string;
  runtimeExt?: '.ts' | '.js';
  mode?: InternalMcpServerMode;
}

function defaultProjectRoot(): string {
  return path.resolve(__dirname, '..');
}

function defaultRuntimeExt(): '.ts' | '.js' {
  return __filename.endsWith('.ts') ? '.ts' : '.js';
}

function defaultMode(runtimeExt: '.ts' | '.js'): InternalMcpServerMode {
  const configured = process.env.SOMA_MCP_SERVER_MODE;
  if (configured === 'source' || configured === 'package') {
    return configured;
  }
  return runtimeExt === '.ts' ? 'source' : 'package';
}

export function resolveInternalMcpServerCommand(
  serverName: InternalMcpServerName,
  options: InternalMcpServerResolveOptions = {},
): InternalMcpServerCommand {
  const spec = INTERNAL_MCP_SERVER_SPECS[serverName];
  const runtimeExt = options.runtimeExt ?? defaultRuntimeExt();
  const mode = options.mode ?? defaultMode(runtimeExt);
  const existsSync = options.existsSync ?? fs.existsSync;

  if (mode === 'package') {
    const requireResolve = options.requireResolve ?? require.resolve;
    const resolvedPath = requireResolve(spec.packageBinSpecifier);
    return {
      command: 'node',
      args: [resolvedPath],
      mode,
      resolvedPath,
      triedPaths: [spec.packageBinSpecifier],
    };
  }

  const projectRoot = options.projectRoot ?? defaultProjectRoot();
  const basePath = path.join(projectRoot, 'packages', 'mcp-servers', spec.dir, spec.basename);
  const preferredPath = `${basePath}${runtimeExt}`;
  const fallbackExt = runtimeExt === '.ts' ? '.js' : '.ts';
  const fallbackPath = `${basePath}${fallbackExt}`;
  const triedPaths = [preferredPath, fallbackPath];

  if (existsSync(preferredPath)) {
    return {
      command: 'npx',
      args: ['tsx', preferredPath],
      mode,
      resolvedPath: preferredPath,
      triedPaths,
    };
  }

  if (existsSync(fallbackPath)) {
    return {
      command: 'npx',
      args: ['tsx', fallbackPath],
      mode,
      resolvedPath: fallbackPath,
      triedPaths,
    };
  }

  throw new Error(`Internal MCP server not found for ${serverName}. Tried: ${triedPaths.join(', ')}`);
}
