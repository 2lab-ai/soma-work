---
name: using-epic-issue
description: "복수 phase/서브태스크로 분해되는 피처를 에픽+서브이슈로 추적. 에픽 body = 체크리스트 + 서브이슈 링크. 설계·리뷰·로그는 서브이슈와 PR에만. 복수 PR / 복수 세션 / 복수 실행자(사람·AI) 환경에서 에픽 body 부패와 재진입 불가를 방지. 플랫폼 문법: `reference/github.md`, `reference/jira.md`."
---

# using-epic-issue

## Core Principle

**에픽은 상태. 서브이슈는 실행. 섞지 마라.**

에픽 body = 체크리스트 + 서브이슈 링크만. 설계 논의, 구현 상세, 리뷰 응답, 진행 로그는 **서브이슈와 PR에만** 축적. AI 에이전트는 세션이 끊기므로 상태의 single source가 이슈에 없으면 재진입이 성립하지 않음.

## When

- 피처가 ≥2개 독립 PR로 분해 가능 (서로 block하지 않음)
- 작업이 단일 세션을 넘어 재진입 필요
- 복수 실행자(사람·AI 에이전트) 교대 투입

**Skip:** 단일 PR로 끝나는 작업 — `z` 바로 호출.

## Process

### P1 — Create epic

플랫폼 native epic/parent 타입으로 생성 (GitHub: `reference/github.md` §1; Jira: `reference/jira.md` §2). 제목: `[scope] <한 줄 목표> — epic`. Body 섹션 (순서 고정, 다른 섹션 추가 금지):

1. **Goal** — 1~2문단. WHY. HOW는 쓰지 않음.
2. **Design Reference** — 설계 문서 링크. 없으면 섹션 생략.
3. **Checklist** — 체크박스 + 서브이슈 링크. 1 체크 = 1 서브이슈.
4. **Done-Done** — 검증 가능한 완료 조건.
5. **Out of Scope** — 명시적 제외.

본문에 **금지**: 구현 상세 / 파일 경로 / 코드 스니펫 / 리뷰 답변 / 설계 논의 / "진행 상황" 섹션.

템플릿: `reference/templates.md` §epic.

### P2 — Create sub-issues

체크리스트 아이템마다 서브이슈 1개 **즉시** 생성. 나중은 오지 않음. Body 섹션 (순서 고정):

1. **Parent** — 에픽 링크
2. **Goal** — 이 phase만의 목표. 1문단.
3. **In Scope / Out of Scope**
4. **File Map** — 수정/신규 파일 표
5. **Test Plan** — Unit / Integration / Regression
6. **PR 요건** — CI, 독립 리뷰, phase 특정 검증

서브이슈 크기는 sprint 이내. 초과 시 즉시 재분해. phase N+1 내용 섞지 않음.

템플릿: `reference/templates.md` §sub-issue.

### P3 — Execute

1. 에픽 열고 미완 체크박스 중 dependency 해결된 1개 선택.
2. 그 서브이슈 URL로 `$z <sub-URL>` — 유일한 진입점.
3. 설계 논의·리뷰·진행 로그는 **서브이슈 댓글과 PR 리뷰**에만.
4. 에픽 body 편집 금지.

AI 에이전트 위임 시 **서브이슈 body만** 컨텍스트로 전달. 에픽 전체 위임 금지.

### P4 — Merge & tick

1. PR에 `Closes <서브이슈>` — 머지 시 서브이슈 자동 close (GitHub: `reference/github.md` §3; Jira 수동 전이: `reference/jira.md` §5).
2. 에픽 체크박스 `[ ]` → `[x]` — **해당 1줄만** edit.
3. 머지 요약은 **서브이슈/PR**에만. 에픽 댓글 금지.
4. 전 체크박스 `[x]` → Done-Done 검증 → open 서브이슈 0 확인 → 에픽 수동 close.

## Invariants (위반 = rollback)

1. 에픽 body 편집은 **Checklist 체크박스 `[ ]↔[x]` 토글 + 제목·라벨 rename**으로 한정.
2. 1 체크박스 = 1 서브이슈 = 1 PR.
3. 서브이슈 close 전 체크박스 `[x]` 금지.
4. 에픽 close 전 전체 서브이슈 close.
5. 에픽 댓글 = "서브이슈 분할 완료" 같은 메타 전환 1회만. 진행 보고 금지.
6. **라벨 규율**: phase별 라벨 금지. 상태 라벨(`blocked`/`ready`/`in-progress`)은 서브이슈에만 — 에픽에 붙이면 Invariant 1을 우회하는 암묵적 상태가 생김.
7. AI 에이전트에 에픽 전체 위임 금지. 서브이슈 body 단위로 컨텍스트 격리. 쓰기 권한도 해당 서브이슈·PR 범위로 한정 (Invariants 1, 5 자동 보호).

## Integration

- **진입 트리거**: 유저가 복수 phase 피처 요청, 또는 `z` phase1이 multi-PR 판정.
- **후속 스킬**: 서브이슈 작업 → `z`; 완료 공지 → `es`.
- **플랫폼 문법**: `reference/github.md` · `reference/jira.md`.
- **병렬성**: 독립 서브이슈는 별도 worktree/branch. 동일 파일을 건드리는 서브이슈는 직렬 (서브이슈 body의 dependency 표기 또는 에픽 Checklist 순서).
- **트래커가 parent-child 미지원**: 체크리스트 링크 + 제목 프리픽스 + 본문 `Parent:` 한 줄로 동일 효과.
