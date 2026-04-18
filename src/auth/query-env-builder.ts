import type { SlotAuthLease } from '../credentials-manager';

/**
 * Result of {@link buildQueryEnv}: a fresh env map suitable for the Claude
 * Agent SDK `query()` call's `options.env`.
 *
 * The map is a **standalone copy** — mutating it has no effect on
 * `process.env`, and two results from distinct leases do not share object
 * identity, so concurrent dispatches cannot interfere with each other's
 * credentials.
 */
export interface QueryEnvResult {
  env: Record<string, string>;
}

/**
 * Build a per-call env map that carries the lease's fresh access token to the
 * Claude Agent SDK via `options.env`.
 *
 * Why this exists:
 *   Prior to this seam, `TokenManager.mirrorToEnv()` mutated
 *   `process.env.CLAUDE_CODE_OAUTH_TOKEN` as a shared global. Two concurrent
 *   `query()` calls holding leases on different CCT slots would race each
 *   other — whichever wrote last won, leaking one tenant's token into the
 *   other tenant's subprocess. `buildQueryEnv()` replaces that with a
 *   per-spawn env map, scoped to a single `query()` invocation.
 *
 * Contract:
 *   - NEVER mutates `process.env`.
 *   - Returns a new object each call; callers hold no aliases to a shared
 *     map, so parallel calls are trivially isolated.
 *   - `CLAUDE_CODE_OAUTH_TOKEN` is always set to `lease.accessToken`.
 *     For both current lease kinds (`setup_token`, `oauth_credentials`) this
 *     is the value the Agent SDK hands to the Claude CLI over OAuth.
 *   - All other `process.env` variables are copied through untouched, so the
 *     subprocess still sees PATH, NODE_ENV, HOME, etc.
 *
 * Non-goals for this module (tracked in #575 PR-2 / v2.1):
 *   - `api_key` lease kind + `ANTHROPIC_API_KEY` env var.
 *   - `CLAUDE_CONFIG_DIR` credential-directory isolation.
 */
export function buildQueryEnv(lease: SlotAuthLease): QueryEnvResult {
  // Shallow-copy process.env into a plain record. process.env is a proxy
  // whose enumerable string values are what Node forwards to subprocesses,
  // so copying owned string entries is both correct and explicit.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }

  // Override the token slot on the per-call map only. process.env is never
  // touched.
  env.CLAUDE_CODE_OAUTH_TOKEN = lease.accessToken;

  return { env };
}
