# Independent correctness review — auth capacity overview

Reviewer: single Fable independent review. Explicitly NOT a trinity unanimous
review and NOT an Opus fallback. Model selected by the parent session (no user
message in evidence proves direct model selection). No llm MCP, no other agents.
Date: 2026-09-16 (round 1 full + bounded rounds 2-3). Read-only review; no edits
made to source.

## Scope reviewed

Working diff in `soma-work_20260916_auth` branch `feat/auth-capacity-overview`:

- `src/auth/llmux-client.ts` (type additions: group/type docs, `usage_control`)
- `src/slack/auth/actions.ts`, `src/slack/auth/builder.ts`, `src/slack/auth/views.ts`
- `src/slack/z/topics/auth-topic.ts`, `src/slack/z/topics/cct-topic.ts`
- `src/slack/cct/actions.ts` (round-3 continuity fix), `src/slack/commands/auth-handler.ts` (comments)
- Untracked: `src/slack/auth/capacity.ts`, `src/slack/cct/auth-origin.ts`,
  tests `src/slack/auth/__tests__/{actions,builder.capacity,overview.integration}.test.ts`,
  `src/slack/z/topics/__tests__/auth-topic.ccp-embed.test.ts`,
  `src/slack/cct/__tests__/{auth-origin,actions.auth-origin}.test.ts`

Checked against `.prd/auth-capacity-overview/spec.md` acceptance A1–A9 and `ssot.md`
T1–T3. Round-3 pinned state (md5): cct/actions.ts `30c47d57ad0c22155e886b38244e312f`,
cct-topic.ts `a680c2455a3989286f38e5bc5fd279ba`, auth-topic.ts
`5cb75ffdb27d33c4e1c2eed233ead115`, auth/builder.ts `33f695f01b65e776e7ace9a54d8f00c0`,
capacity.ts `a989aaa5ea1d46e7f57a149b18a89707`, auth/actions.ts
`7ffd3656bfa63e54d2558611abc93081`, cct/builder.ts (unmodified from HEAD)
`6c55c5babbcfcade05d464b84d4482a4`.

## Verification actually run (not only evidence logs)

- Round 1: `tsc --noEmit` clean; 4 auth suites green. Full `vitest run` → 21
  failures in `query-env-builder` / `slack-handler` / `token-manager`; re-run of
  those three suites against a pristine `git archive HEAD` export produced the
  IDENTICAL 21 failures → **baseline environment issues, not regressions from
  this diff** (parent runs the environment diagnostic + clean full release run).
- Round 2 (bounded): `tsc --noEmit` clean; 7 suites / 99 tests green incl.
  `auth-topic.ccp-embed.test.ts` and `overview.integration.test.ts`.
- Round 3 (bounded, final): `tsc --noEmit` clean; **17 suites / 398 tests
  green**: all of `src/slack/cct/__tests__/` (incl. pre-existing
  `actions.test.ts` 58 and `builder.test.ts` 137 — direct-card flows show no
  regression), `auth-origin.test.ts` (8), `actions.auth-origin.test.ts` (14),
  `auth-topic.ccp-embed.test.ts` (13), `auth-topic.test.ts` (12),
  `cct-topic.test.ts` (21), all `src/slack/auth/__tests__/` suites.
  No full-suite rerun in bounded rounds, per coordinator; parent owns the
  clean full release run.

## FINAL VERDICT: APPROVE — both MUST-FIXes verified resolved

### MUST-FIX 1 — RESOLVED (round 2): ccp block budget via slot pagination

Legacy slots are slot-paginated through the wrapper page state
(`renderCctCard` `embed: {page, pageSize: 8}`) — windowed, never
block-truncated; every slot reachable (pinned: 20 slots, exactly one page
each); page clamping handles NaN/negative/stale out-of-range; composed card
pinned <= 49 blocks at 24 rich slots (admin and readonly; 1 block reserved for
the action banner). Embed rendering strips only `cct_refresh_card` (empty
actions rows dropped — Slack rejects zero-element actions blocks). Direct
`cct` output unchanged; its pre-existing 51-block direct rendering at 24 rich
slots is locked as baseline out of scope (#701 contract covers <= 15 slots).

### MUST-FIX 2 — RESOLVED (round 3): embedded mutation continuity (`auth-origin`)

Previously, embedded legacy mutation clicks re-rendered the bare unpaginated
CCT card (wrapper wiped, cap re-broken on large pools). Verified fix:

- **Codec** (`src/slack/cct/auth-origin.ts`): the frozen `cm:<mode>|<payload>`
  codec is NOT extended; the payload is wrapped as `ao:<page>|<inner>` and
  modal `private_metadata` as JSON `{cctAuthOrigin:{page,channel,ts},payload}`.
  Strict-shape decode: malformed `ao:` forms and foreign JSON fail safe to
  plain payload / `origin: null` (8 codec tests incl. `|`/`:` in inner
  payloads, invalid-page/empty-inner encode rejection).
- **Stamping** (`cct-topic.ts` `stampAuthOriginOnActionValues`): every
  `cm:`-tagged value on the embedded card is stamped — per-slot Activate /
  Attach / Detach / Remove and card-level Next / Add / Refresh-All are all
  `cm:`-tagged in `cct/builder.ts` (lines 781-806, 959-972), so no mutation
  control escapes; non-tagged values (cancel, auth nav JSON) untouched; stamp
  runs inside `renderCctCard` before the wrapper nav is appended (no
  double-wrap). Direct cards never pass through.
- **Wrapper retention** (`cct/actions.ts`): block_action mutations
  (activate / detach / next / refresh_usage_all) with an origin route to
  `renderAuthWrapperInPlace` → `renderAuthCard` at the origin page; modal
  opens (add / remove / attach) stamp origin + card surface into
  `private_metadata` (preserved across the `kind_radio` `views.update`
  replacement); modal submits with origin `chat.update` the auth wrapper at
  the stored surface instead of posting a bare ephemeral card. `origin: null`
  → byte-identical direct-card paths (pinned per route; 14 routing tests).
- **Authorized decode**: the `ao:` marker carries ONLY a page (digit-validated,
  floored, clamped by the embed renderer); viewer mode never derives from it.
  Block_action mode comes from the pre-existing #803 `cm:` codec via
  `resolveRenderMode`, and `renderAuthCard` independently re-checks
  `isAdminUser` server-side — a forged `cm:admin|ao:N|...` from a non-admin
  re-renders the READONLY wrapper. Modal-submit path renders `admin` but is
  demoted server-side the same way. Embedding widens no authorization surface
  (mutation handlers themselves are the pre-existing #803 surface, untouched).
- **Errors**: `rerenderAuthWrapperAt` catches and warns on update failure;
  `refresh_usage_all` retains its ephemeral banner fallback when the surface
  is unknown/failed (partial-failure banner not dropped — tested with the
  all-failed banner-first assertion).
- **50-block bound**: wrapper re-renders go through the paginated ccp branch
  (<= 49 pinned incl. banner reserve); banner-prefixed refresh_usage_all path
  stays within the reserved slot.

## Verified sound (rounds 1-3, re-confirmed on final files)

- Authority guards: all auth mutation routes admin-gated (`requireAdmin`); nav
  routes re-check the actor; `renderAuthCard` demotes forged
  `viewerMode:'admin'` (incl. embedded CCT card); fail-safe nav-state parsing.
  Admin default = readonly overview, opt-in admin mode (A6/A7).
- llmux pagination: grouped-order windowing correct, all accounts reachable
  (A9); Claude/Codex/Grok summaries on every page from the complete pool.
- Capacity semantics: expired/invalid windows unknown, never replenished (A3);
  no invented token balances (A2); Grok/apikey → "미제공" never zero/unlimited,
  rate-limit windows never shown as subscription resets (A5); 미확인 =
  `total - available - blocked` (disjoint, non-negative); zero vs unknown
  preserved for Codex manual reset credits; reclaimed %p with caveats (A4);
  inputs not mutated (A1); `authText` escaping throughout.
- Entry wiring: naked `auth` and `/z auth` reach the same renderer (A8);
  `overview.integration.test.ts` exercises the emitted nav buttons through
  real `AuthHandler`/binding/actions entry points; single Bolt registration.

## Non-blocking observations (optional; none block release)

1. `boundedText` truncation at 2800 chars can bisect a `<!date^…>` token in a
   pathologically long section. Cosmetic.
2. `actions.test.ts` "malformed page payload" test title says "readonly" but
   correctly asserts admin for an admin actor. Title-only.
3. Admin clicking a pre-T3 card's plain-`'refresh'` value lands on the
   readonly overview (documented fail-safe).
4. Modal submit whose origin lacks a card surface (e.g. wrapper rendered on an
   ephemeral surface where `container.message_ts` is absent) early-returns in
   `rerenderAuthWrapperAt` — the mutation lands but no card feedback is posted.
   Degraded-feedback edge only; direct-card flows keep the ephemeral card.
