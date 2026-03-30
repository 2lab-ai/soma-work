# Docs Cleanup & Update — Spec

> STV Spec | Created: 2026-03-06

## 1. Overview

프로젝트 문서가 2025-12월 기준으로 정체되어 현재 코드베이스와 괴리가 발생.
outdated 경로/참조 수정, stale spec 현행화, 완료된 historical docs 아카이빙, architecture.md 갱신을 통해
문서와 코드의 정합성을 복원한다.

## 2. User Stories

- As a developer, I want docs to reflect the current codebase, so that I can trust documentation as a reference
- As an AI agent, I want accurate file paths and module references in specs, so that I can navigate the codebase correctly
- As a contributor, I want stale historical docs archived, so that I focus on current, relevant documentation

## 3. Acceptance Criteria

- [x] docs/spec/ 시리즈 (00~13)의 outdated 참조가 현행 코드에 맞게 수정됨
- [x] docs/spec/10-commands.md에 2026-03 기준 전체 커맨드 목록이 반영됨
- [x] docs/architecture.md의 LOC 수치와 모듈 목록이 현재 코드에 맞게 갱신됨
- [x] 완료된 historical docs가 docs/archive/로 이동됨
- [x] 모든 문서에서 옛 경로(`/Users/dd/claude-code-slack-bot/`, `claude-code-slack-bot-store`) 제거됨

## 4. Scope

### In-Scope
- docs/spec/ 시리즈 현행화 (경로, 소스 파일, 인터페이스, 커맨드 목록)
- docs/architecture.md 갱신 (LOC, 모듈 구조)
- Historical docs → docs/archive/ 이동 (srp-refactoring-plan.md, REFACTORING_PLAN.md, github-auth-report.md)
- Outdated 경로/프로젝트명 일괄 수정

### Out-of-Scope
- 새로운 spec 문서 작성
- STV feature docs (admin-commands, cct-token-rotation, mcp-session-tick) 수정 — 별도 라이프사이클
- docs/plans/, docs/research/ 정리 — 날짜 기반 참고 자료로 유지
- 코드 변경 (문서만 변경)

## 5. Architecture

### 5.1 변경 대상 파일 맵

| Category | Files | Action |
|----------|-------|--------|
| Archive | `docs/srp-refactoring-plan.md` | → `docs/archive/` |
| Archive | `REFACTORING_PLAN.md` | → `docs/archive/` |
| Archive | `docs/github-auth-report.md` | → `docs/archive/` |
| Update | `docs/spec/03-session-management.md` | source 파일 참조 수정 |
| Update | `docs/spec/07-permission-system.md` | 프로젝트명 수정 |
| Update | `docs/spec/08-user-settings.md` | `accepted` 필드 추가 |
| Update | `docs/spec/09-configuration.md` | 경로 현행화 |
| Update | `docs/spec/10-commands.md` | 전체 커맨드 목록 갱신 |
| Update | `docs/spec/13-slack-ui-action-panel.md` | 파일 참조 수정 |
| Update | `docs/architecture.md` | LOC + 모듈 목록 갱신 |

### 5.2 Integration Points
- 없음 (코드 변경 없이 문서만 수정)

## 6. Non-Functional Requirements
- 정확성: 모든 파일 경로/모듈 참조가 실제 코드와 일치
- 일관성: 프로젝트명은 `soma-work`로 통일
- 최신성: 버전/날짜 표기 갱신

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Outdated 경로를 현행 경로로 일괄 치환 | tiny | 문자열 리터럴 변경, 되돌리기 ~5줄 |
| docs/plans/, docs/research/는 유지 | tiny | 날짜 prefix로 이미 정리됨, 이동 불필요 |
| STV feature docs는 건드리지 않음 | small | 별도 라이프사이클, 간섭하면 혼란 |
| docs/issues/는 유지 | tiny | 아직 open 상태일 수 있음 |
| sdk-migration-0.1-to-0.2.md 유지 | small | 아직 참조 가치 있음 (SDK 0.2 사용 중) |

## 8. Open Questions
None

## 9. Next Step
→ `stv:trace`로 Vertical Trace 진행
