/**
 * Deploy-time sandbox grant for deploy-workflow sessions.
 *
 * Post-deploy QA runs inside the requester's deploy-workflow session, under the
 * SDK sandbox. On some hosts it needs a little more than that sandbox allows:
 * write access to a few host directories and network access to the QA
 * environment's hostnames. The fleet deploy (`.github/workflows/deploy.yml`)
 * writes exactly that, for THIS runner, into `<target>/config.json#deploySandbox`,
 * and `buildStreamOptions` applies it only to a `deploy` workflow turn sent by a
 * listed user (`src/sandbox/deploy-sandbox-grant.ts`).
 *
 * Input is the `DEPLOY_SANDBOX` env var, one entry per line, set from exactly
 * one channel's repo secret (`PRODUCTION_DEPLOY_SANDBOX` for the `main`
 * environment, `PREVIEW_DEPLOY_SANDBOX` otherwise — never a fallback):
 *
 *   runner-label|user[,user...]|domain[,domain...]|path[,path...]
 *
 * Blank lines and `#` comments are ignored; the domain and path fields may be
 * empty; a runner may appear on several lines (their union is its grant).
 * Every other line is validated — including lines for other runners, and
 * against the channel's runner labels (`CHANNEL_RUNNER_LABELS`) — so a typo
 * fails the deploy. The value rules are `src/sandbox/deploy-sandbox-rules.ts`,
 * the ones the runtime applies, so the deploy never writes what the runtime
 * would drop.
 *
 * Unlike the environment plugins this REPLACES: lines for this runner set the
 * key; no line for this runner (an empty or unset secret included) deletes it,
 * so removing a line revokes the grant on the next deploy. A runner with no
 * line and no key to delete is a no-op that never fails on the destination:
 * the strict checks below run only when the key will be set or deleted.
 *
 * Same step, same rules as `apply-env-plugins.ts`: `--check` before the service
 * stops (everything computed and checked, nothing written), the real run before
 * the restart, node built-ins only (no `node_modules` on the target yet), and
 * counts-only output — the deploy log of this repository is public.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DEPLOY_SANDBOX_KEY,
  type DeploySandboxGrant,
  isGrantDomain,
  isGrantPath,
  isSlackUserId,
} from '../sandbox/deploy-sandbox-rules';
import { EnvPluginsError, inspectTarget, writeConfigAtomically } from './apply-env-plugins';

/** GitHub runner labels (same rule as apply-env-plugins). */
const RUNNER_LABEL_RE = /^[A-Za-z0-9._-]+$/;
const LINE_SHAPE = 'runner-label|user[,user...]|domain[,domain...]|path[,path...]';

/** Failure with a message that is safe to print in a public deploy log. */
export class DeploySandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploySandboxError';
  }
}

export interface DeploySandboxLine extends DeploySandboxGrant {
  /** 1-based line number in DEPLOY_SANDBOX. */
  line: number;
  runnerLabel: string;
}

function fieldError(line: number, field: number, label: string): DeploySandboxError {
  return new DeploySandboxError(`line ${line}: field ${field} (${label}) is invalid; expected ${LINE_SHAPE}`);
}

/** Comma-separated items, trimmed, de-duplicated; every item must pass `valid`. */
function parseList(
  field: string,
  valid: (value: unknown) => value is string,
  fail: () => DeploySandboxError,
): string[] {
  if (field === '') return [];
  const items: string[] = [];
  for (const item of field.split(',').map((value) => value.trim())) {
    if (!valid(item)) throw fail();
    if (!items.includes(item)) items.push(item);
  }
  return items;
}

/** Parse every non-comment line of DEPLOY_SANDBOX. Throws {@link DeploySandboxError} on the first bad line. */
export function parseDeploySandbox(raw: string | undefined): DeploySandboxLine[] {
  const entries: DeploySandboxLine[] = [];
  const lines = (raw ?? '').split(/\r?\n/);

  lines.forEach((text, index) => {
    const lineNo = index + 1;
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const fields = trimmed.split('|').map((field) => field.trim());
    if (fields.length !== 4) {
      throw new DeploySandboxError(`line ${lineNo}: expected 4 fields (${LINE_SHAPE}), got ${fields.length}`);
    }
    const [runnerLabel, userList, domainList, pathList] = fields;

    if (!RUNNER_LABEL_RE.test(runnerLabel)) throw fieldError(lineNo, 1, 'runner-label');
    const users = parseList(userList, isSlackUserId, () => fieldError(lineNo, 2, 'user list'));
    if (users.length === 0) throw fieldError(lineNo, 2, 'user list');
    const allowedDomains = parseList(domainList, isGrantDomain, () => fieldError(lineNo, 3, 'domain list'));
    const allowWrite = parseList(pathList, isGrantPath, () => fieldError(lineNo, 4, 'path list'));

    entries.push({ line: lineNo, runnerLabel, users, allowedDomains, allowWrite });
  });

  return entries;
}

function union(lists: string[][]): string[] {
  const out: string[] = [];
  for (const item of lists.flat()) if (!out.includes(item)) out.push(item);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface MergeResult {
  /** The merged config. Every other key keeps its value and order. */
  config: Record<string, unknown>;
  changed: boolean;
}

/**
 * Set (grant) or delete (null) `deploySandbox` in a parsed config.json object
 * (pure; the input is not mutated). An existing key is replaced in place.
 */
export function mergeDeploySandbox(config: Record<string, unknown>, grant: DeploySandboxGrant | null): MergeResult {
  let merged: Record<string, unknown>;
  if (grant) {
    merged = {
      ...config,
      [DEPLOY_SANDBOX_KEY]: {
        users: [...grant.users],
        allowedDomains: [...grant.allowedDomains],
        allowWrite: [...grant.allowWrite],
      },
    };
  } else {
    merged = { ...config };
    delete merged[DEPLOY_SANDBOX_KEY];
  }
  return { config: merged, changed: JSON.stringify(merged) !== JSON.stringify(config) };
}

/**
 * Whether `<targetDir>/config.json` carries the key, read the way the runtime
 * reads it (`loadDeploySandboxGrant`: follows a symlink, and any read or parse
 * failure means no grant). Consulted only when this runner has no line: no key
 * means nothing to delete, so the strict destination checks are skipped.
 */
function hasDeploySandboxKey(targetDir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(targetDir, 'config.json'), 'utf8'));
    return isPlainObject(parsed) && parsed[DEPLOY_SANDBOX_KEY] !== undefined;
  } catch {
    return false;
  }
}

/**
 * `applied` = the key was set or changed; `revoked` = it was deleted;
 * `unchanged` = the same grant is already there; `none` = no line for this
 * runner and no key to delete (nothing inspected, nothing written). With
 * `checkOnly`, what the real run would do.
 */
export type ApplyStatus = 'applied' | 'revoked' | 'unchanged' | 'none';

export interface ApplyResult {
  status: ApplyStatus;
  /** This runner's grant (0 when it has none). */
  users: number;
  domains: number;
  paths: number;
}

export interface ApplyOptions {
  targetDir: string;
  deploySandbox: string | undefined;
  runnerLabel: string | undefined;
  /**
   * Every runner label of the channel (before any manual `targets` narrowing).
   * When given, a line naming any other label fails — a typo would otherwise
   * grant nothing anywhere.
   */
  channelRunnerLabels?: readonly string[];
  /** Compute everything and fail the same way, but write nothing (`--check`). */
  checkOnly?: boolean;
}

export function applyDeploySandbox(options: ApplyOptions): ApplyResult {
  const checkOnly = options.checkOnly === true;
  const entries = parseDeploySandbox(options.deploySandbox);

  const known = options.channelRunnerLabels;
  if (known && known.length > 0) {
    const stray = entries.find((entry) => !known.includes(entry.runnerLabel));
    if (stray) throw new DeploySandboxError(`line ${stray.line}: runner label is not a deploy target of this channel`);
  }

  let grant: DeploySandboxGrant | null = null;
  if (entries.length > 0) {
    const runnerLabel = options.runnerLabel?.trim();
    if (!runnerLabel) throw new DeploySandboxError('RUNNER_LABEL is not set but DEPLOY_SANDBOX has entries');
    const selected = entries.filter((entry) => entry.runnerLabel === runnerLabel);
    if (selected.length > 0) {
      grant = {
        users: union(selected.map((entry) => entry.users)),
        allowedDomains: union(selected.map((entry) => entry.allowedDomains)),
        allowWrite: union(selected.map((entry) => entry.allowWrite)),
      };
    }
  }
  const counts = {
    users: grant?.users.length ?? 0,
    domains: grant?.allowedDomains.length ?? 0,
    paths: grant?.allowWrite.length ?? 0,
  };
  if (!grant && !hasDeploySandboxKey(options.targetDir)) return { status: 'none', ...counts };

  const { configFile, raw } = inspectTarget(options.targetDir, checkOnly);

  let current: Record<string, unknown> = {};
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new DeploySandboxError('config.json is not valid JSON; left untouched');
    }
    if (!isPlainObject(parsed)) throw new DeploySandboxError('config.json is not a JSON object; left untouched');
    current = parsed;
  }

  const merged = mergeDeploySandbox(current, grant);
  if (!merged.changed) return { status: 'unchanged', ...counts };
  const status: ApplyStatus = grant ? 'applied' : 'revoked';
  if (checkOnly) return { status, ...counts };

  // Serialized like config-loader saveConfig: insertion order, two spaces, trailing newline.
  writeConfigAtomically(configFile, `${JSON.stringify(merged.config, null, 2)}\n`);
  return { status, ...counts };
}

const USAGE = 'usage: apply-deploy-sandbox.js [--check] <target-dir>';

function parseArgs(argv: string[]): { targetDir: string; checkOnly: boolean } | null {
  const args = [...argv];
  const checkOnly = args[0] === '--check';
  if (checkOnly) args.shift();
  if (args.length !== 1 || !args[0] || args[0].startsWith('-')) return null;
  return { targetDir: args[0], checkOnly };
}

export interface CliIo {
  argv: string[];
  env: Record<string, string | undefined>;
  log: (message: string) => void;
  error: (message: string) => void;
}

/** `node dist/deploy/apply-deploy-sandbox.js [--check] <target-dir>`; returns the exit code. */
export function runCli(io: CliIo): number {
  const args = parseArgs(io.argv);
  if (!args) {
    io.error(`deploy-sandbox: failed (${USAGE})`);
    return 1;
  }
  const { targetDir, checkOnly } = args;

  try {
    // The deploy step always passes the channel's label set; without it the
    // typo check would be skipped, so fail closed instead.
    const channelRunnerLabels = (io.env.CHANNEL_RUNNER_LABELS ?? '')
      .split(/[\s,]+/)
      .filter((label) => label.length > 0);
    if (channelRunnerLabels.length === 0 && parseDeploySandbox(io.env.DEPLOY_SANDBOX).length > 0) {
      throw new DeploySandboxError('runner label set missing (CHANNEL_RUNNER_LABELS) but DEPLOY_SANDBOX has entries');
    }
    const result = applyDeploySandbox({
      targetDir,
      deploySandbox: io.env.DEPLOY_SANDBOX,
      runnerLabel: io.env.RUNNER_LABEL,
      channelRunnerLabels,
      checkOnly,
    });
    const counts = `${result.users} user(s), ${result.domains} domain(s), ${result.paths} path(s)`;
    let outcome = '';
    switch (result.status) {
      case 'applied':
        outcome = checkOnly ? `would apply ${counts} to config.json` : `applied ${counts} to config.json`;
        break;
      case 'revoked':
        outcome = `${checkOnly ? 'would remove' : 'removed'} the grant from config.json, no entries for this runner`;
        break;
      case 'unchanged':
        outcome =
          result.users > 0 ? `unchanged, ${counts} already in config.json` : 'unchanged, no grant for this runner';
        break;
      case 'none':
        outcome = 'nothing to apply, no grant for this runner';
        break;
    }
    io.log(checkOnly ? `deploy-sandbox: check ok (${outcome})` : `deploy-sandbox: ${outcome}`);
    return 0;
  } catch (error) {
    // Only our own messages (and the shared destination checks') are printed
    // verbatim; anything else (fs errors carry the path) is reduced to its
    // code or class name.
    const reason =
      error instanceof DeploySandboxError || error instanceof EnvPluginsError
        ? error.message
        : ((error as NodeJS.ErrnoException | undefined)?.code ?? (error as Error | undefined)?.name ?? 'error');
    io.error(`deploy-sandbox: ${checkOnly ? 'check failed' : 'failed'} (${reason})`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(
    runCli({
      argv: process.argv.slice(2),
      env: process.env,
      log: (message) => console.log(message),
      error: (message) => console.error(message),
    }),
  );
}
