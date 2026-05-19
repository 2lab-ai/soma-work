# Claude Review Prompt — Packages SRP Refactor

You are reviewing a TypeScript monorepo refactor in `/Users/zhugehyuk/2lab.ai/soma-work`.

Review mode only:

- Do not modify files.
- Do not commit, stage, push, or run destructive commands.
- You may inspect files and run read-only commands as needed.
- Focus on correctness, package boundaries, runtime regressions, and test coverage.

Primary review document:

- `docs/current/plans/packages-srp-refactor/refactor-review.md`

Relevant original plan documents:

- `docs/stale-plans/review-needed/packages-srp-refactor/README.md`
- `docs/stale-plans/review-needed/packages-srp-refactor/plan.md`

High-signal changed areas to inspect:

- `packages/slack/package.json`
- `packages/slack/src/index.ts`
- `packages/slack/src/pipeline/index.ts`
- `packages/slack/src/pipeline/session-initializer.ts`
- `packages/slack/src/pipeline/stream-executor.ts`
- `src/slack/pipeline/session-initializer.ts`
- `src/slack/pipeline/stream-executor.ts`
- `src/__tests__/packages-srp-phase2-slack-contract.test.ts`
- `src/slack/pipeline/__tests__/session-initializer-*.test.ts`
- `src/slack/pipeline/__tests__/stream-executor*.test.ts`

Known verification evidence:

- `npm run build -w @soma/slack`: passed.
- `npm run build:somalib`: passed.
- `npm run build:packages`: passed.
- `npx tsc --noEmit --pretty false`: passed.
- Package source boundary scan for root/somalib imports: no matches.
- `git diff --check`: passed.
- Focused package/Slack pipeline tests: 257 passed.
- Full `npx vitest run`: 6454 passed, 10 failed.
- Known full-suite failures are environment-dependent:
  - 5 `src/__tests__/claude-handler.integration.test.ts` failures: no healthy CCT slot.
  - 5 `src/notification-channels/__tests__/webhook-channel.test.ts` failures: `example.com` DNS validation blocks before mock fetch.
- `npm run build` still fails at `biome check` due existing lint diagnostics unrelated to this refactor.

Review criteria:

1. Does the refactor satisfy the packages × SRP direction without breaking current import compatibility?
2. Are root shims sufficiently thin and safe?
3. Are provider setters a reasonable boundary, or do they create material runtime/test risks?
4. Did `SessionInitializer` and `StreamExecutor` preserve their important behavior, especially phase-gating and error/retry behavior?
5. Does the contract test actually cover the package-boundary promises it claims?
6. Are there any missing exports, type mismatches, module singleton hazards, circular-import hazards, or stale package build hazards?
7. Is the refactoring document accurate and complete enough for a reviewer/operator?

Output format:

```
Score: <0-100>

Blocking findings:
- <none or issue with file:line, impact, fix>

Important findings:
- <none or issue with file:line, impact, fix>

Minor findings:
- <none or issue with file:line, impact, fix>

Score rationale:
<short rationale>

98+ readiness:
<yes/no, and exact remaining requirements if no>
```

Scoring rule:

- Give 98 or higher only if there are no blocking or important findings and the residual risks are minor/documented.
- If you find an important issue, score below 98 and make the fix concrete.
