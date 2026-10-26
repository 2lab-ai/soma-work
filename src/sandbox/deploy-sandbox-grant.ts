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
 * turn whose sender and session owner are both in `users`. A missing key is no
 * grant. The file is read
 * and validated on every call (once per deploy-workflow turn), so an edit or a
 * revoking deploy applies from the next turn.
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

/**
 * Whether `target` names itself on disk, so a grant cannot be pointed at a
 * forbidden location through a link:
 *
 *   - an existing path must resolve (realpath) to exactly the same string;
 *   - a path realpath cannot find is walked from the root with lstat, because
 *     realpath answers ENOENT for a dangling symlink exactly as for an absent
 *     path. Every component that exists must be a real directory — a symlink
 *     (dangling or not) or anything else is a refusal — and only a component
 *     lstat cannot find counts as missing. Everything from the first missing
 *     component down is the tail the session creates inside the grant. The
 *     deepest existing component must then resolve to itself.
 *
 * Any other failure (no permission, a component that is not a directory) is a
 * refusal.
 */
export function resolvesToItself(target: string): boolean {
  try {
    return fs.realpathSync.native(target) === target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }

  let current = '';
  let deepestExisting = '/';
  for (const component of target.split('/').slice(1)) {
    current = `${current}/${component}`;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      return false;
    }
    if (!stat.isDirectory()) return false;
    deepestExisting = current;
  }
  try {
    return fs.realpathSync.native(deepestExisting) === deepestExisting;
  } catch {
    return false;
  }
}

export interface SanitizeOptions {
  /** Runtime check on each lexically valid path; defaults to {@link resolvesToItself}. */
  pathResolves?: (target: string) => boolean;
}

/** Validate the raw `config.json#deploySandbox` value. */
export function sanitizeDeploySandboxGrant(raw: unknown, options: SanitizeOptions = {}): SanitizedDeploySandboxGrant {
  const dropped = { users: 0, domains: 0, paths: 0 };
  if (raw === undefined) return { grant: null, dropped, malformed: false };
  if (!isPlainObject(raw)) return { grant: null, dropped, malformed: true };

  const pathResolves = options.pathResolves ?? resolvesToItself;
  const users = keepValid(raw.users, isSlackUserId);
  const domains = keepValid(raw.allowedDomains, isGrantDomain);
  const paths = keepValid(raw.allowWrite, (value): value is string => isGrantPath(value) && pathResolves(value));
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

function freeze(grant: DeploySandboxGrant | null): DeploySandboxGrant | null {
  if (!grant) return null;
  Object.freeze(grant.users);
  Object.freeze(grant.allowedDomains);
  Object.freeze(grant.allowWrite);
  return Object.freeze(grant);
}

/**
 * The grant in `configFile`, read and validated on every call — no cache: the
 * file is small and this runs once per deploy-workflow turn. Missing file or
 * key → null, silently. An unreadable file, a malformed key, or dropped entries
 * → one warning for the call, counts only.
 */
export function loadDeploySandboxGrant(
  configFile: string | undefined,
  logger: DeploySandboxGrantLogger,
): DeploySandboxGrant | null {
  if (!configFile) return null;

  let text: string;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('config.json could not be read; no deploy sandbox grant');
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger.warn('config.json could not be read as JSON; no deploy sandbox grant');
    return null;
  }
  const result = sanitizeDeploySandboxGrant(isPlainObject(parsed) ? parsed[DEPLOY_SANDBOX_KEY] : undefined);
  if (result.malformed) {
    logger.warn('config.json#deploySandbox is not an object; no deploy sandbox grant');
  } else if (result.dropped.users + result.dropped.domains + result.dropped.paths > 0) {
    logger.warn('Dropped invalid config.json#deploySandbox entries', result.dropped);
  }
  return freeze(result.grant);
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
