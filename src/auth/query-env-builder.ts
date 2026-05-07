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
 * Reserved env keys that operators MUST NOT set via `config.json#claude.env`.
 *
 * Two reasons a key lands here:
 *   1. **Auth ownership** — `CLAUDE_CODE_OAUTH_TOKEN` is owned by the lease;
 *      `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` would silently re-route
 *      auth to a different provider/path.
 *   2. **Subprocess integrity** — `CLAUDE_CONFIG_DIR` redirects credential
 *      state, `CLAUDE_CODE_USE_BEDROCK`/`USE_VERTEX` re-route traffic to a
 *      different provider, and `HTTP_PROXY` / `HTTPS_PROXY` /
 *      `NODE_EXTRA_CA_CERTS` widen the TLS-trust attack surface.
 *
 * Single source of truth — consumed by:
 *   - {@link setQueryEnvAdditional} / {@link buildQueryEnv} (build-time
 *     defense in depth: lease token override happens last)
 *   - `parseClaudeEnv()` in `config-loader.ts` (load-time drop with
 *     warn so operators learn about the conflict)
 */
export const RESERVED_LEASE_KEYS: readonly string[] = Object.freeze([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NODE_EXTRA_CA_CERTS',
]);

/**
 * Module-level state for operator-controlled additional env (config.json#claude.env).
 *
 * Set ONCE at boot from `index.ts` via {@link setQueryEnvAdditional}; read
 * concurrently by every {@link buildQueryEnv} call across all 7 SDK call
 * sites in the repo (claude-handler ×2, conversation/* ×3, slack/z/topics/*).
 *
 * Mutability scope:
 *   - Single mutation point at process startup → no read/write races in steady
 *     state.
 *   - Tests reset between cases via `beforeEach(() => setQueryEnvAdditional({}))`.
 *
 * Hot reload is intentionally NOT supported. Operators must restart the
 * process after editing `config.json#claude.env`. This is documented in
 * README.md and `config.example.json`.
 */
let _additionalEnv: Record<string, string> = {};

/**
 * Install the operator-controlled additional env (parsed from
 * `config.json#claude.env`). Defensively clones the input so post-call
 * mutation by the caller cannot leak into module state.
 *
 * Restart required for changes — there is no watcher.
 */
export function setQueryEnvAdditional(env: Record<string, string>): void {
  _additionalEnv = { ...env };
}

/**
 * Read-only accessor for the currently installed additional env. Returned
 * object is a defensive clone, so callers cannot mutate module state.
 *
 * Used by tests and the boot-time timing log; not by `buildQueryEnv` itself
 * (which reads the module variable directly to avoid an extra clone per
 * dispatch).
 */
export function getQueryEnvAdditional(): Record<string, string> {
  return { ..._additionalEnv };
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
 * Layering (last write wins):
 *   1. Shallow copy of `process.env` (PATH, HOME, NODE_ENV, etc.).
 *   2. Operator-controlled additional env from `config.json#claude.env`,
 *      installed via {@link setQueryEnvAdditional}. Operator intent overrides
 *      the inherited shell environment.
 *   3. `CLAUDE_CODE_OAUTH_TOKEN = lease.accessToken`. ALWAYS last — defense
 *      in depth even if the load-time denylist in `parseClaudeEnv` is
 *      bypassed, the lease's fresh token cannot be overridden by config.
 *
 * Contract:
 *   - NEVER mutates `process.env`.
 *   - Returns a new object each call; callers hold no aliases to a shared
 *     map, so parallel calls are trivially isolated.
 *   - `CLAUDE_CODE_OAUTH_TOKEN` is always set to `lease.accessToken`.
 *     For both current lease kinds (`setup_token`, `oauth_credentials`) this
 *     is the value the Agent SDK hands to the Claude CLI over OAuth.
 *   - All other `process.env` variables are copied through, then the
 *     operator-controlled additional env overlays them.
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

  // Layer 2 — operator-controlled additional env. Already validated +
  // denylist-filtered by `parseClaudeEnv` at load time; values are guaranteed
  // strings. Overlays the inherited process.env.
  for (const [key, value] of Object.entries(_additionalEnv)) {
    env[key] = value;
  }

  // Layer 3 — lease token override. ALWAYS last. Defense in depth: even if a
  // future code path forgets to deny `CLAUDE_CODE_OAUTH_TOKEN` at load time,
  // the lease's fresh token wins here. process.env is never touched.
  env.CLAUDE_CODE_OAUTH_TOKEN = lease.accessToken;

  return { env };
}
