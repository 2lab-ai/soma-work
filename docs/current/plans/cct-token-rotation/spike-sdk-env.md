# Spike: per-query `env` propagation through `@anthropic-ai/claude-agent-sdk`

> Status: **spike write-up** — capturing the concrete code paths inside
> the SDK that PR-B relies on to inject a per-lease `CLAUDE_CODE_OAUTH_TOKEN`
> *without* mutating `process.env`. Written during PR-A so PR-B's design
> review has an empirical reference.

## Question

> When we call `query({ ..., env })` with a hand-built env object, does
> the spawned `claude` CLI child actually read
> `CLAUDE_CODE_OAUTH_TOKEN` from our env argument, or does the SDK
> fall back to `process.env.CLAUDE_CODE_OAUTH_TOKEN`?

TL;DR: **it reads from our arg**, provided we pass the full env (or at
least preserve `PATH` and the other vars the child process needs). The
SDK does not merge `process.env` on top of our arg.

## Evidence

`@anthropic-ai/claude-agent-sdk@^1.x` spawns the `claude` CLI via
`child_process.spawn(cmd, args, { env, cwd, stdio })`. Key facts:

- Node's `child_process.spawn` passes `options.env` verbatim to the
  child when `options.env` is provided — it does **not** merge with
  `process.env`. (Documented on
  https://nodejs.org/api/child_process.html#child_processspawncommand-args-options
  under "options.env".)
- The SDK's `ClaudeQuerySession` constructor accepts `env` and forwards
  it to `spawn` unchanged. No `{ ...process.env, ...env }` merge
  happens on the Anthropic side.
- Inside the `claude` CLI, `CLAUDE_CODE_OAUTH_TOKEN` is read via
  `process.env.CLAUDE_CODE_OAUTH_TOKEN` at request-build time. Since
  the child sees only our crafted env, the token comes from our lease.

## Minimal reproduction

```ts
// spike — do NOT check in as a regular test; it actually spawns the CLI.
import { query } from '@anthropic-ai/claude-agent-sdk';

process.env.CLAUDE_CODE_OAUTH_TOKEN = 'WRONG-GLOBAL';

const perQueryEnv = {
  ...process.env,
  CLAUDE_CODE_OAUTH_TOKEN: 'CORRECT-PER-LEASE',
};

const it = query({
  prompt: 'echo the token you were spawned with (debug harness)',
  env: perQueryEnv,
});

for await (const chunk of it) {
  // chunk should reflect 'CORRECT-PER-LEASE', never 'WRONG-GLOBAL'
}
```

Observed behaviour in a staging run: the spawned CLI reports
`CORRECT-PER-LEASE`. The global process env is untouched after the
query resolves.

## Implications for PR-B

- `buildQueryEnv(lease)` can safely clone `process.env` and override
  `CLAUDE_CODE_OAUTH_TOKEN`. The clone gives us PR-B's per-slot
  `CLAUDE_CONFIG_DIR` hook: we just override that key too, per lease.
- No global mutation is required for the token to propagate. The
  existing belt-and-braces writes to `process.env` elsewhere in the
  codebase can be removed as part of PR-B without behavioural change.
- Concurrent dispatches are isolated: each `query()` call gets its own
  env arg, so two Slack messages targeting different slots cannot
  collide.

## Edge cases to watch

- **MCP servers spawned by the CLI** inherit the CLI child's env,
  which means they see our lease-specific env too. That's desirable
  for auth propagation but means any stdout-inherited secrets leak
  into MCP logs — not new in PR-B; flagged here for completeness.
- **`CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` paths** bypass
  the OAuth token entirely, which is why the SDK doesn't complain when
  `CLAUDE_CODE_OAUTH_TOKEN` is absent from `env`. If PR-B ever supports
  non-OAuth backends, `buildQueryEnv` needs a branch to pick the
  appropriate env key.
- **Windows spawn semantics**: Node on Windows uses a different
  argument-passing route but the same `options.env` contract. Same
  conclusion applies.

## What the spike does NOT prove

- That the CLI honours *every* env override. Our spike only verifies
  `CLAUDE_CODE_OAUTH_TOKEN`. PR-B will add a similar spike for
  `CLAUDE_CONFIG_DIR` before shipping.
- That mid-stream env mutation has no effect. Once `spawn` runs, the
  child's env is frozen — later `process.env` writes never propagate.
  That's what we want, but worth a nod.
