# plugin-split — loop

Driver for the converge rounds. Round 0 = spec fixed (2026-09-14 morning). Round 1 = WU-1..3 implemented on this branch (2026-09-14, PR-only per user; merge is the user's review gate).

## Build facts (measured 2026-09-14, worktree `.worktrees/prd-plugin-split` @ `c0a3bac`)

- gate: `npm test` (vitest) · `npm run build` (check → somalib → packages → tsc → asset copies)
- plugin contract tests: `src/plugin/__tests__/zworkflow-default.test.ts`,
  `src/__tests__/no-duplicate-plugin-assets.test.ts`, `src/__tests__/skill-refs.test.ts`,
  `src/__tests__/no-todo-guard.test.ts`, `src/__tests__/config-loader.test.ts`,
  `src/plugin/__tests__/config-parser.test.ts` — all pin `src/local` or the `zworkflow` name
- census: `python3 ~/2lab.ai/zbrain/scripts/plugin-dep-census.py <plugin-root>`
- `git worktree list` shows 4 unrelated live worktrees; this branch is `prd/plugin-split`

## Work units (file ownership disjoint; one agent per WU; DEV.md §1/§3)

| WU | branch | scope | depends on |
|---|---|---|---|
| WU-1 | `feat/plugin-local` | `git mv src/local plugin/local`; plugin.json name `local` 2.0.0; `bundled.ts` root-relative path; `package.json` copy; `defaults.ts`; literals in claude-handler / query-env-builder / plugin-manager / plugins-handler / config.example.json; rewrite the 6 pinned tests | — |
| WU-2 | same PR as WU-1 | `plugin/core` skeleton (name `core` 2.0.0); `git mv` the 17 verdict units; `core:` references from `local` callers; marketplace + defaults + bundled entries for `core`; build copy | WU-1 |
| WU-3 | same PR | closure test: for every unit under `plugin/core`, census reports no `direct:`/`propagated:` reason; fails the build otherwise | WU-2 |
| WU-4 | `feat/plugin-core-t1` … `-t3` | promotion tranches T0–T3 from `03-migration-verdict.md`, one PR each, each gated by WU-3 | merge of WU-1..3 |
| WU-5 | `feat/plugin-core-stv` | stv rewrites → census → `core`; `stv@oh-my-claude` out of `DEFAULT_PLUGINS`; oh-my-claude README deprecation | WU-3 |
| WU-6 | zbrain commit(s) | zbrain candidates → census → Sanitize scan → `core`; zbrain `zworkflow:` → `core:`/`local:` | WU-1..3 shipped |
| WU-7 | release | soma-work release cut, 4 deployments reinstalled (env-channel release notes), `/plugins` smoke, personal-machine plugin cache swap | WU-1..3 merged |

WU-1 + WU-2 + WU-3 are one atomic PR: the marketplace tracks `main`, and a `main` commit where
`zworkflow` is gone and `core` is not yet registered breaks every external install.

## Round plan

- Round 1: WU-1..3 → gates green → dual-engine review → merge → WU-7 (user gate on the release
  tag) → observed: `/plugins` output in the bot, `local:z` and `core:structurize` transcripts.
- Round 2: WU-4 tranches, each independently accepted or closed as permanent `local`.
- Round 3: WU-5, WU-6.

## Gap matrix (round 1 — after WU-1..3, before merge)

| acceptance (01-spec §Acceptance) | state | evidence |
|---|---|---|
| 1 layout | closed on branch | `plugin/local` (38 skills · 9 agents · 6 commands · 4 hooks), `plugin/core` (8 skills · 7 agents · prompts/reviewer-persona.md); `src/local` gone |
| 2 core closure clean | closed on branch | `src/__tests__/core-plugin-closure.test.ts` 19 tests green; census on `plugin/core`: 0 direct disqualifications |
| 3 contract tests | closed on branch | `plugin-split.test.ts` (renamed) + 6 repointed; full vitest 0 failed / 9916 passed (baseline 9895; +21 = plugin/** colocated tests re-included via vitest.config.ts) |
| 4 build copies | closed on branch | `npm run build` → `dist/local` + `dist/core`; `require('./dist/plugin/bundled.js').BUNDLED_PLUGINS` = {local: …/dist/local, core: …/dist/core} |
| 5 bot loads both | open | — |
| 6 no `zworkflow:` refs | soma-work closed on branch (`grep -rn zworkflow: src plugin` = 0); zbrain open (WU-6) | zbrain: ≥6 skills, 3 memory files |
| 7 defaults list | closed on branch | `DEFAULT_PLUGINS` = superpowers, stv, local@soma-work, core@soma-work |

## User decisions carried (defaults apply unless vetoed)

- D0 plugin names `local` / `core` (user shorthand `zworkflow@local` → plugin `local`).
- D1 tranches T0–T3 run in order; each may end as permanent `local`.
- D2 stv rewrites enter only via census.
- D3 `stv@oh-my-claude` leaves defaults after WU-5.
- D4 old `zworkflow@soma-work` marketplace entry removed at WU-1 merge; migration note in release notes.

## Verify log

### Round 1 — 2026-09-14 (branch `prd/plugin-split`, PR-only)

Corrections discovered while implementing (both recorded in `03-migration-verdict.md`):
- `commands/review-pr` stays local — `oracle-reviewer` (llm__chat) is an always-applicable reviewer; census had no command→command edges.
- `agents/zkorean` stays local — the agent reads the local skill's `references/rules.md`; entangled pair.
- `prompts/reviewer-persona.md` moves with `agents/reviewer` (sole user) — caught by the closure test's path-resolution rule.

Coverage holes opened by the move and closed in the same PR: `vitest.config.ts` include and `biome.json` includes (+`npm run check`) now cover `plugin/**` — 15 colocated test files had gone silently dead.

Gates (run by the dispatcher, not taken from agent reports):
- `npx tsc --noEmit` OK · `npx biome check src/ somalib/ scripts/ packages/ plugin/` 0 errors (1046 files)
- `npx vitest run` 0 failed / 9916 passed
- `npm run build` OK; `dist/local`, `dist/core` present; bundled resolver returns both in bundle mode
- `plugin-dep-census.py plugin/core`: 0 direct disqualifications; closure test green

Not done in this round (by design): bot-side smoke (acceptance 5) — needs a deployed bot; zbrain namespace migration (WU-6); stv (WU-5, user: do not touch); release (WU-7).
