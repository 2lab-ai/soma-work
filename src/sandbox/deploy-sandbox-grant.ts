/**
 * Runtime half of the deploy sandbox grant.
 *
 * Post-deploy QA runs inside the requester's deploy-workflow session, under the
 * ordinary SDK sandbox. Besides what that sandbox already allows, it needs write
 * access to a few host directories (a shared QA lock, the run evidence) and
 * network access to the QA environment's hostnames. The fleet deploy writes
 * exactly that, per runner, into `config.json#deploySandbox`
 * (`src/deploy/apply-deploy-sandbox.ts`):
 *
 *   { "deploySandbox": { "users": [...], "allowedDomains": [...], "allowWrite": [...] } }
 *
 * `buildStreamOptions` appends it to the sandbox only for a `deploy` workflow
 * turn whose sender is in `users`. A missing key is no grant.
 *
 * The values are host topology, so no log line here names one — counts only.
 */

import fs from 'node:fs';
import {
  DEPLOY_SANDBOX_KEY,
  type DeploySandboxGrant,
  isGrantDomain,
  isGrantPath,
  isSlackUserId,
} from './deploy-sandbox-rules';

export type { DeploySandboxGrant } from './deploy-sandbox-rules';

export interface SanitizedDeploySandboxGrant {
  /** Null = no grant: key absent, not an object, no valid user, or nothing to grant. */
  grant: DeploySandboxGrant | null;
  /** Entries dropped as invalid, per list. A list that is not an array counts as one. */
  dropped: { users: number; domains: number; paths: number };
  /** The key is present but is not a JSON object. */
  malformed: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Valid entries in first-seen order, duplicates removed; `invalid` counts the rest. */
function keepValid(raw: unknown, valid: (value: unknown) => value is string): { kept: string[]; invalid: number } {
  if (raw === undefined) return { kept: [], invalid: 0 };
  if (!Array.isArray(raw)) return { kept: [], invalid: 1 };
  const kept: string[] = [];
  let invalid = 0;
  for (const item of raw) {
    if (!valid(item)) invalid++;
    else if (!kept.includes(item)) kept.push(item);
  }
  return { kept, invalid };
}

/** Validate the raw `config.json#deploySandbox` value (pure). */
export function sanitizeDeploySandboxGrant(raw: unknown): SanitizedDeploySandboxGrant {
  const dropped = { users: 0, domains: 0, paths: 0 };
  if (raw === undefined) return { grant: null, dropped, malformed: false };
  if (!isPlainObject(raw)) return { grant: null, dropped, malformed: true };

  const users = keepValid(raw.users, isSlackUserId);
  const domains = keepValid(raw.allowedDomains, isGrantDomain);
  const paths = keepValid(raw.allowWrite, isGrantPath);
  dropped.users = users.invalid;
  dropped.domains = domains.invalid;
  dropped.paths = paths.invalid;

  const empty = users.kept.length === 0 || (domains.kept.length === 0 && paths.kept.length === 0);
  const grant = empty ? null : { users: users.kept, allowedDomains: domains.kept, allowWrite: paths.kept };
  return { grant, dropped, malformed: false };
}

export interface DeploySandboxGrantLogger {
  warn(message: string, data?: unknown): void;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  ino: number;
  grant: DeploySandboxGrant | null;
}

/**
 * Per config file. Keyed on mtime, plus size and inode so that a rewrite that
 * lands within the filesystem's mtime granularity (and the deploy writer's
 * rename, which always brings a new inode) is still seen.
 */
const cache = new Map<string, CacheEntry>();

function freeze(grant: DeploySandboxGrant | null): DeploySandboxGrant | null {
  if (!grant) return null;
  Object.freeze(grant.users);
  Object.freeze(grant.allowedDomains);
  Object.freeze(grant.allowWrite);
  return Object.freeze(grant);
}

/**
 * The grant in `configFile`, re-read only when the file changes. Missing file
 * or key → null, silently. An unreadable file, a malformed key, or dropped
 * entries → one warning per change of the file, counts only.
 */
export function loadDeploySandboxGrant(
  configFile: string | undefined,
  logger: DeploySandboxGrantLogger,
): DeploySandboxGrant | null {
  if (!configFile) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(configFile);
  } catch {
    cache.delete(configFile);
    return null;
  }
  const cached = cache.get(configFile);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.ino === stat.ino) {
    return cached.grant;
  }

  let grant: DeploySandboxGrant | null = null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const result = sanitizeDeploySandboxGrant(isPlainObject(parsed) ? parsed[DEPLOY_SANDBOX_KEY] : undefined);
    grant = freeze(result.grant);
    if (result.malformed) {
      logger.warn('config.json#deploySandbox is not an object; no deploy sandbox grant');
    } else if (result.dropped.users + result.dropped.domains + result.dropped.paths > 0) {
      logger.warn('Dropped invalid config.json#deploySandbox entries', result.dropped);
    }
  } catch {
    logger.warn('config.json could not be read as JSON; no deploy sandbox grant');
  }
  cache.set(configFile, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, grant });
  return grant;
}

/** Structural slice of the SDK `sandbox` settings the grant extends. */
export interface DeploySandboxTarget {
  filesystem?: { allowWrite?: string[] };
  network?: { allowedDomains?: string[] };
}

/**
 * Append the grant to `sandbox` in place, skipping entries it already has.
 * Domains are added only when `network` is true (the allowlist is active);
 * otherwise the network settings are left exactly as they are. Returns how many
 * entries were actually added.
 */
export function extendSandboxWithGrant(
  sandbox: DeploySandboxTarget,
  grant: DeploySandboxGrant,
  options: { network: boolean },
): { paths: number; domains: number } {
  if (!sandbox.filesystem) sandbox.filesystem = {};
  const allowWrite = sandbox.filesystem.allowWrite ?? [];
  const paths = grant.allowWrite.filter((entry) => !allowWrite.includes(entry));
  sandbox.filesystem.allowWrite = [...allowWrite, ...paths];

  let domains: string[] = [];
  if (options.network) {
    if (!sandbox.network) sandbox.network = {};
    const allowedDomains = sandbox.network.allowedDomains ?? [];
    domains = grant.allowedDomains.filter((entry) => !allowedDomains.includes(entry));
    sandbox.network.allowedDomains = [...allowedDomains, ...domains];
  }
  return { paths: paths.length, domains: domains.length };
}
