# Auth capacity verification

Status: in-progress
Date: 2026-09-16
[Spec](../06-auth-capacity-spec.md) · [SSOT](ssot.md) · [Trace](trace.md) · [Review](review.md)

## Observed local receipts

The final source tree passed the following directly executed checks. These are local checks, not a deployment receipt.

- `npx tsc --noEmit`: exit 0 (`auth-evidence/typecheck-final.log`)
- `npm run build`: exit 0, including Biome and workspace compilation (`build-final.log`)
- `npm run test:release`: exit 0; 531 files passed, 1 skipped; 10,583 tests passed, 5 skipped; 180.21 seconds (`full-release-reviewed.log`, started 2026-09-16 19:45:06 local time). This includes the final invalid-reset and legacy-refresh corrections; the earlier 10,566-test run predates them.
- Final auth/CCT/topic/action regression sweep: 63 files, 879 tests passed (`final-integration.log`)
- Independent Fable review: APPROVE after correcting both legacy composition defects; [review.md](review.md) records the findings and bounded rechecks. This is not a three-engine consensus.
- `git diff --check`: exit 0
- `npx calldiff@0.5.0 diff origin/main --file src/slack/z/topics/auth-topic.ts --max-depth 2`: exit 0; final report in `calldiff-pr.log`. Base is `94d44e3`. The base changed only `.prd/slack-agent-ui/verification.md` after the successful source checks; source and test contents are unchanged by that rebase.

Logs and screenshots are in the session workspace `auth-evidence/`, outside the repository. No live credentials are included in committed fixtures or documents.

## Red to green evidence

- T1–T2: `capacity-red.log` (9 behavioral failures), `capacity-extra-red.log` (3 additional failures), `paging-red.log` and `preview-red.log` (one each) preceded the corresponding source fixes.
- T3: `t3-red.log` captured 28 failures before readonly-default and explicit admin navigation were implemented.
- T3 legacy composition: `t3-ccp-embed-red.log` captured 7 failures, including 56-block admin and 52-block readonly compositions. Slot pagination preserves reachability and the message limit.
- T3 legacy mutation continuity: `t3-mutation-red.log` captured 12 behavior failures and the absent codec. `t3-mutation-green.log` records 35 passing codec, action and embedding tests.
- T2 final review: `reset-validation-red.log` captured 6 invalid absolute timestamp failures; all 10 `capacity.reset.test.ts` cases now pass. Only omitted/null/zero timestamps permit relative fallback.
- T2/T3 final review: `legacy-refresh-red.log` captured 4 missing readonly fetch/feedback failures with attached-slot fixtures. All 7 `overview.refresh.test.ts` cases now pass, including new values, one non-force fetch, page/view retention and cached/error notice. Combined auth/CCT/topics: 37 files / 590 tests passed.
- Final GREEN: the complete release suite above contains every committed regression test.

## Reproducible test environment

The bot shell carries runtime credentials and config. Running the suite in that ambient environment is not isolated. All 21 unrelated failures were reproduced on both base and worktree with synthetic contamination; both passed 201/201 with clean environment.

A first full isolated run also failed because the temporary socket directory exceeded macOS's 103-byte Unix-socket limit and HOME used `/private/tmp` while the sensitive-path filter normalized inputs to `/tmp`. The corrected run uses short child directories with the `/tmp` spelling. No unrelated source or assertion was changed.

```sh
S=/tmp/U094E5L4A15/session_1789551449848_6df1fd6b
mkdir -p "$S/h" "$S/t" "$S/d"
env -i PATH="$PATH" HOME="$S/h" TMPDIR="$S/t" \
  DATA_DIR="$S/d" SOMA_DATA_DIR="$S/d" npm run test:release
```

## Requirement evidence

- T1 / A1–A2: `builder.capacity.test.ts` asserts provider order, scheduler order, immutable inputs, normalized totals, full-pool summaries on every page, and all 70 accounts reachable. Trace S1 follows both command entry points to the renderer.
- T2 / A2–A5: capacity tests assert remaining percentages, local-date reset tags, relative times, recovered percentage points, unknown/expired data, cooldown/auth failure, model-scoped limits, Grok synthetic-reset suppression and zero-versus-unknown Codex counters. Trace S2 follows the validation and display branches.
- T3 / A6–A9: `overview.integration.test.ts` runs actual command → renderer → emitted button → registered action for default view, admin opt-in, paging, refresh, return and forged non-admin clicks. `actions.test.ts` pins existing mutation guards. `auth-topic.ccp-embed.test.ts`, `auth-origin.test.ts` and `actions.auth-origin.test.ts` pin bounded legacy composition and mutation continuity. Trace S3 covers the same path.
- T4: recovered/read the original using-dotprd definition at zbrain `2fef422eb63070bc01f1b629faa1734a3b4a83a9`; applied numbered spec/architecture, verbatim SSOT, work-unit loop and observation ledger. The original failed runtime Skill invocations are not represented as successful. Trace S4 and [provenance](ssot.md#skill-availability) distinguish recovery from installation.

## Research and visual evidence

Upstream llmux `8be574b18290d3bcb1b80ea644aa481e95aa2da6` was inspected directly. Its status payload has ratios/reset times, not token denominators or plan weights. Grok counts are discarded upstream; its fallback reset is synthetic. Codex reset counters are real observations and displayed without redemption. Sources are recorded in the numbered spec.

Actual `buildAuthCardBlocks` output generated readonly and admin JSON/PNG previews with synthetic data. The parent inspected the images and corrected Grok wording and timestamp localization. These are CSS approximations, not live Slack screenshots. The pre-implementation HTML analysis is also explicitly labelled as pre-implementation.

## PR and Slack API observations — 2026-09-16

- [PR #220](https://github.com/2lab-ai/soma-work/pull/220), source commit `0f174a8`: open, not merged.
- [CI quality gate](https://github.com/2lab-ai/soma-work/actions/runs/35087367768): SUCCESS, including install, workspace build, lint, typecheck, complete release tests and production build.
- Final autonomous review: `trinity-fallback2 (opus)` APPROVE with no blocking findings. See [review](review.md). No primary three-engine consensus is claimed.
- [Real Slack schema preview](https://slack.com/archives/C0AKY7W2UGZ/p1789556768976519): `chat.postMessage` returned `ok:true` for 14 blocks from the actual readonly builder with synthetic accounts; requested thread was confirmed in the response. Operational buttons were deliberately omitted. This proves acceptance of the capacity sections, not deployed command routing, button behavior or observed client pixels.

## Restart validation — 2026-09-16

- Recovered the same working tree and PR #220 after the service restart. Latest published `4568ece` also passed [CI quality-gates](https://github.com/2lab-ai/soma-work/actions/runs/35088921534); its Sanitize Gate still reports the same single historical object.
- Added 8 regression cases in `src/slack/auth/__tests__/actions.test.ts`: forged non-admin settings/removal submissions, invalid URL, reachable/unreachable settings persistence, missing removal name, and successful/failed removal feedback. The suite passes 34 tests. These strengthen coverage of existing behavior; no production source changed in this round.
- Reran `npm run test:release`: 531 files passed, 1 skipped; 10,591 tests passed, 5 skipped; 179.08 seconds (`restart-full-release.log`). `npx tsc --noEmit` and `npm run build` exit 0 (`restart-typecheck.log`, `restart-build.log`).
- Launched a real Bolt HTTP receiver on an ephemeral loopback port and sent signed Events API and block-action requests. Production compiled `AuthHandler`, `registerAuthActions`, renderers and llmux client ran without module mocks. Only llmux and the Slack Web API were synthetic loopback fixtures. Nine steps passed: admin initial overview, opt-in, page two, changed HTTP usage snapshot, settings modal, account switch, return to overview, ordinary overview and forged admin-mode demotion. Maximum observed response: 31 blocks. Receipt: `auth-http-journey.receipt.json` with source `4568ece`.
- The HTTP journey is a subsystem integration receipt, not a full host boot or deployed Slack interaction. The real Slack SDK receiver and outbound HTTP were exercised; the production daemon, user accounts and real secrets were not touched. The fixture message listener intentionally invokes the existing AuthHandler; it does not prove the full CommandRouter registration.
- `npx calldiff@0.5.0 diff` reports `No callstack changes between HEAD and working tree.` The change in this round is tests and verification documents only. Root README and architecture claims remain unchanged and were checked for impact.

## Shared sanitize failure provenance

[Sanitize run](https://github.com/2lab-ai/soma-work/actions/runs/35087367747) failed `objects=1 paths=0 refs=0`; current main's run has the same result. A read-only scan of 15,997 reachable objects in the reused runner checkout located the sole matching historical ledger blob `c0c4b8a3ced503ab1c503c2d95186655bcce1821`.

The old blob remains reachable from the unrelated deployment-selection branch and cached PR merge refs (`origin/feat/deploy-target-select`, `pull/218/merge`, `pull/219/merge`). It is not reachable from current main or the auth feature branch. The forbidden literal was neither printed nor copied into these artifacts.

[Evidence on PR #219](https://github.com/2lab-ai/soma-work/pull/219#issuecomment-5696405694) and [PR #220](https://github.com/2lab-ai/soma-work/pull/220#issuecomment-5696405900) identifies an owner-controlled rebase and stale-ref cleanup, rather than a source change to auth. No unrelated remote branch or runner ref was modified. No failing gate was bypassed.

## Still required for shipment

- Shared sanitize gate recovery, then current-SHA green check
- Merge and permitted preview deployment
- Post-deploy Slack receipt for overview and administrator interaction
- Final requirement-to-evidence proof and report

Until these exist, numbered documents remain in-progress. No production deployment or complete live acceptance is claimed.
