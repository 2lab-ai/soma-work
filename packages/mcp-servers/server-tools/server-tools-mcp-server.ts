#!/usr/bin/env node

import { createHash } from 'node:crypto';
import type { ToolDefinition, ToolResult } from '@soma/process-shared/mcp/base-mcp-server.js';
import { BaseMcpServer } from '@soma/process-shared/mcp/base-mcp-server.js';
import { ConfigCache } from '@soma/process-shared/mcp/config-cache.js';
import { isSecretRef, resolveSecretRefs, SecretRefError } from '@soma/process-shared/secret-ref.js';
import { StderrLogger } from '@soma/process-shared/stderr-logger.js';
import { type ChildProcess, execFileSync, type SpawnSyncReturns, spawn, spawnSync } from 'child_process';
import { appendAudit } from './env-audit.js';
import {
  CfError,
  type CfFetch,
  CfOutcomeUnknownError,
  cfCall,
  cfRequest,
  type EnvCloudflareConfig,
} from './env-cloudflare.js';
import {
  allowedRepo,
  approvalProblem,
  approve,
  type EnvGithubConfig,
  type Fetch,
  GithubError,
  headSha,
  merge,
  mergeProblem,
  OutcomeUnknownError,
  prNumber,
  prState,
  repoRead,
} from './env-github.js';
import { defaultLoginFetch, LoginError, type LoginFetch, login, loginSpec } from './env-login.js';
import { redactLogSecrets } from './redact-logs.js';

const configLogger = new StderrLogger('server-tools:config');

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
  /**
   * The environment user this server acts as (env-access WU3, #1211), e.g. `env:acme-dev2`: a non-human user with
   * the environment's own GitHub token and accounts. Its writes are audited under this name.
   */
  envUser?: string;
  ssh: { host: string };
  databases?: Record<string, DatabaseConfig>;
  /** The environment's GitHub token and what it may approve and merge (`gh_pr`). */
  github?: EnvGithubConfig;
  /** The environment's scoped Cloudflare token and zones (`cf_api`, env-access WU6, #1214). */
  cloudflare?: EnvCloudflareConfig;
  /** The environment's web app accounts (`login`, WU3b): url, body (its password a `$secret`), where the session is. */
  web?: { logins?: Record<string, unknown> };
}

type ServerToolsConfig = Record<string, ServerConfig>;

// ── Config Loading (via ConfigCache) ───────────────────────

const configCache = new ConfigCache<ServerToolsConfig>(
  {},
  {
    section: 'server-tools',
    loader: (raw: any) => {
      if (raw && typeof raw === 'object') {
        // Exclude "permission" reserved key — it's tool-level permission config, not a server entry
        const { permission, ...servers } = raw;
        return resolveServerSecrets(servers);
      }
      return {} as ServerToolsConfig; // Section removed/invalid → clear config
    },
  },
);

/**
 * Each server with its `{"$secret": name}` references replaced from the secret store the bot names in
 * `SOMA_SECRETS_DIR` (.prd/25-env-access-architecture.md §2). A server whose reference does not
 * resolve is left out — never run with a missing password — and only its name and the secret's name
 * are logged.
 */
/** True when a `{"$secret": …}` reference sits anywhere in `value` (as `resolveSecretRefs` would resolve it). */
function namesSecret(value: unknown, depth = 0): boolean {
  if (isSecretRef(value)) return true;
  if (depth > 32 || !value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some((v) => namesSecret(v, depth + 1));
}

/**
 * An environment's web logins keep their password in the secret store (WU3b, #1211): a login whose body names no
 * `{"$secret": …}` is left out, so a password written into config.json is never posted.
 */
function withSecretLogins(name: string, server: unknown): unknown {
  const web = (server as { web?: { logins?: unknown } } | null)?.web;
  const logins = web?.logins;
  if (logins === undefined || logins === null) return server;
  if (typeof logins !== 'object' || Array.isArray(logins)) {
    configLogger.warn(`server "${name}": web.logins left out — it must be an object of named logins`);
    return { ...(server as Record<string, unknown>), web: { ...web, logins: {} } };
  }
  const kept: Record<string, unknown> = {};
  for (const [account, spec] of Object.entries(logins as Record<string, unknown>)) {
    const body = (spec as { body?: unknown } | null)?.body;
    if (namesSecret(body)) kept[account] = spec;
    else
      configLogger.warn(`server "${name}": login "${account}" left out — its body must name a {"$secret": "<name>"}`);
  }
  return { ...(server as Record<string, unknown>), web: { ...web, logins: kept } };
}

function resolveServerSecrets(servers: Record<string, unknown>): ServerToolsConfig {
  const out: ServerToolsConfig = {};
  for (const [name, entry] of Object.entries(servers)) {
    let server = entry;
    // An environment's GitHub token lives in the secret store only, never in config.json (WU3, #1211).
    const github = (entry as { github?: { token?: unknown } } | null)?.github;
    if (github && typeof github === 'object' && !isSecretRef(github.token)) {
      configLogger.warn(`server "${name}": github left out — github.token must be {"$secret": "<name>"}`);
      const { github: _dropped, ...rest } = entry as Record<string, unknown>;
      server = rest;
    }
    // The same for its Cloudflare token (WU6, #1214).
    const cloudflare = (server as { cloudflare?: { token?: unknown } } | null)?.cloudflare;
    if (cloudflare && typeof cloudflare === 'object' && !isSecretRef(cloudflare.token)) {
      configLogger.warn(`server "${name}": cloudflare left out — cloudflare.token must be {"$secret": "<name>"}`);
      const { cloudflare: _dropped, ...rest } = server as Record<string, unknown>;
      server = rest;
    }
    server = withSecretLogins(name, server);
    try {
      out[name] = resolveSecretRefs(server, process.env.SOMA_SECRETS_DIR) as ServerConfig;
    } catch (error) {
      if (!(error instanceof SecretRefError)) throw error;
      configLogger.warn(`server "${name}" left out: ${error.message}`);
    }
  }
  return out;
}

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
      text = JSON.stringify({
        backend: response.backend,
        truncated: true,
        rowCount: response.rowCount,
        error: 'Response too large even after truncation',
      });
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
    sshTunnel = spawn('ssh', ['-L', `${localPort}:${remoteHost}:${remotePort}`, sshHost, '-N'], { stdio: 'pipe' });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('SSH tunnel timeout'));
      }, SSH_TUNNEL_TIMEOUT_MS);

      sshTunnel!.stderr!.on('data', () => {});

      setTimeout(() => {
        clearTimeout(timeout);
        resolve();
      }, SSH_TUNNEL_WAIT_MS);

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

    return await fn(localPort);
  } finally {
    if (sshTunnel) {
      sshTunnel.kill();
    }
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

function assertDbType<T extends DatabaseConfig>(
  dbConfig: DatabaseConfig,
  expectedType: T['type'],
  database: string,
): asserts dbConfig is T {
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

const CH_DANGEROUS_TABLE_FUNCTIONS =
  /\b(url|s3|file|remote|remoteSecure|cluster|clusterAllReplicas|mysql|postgresql|jdbc|hdfs|input|generateRandom|numbers|zeros)\s*\(/i;
const CH_DANGEROUS_STATEMENTS =
  /\b(SYSTEM|KILL|ATTACH|DETACH|OPTIMIZE|RENAME|GRANT|REVOKE|CREATE|DROP|ALTER|INSERT|DELETE|UPDATE|TRUNCATE|SET|USE)\b/i;
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
  'GET',
  'MGET',
  'HGET',
  'HGETALL',
  'HMGET',
  'HKEYS',
  'HVALS',
  'HLEN',
  'HEXISTS',
  'LRANGE',
  'LLEN',
  'LINDEX',
  'SMEMBERS',
  'SCARD',
  'SISMEMBER',
  'SRANDMEMBER',
  'ZRANGE',
  'ZRANGEBYSCORE',
  'ZRANGEBYLEX',
  'ZREVRANGE',
  'ZCARD',
  'ZSCORE',
  'ZCOUNT',
  'ZRANK',
  'SCAN',
  'HSCAN',
  'SSCAN',
  'ZSCAN',
  'TYPE',
  'TTL',
  'PTTL',
  'EXISTS',
  'STRLEN',
  'DBSIZE',
  'INFO',
  'PING',
  'ECHO',
  'TIME',
  'OBJECT',
  'MEMORY',
  'XLEN',
  'XRANGE',
  'XREVRANGE',
  'XINFO',
  'GEORADIUS',
  'GEODIST',
  'GEOPOS',
  'GEOHASH',
  'GEOMEMBERS',
  'GEOSEARCH',
  'PFCOUNT',
  'BITCOUNT',
  'BITPOS',
  'GETBIT',
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
  'find',
  'aggregate',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
  'listCollections',
  'listIndexes',
]);

const MONGO_BLOCKED_OPERATORS = /\$(where|function|accumulator|out|merge|lookup\b.*\bpipelineFrom)/;

export function validateMongoOperation(operation: string): void {
  if (!MONGO_ALLOWED_OPERATIONS.has(operation)) {
    throw new Error(
      `MongoDB operation "${operation}" is not allowed. Allowed: ${[...MONGO_ALLOWED_OPERATIONS].join(', ')}`,
    );
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
// A date, a time (fractional seconds only after seconds) with an optional Z or ±HH:MM zone, or a duration.
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$|^\d+[smhd]$/;

export function validateDockerName(value: string, field: string): void {
  if (!DOCKER_NAME_RE.test(value)) {
    throw new Error(`Invalid ${field} name: must match ${DOCKER_NAME_RE.source}`);
  }
}

export function validateTimestamp(value: string, field: string): void {
  if (!TIMESTAMP_RE.test(value)) {
    throw new Error(`Invalid ${field}: must be RFC 3339 datetime or duration (e.g., 10m, 1h, 2026-01-01T00:00:00Z)`);
  }
}

/** A validated since/until as docker reads it: Go's duration parser has no day unit, so `Nd` goes out as hours. */
function toDockerTime(value: string): string {
  const days = /^(\d+)d$/.exec(value);
  // BigInt keeps any digit count exact and digits-only, like the value that passed validation.
  return days ? `${BigInt(days[1]) * 24n}h` : value;
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

const NOT_SWARM_MANAGER_RE = /not a swarm manager/i;

function readStderr(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const v = (err as { stderr?: unknown }).stderr;
    if (typeof v === 'string') return v;
    if (Buffer.isBuffer(v)) return v.toString('utf-8');
  }
  return '';
}

// `cause: err` preserves execFileSync exit code / signal / stderr through the rewrite.
function rethrowAsSwarmError(err: unknown, server: string): never {
  if (NOT_SWARM_MANAGER_RE.test(readStderr(err))) {
    throw new Error(`Server '${server}' is not a Docker Swarm manager`, { cause: err });
  }
  throw err;
}

function parseNdjson(output: string, source: string): unknown[] {
  return output
    .trim()
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        const snippet = line.length > 100 ? `${line.slice(0, 100)}…` : line;
        throw new Error(`Invalid NDJSON from ${source}: ${snippet}`, { cause: e });
      }
    });
}

function runSshDocker(sshHost: string, dockerArgs: string[], server: string): string {
  try {
    return execFileSync('ssh', [sshHost, ...dockerArgs], { timeout: 30000, encoding: 'utf-8' });
  } catch (err) {
    rethrowAsSwarmError(err, server);
  }
}

export function handleListService(args: Record<string, unknown>) {
  const server = args.server as string;
  const stack = args.stack as string | undefined;
  const config = loadConfig();

  if (!config[server]) {
    throw new Error(`Unknown server: ${server}`);
  }

  const sshHost = config[server].ssh.host;

  let dockerArgs: string[];
  let source: string;
  if (stack !== undefined) {
    validateDockerName(stack, 'stack');
    dockerArgs = ['docker', 'stack', 'services', stack, '--format', 'json'];
    source = 'docker stack services';
  } else {
    dockerArgs = ['docker', 'ps', '--format', 'json'];
    source = 'docker ps';
  }

  const output = runSshDocker(sshHost, dockerArgs, server);
  const services = parseNdjson(output, source);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(services) }],
  };
}

export function handleListStack(args: Record<string, unknown>) {
  const server = args.server as string;
  const config = loadConfig();

  if (!config[server]) {
    throw new Error(`Unknown server: ${server}`);
  }

  const sshHost = config[server].ssh.host;
  const output = runSshDocker(sshHost, ['docker', 'stack', 'ls', '--format', 'json'], server);
  const stacks = parseNdjson(output, 'docker stack ls');

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(stacks) }],
  };
}

// ── Logs ──────────────────────────────────────────────────

const LOGS_TIMEOUT_MS = 30000;
/** spawnSync applies this to stdout and stderr separately, so a reply can carry up to 1 MB of each. */
const LOGS_MAX_BUFFER = 1024 * 1024;
/** Redacted stderr a failure message carries at most. */
const LOGS_ERROR_DETAIL_CHARS = 2000;
const LOGS_STDERR_SEPARATOR = '----- stderr -----';

/** Why a `logs` run failed, from fields that hold no output. */
function logsFailureReason(result: SpawnSyncReturns<string>, timeoutMs = LOGS_TIMEOUT_MS): string {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ETIMEDOUT') return `timed out after ${timeoutMs / 1000}s`;
  if (code === 'ENOBUFS') {
    return `output exceeded ${LOGS_MAX_BUFFER / (1024 * 1024)} MB on one stream; narrow the window with since/until or lower tail`;
  }
  if (result.error) return `ssh could not run (${code ?? 'unknown error'})`;
  if (result.signal) return `killed by ${result.signal}`;
  return `exit status ${result.status}`;
}

/**
 * The error for a failed `logs` run: a fresh Error built from redacted, capped stderr. Node's own error and the
 * child's streams are never thrown — base-mcp-server returns the message to the model and the stderr logger
 * spreads the error's own properties, so raw `stdout`/`stderr` on it would reach both.
 */
function logsFailure(
  result: SpawnSyncReturns<string>,
  command: string,
  server: string,
  timeoutMs = LOGS_TIMEOUT_MS,
): Error {
  let stderr = result.stderr ?? '';
  // A killed child can stop mid-line, and a secret cut short no longer matches its shape: keep whole lines only.
  if (result.error || result.signal) stderr = stderr.slice(0, stderr.lastIndexOf('\n') + 1);
  let detail = redactLogSecrets(stderr).trimEnd();
  if (detail.length > LOGS_ERROR_DETAIL_CHARS) detail = `${detail.slice(0, LOGS_ERROR_DETAIL_CHARS)} [truncated]`;
  const head = `${command} failed on ${server}: ${logsFailureReason(result, timeoutMs)}`;
  return new Error(detail.length > 0 ? `${head}\n${detail}` : head);
}

export function handleLogs(args: Record<string, unknown>) {
  const server = args.server as string;
  const service = args.service as string;
  const stack = args.stack as string | undefined;
  const since = args.since as string | undefined;
  const until = args.until as string | undefined;
  // docker takes the last --tail lines of the whole log before applying --since/--until, so a default tail would
  // empty any window older than those lines: with since and no tail, the whole window comes back.
  const tail = (args.tail as number | undefined) ?? (since ? undefined : 100);
  if (tail !== undefined && (!Number.isInteger(tail) || tail < 0 || tail > 10000)) {
    throw new Error('Invalid tail: must be an integer between 0 and 10000');
  }
  const timestamps = args.timestamps as boolean | undefined;

  const config = loadConfig();

  if (!config[server]) {
    throw new Error(`Unknown server: ${server}`);
  }

  // All input shape validation first (names + timestamps), then mode-specific rules.
  if (stack !== undefined) validateDockerName(stack, 'stack');
  validateDockerName(service, 'service');
  if (since) validateTimestamp(since, 'since');
  if (until) validateTimestamp(until, 'until');

  if (stack !== undefined && until !== undefined) {
    throw new Error(
      '--until is not supported when stack is set (docker service logs has no --until flag). ' +
        'Remove "until" or unset "stack" to use docker logs mode.',
    );
  }

  const sshHost = config[server].ssh.host;
  const sshArgs: string[] = [sshHost];

  if (stack !== undefined) {
    sshArgs.push('docker', 'service', 'logs');
  } else {
    sshArgs.push('docker', 'logs');
  }

  if (tail !== undefined) sshArgs.push('--tail', String(tail));
  if (since) sshArgs.push('--since', toDockerTime(since));
  if (until) sshArgs.push('--until', toDockerTime(until));
  if (timestamps) sshArgs.push('--timestamps');

  sshArgs.push(service);

  // Both streams are piped: the container's stderr comes back to the caller (redacted) instead of passing
  // through to this process's own stderr.
  const result = spawnSync('ssh', sshArgs, {
    timeout: LOGS_TIMEOUT_MS,
    maxBuffer: LOGS_MAX_BUFFER,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw logsFailure(result, stack !== undefined ? 'docker service logs' : 'docker logs', server);
  }

  const stdout = redactLogSecrets(result.stdout ?? '');
  const stderr = result.stderr ?? '';
  const text =
    stderr.length === 0
      ? stdout
      : `${stdout}${stdout === '' || stdout.endsWith('\n') ? '' : '\n'}${LOGS_STDERR_SEPARATOR}\n${redactLogSecrets(stderr)}`;

  return {
    content: [{ type: 'text' as const, text }],
  };
}

// ── ssh_exec (env-access WU2, #1210) ─────────────────────

/**
 * Host commands run here, outside every model sandbox, with this process's ssh keys — no model reads
 * a key or runs Bash ssh. The model sees the command's output, redacted for secret shapes. Admins
 * only: policy step 4 denies `ssh_exec` to everyone else (`build-stream-options.ts`).
 */
const SSH_EXEC_DEFAULT_TIMEOUT_S = 60;
const SSH_EXEC_MAX_TIMEOUT_S = 600;
// ── gh_pr: an environment user's PR actions (env-access WU3, #1211) ──

const GH_PR_ACTIONS = ['view', 'approve', 'merge'] as const;

function envGithub(server: unknown): { name: string; config: ServerConfig; github: EnvGithubConfig } {
  const config = loadConfig();
  if (typeof server !== 'string' || !Object.keys(config).includes(server)) throw new Error(`Unknown server: ${server}`);
  const github = config[server].github;
  if (!github || typeof github.token !== 'string' || !Array.isArray(github.repos)) {
    throw new Error(`Server ${server} has no github section (token and repos)`);
  }
  // A string where a list belongs would match by substring (`"bot"` in `"renovate[bot]"`): refuse the section.
  const isList = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
  for (const key of ['approveWhen', 'mergeWhen'] as const) {
    const when = github[key] as Record<string, unknown> | undefined;
    if (when === undefined) continue;
    for (const field of ['authors', 'bases']) {
      if (typeof when !== 'object' || !isList(when[field])) {
        throw new Error(`Server ${server}: github.${key}.${field} must be a list`);
      }
    }
  }
  if (!isList(github.repos) || !isList(github.mergeMethods) || !isList(github.requiredChecks)) {
    throw new Error(`Server ${server}: github.repos, github.mergeMethods and github.requiredChecks must be lists`);
  }
  return { name: server, config: config[server], github };
}

/**
 * `gh_read` (env-access WU5, #1213): one GET of the environment's own repository with its token, for deploy
 * confirmation and QA. Only the parts `repoReadPath` allows; nothing is written, so nothing is audited.
 */
export async function handleGhRead(
  args: Record<string, unknown>,
  fetchImpl: Fetch = globalThis.fetch as unknown as Fetch,
) {
  const env = envGithub(args.server);
  try {
    const answer = await repoRead(fetchImpl, env.github, args.path, args.query);
    return { content: [{ type: 'text' as const, text: JSON.stringify(answer) }] };
  } catch (err) {
    if (err instanceof GithubError) throw new Error(err.message);
    throw new Error(`gh_read failed on ${env.name}`);
  }
}

// ── cf_api: an environment's Cloudflare calls (env-access WU6, #1214) ──

function envCloudflare(server: unknown): { name: string; config: ServerConfig; cloudflare: EnvCloudflareConfig } {
  const config = loadConfig();
  if (typeof server !== 'string' || !Object.keys(config).includes(server)) throw new Error(`Unknown server: ${server}`);
  const cloudflare = config[server].cloudflare;
  const zones = cloudflare?.zones;
  const zonesOk =
    !!zones &&
    typeof zones === 'object' &&
    !Array.isArray(zones) &&
    Object.values(zones).every((id) => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id));
  if (!cloudflare || typeof cloudflare.token !== 'string' || !zonesOk) {
    throw new Error(`Server ${server} has no cloudflare section (token and zones of 32-hex IDs)`);
  }
  return { name: server, config: config[server], cloudflare };
}

/**
 * One Cloudflare API call on one of the environment's zones, with its own scoped token (never shown). A read runs as
 * is; a write needs `cloudflare.write`, a requester, and the audit ledger before and after (a write with no answer is
 * recorded `unknown`). `fetchImpl` is for tests.
 */
export async function handleCfApi(
  args: Record<string, unknown>,
  fetchImpl: CfFetch = globalThis.fetch as unknown as CfFetch,
) {
  const env = envCloudflare(args.server);
  try {
    const request = cfRequest(env.cloudflare, args);
    if (request.method === 'GET') {
      const answer = await cfCall(fetchImpl, env.cloudflare, request);
      return { content: [{ type: 'text' as const, text: JSON.stringify(answer) }] };
    }
    const requester = process.env.SOMA_REQUESTER;
    if (!requester) throw new CfError('not sent: the session has no requester to record');
    const audit = {
      server: env.name,
      ...(env.config.envUser ? { envUser: env.config.envUser } : {}),
      requester,
      tool: 'cf_api',
      action: request.method,
    };
    // What was sent, without the body itself (it may hold a value the ledger should not keep): its SHA-256.
    const detail = {
      zone: request.zone,
      path: request.path,
      ...(request.query ? { query: request.query.slice(1) } : {}),
      ...(request.body !== undefined ? { bodySha256: createHash('sha256').update(request.body).digest('hex') } : {}),
    };
    try {
      appendAudit(process.env.SOMA_AUDIT_DIR, { ...audit, phase: 'intent', detail });
    } catch (err) {
      throw new CfError(`not sent: ${(err as Error).message}`);
    }
    let answer: Awaited<ReturnType<typeof cfCall>>;
    try {
      answer = await cfCall(fetchImpl, env.cloudflare, request);
    } catch (err) {
      const phase = err instanceof CfOutcomeUnknownError ? 'unknown' : 'failed';
      const message = err instanceof CfError ? err.message : `cf_api failed on ${env.name}`;
      try {
        appendAudit(process.env.SOMA_AUDIT_DIR, { ...audit, phase, detail: { ...detail, error: message } });
      } catch (auditErr) {
        throw new CfError(`${message}; the audit ledger could not record it (${(auditErr as Error).message})`);
      }
      throw new CfError(message);
    }
    try {
      appendAudit(process.env.SOMA_AUDIT_DIR, {
        ...audit,
        phase: 'done',
        detail: { ...detail, status: answer.status },
      });
    } catch (err) {
      throw new CfError(
        `Cloudflare ${request.method} was made (${answer.status}), but the audit ledger could not record it (${(err as Error).message}); do not retry`,
      );
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(answer) }] };
  } catch (err) {
    if (err instanceof CfError) throw new Error(err.message);
    throw new Error(`cf_api failed on ${env.name}`);
  }
}

/**
 * view / approve / merge one PR as the environment user, with the environment's token. approve and merge run only
 * under the environment's conditions, at the head SHA the caller passes, for the person the bot names
 * (`SOMA_REQUESTER`); each is written to the audit ledger before it runs, and again with its outcome. `fetchImpl`
 * is for tests.
 */
export async function handleGhPr(
  args: Record<string, unknown>,
  fetchImpl: Fetch = globalThis.fetch as unknown as Fetch,
) {
  const action = args.action;
  if (typeof action !== 'string' || !(GH_PR_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`Invalid action: one of ${GH_PR_ACTIONS.join(', ')}`);
  }
  const env = envGithub(args.server);
  try {
    const repo = allowedRepo(env.github, args.repo);
    const number = prNumber(args.pr);
    const state = await prState(fetchImpl, env.github, repo, number);
    if (action === 'view') return { content: [{ type: 'text' as const, text: JSON.stringify(state) }] };

    const done = action === 'approve' ? 'approved' : 'merged';
    const sha = headSha(args.sha);
    const method = action === 'merge' ? (typeof args.method === 'string' ? args.method : 'merge') : undefined;
    const problem =
      action === 'approve'
        ? approvalProblem(env.github, state, sha)
        : mergeProblem(env.github, state, sha, method ?? 'merge');
    if (problem) throw new GithubError(`not ${done}: ${problem}`);
    const requester = process.env.SOMA_REQUESTER;
    if (!requester) throw new GithubError(`not ${done}: the session has no requester to record`);

    const audit = {
      server: env.name,
      ...(env.config.envUser ? { envUser: env.config.envUser } : {}),
      requester,
      tool: 'gh_pr',
      action,
    };
    const detail = { repo, pr: number, sha, base: state.base, ...(method ? { method } : {}) };
    try {
      appendAudit(process.env.SOMA_AUDIT_DIR, { ...audit, phase: 'intent', detail });
    } catch (err) {
      throw new GithubError(`not ${done}: ${(err as Error).message}`);
    }

    let result: string;
    try {
      if (action === 'approve') {
        const body =
          typeof args.body === 'string' && args.body.trim() !== '' ? args.body : 'Approved by environment user.';
        await approve(fetchImpl, env.github, repo, number, sha, state.base, body);
        result = `approved ${repo}#${number} at ${sha}`;
      } else {
        const merged = await merge(fetchImpl, env.github, repo, number, sha, state.base, method ?? 'merge');
        result = `merged ${repo}#${number} at ${sha} as ${merged}`;
      }
    } catch (err) {
      // No answer and no way to look it up: the write may have been made. Say so, and record it as such.
      const unknown = err instanceof OutcomeUnknownError;
      const reason = err instanceof GithubError ? err.message : `gh_pr failed on ${env.name}`;
      const message = unknown ? `${action}: the outcome is unknown — ${reason}` : reason;
      try {
        appendAudit(process.env.SOMA_AUDIT_DIR, {
          ...audit,
          phase: unknown ? 'unknown' : 'failed',
          detail: { ...detail, error: message },
        });
      } catch (auditErr) {
        throw new GithubError(
          `${message}; the audit ledger could not record the failure (${(auditErr as Error).message})`,
        );
      }
      throw new GithubError(message);
    }
    try {
      appendAudit(process.env.SOMA_AUDIT_DIR, { ...audit, phase: 'done', detail: { ...detail, result } });
    } catch (err) {
      throw new GithubError(
        `${result}, but the audit ledger could not record it (${(err as Error).message}). It was made: do not retry.`,
      );
    }
    return { content: [{ type: 'text' as const, text: result }] };
  } catch (err) {
    // Only messages this module wrote: never a token, never a raw response.
    if (err instanceof GithubError) throw new Error(err.message);
    throw new Error(`gh_pr failed on ${env.name}`);
  }
}

// ── login: an environment user's web session (env-access WU3b, #1211) ──

/**
 * Log in to the environment's web app as one of its accounts and return the session — never the password. Runs for
 * the person the bot names (`SOMA_REQUESTER`) and is written to the audit ledger before and after, without the
 * session. `fetchImpl` is for tests.
 */
export async function handleLogin(args: Record<string, unknown>, fetchImpl: LoginFetch = defaultLoginFetch) {
  const server = args.server;
  const account = args.account;
  const config = loadConfig();
  if (typeof server !== 'string' || !Object.keys(config).includes(server)) throw new Error(`Unknown server: ${server}`);
  if (typeof account !== 'string' || account === '') throw new Error('account is required');
  const logins = config[server].web?.logins;
  if (!logins || typeof logins !== 'object' || Array.isArray(logins))
    throw new Error(`Server ${server} has no web logins`);
  if (!Object.keys(logins).includes(account)) throw new Error(`Server ${server} has no login named ${account}`);
  const env = config[server];
  try {
    const spec = loginSpec(logins[account], account);
    const requester = process.env.SOMA_REQUESTER;
    if (!requester) throw new LoginError('not logged in: the session has no requester to record');
    const audit = {
      server,
      ...(env.envUser ? { envUser: env.envUser } : {}),
      requester,
      tool: 'login',
      action: 'login',
    };
    const detail = { account, host: new URL(spec.url).host };
    try {
      appendAudit(process.env.SOMA_AUDIT_DIR, { ...audit, phase: 'intent', detail });
    } catch (err) {
      throw new LoginError(`not logged in: ${(err as Error).message}`);
    }
    let session: Awaited<ReturnType<typeof login>>;
    try {
      session = await login(fetchImpl, spec);
    } catch (err) {
      const message = err instanceof LoginError ? err.message : `login failed on ${server}`;
      try {
        appendAudit(process.env.SOMA_AUDIT_DIR, { ...audit, phase: 'failed', detail: { ...detail, error: message } });
      } catch (auditErr) {
        throw new LoginError(
          `${message}; the audit ledger could not record the failure (${(auditErr as Error).message})`,
        );
      }
      throw new LoginError(message);
    }
    try {
      appendAudit(process.env.SOMA_AUDIT_DIR, { ...audit, phase: 'done', detail: { ...detail, kind: session.kind } });
    } catch (err) {
      throw new LoginError(
        `logged in to ${detail.host} as ${account}, but the audit ledger could not record it (${(err as Error).message}); the session was not handed out`,
      );
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ server, account, ...session }) }] };
  } catch (err) {
    // Only messages this module wrote: never the password, never a response body.
    if (err instanceof LoginError) throw new Error(err.message);
    throw new Error(`login failed on ${server}`);
  }
}

const SSH_EXEC_MAX_COMMAND_CHARS = 8192;
const SSH_EXEC_TIMEOUT_NOTE =
  'Only the local ssh client was stopped: the remote command may still be running and its outcome is unknown. ' +
  'Check the host before running it again.';

export function handleSshExec(args: Record<string, unknown>) {
  const server = args.server as string;
  const command = args.command;
  const timeoutS = args.timeout_s ?? SSH_EXEC_DEFAULT_TIMEOUT_S;

  const config = loadConfig();
  // Own keys only: `__proto__` or `toString` is not a server.
  if (typeof server !== 'string' || !Object.keys(config).includes(server)) {
    throw new Error(`Unknown server: ${server}`);
  }
  if (typeof command !== 'string' || command.trim() === '' || command.length > SSH_EXEC_MAX_COMMAND_CHARS) {
    throw new Error(`Invalid command: a non-empty string of at most ${SSH_EXEC_MAX_COMMAND_CHARS} characters`);
  }
  if (
    typeof timeoutS !== 'number' ||
    !Number.isInteger(timeoutS) ||
    timeoutS < 1 ||
    timeoutS > SSH_EXEC_MAX_TIMEOUT_S
  ) {
    throw new Error(`Invalid timeout_s: an integer between 1 and ${SSH_EXEC_MAX_TIMEOUT_S}`);
  }

  // BatchMode: never prompt for a password or a host key. `--` ends ssh's options before the host: OpenSSH
  // parses options again after the host otherwise, and a command such as `-oProxyCommand=…` would run on
  // this host, as the bot, outside every sandbox. The remote shell runs `command` as one string.
  const result = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', config[server].ssh.host, command],
    {
      timeout: timeoutS * 1000,
      maxBuffer: LOGS_MAX_BUFFER,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error || result.signal) {
    // Same failure shape as `logs`: a fresh error from redacted, capped stderr, never the raw output.
    const failure = logsFailure(result, 'ssh_exec', server, timeoutS * 1000);
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    // ssh ran and was stopped here (the timeout, output over the buffer, a signal): only the local client
    // stopped, and a remote command with no terminal keeps running (review-of-legends R4, trinity R4). Say so,
    // so a retry does not repeat a deploy that is still going. An ssh that never started ran nothing.
    const stoppedLocally = code === 'ETIMEDOUT' || code === 'ENOBUFS' || (!result.error && result.signal);
    if (!stoppedLocally) throw failure;
    const [head, ...detail] = failure.message.split('\n');
    throw new Error([head, SSH_EXEC_TIMEOUT_NOTE, ...detail].join('\n'));
  }

  const stdout = redactLogSecrets(result.stdout ?? '');
  const stderr = result.stderr ?? '';
  const body =
    stderr.length === 0
      ? stdout
      : `${stdout}${stdout === '' || stdout.endsWith('\n') ? '' : '\n'}${LOGS_STDERR_SEPARATOR}\n${redactLogSecrets(stderr)}`;
  return {
    content: [{ type: 'text' as const, text: `exit ${result.status}\n${body}` }],
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
        host: '127.0.0.1',
        port: localPort,
        user: dbConfig.user,
        password: dbConfig.password,
        database,
        connectTimeout: 10000,
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
      if (connection) {
        try {
          await connection.end();
        } catch {
          /* ignore */
        }
      }
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
      const rowCount = isArray ? result.length : result !== null && result !== undefined ? 1 : 0;
      const truncated = isArray && result.length > MAX_ROWS;

      return buildToolResult({
        backend: 'redis',
        data: truncated ? (result as any[]).slice(0, MAX_ROWS) : data,
        rowCount: truncated ? MAX_ROWS : rowCount,
        truncated,
      });
    } finally {
      try {
        client.disconnect();
      } catch {
        /* ignore */
      }
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
          const docs = await db
            .collection(collection)
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
          const docs = await db
            .collection(collection)
            .aggregate(safePipeline as any[], { maxTimeMS: QUERY_TIMEOUT_MS, allowDiskUse: false })
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
      try {
        await client.close();
      } catch {
        /* ignore */
      }
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
      const rows = (await resultSet.json()) as any[];

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
      try {
        await client.close();
      } catch {
        /* ignore */
      }
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
        description:
          'List all configured servers with their SSH hosts and available databases (including type: mysql/redis/mongodb/clickhouse).',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'list_service',
        description:
          'List running Docker containers (or Swarm services when stack is set) on a server via SSH. Default mode: docker ps. With stack: docker stack services <stack> --format json. Output is opaque NDJSON pass-through; field names differ between modes.',
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Server name from config.' },
            stack: {
              type: 'string',
              description:
                'Optional Docker Swarm stack name. When set, lists services of the stack via "docker stack services" instead of "docker ps".',
            },
          },
          required: ['server'],
        },
      },
      {
        name: 'list_stack',
        description:
          'List Docker Swarm stacks on a server via SSH. Calls "docker stack ls --format json" and returns NDJSON-parsed array. Errors if the host is not a Swarm manager.',
        inputSchema: {
          type: 'object',
          properties: { server: { type: 'string', description: 'Server name from config.' } },
          required: ['server'],
        },
      },
      {
        name: 'ssh_exec',
        description:
          'Run one shell command on a configured server over SSH and return "exit <status>", its stdout and, after a "----- stderr -----" line, its stderr. Output is redacted for common secret shapes. This is the only way to run a command on a host: Bash ssh is blocked, and no model reads an ssh key. Admins only.',
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Server name from config (see list).' },
            command: {
              type: 'string',
              description: 'The command line the remote shell runs, at most 8192 characters.',
            },
            timeout_s: {
              type: 'number',
              description:
                'Seconds before the local ssh client is stopped: an integer from 1 to 600. Default 60. The remote command is not guaranteed to stop with it; after a timeout, check the host before running the command again.',
            },
          },
          required: ['server', 'command'],
        },
      },
      {
        name: 'login',
        description:
          "Log in to a server's environment web app as one of its configured accounts (web.logins) and get the " +
          'session: a bearer token, or a session cookie. The account password stays in the secret store and is ' +
          'never shown. Audited. Use the session for the API calls the task needs. Admins, or a user the ' +
          "environment's admin approved.",
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Server name from config (see list) whose web logins to use.' },
            account: { type: 'string', description: "One of that server's web.logins names." },
          },
          required: ['server', 'account'],
        },
      },
      {
        name: 'cf_api',
        description:
          "Call the Cloudflare API on one of a server's environment zones with the environment's own scoped token " +
          '(never shown): path /zones/<zone id>/… (dns_records, settings, purge_cache, …), method GET, or POST/PUT/' +
          'PATCH/DELETE when the environment allows writes (audited). Token, user and member paths are never ' +
          "reachable. Returns {status, truncated, body}. Admins, or a user the environment's admin approved.",
        inputSchema: {
          type: 'object',
          properties: {
            server: {
              type: 'string',
              description: 'Server name from config (see list) whose cloudflare section to use.',
            },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
            path: { type: 'string', description: '/zones/<zone id>/… — no query string; put parameters in query.' },
            query: { type: 'object', description: 'Query parameters (strings, numbers, booleans).' },
            body: { type: 'object', description: 'JSON body for POST, PUT or PATCH.' },
          },
          required: ['server', 'method', 'path'],
        },
      },
      {
        name: 'gh_read',
        description:
          "GET one path of a server's environment repository with the environment's own GitHub token (never shown): " +
          'commits, compare, pulls, issues, actions runs/jobs/workflows, check-runs, statuses, branches, contents, ' +
          'releases, tags, deployments. Returns {path, truncated, body} (body is the JSON answer, or its first ' +
          "200000 characters as text when truncated). For deploy confirmation and QA. Admins, or a user the environment's admin approved.",
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Server name from config (see list) whose github section to use.' },
            path: { type: 'string', description: 'repos/<owner>/<name>/… — no query string; put parameters in query.' },
            query: {
              type: 'object',
              description:
                'Query parameters (strings, numbers, booleans), e.g. {"per_page": 50, "sha": "deploy/dev2"}.',
            },
          },
          required: ['server', 'path'],
        },
      },
      {
        name: 'gh_pr',
        description:
          "Act on one GitHub PR as a server's environment user, with that environment's own token (no model reads it). " +
          "view: the PR's state, author, base, head SHA and checks. approve: only when the environment's approveWhen " +
          'holds (author, base, all checks green) and `sha` is still the head. merge: only into one of the ' +
          "environment's mergeWhen bases, by a listed author, with all checks green, at `sha`. approve and merge " +
          'are audited. Admins only.',
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Server name from config (see list) whose github section to use.' },
            action: { type: 'string', enum: ['view', 'approve', 'merge'] },
            repo: { type: 'string', description: "owner/name, one of the environment's repos." },
            pr: { type: 'number', description: 'PR number.' },
            sha: { type: 'string', description: 'approve/merge: the full head SHA you looked at with view.' },
            method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'merge: default merge.' },
            body: { type: 'string', description: 'approve: review text.' },
          },
          required: ['server', 'action', 'repo', 'pr'],
        },
      },
      {
        name: 'logs',
        description:
          'Fetch Docker container logs (or Swarm service logs when stack is set) from a server via SSH. Default mode: docker logs. With stack: docker service logs (caller must pass the full <stack>_<svc> name in service). NOTE: --until is not supported in stack mode. Container stderr follows stdout under a "----- stderr -----" line. Output is redacted for common secret shapes (tokens, API keys, passwords, URL credentials, private key blocks).',
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Server name from config.' },
            service: {
              type: 'string',
              description: 'Docker container/service name. In stack mode, pass the full <stack>_<svc> name.',
            },
            stack: {
              type: 'string',
              description:
                'Optional Docker Swarm stack name. When set, fetches logs via "docker service logs" (Swarm mode). --until is not supported in this mode.',
            },
            tail: {
              type: 'number',
              description:
                'Lines counted back from the end of the whole log, applied before since/until: a window older than those lines comes back empty. To read a past window, give since (and until) and leave tail out; then every line in the window is returned. Default: 100 when since is not set; none when it is.',
            },
            since: {
              type: 'string',
              description:
                'Show logs since this time: RFC 3339 such as "2026-01-01T00:00:00Z" or "2026-01-01T09:00:00+09:00" (a time with no zone is read in the server\'s local time), or a duration back from now such as "10m" (units s, m, h, d).',
            },
            until: {
              type: 'string',
              description:
                'Show logs until this time, in the same forms as since (e.g., "2026-01-01T00:10:00Z" or "5m"). Not supported when stack is set.',
            },
            timestamps: { type: 'boolean', description: 'Show timestamps in log output.' },
          },
          required: ['server', 'service'],
        },
      },
      {
        name: 'db_query',
        description:
          'Execute a read-only SQL query on a MySQL database via SSH tunnel. Only SELECT, SHOW, DESCRIBE, EXPLAIN, DESC are allowed.',
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
        description:
          'Execute a read-only Redis command via SSH tunnel. Only read commands are allowed (GET, HGETALL, LRANGE, SCAN, INFO, etc.).',
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
        description:
          'Execute a read-only MongoDB query via SSH tunnel. Supported operations: find, aggregate, countDocuments, distinct, listCollections, listIndexes.',
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Server name from config.' },
            database: { type: 'string', description: 'Database name from config (must be type: mongodb).' },
            collection: { type: 'string', description: 'Collection name.' },
            operation: {
              type: 'string',
              description:
                'Operation: find, aggregate, countDocuments, estimatedDocumentCount, distinct, listCollections, listIndexes.',
            },
            filter: { type: 'object', description: 'Query filter (for find, countDocuments, distinct).' },
            pipeline: { type: 'array', description: 'Aggregation pipeline stages (for aggregate).' },
            options: {
              type: 'object',
              description:
                'Query options: { limit?: number, sort?: object, projection?: object, field?: string (for distinct) }.',
            },
          },
          required: ['server', 'database', 'operation'],
        },
      },
      {
        name: 'clickhouse_query',
        description:
          'Execute a read-only SQL query on a ClickHouse database via SSH tunnel. Only SELECT, SHOW, DESCRIBE, EXPLAIN, EXISTS are allowed.',
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
      case 'list_stack':
        return handleListStack(args);
      case 'logs':
        return handleLogs(args);
      case 'ssh_exec':
        return handleSshExec(args);
      case 'login':
        return await handleLogin(args);
      case 'cf_api':
        return await handleCfApi(args);
      case 'gh_read':
        return await handleGhRead(args);
      case 'gh_pr':
        return await handleGhPr(args);
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
