#!/usr/bin/env node

import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { BaseMcpServer } from '../_shared/base-mcp-server.js';
import { ConfigCache } from '../_shared/config-cache.js';
import type { ToolDefinition, ToolResult } from '../_shared/base-mcp-server.js';

// ── Constants ─────────────────────────────────────────────

const MAX_ROWS = 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1MB
const QUERY_TIMEOUT_MS = 60000;
const SSH_TUNNEL_TIMEOUT_MS = 10000;
const SSH_TUNNEL_WAIT_MS = 1500;

// ── Config Types ───────────────────────────────────────────

interface MySQLConfig {
  type: 'mysql';
  host: string;
  port: number;
  user: string;
  password: string;
}

interface RedisConfig {
  type: 'redis';
  host: string;
  port: number;
  password?: string;
  db?: number;
}

interface MongoDBConfig {
  type: 'mongodb';
  host: string;
  port: number;
  user?: string;
  password?: string;
  authSource?: string;
  database?: string;
}

interface ClickHouseConfig {
  type: 'clickhouse';
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
}

type DatabaseConfig = MySQLConfig | RedisConfig | MongoDBConfig | ClickHouseConfig;

interface ServerConfig {
  ssh: { host: string };
  databases?: Record<string, DatabaseConfig>;
}

type ServerToolsConfig = Record<string, ServerConfig>;

// ── Config Loading (via ConfigCache) ───────────────────────

const configCache = new ConfigCache<ServerToolsConfig>({}, {
  section: 'server-tools',
  loader: (raw: any) => {
    if (raw && typeof raw === 'object') {
      // Exclude "permission" reserved key — it's tool-level permission config, not a server entry
      const { permission, ...servers } = raw;
      return servers as ServerToolsConfig;
    }
    return {} as ServerToolsConfig; // Section removed/invalid → clear config
  },
});

export function loadConfig(): ServerToolsConfig {
  return configCache.get();
}

export function resetConfigCache(): void {
  configCache.reset();
}

// ── Response Helpers ──────────────────────────────────────

interface QueryResponse {
  backend: 'mysql' | 'redis' | 'mongodb' | 'clickhouse';
  data: unknown;
  rowCount: number;
  truncated: boolean;
}

function buildToolResult(response: QueryResponse): ToolResult {
  let text = JSON.stringify(response);
  let truncated = response.truncated;

  if (Buffer.byteLength(text, 'utf-8') > MAX_RESPONSE_BYTES) {
    truncated = true;
    // Re-serialize with truncation note
    text = JSON.stringify({ ...response, truncated, note: 'Response truncated due to size limit (1MB)' });
    if (Buffer.byteLength(text, 'utf-8') > MAX_RESPONSE_BYTES) {
      text = JSON.stringify({ backend: response.backend, truncated: true, rowCount: response.rowCount, error: 'Response too large even after truncation' });
    }
  }

  return { content: [{ type: 'text' as const, text }] };
}

// ── SSH Tunnel Helper ─────────────────────────────────────

async function withSshTunnel<T>(
  sshHost: string,
  remoteHost: string,
  remotePort: number,
  fn: (localPort: number) => Promise<T>,
): Promise<T> {
  const localPort = Math.floor(Math.random() * 16000) + 49152;
  let sshTunnel: ChildProcess | null = null;

  try {
    sshTunnel = spawn(
      'ssh',
      ['-L', `${localPort}:${remoteHost}:${remotePort}`, sshHost, '-N'],
      { stdio: 'pipe' },
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('SSH tunnel timeout')); }, SSH_TUNNEL_TIMEOUT_MS);

      sshTunnel!.stderr!.on('data', () => {});

      setTimeout(() => { clearTimeout(timeout); resolve(); }, SSH_TUNNEL_WAIT_MS);

      sshTunnel!.on('error', (err) => { clearTimeout(timeout); reject(err); });
      sshTunnel!.on('exit', (code) => {
        if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`SSH tunnel exited with code ${code}`)); }
      });
    });

    return await fn(localPort);
  } finally {
    if (sshTunnel) { sshTunnel.kill(); }
  }
}

// ── Server/DB Config Resolution ───────────────────────────

function resolveServerAndDb(server: string, database: string): { sshHost: string; dbConfig: DatabaseConfig } {
  const config = loadConfig();

  if (!config[server]) {
    throw new Error(`Unknown server: ${server}`);
  }

  if (!config[server].databases?.[database]) {
    throw new Error(`Unknown database: ${database} on server ${server}`);
  }

  return {
    sshHost: config[server].ssh.host,
    dbConfig: config[server].databases![database],
  };
}

function assertDbType<T extends DatabaseConfig>(dbConfig: DatabaseConfig, expectedType: T['type'], database: string): asserts dbConfig is T {
  if (dbConfig.type !== expectedType) {
    throw new Error(`Database "${database}" is type "${dbConfig.type}", not "${expectedType}"`);
  }
}

// ── MySQL SQL Validation ──────────────────────────────────

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

// ── ClickHouse SQL Validation ─────────────────────────────

const CH_DANGEROUS_TABLE_FUNCTIONS = /\b(url|s3|file|remote|remoteSecure|cluster|clusterAllReplicas|mysql|postgresql|jdbc|hdfs|input|generateRandom|numbers|zeros)\s*\(/i;
const CH_DANGEROUS_STATEMENTS = /\b(SYSTEM|KILL|ATTACH|DETACH|OPTIMIZE|RENAME|GRANT|REVOKE|CREATE|DROP|ALTER|INSERT|DELETE|UPDATE|TRUNCATE|SET|USE)\b/i;
const CH_FORMAT_TO_FILE = /\bINTO\s+OUTFILE\b/i;

export function validateClickHouseQuery(query: string): boolean {
  const trimmed = query.trim();

  if (/\/\*!/.test(trimmed)) return false;

  const stripped = trimmed.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  const firstWord = stripped.split(/\s+/)[0]?.toUpperCase();
  const ALLOWED = ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'EXISTS', 'DESC'];
  if (!ALLOWED.includes(firstWord || '')) return false;

  const withoutStrings = stripped.replace(/'[^']*'/g, '');
  if (/;/.test(withoutStrings)) return false;

  if (CH_DANGEROUS_TABLE_FUNCTIONS.test(stripped)) return false;
  if (CH_FORMAT_TO_FILE.test(stripped)) return false;

  // Check for dangerous statements embedded (e.g., in subqueries)
  const upperStripped = stripped.toUpperCase();
  if (/\b(SYSTEM|KILL|ATTACH|DETACH|OPTIMIZE|RENAME|GRANT|REVOKE)\b/.test(upperStripped)) return false;

  // Block SETTINGS clause (could override readonly)
  if (/\bSETTINGS\b/i.test(withoutStrings)) return false;

  return true;
}

// ── Redis Command Validation ──────────────────────────────

const REDIS_READ_COMMANDS = new Set([
  'GET', 'MGET', 'HGET', 'HGETALL', 'HMGET', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS',
  'LRANGE', 'LLEN', 'LINDEX',
  'SMEMBERS', 'SCARD', 'SISMEMBER', 'SRANDMEMBER',
  'ZRANGE', 'ZRANGEBYSCORE', 'ZRANGEBYLEX', 'ZREVRANGE', 'ZCARD', 'ZSCORE', 'ZCOUNT', 'ZRANK',
  'SCAN', 'HSCAN', 'SSCAN', 'ZSCAN',
  'TYPE', 'TTL', 'PTTL', 'EXISTS', 'STRLEN', 'DBSIZE',
  'INFO', 'PING', 'ECHO', 'TIME',
  'OBJECT', 'MEMORY',
  'XLEN', 'XRANGE', 'XREVRANGE', 'XINFO',
  'GEORADIUS', 'GEODIST', 'GEOPOS', 'GEOHASH', 'GEOMEMBERS', 'GEOSEARCH',
  'PFCOUNT',
  'BITCOUNT', 'BITPOS', 'GETBIT',
]);

const SCAN_MAX_COUNT = 100;

export function validateRedisCommand(command: string, args: string[]): void {
  const upperCmd = command.toUpperCase();

  if (!REDIS_READ_COMMANDS.has(upperCmd)) {
    throw new Error(`Redis command "${command}" is not allowed. Only read-only commands are permitted.`);
  }

  // Cap SCAN count to prevent excessive iteration
  if (['SCAN', 'HSCAN', 'SSCAN', 'ZSCAN'].includes(upperCmd)) {
    const countIdx = args.findIndex((a) => a.toUpperCase() === 'COUNT');
    if (countIdx !== -1) {
      const countVal = parseInt(args[countIdx + 1], 10);
      if (isNaN(countVal) || countVal > SCAN_MAX_COUNT) {
        throw new Error(`SCAN COUNT must be <= ${SCAN_MAX_COUNT}`);
      }
    }
  }
}

// ── MongoDB Query Validation ──────────────────────────────

const MONGO_ALLOWED_OPERATIONS = new Set([
  'find', 'aggregate', 'countDocuments', 'estimatedDocumentCount',
  'distinct', 'listCollections', 'listIndexes',
]);

const MONGO_BLOCKED_OPERATORS = /\$(where|function|accumulator|out|merge|lookup\b.*\bpipelineFrom)/;

export function validateMongoOperation(operation: string): void {
  if (!MONGO_ALLOWED_OPERATIONS.has(operation)) {
    throw new Error(`MongoDB operation "${operation}" is not allowed. Allowed: ${[...MONGO_ALLOWED_OPERATIONS].join(', ')}`);
  }
}

export function validateMongoQuery(obj: unknown, path = ''): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    obj.forEach((item, i) => validateMongoQuery(item, `${path}[${i}]`));
    return;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (MONGO_BLOCKED_OPERATORS.test(key)) {
      throw new Error(`MongoDB operator "${key}" is blocked for security (at ${path}.${key})`);
    }
    validateMongoQuery(value, `${path}.${key}`);
  }
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
    databases: srv.databases
      ? Object.entries(srv.databases).map(([dbName, dbCfg]) => ({ name: dbName, type: dbCfg.type }))
      : [],
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

// ── MySQL Handler ─────────────────────────────────────────

export async function handleDbQuery(args: Record<string, unknown>) {
  const server = args.server as string;
  const database = args.database as string;
  const query = args.query as string;

  const { sshHost, dbConfig } = resolveServerAndDb(server, database);
  assertDbType<MySQLConfig>(dbConfig, 'mysql', database);

  if (!validateReadOnlyQuery(query)) {
    throw new Error('Only read-only queries are allowed (SELECT, SHOW, DESCRIBE, EXPLAIN, DESC)');
  }

  return withSshTunnel(sshHost, dbConfig.host, dbConfig.port, async (localPort) => {
    let connection: any = null;
    try {
      const mysql2 = await import('mysql2/promise');
      connection = await mysql2.createConnection({
        host: '127.0.0.1', port: localPort,
        user: dbConfig.user, password: dbConfig.password,
        database, connectTimeout: 10000,
        multipleStatements: false,
      });

      const [rows, fields] = await connection.query({ sql: query, timeout: QUERY_TIMEOUT_MS });

      const columns = (fields as any[])?.map((f: any) => f.name) || [];
      const rowArray = Array.isArray(rows) ? rows : [];
      const truncated = rowArray.length > MAX_ROWS;
      const limitedRows = truncated ? rowArray.slice(0, MAX_ROWS) : rowArray;

      return buildToolResult({
        backend: 'mysql',
        data: { columns, rows: limitedRows },
        rowCount: limitedRows.length,
        truncated,
      });
    } finally {
      if (connection) { try { await connection.end(); } catch { /* ignore */ } }
    }
  });
}

// ── Redis Handler ─────────────────────────────────────────

export async function handleRedisQuery(args: Record<string, unknown>) {
  const server = args.server as string;
  const database = args.database as string;
  const command = args.command as string;
  const commandArgs = (args.args as string[]) ?? [];

  if (!command || typeof command !== 'string') {
    throw new Error('Redis command is required');
  }
  if (!Array.isArray(commandArgs) || commandArgs.some((a) => typeof a !== 'string')) {
    throw new Error('Redis args must be an array of strings');
  }

  const { sshHost, dbConfig } = resolveServerAndDb(server, database);
  assertDbType<RedisConfig>(dbConfig, 'redis', database);

  validateRedisCommand(command, commandArgs);

  return withSshTunnel(sshHost, dbConfig.host, dbConfig.port, async (localPort) => {
    const Redis = (await import('ioredis')).default;
    const client = new Redis({
      host: '127.0.0.1',
      port: localPort,
      password: dbConfig.password || undefined,
      db: dbConfig.db ?? 0,
      connectTimeout: 10000,
      commandTimeout: QUERY_TIMEOUT_MS,
      lazyConnect: true,
    });

    try {
      await client.connect();
      const result = await (client as any).call(command.toUpperCase(), ...commandArgs);

      const data = result;
      const isArray = Array.isArray(result);
      const rowCount = isArray ? result.length : (result !== null && result !== undefined ? 1 : 0);
      const truncated = isArray && result.length > MAX_ROWS;

      return buildToolResult({
        backend: 'redis',
        data: truncated ? (result as any[]).slice(0, MAX_ROWS) : data,
        rowCount: truncated ? MAX_ROWS : rowCount,
        truncated,
      });
    } finally {
      try { client.disconnect(); } catch { /* ignore */ }
    }
  });
}

// ── MongoDB Handler ───────────────────────────────────────

export async function handleMongoDBQuery(args: Record<string, unknown>) {
  const server = args.server as string;
  const database = args.database as string;
  const collection = args.collection as string;
  const operation = args.operation as string;
  const filter = (args.filter as Record<string, unknown>) ?? {};
  const pipeline = args.pipeline as unknown[] | undefined;
  const options = (args.options as Record<string, unknown>) ?? {};

  if (!operation || typeof operation !== 'string') {
    throw new Error('MongoDB operation is required');
  }

  const { sshHost, dbConfig } = resolveServerAndDb(server, database);
  assertDbType<MongoDBConfig>(dbConfig, 'mongodb', database);

  validateMongoOperation(operation);
  validateMongoQuery(filter);
  if (pipeline) validateMongoQuery(pipeline);

  const dbName = dbConfig.database || database;

  return withSshTunnel(sshHost, dbConfig.host, dbConfig.port, async (localPort) => {
    const { MongoClient } = await import('mongodb');

    let authPart = '';
    if (dbConfig.user && dbConfig.password) {
      authPart = `${encodeURIComponent(dbConfig.user)}:${encodeURIComponent(dbConfig.password)}@`;
    }
    const authSource = dbConfig.authSource || 'admin';
    const uri = `mongodb://${authPart}127.0.0.1:${localPort}/${dbName}?authSource=${authSource}&connectTimeoutMS=10000&serverSelectionTimeoutMS=10000`;

    const client = new MongoClient(uri);

    try {
      await client.connect();
      const db = client.db(dbName);

      let result: unknown;
      let rowCount = 0;
      let truncated = false;

      switch (operation) {
        case 'find': {
          const limit = Math.min(Number(options.limit) || MAX_ROWS, MAX_ROWS);
          const docs = await db.collection(collection)
            .find(filter, { maxTimeMS: QUERY_TIMEOUT_MS, allowDiskUse: false } as any)
            .sort((options.sort as any) || {})
            .project((options.projection as any) || {})
            .limit(limit)
            .toArray();
          result = docs;
          rowCount = docs.length;
          truncated = docs.length >= limit && limit === MAX_ROWS;
          break;
        }
        case 'aggregate': {
          if (!Array.isArray(pipeline)) {
            throw new Error('pipeline is required for aggregate operation');
          }
          // Inject $limit if not present at end
          const hasLimit = pipeline.some((s: any) => '$limit' in s);
          const safePipeline = hasLimit ? pipeline : [...pipeline, { $limit: MAX_ROWS }];
          const docs = await db.collection(collection)
            .aggregate(safePipeline, { maxTimeMS: QUERY_TIMEOUT_MS, allowDiskUse: false })
            .toArray();
          result = docs;
          rowCount = docs.length;
          truncated = docs.length >= MAX_ROWS;
          break;
        }
        case 'countDocuments': {
          const count = await db.collection(collection).countDocuments(filter, { maxTimeMS: QUERY_TIMEOUT_MS });
          result = { count };
          rowCount = 1;
          break;
        }
        case 'estimatedDocumentCount': {
          const count = await db.collection(collection).estimatedDocumentCount({ maxTimeMS: QUERY_TIMEOUT_MS });
          result = { count };
          rowCount = 1;
          break;
        }
        case 'distinct': {
          const field = options.field as string;
          if (!field) throw new Error('options.field is required for distinct operation');
          const values = await db.collection(collection).distinct(field, filter);
          result = values;
          rowCount = values.length;
          truncated = values.length > MAX_ROWS;
          if (truncated) result = values.slice(0, MAX_ROWS);
          break;
        }
        case 'listCollections': {
          const collections = await db.listCollections().toArray();
          result = collections;
          rowCount = collections.length;
          break;
        }
        case 'listIndexes': {
          const indexes = await db.collection(collection).listIndexes().toArray();
          result = indexes;
          rowCount = indexes.length;
          break;
        }
        default:
          throw new Error(`Unhandled operation: ${operation}`);
      }

      return buildToolResult({
        backend: 'mongodb',
        data: result,
        rowCount,
        truncated,
      });
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
  });
}

// ── ClickHouse Handler ────────────────────────────────────

export async function handleClickHouseQuery(args: Record<string, unknown>) {
  const server = args.server as string;
  const database = args.database as string;
  const query = args.query as string;

  const { sshHost, dbConfig } = resolveServerAndDb(server, database);
  assertDbType<ClickHouseConfig>(dbConfig, 'clickhouse', database);

  if (!validateClickHouseQuery(query)) {
    throw new Error('Only read-only queries are allowed (SELECT, SHOW, DESCRIBE, EXPLAIN, EXISTS)');
  }

  const chDatabase = dbConfig.database || database;

  return withSshTunnel(sshHost, dbConfig.host, dbConfig.port, async (localPort) => {
    const { createClient } = await import('@clickhouse/client');
    const client = createClient({
      url: `http://127.0.0.1:${localPort}`,
      username: dbConfig.user,
      password: dbConfig.password,
      database: chDatabase,
      request_timeout: QUERY_TIMEOUT_MS,
      clickhouse_settings: {
        readonly: 1,
        max_result_rows: String(MAX_ROWS),
        max_result_bytes: String(MAX_RESPONSE_BYTES),
      } as any,
    });

    try {
      const resultSet = await client.query({ query, format: 'JSONEachRow' });
      const rows = await resultSet.json() as any[];

      const truncated = rows.length >= MAX_ROWS;
      const limitedRows = truncated ? rows.slice(0, MAX_ROWS) : rows;
      const columns = limitedRows.length > 0 ? Object.keys(limitedRows[0]) : [];

      return buildToolResult({
        backend: 'clickhouse',
        data: { columns, rows: limitedRows },
        rowCount: limitedRows.length,
        truncated,
      });
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
  });
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
        description: 'List all configured servers with their SSH hosts and available databases (including type: mysql/redis/mongodb/clickhouse).',
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
        description: 'Execute a read-only SQL query on a MySQL database via SSH tunnel. Only SELECT, SHOW, DESCRIBE, EXPLAIN, DESC are allowed.',
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Server name from config.' },
            database: { type: 'string', description: 'Database name from config (must be type: mysql).' },
            query: { type: 'string', description: 'SQL query to execute (read-only).' },
          },
          required: ['server', 'database', 'query'],
        },
      },
      {
        name: 'redis_query',
        description: 'Execute a read-only Redis command via SSH tunnel. Only read commands are allowed (GET, HGETALL, LRANGE, SCAN, INFO, etc.).',
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Server name from config.' },
            database: { type: 'string', description: 'Database name from config (must be type: redis).' },
            command: { type: 'string', description: 'Redis command (e.g., GET, HGETALL, SCAN).' },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'Command arguments as array of strings (e.g., ["mykey"] for GET mykey).',
            },
          },
          required: ['server', 'database', 'command'],
        },
      },
      {
        name: 'mongodb_query',
        description: 'Execute a read-only MongoDB query via SSH tunnel. Supported operations: find, aggregate, countDocuments, distinct, listCollections, listIndexes.',
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Server name from config.' },
            database: { type: 'string', description: 'Database name from config (must be type: mongodb).' },
            collection: { type: 'string', description: 'Collection name.' },
            operation: { type: 'string', description: 'Operation: find, aggregate, countDocuments, estimatedDocumentCount, distinct, listCollections, listIndexes.' },
            filter: { type: 'object', description: 'Query filter (for find, countDocuments, distinct).' },
            pipeline: { type: 'array', description: 'Aggregation pipeline stages (for aggregate).' },
            options: {
              type: 'object',
              description: 'Query options: { limit?: number, sort?: object, projection?: object, field?: string (for distinct) }.',
            },
          },
          required: ['server', 'database', 'operation'],
        },
      },
      {
        name: 'clickhouse_query',
        description: 'Execute a read-only SQL query on a ClickHouse database via SSH tunnel. Only SELECT, SHOW, DESCRIBE, EXPLAIN, EXISTS are allowed.',
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Server name from config.' },
            database: { type: 'string', description: 'Database name from config (must be type: clickhouse).' },
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
      case 'redis_query':
        return await handleRedisQuery(args);
      case 'mongodb_query':
        return await handleMongoDBQuery(args);
      case 'clickhouse_query':
        return await handleClickHouseQuery(args);
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
