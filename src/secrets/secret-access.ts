/**
 * Which secrets one server-tools call uses, and whether a non-admin may have it use them (secret-access WU2, #1338,
 * `.prd/33-secret-access-architecture.md` §3).
 *
 * The model never receives a secret: server-tools resolves `{"$secret": …}` outside every sandbox and returns only
 * results. "The model asks for a key" therefore means a tool call whose server section names a secret. This module
 * reads that from the raw `server-tools` section (references unresolved) and answers per call:
 *   - none     — the call uses no secret (host-command tools, listings): secret grants never open it;
 *   - covered  — every secret it uses is granted to the requester (always, or in this thread);
 *   - missing  — the names still to approve, sorted (the card lists them).
 *
 * The section a tool reads is narrowed by the argument that picks an entry (`database`, `account`); when it does not
 * pick one, every entry counts — a card more, never a secret less.
 */

import { type GrantScope, isSecretUseAllowed } from '../user-skill-grants-store';

// biome-ignore lint/style/noCommonJs: @soma/process-shared sub-path types are not visible under moduleResolution node
const { isSecretRef } = require('@soma/process-shared/secret-ref.js') as {
  isSecretRef(value: unknown): value is { $secret: string };
};

const SERVER_TOOLS_PREFIX = 'mcp__server-tools__';
const MAX_DEPTH = 32;

/** server-tools tools that use no secret: the host's own identity, listings, call records. */
const NO_SECRET_TOOLS: ReadonlySet<string> = new Set([
  'list',
  'list_service',
  'list_stack',
  'logs',
  'ssh_exec',
  'phone_calls',
]);

const DB_TOOLS: ReadonlySet<string> = new Set(['db_query', 'redis_query', 'mongodb_query', 'clickhouse_query']);

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null;
}

function refsIn(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;
  if (isSecretRef(value)) {
    out.add(value.$secret);
    return;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) refsIn(child, out, depth + 1);
}

/** The entries of a named map the argument picks: that one when it exists, else all of them. */
function pickedEntries(map: unknown, key: unknown): unknown[] {
  const m = obj(map);
  if (!m) return [];
  if (typeof key === 'string' && Object.keys(m).includes(key)) return [m[key]];
  return Object.values(m);
}

/** The secret names a server-tools call reads, sorted. Empty for a call that uses none. */
export function secretsForCall(
  section: unknown,
  toolName: string,
  input: Record<string, unknown> | undefined,
): string[] {
  if (!toolName.startsWith(SERVER_TOOLS_PREFIX)) return [];
  const tool = toolName.slice(SERVER_TOOLS_PREFIX.length);
  if (NO_SECRET_TOOLS.has(tool)) return [];
  const servers = obj(section);
  const server = input?.server;
  if (!servers || typeof server !== 'string' || server === 'permission') return [];
  if (!Object.keys(servers).includes(server)) return [];
  const entry = obj(servers[server]);
  if (!entry) return [];

  const found = new Set<string>();
  if (DB_TOOLS.has(tool)) {
    for (const db of pickedEntries(entry.databases, input?.database)) refsIn(db, found);
  } else if (tool === 'gh_read' || tool === 'gh_pr') {
    refsIn(entry.github, found);
  } else if (tool === 'login') {
    for (const login of pickedEntries(obj(entry.web)?.logins, input?.account)) refsIn(login, found);
  } else if (tool === 'phone_call') {
    refsIn(entry.phone, found);
  } else if (tool === 'cf_api') {
    const cloudflare = obj(entry.cloudflare);
    const accounts =
      cloudflare && obj(cloudflare.accounts) ? pickedEntries(cloudflare.accounts, input?.account) : [cloudflare];
    for (const account of accounts) refsIn(account, found);
    // An account that deploys from a repository reads it with the environment's GitHub token.
    if (accounts.some((account) => obj(account)?.sources !== undefined)) refsIn(entry.github, found);
  } else {
    // A tool this table does not know: the whole server section (fail closed).
    refsIn(entry, found);
  }
  return [...found].sort();
}

export type SecretAccess = { kind: 'none' } | { kind: 'covered' } | { kind: 'missing'; names: string[] };

/** May `requesterId`'s model have this call use the secrets it reads? Admins are not checked here. */
export function checkSecretAccess(
  toolName: string,
  input: Record<string, unknown> | undefined,
  requesterId: string,
  scope: GrantScope | undefined,
  section: unknown,
): SecretAccess {
  const names = secretsForCall(section, toolName, input);
  if (names.length === 0) return { kind: 'none' };
  const missing = names.filter((name) => !isSecretUseAllowed(name, requesterId, scope));
  return missing.length === 0 ? { kind: 'covered' } : { kind: 'missing', names: missing };
}
