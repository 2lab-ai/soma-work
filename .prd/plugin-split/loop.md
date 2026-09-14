# plugin-split — loop

Driver for the converge rounds. Round 0 = this document; no code has moved.

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

## Gap matrix (round 0)

| acceptance (01-spec §Acceptance) | state | evidence |
|---|---|---|
| 1 layout | open | `src/local` present, `plugin/` absent |
| 2 core closure clean | open | verdict exists, `plugin/core` does not |
| 3 contract tests | open | 6 tests pin old layout |
| 4 build copies | open | `cp -r src/local dist/` in `package.json:13` |
| 5 bot loads both | open | — |
| 6 no `zworkflow:` refs | open | zbrain: ≥6 skills, 3 memory files; soma-work: 3 src files |
| 7 defaults list | open | `defaults.ts:29-31` |

## User decisions carried (defaults apply unless vetoed)

- D0 plugin names `local` / `core` (user shorthand `zworkflow@local` → plugin `local`).
- D1 tranches T0–T3 run in order; each may end as permanent `local`.
- D2 stv rewrites enter only via census.
- D3 `stv@oh-my-claude` leaves defaults after WU-5.
- D4 old `zworkflow@soma-work` marketplace entry removed at WU-1 merge; migration note in release notes.

## Verify log

(empty — round 0)
