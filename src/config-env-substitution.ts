/**
 * Environment variable substitution for `config.json`.
 *
 * Supported placeholder syntax in any string value of `config.json`:
 *   - `${VAR}`              → replaced with `process.env.VAR`
 *   - `${VAR:-default}`     → `process.env.VAR` if set & non-empty, else `default`
 *   - `${VAR:?error msg}`   → `process.env.VAR` if set & non-empty, else throw
 *   - `$$`                  → literal `$` (escape — produces no substitution)
 *
 * Anything that doesn't match the placeholder grammar is left verbatim so
 * existing values like `$HOME` (which is shell-only, not env-var syntax in
 * this loader) or a `$` mid-token survive unchanged. Only `${...}` triggers
 * the lookup.
 *
 * The substitution walks all JSON-shaped values (objects, arrays, primitives)
 * and rewrites `string` leaves only. Numbers / booleans / null are returned
 * untouched.
 *
 * Logging contract:
 *   - Missing required `${VAR}` (no default, no `?`) logs a warn and the
 *     placeholder is preserved verbatim. The placeholder name reaches the
 *     downstream consumer, which makes the failure visible at the request
 *     layer instead of silently producing an empty `Authorization: Basic`
 *     header that the remote MCP server would reject as 401.
 *   - The substituted VALUE is never logged. Operators put secrets in env
 *     vars precisely because they don't want them in stdout; this module
 *     respects that.
 *   - Missing-var warnings are deduped per-process per-name to avoid log
 *     spam when `loadConfig` is called repeatedly (boot + every
 *     plugin-manager save).
 */

import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

const logger = new Logger('ConfigEnvSubstitution');

/**
 * Match `${VAR}`, `${VAR:-default}`, `${VAR:?msg}`.
 *
 * Group 1 = variable name (POSIX env-var rules: alpha/underscore start).
 * Group 2 = operator: `:-` (default) or `:?` (required-with-message).
 * Group 3 = operand text (default value or error message).
 *
 * The name regex matches the same shape `parseClaudeEnv` enforces, so an
 * operator who can put a key in `claude.env` can also reference it here
 * without surprises.
 */
const PLACEHOLDER_REGEX = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|:\?)([^}]*))?\}/g;

/**
 * `$$` escape sentinel. Replaced before placeholder scanning so a literal
 * `$$` in the config never accidentally enters the placeholder grammar
 * (e.g. `$${FOO}` should yield `${FOO}`, not the substitution of FOO).
 */
const ESCAPE_SENTINEL = '\u0000__SOMA_DOLLAR_LITERAL__\u0000';

/**
 * Per-process dedupe of missing-var warnings. Module-scoped so repeated
 * `loadConfig` calls (boot + every plugin-manager save) don't re-warn
 * for the same unset placeholder. Reset only via `vi.resetModules()` in tests.
 */
const warnedMissing = new Set<string>();

/**
 * Per-process dedupe of `.env` files we've already attempted to load.
 * `dotenv.config({ path })` is a no-op for missing files but does silently
 * accumulate work; this set is the boot-time short-circuit AND the test
 * isolation hook.
 */
const triedEnvFiles = new Set<string>();

/**
 * Result type for substitution — returns the rewritten value plus the names
 * of variables that were missing (no default, no `?`). Caller decides how
 * to surface the misses — in `loadConfig` we just warn; tests assert
 * on the array directly.
 */
export interface SubstituteResult<T> {
  value: T;
  missing: string[];
}

/**
 * Recursively substitute `${VAR}` placeholders in every string leaf of a
 * JSON-shaped value. Returns a new structure; the input is never mutated.
 *
 * Throws when a placeholder uses `${VAR:?msg}` and `VAR` is unset/empty —
 * this is the operator's "fail-fast" opt-in for required secrets.
 */
export function substituteEnvVars<T>(input: T): SubstituteResult<T> {
  const missing: string[] = [];
  const result = walk(input, missing);
  return { value: result as T, missing };
}

function walk(node: unknown, missing: string[]): unknown {
  if (typeof node === 'string') {
    return substituteString(node, missing);
  }
  if (Array.isArray(node)) {
    return node.map((item) => walk(item, missing));
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = walk(v, missing);
    }
    return out;
  }
  return node;
}

/**
 * Resolve `${VAR}`, `${VAR:-default}`, `${VAR:?msg}` placeholders in a single
 * string. `$$` is honored as an escape for a literal `$`.
 *
 * Resolution rules (mirror Bash parameter expansion semantics):
 *   - `${VAR}`           : process.env[VAR] || '' if unset (and tracked as missing)
 *   - `${VAR:-default}`  : process.env[VAR] if set AND non-empty, else `default`
 *   - `${VAR:?msg}`      : process.env[VAR] if set AND non-empty, else throw
 *
 * The "set AND non-empty" rule (vs. just "set") matches dotenv loading: a
 * `.env` line `FOO=` defines FOO as `''`, and operators almost always intend
 * that to mean "fall back to default", not "use empty string". This is the
 * same trade-off Docker Compose `${VAR:-default}` makes.
 */
function substituteString(input: string, missing: string[]): string {
  // Honor `$$` as a literal-dollar escape BEFORE placeholder scan. Without
  // this, `$${FOO}` would match `${FOO}` and substitute FOO instead of
  // producing `${FOO}` literal.
  const escaped = input.split('$$').join(ESCAPE_SENTINEL);

  const replaced = escaped.replace(PLACEHOLDER_REGEX, (full, name, operator, operand) => {
    const raw = process.env[name];
    const isPresent = raw !== undefined && raw !== '';

    if (isPresent) {
      return raw as string;
    }

    if (operator === ':-') {
      return operand ?? '';
    }

    if (operator === ':?') {
      const msg = (operand ?? '').trim() || `required env var ${name} is not set`;
      throw new Error(`config.json: ${msg} (placeholder \${${name}:?...})`);
    }

    // Bare `${VAR}`: keep placeholder visible. Track as missing so the
    // caller can warn (deduped).
    if (!missing.includes(name)) missing.push(name);
    return full;
  });

  return replaced.split(ESCAPE_SENTINEL).join('$');
}

/**
 * Load `.env` files in the priority order:
 *   1. `${cwd}/.env`
 *   2. `${dirname(configFile)}/.env`
 *   3. `${dirname(dirname(configFile))}/.env`        (parent of config dir)
 *
 * dotenv default behavior is "first writer wins" — values already in
 * `process.env` (set by OS or an earlier dotenv.config call) are NOT
 * overwritten. So loading in priority order means the highest-priority
 * file's values take effect.
 *
 * Files that don't exist are silently skipped. Files we've already tried
 * (per-process) are skipped — important because `env-paths.ts` already
 * called `dotenv.config({ path: ENV_FILE })` at module load, and we don't
 * want to re-parse that file on every `loadConfig` call.
 *
 * Returns the absolute paths that contributed at least one variable (after
 * the dedupe), for logging.
 */
export function loadDotenvForConfig(configFile: string): string[] {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(path.dirname(configFile), '.env'),
    path.resolve(path.dirname(path.dirname(configFile)), '.env'),
  ];

  const loaded: string[] = [];
  // Use a local Set in addition to the module-scoped one so test isolation
  // (which clears `triedEnvFiles` via vi.resetModules) still produces a
  // fresh per-config dedupe within a single call.
  const seenThisCall = new Set<string>();

  for (const candidate of candidates) {
    if (seenThisCall.has(candidate)) continue;
    seenThisCall.add(candidate);
    if (triedEnvFiles.has(candidate)) continue;
    triedEnvFiles.add(candidate);

    if (!fs.existsSync(candidate)) continue;

    const result = dotenv.config({ path: candidate });
    if (result.error) {
      logger.warn('Failed to parse .env', { path: candidate, error: result.error.message });
      continue;
    }
    const count = result.parsed ? Object.keys(result.parsed).length : 0;
    logger.info('Loaded .env for config.json substitution', { path: candidate, vars: count });
    loaded.push(candidate);
  }

  return loaded;
}

/**
 * Emit one warn per missing placeholder name — deduped across the lifetime
 * of the process. Keeps boot logs quiet under repeated loads while still
 * surfacing the first occurrence so an operator notices.
 *
 * The placeholder NAME is logged but the (substituted) VALUE never is —
 * because the value is the secret operators are trying to keep out of logs.
 */
export function warnMissingPlaceholders(missing: string[], source: string): void {
  for (const name of missing) {
    if (warnedMissing.has(name)) continue;
    warnedMissing.add(name);
    logger.warn(
      `config env-var \${${name}} not set; placeholder kept verbatim — downstream call will fail with that text`,
      { source },
    );
  }
}

/**
 * Test-only hook to reset module-scoped dedupe state. Tests that exercise
 * the warn-once / load-once behavior call this in `beforeEach` instead of
 * relying on `vi.resetModules`, which is heavier and doesn't work for
 * default-imported modules in some Vitest configurations.
 */
export function __resetForTests(): void {
  warnedMissing.clear();
  triedEnvFiles.clear();
}
