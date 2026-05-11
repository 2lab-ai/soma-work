# Packages × SRP Refactor

> Status: **Plan only** (no code changes). Author: 2026-05-11.
> 
> Sibling docs: [`plan.md`](./plan.md) · [`references.md`](./references.md)

## 한 줄 요약

`src/`에 쌓인 88,550 LOC / 574 파일을 [gemini-cli](https://github.com/google-gemini/gemini-cli)의 npm workspaces × SRP 패턴으로 9개 패키지로 분해한다. **Slack adapter부터 먼저 떼낸다.**

## Why now

| 신호 | 현재 비용 |
|---|---|
| `src/session-registry.ts` 76KB, `token-manager.ts` 96KB, `slack-handler.ts` 60KB, `claude-handler.ts` 52KB | 한 파일 변경 = 전체 빌드 + 전체 테스트, 변경 영향 반경 파악 불가 |
| `src/` 루트에 30+ 파일이 평면적으로 공존 | 새 entry 추가 시 어디 두는 게 옳은지 결정이 매번 새로움 |
| `@slack/bolt` import가 core(`claude-handler.ts`, `session-registry.ts`)에 leak | core 단독 테스트/재사용 불가, Slack 외 채널(다른 메신저) 추가 시 ripple 큼 |
| `mcp-servers/`의 독립화 작업이 이미 진행 중 (`docs/mcp-refactor`, `docs/mcp-server-independence`, `docs/mcp-extraction`) | 같은 방향성을 src/ 본체로 확장하면 일관된 monorepo 구조가 자연스럽게 완성됨 |
| `somalib/` workspace는 이미 존재 (cron, model-commands, permission, stderr-logger) | proto-core는 이미 시작됨 — 마저 분리하면 됨 |

## What this doc is / is not

- **Is:** 9-패키지 구조 결정, 의존 방향 DAG, 6단계 마이그레이션 페이즈, biome 환경에서의 cross-package import 금지 메커니즘, build 단계 asset cp 파이프라인 교체안.
- **Is not:** 코드 변경. 이 PR은 docs only. 실제 이동은 페이즈별로 별도 PR로 나간다.

## TL;DR — first move

[`@soma/slack`](./plan.md#phase-1--soma-slack-가장-먼저)부터 카브아웃한다. `src/slack/` (3.9M, 가장 응집도 높음) + `slack-handler.ts` + Slack notifier 류를 workspace로 이동하고 이전 경로는 임시 re-export로 호환 유지. **Slack 의존이 core에 leak되던 문제가 즉시 폭로**되고, 이후 페이즈가 따를 의존 방향이 한 PR로 확정된다. 이 한 페이즈가 가장 작은 위험 × 가장 큰 페이오프.

## Audit trail

A, F 등 비공개 결정은 모두 codex consult(`mcp__llm__chat model=codex`) + gemini-cli 실제 소스(`packages/core`, `packages/cli`) 교차검증으로 결정. 트랜스크립트는 [`references.md`](./references.md).
