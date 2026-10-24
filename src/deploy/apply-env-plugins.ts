/**
 * Deploy-time environment plugins.
 *
 * The fleet deploy (`.github/workflows/deploy.yml`) runs this between
 * `sync-bundle.sh` and `install-target.sh`: it merges the marketplace and plugin
 * refs configured for THIS runner into `<target>/config.json`, and the daemon's
 * PluginManager fetches and loads them when `install-target.sh` restarts it.
 * Earlier, before `service.sh stop`, the same step runs it with `--check`: the
 * whole computation and every destination check, no write, the same failures —
 * so bad input fails the deploy while the old service is still running.
 *
 * Input is the `ENV_PLUGINS` env var, one entry per line. The deploy step sets
 * it from exactly one channel's repo secret (`PRODUCTION_ENV_PLUGINS` for the
 * `main` environment, `PREVIEW_ENV_PLUGINS` otherwise — never a fallback):
 *
 *   runner-label|marketplace-name|owner/repo[@ref]|plugin[,plugin...]
 *
 * Blank lines and `#` comments are ignored. Every other line is validated —
 * including lines for other runners, and against the channel's runner labels
 * (`CHANNEL_RUNNER_LABELS`) — so a typo fails the deploy instead of silently
 * installing nothing.
 *
 * Import-lean by design: at that point of the deploy the target has no
 * `node_modules` (sync-bundle wipes it and the bundle carries none), so this
 * module may load node built-ins only. It therefore mirrors the rules of
 * `src/plugin/config-parser.ts` instead of importing them; the mirror is held
 * to the real validators by `__tests__/apply-env-plugins.test.ts`.
 *
 * Output is counts only. The deploy log of this repository is public, so no
 * message names a repo, marketplace, plugin, runner, or path.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MarketplaceEntry } from '../plugin/types';

/** Mirrors config-parser SAFE_NAME_RE (marketplace and plugin names are path components). */
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
/** GitHub runner labels. */
const RUNNER_LABEL_RE = /^[A-Za-z0-9._-]+$/;
/** Exactly `owner/repo` — stricter than config-parser's "contains a slash". */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** Branch, tag, or SHA; slash-separated segments, never `..`. */
const REF_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
const DEFAULT_REF = 'main';
/** Same mode every config.json writer uses (config-loader CONFIG_FILE_MODE). */
const CONFIG_FILE_MODE = 0o600;
const LINE_SHAPE = 'runner-label|marketplace-name|owner/repo[@ref]|plugin[,plugin...]';

/** Failure with a message that is safe to print in a public deploy log. */
export class EnvPluginsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvPluginsError';
  }
}

export interface EnvPluginLine {
  /** 1-based line number in ENV_PLUGINS. */
  line: number;
  runnerLabel: string;
  marketplace: Required<MarketplaceEntry>;
  /** Plugin names (not refs), de-duplicated, in line order. */
  plugins: string[];
}

function fieldError(line: number, field: number, label: string): EnvPluginsError {
  return new EnvPluginsError(`line ${line}: field ${field} (${label}) is invalid; expected ${LINE_SHAPE}`);
}

/**
 * Parse every non-comment line of ENV_PLUGINS. Throws {@link EnvPluginsError}
 * on the first malformed line, and on two lines that give the same runner and
 * marketplace name different sources.
 */
export function parseEnvPlugins(raw: string | undefined): EnvPluginLine[] {
  const entries: EnvPluginLine[] = [];
  const lines = (raw ?? '').split(/\r?\n/);

  lines.forEach((text, index) => {
    const lineNo = index + 1;
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const fields = trimmed.split('|').map((field) => field.trim());
    if (fields.length !== 4) {
      throw new EnvPluginsError(`line ${lineNo}: expected 4 fields (${LINE_SHAPE}), got ${fields.length}`);
    }
    const [runnerLabel, name, source, pluginList] = fields;

    if (!RUNNER_LABEL_RE.test(runnerLabel)) throw fieldError(lineNo, 1, 'runner-label');
    if (!SAFE_NAME_RE.test(name)) throw fieldError(lineNo, 2, 'marketplace-name');

    const at = source.indexOf('@');
    const repo = at < 0 ? source : source.slice(0, at);
    const ref = at < 0 ? DEFAULT_REF : source.slice(at + 1);
    if (!REPO_RE.test(repo) || !REF_RE.test(ref) || ref.split('/').includes('..')) {
      throw fieldError(lineNo, 3, 'owner/repo[@ref]');
    }

    const plugins: string[] = [];
    for (const plugin of pluginList.split(',').map((item) => item.trim())) {
      if (!SAFE_NAME_RE.test(plugin)) throw fieldError(lineNo, 4, 'plugin list');
      if (!plugins.includes(plugin)) plugins.push(plugin);
    }

    const conflicting = entries.find(
      (entry) =>
        entry.runnerLabel === runnerLabel &&
        entry.marketplace.name === name &&
        (entry.marketplace.repo !== repo || entry.marketplace.ref !== ref),
    );
    if (conflicting) {
      throw new EnvPluginsError(
        `line ${lineNo}: same runner and marketplace name as line ${conflicting.line} with a different owner/repo[@ref]`,
      );
    }

    entries.push({ line: lineNo, runnerLabel, marketplace: { name, repo, ref }, plugins });
  });

  return entries;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface MergeResult {
  /** The merged config. Keys other than `plugin.marketplace` / `plugin.plugins` keep their value and order. */
  config: Record<string, unknown>;
  changed: boolean;
}

/**
 * Merge entries into a parsed config.json object (pure; the input is not mutated).
 * A marketplace entry replaces every entry of the same name, at the position of
 * the first one — the loader lets a later same-name entry win, so a leftover
 * duplicate would shadow the replacement. Plugin refs are appended once.
 */
export function mergeEnvPlugins(config: Record<string, unknown>, entries: EnvPluginLine[]): MergeResult {
  const plugin = config.plugin === undefined ? {} : config.plugin;
  if (!isPlainObject(plugin)) throw new EnvPluginsError('config.json "plugin" is not an object; left untouched');
  if (plugin.marketplace !== undefined && !Array.isArray(plugin.marketplace)) {
    throw new EnvPluginsError('config.json "plugin.marketplace" is not an array; left untouched');
  }
  if (plugin.plugins !== undefined && !Array.isArray(plugin.plugins)) {
    throw new EnvPluginsError('config.json "plugin.plugins" is not an array; left untouched');
  }

  let marketplace: unknown[] = [...((plugin.marketplace as unknown[] | undefined) ?? [])];
  const plugins: unknown[] = [...((plugin.plugins as unknown[] | undefined) ?? [])];

  for (const entry of entries) {
    const sameName = (item: unknown) => isPlainObject(item) && item.name === entry.marketplace.name;
    const first = marketplace.findIndex(sameName);
    const replacement = { ...entry.marketplace };
    if (first < 0) {
      marketplace.push(replacement);
    } else {
      marketplace = marketplace.flatMap((item, index) => {
        if (index === first) return [replacement];
        return sameName(item) ? [] : [item];
      });
    }
    for (const name of entry.plugins) {
      const ref = `${name}@${entry.marketplace.name}`;
      if (!plugins.includes(ref)) plugins.push(ref);
    }
  }

  const merged = { ...config, plugin: { ...plugin, marketplace, plugins } };
  return { config: merged, changed: JSON.stringify(merged) !== JSON.stringify(config) };
}

/**
 * Atomic write: same-directory temp (O_EXCL|O_NOFOLLOW) → fsync → chmod 0600 →
 * rename. Hand-rolled because `@soma/common/atomic-write` is not loadable
 * before `npm ci` on the target. No `.bak`: the merge only adds, and
 * sync-bundle would delete a backup on the next deploy anyway.
 */
function writeConfigAtomically(configFile: string, content: string): void {
  const dir = path.dirname(configFile);
  const tmp = path.join(dir, `.${path.basename(configFile)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      tmp,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      CONFIG_FILE_MODE,
    );
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    // openSync's mode is umask-masked, so restate the intended bits on the fd.
    fs.fchmodSync(fd, CONFIG_FILE_MODE);
    fs.closeSync(fd);
    fd = undefined;
    // rename replaces the directory entry; it never writes through a link.
    fs.renameSync(tmp, configFile);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed or never opened cleanly.
      }
    }
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function statOrNull(filePath: string, follow: boolean): fs.Stats | null {
  try {
    return follow ? fs.statSync(filePath) : fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Every non-mutating check the write depends on, shared by --check and the
 * real apply so the two cannot disagree. Returns the live config.json text, or
 * null when there is none. The one difference is deliberate: --check runs
 * before sync-bundle, which creates a missing target, so to the check a target
 * that does not exist yet is one without a config.json.
 */
function inspectTarget(targetDir: string, checkOnly: boolean): { configFile: string; raw: string | null } {
  const configFile = path.join(targetDir, 'config.json');
  const dir = statOrNull(targetDir, true);
  if (!dir) {
    if (checkOnly) return { configFile, raw: null };
    throw new EnvPluginsError('target directory not found');
  }
  if (!dir.isDirectory()) throw new EnvPluginsError('target is not a directory');
  try {
    fs.accessSync(targetDir, fs.constants.W_OK);
  } catch {
    throw new EnvPluginsError('target directory is not writable');
  }

  const file = statOrNull(configFile, false);
  if (!file) return { configFile, raw: null };
  if (file.isSymbolicLink()) throw new EnvPluginsError('config.json is a symlink; refusing to rewrite it');
  if (!file.isFile()) throw new EnvPluginsError('config.json is not a regular file; left untouched');
  return { configFile, raw: fs.readFileSync(configFile, 'utf8') };
}

export type ApplyStatus = 'none-configured' | 'no-entries' | 'unchanged' | 'applied';

export interface ApplyResult {
  /** With `checkOnly`, what the real run would do (`applied` = would apply). */
  status: ApplyStatus;
  /** Marketplace entries configured for this runner. */
  marketplaces: number;
  /** Plugin refs configured for this runner. */
  pluginRefs: number;
}

export interface ApplyOptions {
  targetDir: string;
  envPlugins: string | undefined;
  runnerLabel: string | undefined;
  /**
   * Every runner label of the channel (before any manual `targets` narrowing).
   * When given, a line naming any other label fails — it is a typo that would
   * otherwise install nothing anywhere.
   */
  channelRunnerLabels?: readonly string[];
  /** Compute everything and fail the same way, but write nothing (`--check`). */
  checkOnly?: boolean;
}

export function applyEnvPlugins(options: ApplyOptions): ApplyResult {
  const checkOnly = options.checkOnly === true;
  const entries = parseEnvPlugins(options.envPlugins);
  if (entries.length === 0) return { status: 'none-configured', marketplaces: 0, pluginRefs: 0 };

  const known = options.channelRunnerLabels;
  if (known && known.length > 0) {
    const stray = entries.find((entry) => !known.includes(entry.runnerLabel));
    if (stray) throw new EnvPluginsError(`line ${stray.line}: runner label is not a deploy target of this channel`);
  }

  const runnerLabel = options.runnerLabel?.trim();
  if (!runnerLabel) throw new EnvPluginsError('RUNNER_LABEL is not set but ENV_PLUGINS has entries');

  const selected = entries.filter((entry) => entry.runnerLabel === runnerLabel);
  const counts = {
    marketplaces: new Set(selected.map((entry) => entry.marketplace.name)).size,
    pluginRefs: new Set(selected.flatMap((entry) => entry.plugins.map((name) => `${name}@${entry.marketplace.name}`)))
      .size,
  };
  if (selected.length === 0) return { status: 'no-entries', ...counts };

  const { configFile, raw } = inspectTarget(options.targetDir, checkOnly);

  let current: Record<string, unknown> = {};
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new EnvPluginsError('config.json is not valid JSON; left untouched');
    }
    if (!isPlainObject(parsed)) throw new EnvPluginsError('config.json is not a JSON object; left untouched');
    current = parsed;
  }

  const merged = mergeEnvPlugins(current, selected);
  if (raw !== null && !merged.changed) return { status: 'unchanged', ...counts };
  if (checkOnly) return { status: 'applied', ...counts };

  // Serialized like config-loader saveConfig: insertion order, two spaces, trailing newline.
  writeConfigAtomically(configFile, `${JSON.stringify(merged.config, null, 2)}\n`);
  return { status: 'applied', ...counts };
}

const USAGE = 'usage: apply-env-plugins.js [--check] <target-dir>';

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

/** `node dist/deploy/apply-env-plugins.js [--check] <target-dir>`; returns the exit code. */
export function runCli(io: CliIo): number {
  const args = parseArgs(io.argv);
  if (!args) {
    io.error(`env-plugins: failed (${USAGE})`);
    return 1;
  }
  const { targetDir, checkOnly } = args;

  try {
    // The library treats the label set as optional (direct callers); the CLI is
    // the deploy step, where a missing set is a wiring fault — fail closed
    // instead of skipping the typo check.
    const channelRunnerLabels = (io.env.CHANNEL_RUNNER_LABELS ?? '')
      .split(/[\s,]+/)
      .filter((label) => label.length > 0);
    if (channelRunnerLabels.length === 0 && parseEnvPlugins(io.env.ENV_PLUGINS).length > 0) {
      throw new EnvPluginsError('runner label set missing (CHANNEL_RUNNER_LABELS) but ENV_PLUGINS has entries');
    }
    const result = applyEnvPlugins({
      targetDir,
      envPlugins: io.env.ENV_PLUGINS,
      runnerLabel: io.env.RUNNER_LABEL,
      channelRunnerLabels,
      checkOnly,
    });
    const counts = `${result.marketplaces} marketplace(s), ${result.pluginRefs} plugin ref(s)`;
    let outcome = '';
    switch (result.status) {
      case 'none-configured':
        outcome = 'none configured for this channel';
        break;
      case 'no-entries':
        outcome = 'no entries for this runner';
        break;
      case 'unchanged':
        outcome = `unchanged, ${counts} already in config.json`;
        break;
      case 'applied':
        outcome = checkOnly ? `would apply ${counts} to config.json` : `applied ${counts} to config.json`;
        break;
    }
    io.log(checkOnly ? `env-plugins: check ok (${outcome})` : `env-plugins: ${outcome}`);
    return 0;
  } catch (error) {
    // Only our own messages are printed verbatim; anything else (fs errors carry
    // the path) is reduced to its code or class name.
    const reason =
      error instanceof EnvPluginsError
        ? error.message
        : ((error as NodeJS.ErrnoException | undefined)?.code ?? (error as Error | undefined)?.name ?? 'error');
    io.error(`env-plugins: ${checkOnly ? 'check failed' : 'failed'} (${reason})`);
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
