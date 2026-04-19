# Agent-Island OAuth Extraction (PR-C scope-setter)

> Status: **design note** — not implemented by PR-A. This file exists so
> PR-A's AuthKey rename lands with a clear target for the follow-on work
> and future reviewers can see the extraction plan before it ships.

## Motivation

Today `src/oauth/` is coupled to Slack through two seams:

1. It imports `src/logger.ts`, which imports `config.ts`, which pulls the
   Slack Bolt configuration. Anything that needs `refreshClaudeCredentials`
   therefore transitively loads the Slack SDK.
2. The CAS-write semantics live in `cct-store`, which is co-hosted with
   `token-manager` — a module whose public API still references Slack
   `ActiveTokenInfo` shapes for the `/z cct` card.

For agent-session (future island: `agent-session/`), cron workers, and
the dashboard backend we need a pure-TS `oauth-island` that only knows
how to:

- Refresh an `OAuthAttachment` given its current shape + `client_id`.
- Validate OAuth scopes (`scope-check.ts`).
- Parse rate-limit headers from an Anthropic response (`header-parser.ts`).

None of those ingest Slack, Bolt, or the Slack-flavoured logger.

## What PR-A already did

To make the extraction mechanical in PR-C, PR-A:

- **Moved `OAuthCredentials` to `src/oauth/refresher.ts`**. The persisted
  shape (`OAuthAttachment`) lives in `src/auth/auth-key.ts` and is the
  only thing that references the store. The HTTP DTO does not.
- **Defined `AuthKey` / `OAuthAttachment`** in a path that doesn't
  depend on Slack. `src/auth/auth-key.ts` has zero runtime imports from
  `src/slack/**`.
- **Kept `acknowledgedConsumerTosRisk: true` as a literal** on
  `OAuthAttachment`. That guarantees any extracted refresher can round-
  trip the attachment without re-prompting the user. The refresher's
  output (`OAuthCredentials`) deliberately does *not* carry the ack —
  the caller is responsible for setting it when persisting.

## What PR-C will do

1. **Carve out `src/oauth/**` into `agent-island-oauth/`** (or
   equivalent top-level package), exporting:
   - `refreshClaudeCredentials(current): Promise<OAuthCredentials>`
   - `OAuthRefreshError` class
   - `scopeCheck(scopes): ScopeReport`
   - `parseRateLimitHeaders(headers): RateLimitInfo`
   - Types: `OAuthCredentials`
2. **Introduce a dependency-injection seam** on
   `TokenManager.refreshSlot(keyId)` so the manager doesn't import the
   refresher directly — it calls an injected `OAuthRefresher` function.
   Slack side supplies the real island impl; tests supply a stub.
3. **Replace the transitive Slack logger import** with a tiny
   `IslandLogger` interface (debug / info / warn / error) that the
   extracted package asks the caller to provide.
4. **Ship the extracted package as a workspace package** so
   agent-session and the dashboard can depend on `@2lab/oauth-island`
   (or equivalent) directly, without going through the Slack bundle.

## Open questions for PR-C

- Do we keep `usage.ts` in the island, or does it stay with
  `token-manager` (since usage requires the store's backoff ledger)?
  Leaning: *stay*, because the backoff state lives in `SlotState` and
  that belongs to the store.
- Does the island own the `CLAUDE_OAUTH_CLIENT_ID` constant? Yes —
  it's per-refresher-flavour, so an `api.anthropic.com` refresher and
  a self-hosted variant would ship with different clients.
- Does the island expose `refreshClaudeCredentialsWithRetry` with the
  hardcoded 2-attempt, 1-min retry window? Lean *no* — retry is a
  caller policy.

## Non-goals (explicitly deferred)

- Refactoring `src/credentials-manager.ts` into the island. It owns the
  lease contract and will stay near `TokenManager`.
- Moving `src/auth/query-env-builder.ts`. It's thin and stable; can
  ship as-is in the Slack app.
- Any change to the v2 schema or the migrator. The island only
  manipulates `OAuthCredentials` in memory — the store shape is
  PR-A-final.
