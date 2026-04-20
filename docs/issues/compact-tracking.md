# Context Compaction Tracking + Per-User Threshold (default 80%)

## Problem (Why)

사용자가 Claude Agent SDK의 **context compaction이 언제 일어나는지 알 수 없고**, 압축 직후 모델이 직전 맥락을 잃어 응답 품질이 급락한다. 현재 알림 UX는 status bar spinner 텍스트만 'compacting/compact_done'으로 바뀌어 즉시 사라지므로 사용자 시야에 들어오지 않는다.

동시에 압축 시점(% 기준)이 **개인마다 선호가 다름**에도 불구하고 현재 soma-work는 어떠한 threshold 설정도 제공하지 않으며, Claude Code 기본 auto-compact는 실측 ~83.5%(200k−13k 버퍼)로 사용자가 조절할 공식 API가 없다.

## Current State (Gap Analysis)

| 항목 | 현재 | 공백 |
|---|---|---|
| SDK `compact_boundary` 수신 | `src/slack/stream-processor.ts:1029-1038` | OK |
| onCompactBoundary 콜백 | `src/slack/pipeline/stream-executor.ts:761-775` | 세션 카운터만 bump |
| Slack 알림 | status bar spinner만 | **thread 본문 post 없음** |
| `PreCompact` hook 등록 | **없음** | SDK hooks={PreToolUse} only (`src/claude-handler.ts:862-866`) |
| `PostCompact` hook | 없음 | — |
| `SessionStart` hook | 없음 | — |
| compactThreshold 설정 | **없음** | `src/user-settings-store.ts`에 필드 부재 |
| context-usage 자동 모니터 | 대시보드 표시만 (`src/conversation/dashboard.ts:314-319`) | threshold 초과 감지 로직 없음 |

## Decisions (from Clarify — Q1-Q4)

- **Q1 알림 채널**: thread reply (공개)
- **Q2 threshold 초과 동작**: 자동 `/compact` 주입 (공식 API 경로)
- **Q3 threshold 설정**: per-user, 50~95%, 1% 단위, 디폴트 **80**
- **Q4 SDK hook**: PreCompact + PostCompact + SessionStart(source=compact) 전부

## Acceptance Criteria (AC — verbatim testable)

**AC1**: User가 `/compact-threshold 75` 명령 또는 설정 UI로 개인 threshold를 50~95 범위에서 저장할 수 있다. 범위 밖 값은 검증 에러 메시지와 함께 거부된다. 저장된 값은 `user-settings.json`에 `compactThreshold` 필드로 영속한다.

**AC2**: 신규 사용자의 기본 `compactThreshold`는 `80`이며, 설정이 없을 때 계산식이 80을 사용한다.

**AC3**: 한 턴이 끝난 시점에 해당 세션의 context usage % (`usage.contextWindow / model.contextWindow * 100`)가 사용자의 `compactThreshold` 이상이면, 다음 턴 시작 전에 `/compact` 메시지가 자동으로 Claude SDK에 주입된다. 주입 직전 thread에 사전 고지 메시지를 1회 post 한다 ("🗜️ Context usage X% ≥ threshold Y% — auto /compact 실행 중").

**AC4**: SDK `PreCompact` hook이 `claude-handler.ts`의 `options.hooks`에 등록되어 있고 발동 시 thread에 "🗜️ Compaction starting · trigger=<manual|auto>" 메시지를 post 한다.

**AC5**: SDK `PostCompact` hook이 등록되어 있고 발동 시 thread에 "✅ Compaction complete · was ~X% → now ~Y% · 중요한 맥락 다시 알려주세요" 메시지를 post 한다. X는 압축 직전 usage%, Y는 압축 직후 usage%.

**AC6**: SDK `SessionStart` hook이 등록되어 있고 `source === "compact"`인 경우 기존 `compaction-context-builder` 경로가 트리거되어 title/workflow/links가 재주입된다. 기존 `compact_boundary` 수신 경로와 동시 발동해도 중복 재주입하지 않는다(idempotent guard).

**AC7**: 사용자가 `/compact-threshold` 명령으로 현재 값을 조회할 수 있다 ("Current threshold: 80%").

**AC8**: 위 6개 hook/threshold/post 동작은 unit test (user-settings-store, threshold-checker) + integration test (mock SDK로 PreCompact/PostCompact payload 흘려 Slack post 호출 검증)로 커버된다.

## Scope (Files to Change)

| 파일 | 변경 요약 |
|---|---|
| `src/user-settings-store.ts` | `compactThreshold: number` 필드 + 검증(`50-95`) + 디폴트 `80` |
| `src/slack/commands/compact-threshold-handler.ts` (신규) | `/compact-threshold [value]` 명령 처리 |
| `src/slack/commands/index.ts` | 새 핸들러 등록 |
| `src/claude-handler.ts` | `options.hooks`에 `PreCompact`/`PostCompact`/`SessionStart` 추가 |
| `src/slack/hooks/compact-hooks.ts` (신규) | 3개 hook의 payload 처리 + Slack post 함수 |
| `src/slack/pipeline/stream-executor.ts` | `onCompactBoundary`에서 thread post 호출 추가; idempotent guard |
| `src/session/compact-threshold-checker.ts` (신규) | 턴 종료 시 usage% 계산 → threshold 비교 → 자동 `/compact` 주입 |
| `src/slack/pipeline/turn-end-hooks.ts` (또는 해당 경로) | 턴 종료 시 threshold-checker 호출 |
| `tests/user-settings-store.test.ts` | AC1, AC2 커버 |
| `tests/compact-threshold-checker.test.ts` (신규) | AC3 커버 |
| `tests/compact-hooks.test.ts` (신규) | AC4-AC6 커버 |

## Test Plan

1. `bun test tests/user-settings-store.test.ts` → 범위 검증, 디폴트 80, 영속 확인
2. `bun test tests/compact-threshold-checker.test.ts` → 80% 임계에서 /compact 주입, 79%에서 미주입
3. `bun test tests/compact-hooks.test.ts` → mock PreCompact/PostCompact/SessionStart payload가 Slack post 호출하는지
4. 수동 QA: slack 채널에서 긴 대화 유도 → 80% 도달 시 thread에 "🗜️ Context usage … auto /compact" 메시지 + compact 완료 후 "✅ Compaction complete …" 메시지 순차 출력 확인
5. `/compact-threshold 60` 호출 → 60% 도달 시 동작 확인

## Out of Scope

- 공식 Claude Code `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env var 주입 (업데이트 취약 — 별도 이슈)
- 압축 전 요약 diff 표시
- 팀 공용 threshold (개인 설정에 국한)
