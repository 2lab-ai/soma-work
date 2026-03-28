#!/usr/bin/env node

import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { BaseMcpServer } from '../_shared/base-mcp-server.js';
import { ConfigCache } from '../_shared/config-cache.js';
import type { ToolDefinition, ToolResult } from '../_shared/base-mcp-server.js';

// ── Config Types ───────────────────────────────────────────

interface DatabaseConfig {
  type: 'mysql';
  host: string;
  port: number;
  user: string;
  password: string;
}

interface ServerConfig {
  ssh: { host: string };
  databases?: Record<string, DatabaseConfig>;
}

type ServerToolsConfig = Record<string, ServerConfig>;

// ── Config Loading (via ConfigCache) ───────────────────────

const configCache = new ConfigCache<ServerToolsConfig>({}, {
  section: 'server-tools',
  loader: (raw: any) => {
    if (raw && typeof raw === 'object') return raw as ServerToolsConfig;
    return {} as ServerToolsConfig; // Section removed/invalid → clear config
  },
});

export function loadConfig(): ServerToolsConfig {
  return configCache.get();
}

export function resetConfigCache(): void {
  configCache.reset();
}

// ── SQL Validation ─────────────────────────────────────────

const DANGEROUS_FUNCTIONS = /\b(SLEEP|BENCHMARK|LOAD_FILE|GET_LOCK|RELEASE_LOCK|IS_FREE_LOCK|IS_USED_LOCK)\s*\(/i;
const LOCKING_CLAUSES = /\bFOR\s+UPDATE\b|\bLOCK\s+IN\s+SHARE\s+MODE\b|\bFOR\s+SHARE\b/i;
const INTO_VARIABLE = /\bINTO\s+@/i;
const INTO_FILE_ORIGINAL = /\bINTO\s*(?:\/\*[\s\S]*?\*\/\s*)*\s*(OUTFILE|DUMPFILE)\b/i;

export function validateReadOnlyQuery(query: string): boolean {
  const trimmed = query.trim();

  if (/\/\*!/.test(trimmed)) return false;
  if (INTO_FILE_ORIGINAL.test(trimmed)) return false;

  const stripped = trimmed.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  const firstWord = stripped.split(/\s+/)[0]?.toUpperCase();
  const ALLOWED = ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'DESC'];
  if (!ALLOWED.includes(firstWord || '')) return false;

  const withoutStrings = stripped.replace(/'[^']*'/g, '');
  if (/;/.test(withoutStrings)) return false;

  if (DANGEROUS_FUNCTIONS.test(stripped)) return false;
  if (LOCKING_CLAUSES.test(stripped)) return false;
  if (INTO_VARIABLE.test(stripped)) return false;

  return true;
}

// ── Input Sanitization ────────────────────────────────────

const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$|^\d+[smhd]$/;

export function validateDockerName(value: string, field: string): void {
  if (!DOCKER_NAME_RE.test(value)) {
    throw new Error(`Invalid ${field} name: must match ${DOCKER_NAME_RE.source}`);
  }
}

export function validateTimestamp(value: string, field: string): void {
  if (!TIMESTAMP_RE.test(value)) {
    throw new Error(`Invalid ${field}: must be ISO 8601 datetime or duration (e.g., 10m, 1h, 2024-01-01T00:00:00)`);
  }
}

// ── Tool Handlers ──────────────────────────────────────────

export function handleList() {
  const config = loadConfig();
  const servers = Object.entries(config).map(([name, srv]) => ({
    name,
    ssh_host: srv.ssh.host,
    databases: srv.databases ? Object.keys(srv.databases) : [],
  }));
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ servers }) }],
  };
}

export function handleListService(args: Record<string, unknown>) {
  const server = args.server as string;
  const config = loadConfig();

  if (!config[server]) {
    throw new Error(`Unknown server: ${server}`);
  }

  const sshHost = config[server].ssh.host;
  const output = execFileSync(
    'ssh',
    [sshHost, 'docker', 'ps', '--format', 'json'],
    { timeout: 30000, encoding: 'utf-8' },
  );

  const containers = output
    .trim()
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(containers) }],
  };
}

export function handleLogs(args: Record<string, unknown>) {
  const server = args.server as string;
  const service = args.service as string;
  const tail = (args.tail as number) ?? 100;
  if (!Number.isInteger(tail) || tail < 0 || tail > 10000) {
    throw new Error('Invalid tail: must be an integer between 0 and 10000');
  }
  const since = args.since as string | undefined;
  const until = args.until as string | undefined;
  const timestamps = args.timestamps as boolean | undefined;

  const config = loadConfig();

  if (!config[server]) {
    throw new Error(`Unknown server: ${server}`);
  }

  validateDockerName(service, 'service');
  if (since) validateTimestamp(since, 'since');
  if (until) validateTimestamp(until, 'until');

  const sshHost = config[server].ssh.host;
  const sshArgs = [sshHost, 'docker', 'logs', '--tail', String(tail)];

  if (since) sshArgs.push('--since', since);
  if (until) sshArgs.push('--until', until);
  if (timestamps) sshArgs.push('--timestamps');

  sshArgs.push(service);

  const output = execFileSync('ssh', sshArgs, {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf-8',
  });

  return {
    content: [{ type: 'text' as const, text: output }],
  };
}

export async function handleDbQuery(args: Record<string, unknown>) {
  const server = args.server as string;
  const database = args.database as string;
  const query = args.query as string;

  const config = loadConfig();

  if (!config[server]) {
    throw new Error(`Unknown server: ${server}`);
  }

  if (!config[server].databases?.[database]) {
    throw new Error(`Unknown database: ${database} on server ${server}`);
  }

  if (!validateReadOnlyQuery(query)) {
    throw new Error('Only read-only queries are allowed (SELECT, SHOW, DESCRIBE, EXPLAIN, DESC)');
  }

  const dbConfig = config[server].databases![database];
  const sshHost = config[server].ssh.host;
  const localPort = Math.floor(Math.random() * 16000) + 49152;

  let sshTunnel: ChildProcess | null = null;
  let connection: any = null;

  try {
    sshTunnel = spawn(
      'ssh',
      ['-L', `${localPort}:${dbConfig.host}:${dbConfig.port}`, sshHost, '-N'],
      { stdio: 'pipe' },
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('SSH tunnel timeout')); }, 10000);

      sshTunnel!.stderr!.on('data', () => {});

      setTimeout(() => { clearTimeout(timeout); resolve(); }, 1500);

      sshTunnel!.on('error', (err) => { clearTimeout(timeout); reject(err); });
      sshTunnel!.on('exit', (code) => {
        if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`SSH tunnel exited with code ${code}`)); }
      });
    });

    const mysql2 = await import('mysql2/promise');
    connection = await mysql2.createConnection({
      host: '127.0.0.1', port: localPort,
      user: dbConfig.user, password: dbConfig.password,
      database, connectTimeout: 10000,
    });

    const [rows, fields] = await connection.query({ sql: query, timeout: 60000 });

    const columns = (fields as any[])?.map((f: any) => f.name) || [];
    const rowArray = Array.isArray(rows) ? rows : [];

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ columns, rows: rowArray, rowCount: rowArray.length }),
      }],
    };
  } finally {
    if (connection) { try { await connection.end(); } catch { /* ignore */ } }
    if (sshTunnel) { sshTunnel.kill(); }
  }
}

// ── MCP Server ─────────────────────────────────────────────

class ServerToolsMCPServer extends BaseMcpServer {
  constructor() {
    super('server-tools-mcp-server');
  }

  defineTools(): ToolDefinition[] {
    return [
      {
        name: 'list',
        description: 'List all configured servers with their SSH hosts and available databases.',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'list_service',
        description: 'List running Docker containers on a server via SSH.',
        inputSchema: {
          type: 'object',
          properties: { server: { type: 'string', description: 'Server name from config.' } },
          required: ['server'],
        },
      },
      {
        name: 'logs',
        description: 'Fetch Docker container logs from a server via SSH.',
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Server name from config.' },
            service: { type: 'string', description: 'Docker container/service name.' },
            tail: { type: 'number', description: 'Number of lines to tail (default: 100).' },
            since: { type: 'string', description: 'Show logs since timestamp (e.g., "2024-01-01T00:00:00").' },
            until: { type: 'string', description: 'Show logs until timestamp.' },
            timestamps: { type: 'boolean', description: 'Show timestamps in log output.' },
          },
          required: ['server', 'service'],
        },
      },
      {
        name: 'db_query',
        description: 'Execute a read-only SQL query on a database via SSH tunnel. Only SELECT, SHOW, DESCRIBE, EXPLAIN, DESC are allowed.',
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Server name from config.' },
            database: { type: 'string', description: 'Database name from config.' },
            query: { type: 'string', description: 'SQL query to execute (read-only).' },
          },
          required: ['server', 'database', 'query'],
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'list':
        return handleList();
      case 'list_service':
        return handleListService(args);
      case 'logs':
        return handleLogs(args);
      case 'db_query':
        return await handleDbQuery(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}

const serverInstance = new ServerToolsMCPServer();
serverInstance.run().catch((error) => {
  console.error('Failed to start Server Tools MCP Server', error);
  process.exit(1);
});
