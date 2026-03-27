#!/usr/bin/env node

import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StderrLogger } from '../_shared/stderr-logger.js';

const logger = new StderrLogger('ServerToolsMCP');

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

// ── Config Loading (mtime-based caching) ───────────────────

let cachedConfig: ServerToolsConfig = {};
let cachedMtimeMs = 0;
let cachedSize = 0;

export function loadConfig(): ServerToolsConfig {
  const CONFIG_FILE = process.env.SOMA_CONFIG_FILE || '';
  if (!CONFIG_FILE) return cachedConfig;

  try {
    const stat = fs.statSync(CONFIG_FILE);
    if (stat.mtimeMs === cachedMtimeMs && stat.size === cachedSize) {
      return cachedConfig;
    }

    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const section = raw?.['server-tools'];

    if (section && typeof section === 'object') {
      cachedConfig = section as ServerToolsConfig;
      logger.info('Reloaded server-tools config from config.json', {
        servers: Object.keys(cachedConfig),
      });
    } else {
      cachedConfig = {};
    }

    cachedMtimeMs = stat.mtimeMs;
    cachedSize = stat.size;
  } catch {
    // File doesn't exist or is invalid — keep current cache
  }

  return cachedConfig;
}

// Reset cache — exported for testing
export function resetConfigCache(): void {
  cachedConfig = {};
  cachedMtimeMs = 0;
  cachedSize = 0;
}

// Initial load
loadConfig();

// ── SQL Validation ─────────────────────────────────────────

/** Dangerous MySQL functions that should never appear in read-only queries */
const DANGEROUS_FUNCTIONS = /\b(SLEEP|BENCHMARK|LOAD_FILE|GET_LOCK|RELEASE_LOCK|IS_FREE_LOCK|IS_USED_LOCK)\s*\(/i;

/** Locking clauses that turn SELECTs into write-intent operations */
const LOCKING_CLAUSES = /\bFOR\s+UPDATE\b|\bLOCK\s+IN\s+SHARE\s+MODE\b|\bFOR\s+SHARE\b/i;

/** INTO @variable (information leak / side-effect path) — but allow INTO OUTFILE/DUMPFILE which is caught separately */
const INTO_VARIABLE = /\bINTO\s+@/i;

/** INTO OUTFILE/DUMPFILE — checked on ORIGINAL query (comment-tolerant) */
const INTO_FILE_ORIGINAL = /\bINTO\s*(?:\/\*[\s\S]*?\*\/\s*)*\s*(OUTFILE|DUMPFILE)\b/i;

export function validateReadOnlyQuery(query: string): boolean {
  const trimmed = query.trim();

  // Block MySQL executable comments (/*!nnnnn ... */) — MySQL executes content inside
  if (/\/\*!/.test(trimmed)) return false;

  // Check INTO OUTFILE/DUMPFILE on ORIGINAL query (before comment stripping)
  // This prevents comment token glue bypass: INTO/**/OUTFILE
  if (INTO_FILE_ORIGINAL.test(trimmed)) return false;

  // Now strip normal block comments for remaining checks
  const stripped = trimmed.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  const firstWord = stripped.split(/\s+/)[0]?.toUpperCase();
  const ALLOWED = ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'DESC'];
  if (!ALLOWED.includes(firstWord || '')) return false;

  // Block semicolons outside string literals
  const withoutStrings = stripped.replace(/'[^']*'/g, '');
  if (/;/.test(withoutStrings)) return false;

  // Block dangerous functions
  if (DANGEROUS_FUNCTIONS.test(stripped)) return false;

  // Block locking clauses
  if (LOCKING_CLAUSES.test(stripped)) return false;

  // Block INTO @variable
  if (INTO_VARIABLE.test(stripped)) return false;

  return true;
}

// ── Input Sanitization ────────────────────────────────────

/** Docker container/service names: alphanumeric, dots, hyphens, underscores */
const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** Docker timestamp args: ISO 8601 datetime or relative duration (e.g., 10m, 1h) */
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

  // Validate user-controlled args before passing to SSH
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
    // Open SSH tunnel
    sshTunnel = spawn(
      'ssh',
      ['-L', `${localPort}:${dbConfig.host}:${dbConfig.port}`, sshHost, '-N'],
      { stdio: 'pipe' },
    );

    // Wait for tunnel to establish
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('SSH tunnel timeout'));
      }, 10000);

      sshTunnel!.stderr!.on('data', () => {
        // SSH tunnel is ready when stderr outputs something or after a short delay
      });

      // Give the tunnel a moment to establish
      setTimeout(() => {
        clearTimeout(timeout);
        resolve();
      }, 1500);

      sshTunnel!.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      sshTunnel!.on('exit', (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`SSH tunnel exited with code ${code}`));
        }
      });
    });

    // Connect to MySQL through the tunnel
    const mysql2 = await import('mysql2/promise');
    connection = await mysql2.createConnection({
      host: '127.0.0.1',
      port: localPort,
      user: dbConfig.user,
      password: dbConfig.password,
      database,
      connectTimeout: 10000,
    });

    // Execute the query with timeout
    const [rows, fields] = await connection.query({ sql: query, timeout: 60000 });

    const columns = (fields as any[])?.map((f: any) => f.name) || [];
    const rowArray = Array.isArray(rows) ? rows : [];

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            columns,
            rows: rowArray,
            rowCount: rowArray.length,
          }),
        },
      ],
    };
  } finally {
    // Cleanup
    if (connection) {
      try {
        await connection.end();
      } catch {
        /* ignore */
      }
    }
    if (sshTunnel) {
      sshTunnel.kill();
    }
  }
}

// ── MCP Server ─────────────────────────────────────────────

class ServerToolsMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      { name: 'server-tools-mcp-server', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list',
          description: 'List all configured servers with their SSH hosts and available databases.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'list_service',
          description: 'List running Docker containers on a server via SSH.',
          inputSchema: {
            type: 'object',
            properties: {
              server: {
                type: 'string',
                description: 'Server name from config.',
              },
            },
            required: ['server'],
          },
        },
        {
          name: 'logs',
          description: 'Fetch Docker container logs from a server via SSH.',
          inputSchema: {
            type: 'object',
            properties: {
              server: {
                type: 'string',
                description: 'Server name from config.',
              },
              service: {
                type: 'string',
                description: 'Docker container/service name.',
              },
              tail: {
                type: 'number',
                description: 'Number of lines to tail (default: 100).',
              },
              since: {
                type: 'string',
                description: 'Show logs since timestamp (e.g., "2024-01-01T00:00:00").',
              },
              until: {
                type: 'string',
                description: 'Show logs until timestamp.',
              },
              timestamps: {
                type: 'boolean',
                description: 'Show timestamps in log output.',
              },
            },
            required: ['server', 'service'],
          },
        },
        {
          name: 'db_query',
          description:
            'Execute a read-only SQL query on a database via SSH tunnel. Only SELECT, SHOW, DESCRIBE, EXPLAIN, DESC are allowed.',
          inputSchema: {
            type: 'object',
            properties: {
              server: {
                type: 'string',
                description: 'Server name from config.',
              },
              database: {
                type: 'string',
                description: 'Database name from config.',
              },
              query: {
                type: 'string',
                description: 'SQL query to execute (read-only).',
              },
            },
            required: ['server', 'database', 'query'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      logger.debug(`Tool call: ${name}`, args);

      try {
        switch (name) {
          case 'list':
            return handleList();
          case 'list_service':
            return handleListService(args as Record<string, unknown>);
          case 'logs':
            return handleLogs(args as Record<string, unknown>);
          case 'db_query':
            return await handleDbQuery(args as Record<string, unknown>);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Tool ${name} failed`, error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('Server Tools MCP Server started', {
      configFile: process.env.SOMA_CONFIG_FILE || '(not set)',
      servers: Object.keys(cachedConfig),
    });

    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
  }
}

const serverInstance = new ServerToolsMCPServer();
serverInstance.run().catch((error) => {
  logger.error('Failed to start Server Tools MCP Server', error);
  process.exit(1);
});
