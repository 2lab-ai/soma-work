---
name: using-epic-issue
description: "복수 phase/서브태스크로 분해되는 피처를 에픽+서브이슈로 추적. 에픽과 서브이슈 제목·Goal은 하이레벨 컨셉 언어만 쓰고, 구체 구현은 서브이슈의 `## 구현 스펙` 섹션에 격리. 설계·리뷰·로그는 서브이슈와 PR에만. 복수 PR / 복수 세션 / 복수 실행자(사람·AI) 환경에서 에픽 body 부패와 재진입 불가를 방지. 플랫폼 문법: `reference/github.md`, `reference/jira.md`."
---

# using-epic-issue

## Core Principle

**에픽은 상태. 서브이슈는 실행. 섞지 마라.**

에픽 body = 체크리스트 + 서브이슈 링크만. 설계 논의, 구현 상세, 리뷰 응답, 진행 로그는 **서브이슈와 PR에만** 축적. AI 에이전트는 세션이 끊기므로 상태의 single source가 이슈에 없으면 재진입이 성립하지 않음.

**언어 층 분리 (언어 규율)**

- **에픽** — 제목·Goal·Checklist·Done-Done·Out of Scope 모두 **하이레벨 컨셉 언어**. 사람이 읽어서 "왜·무엇을" 이해 가능. 클래스/함수/파일 이름, 코드 스니펫, ENV 변수 금지.
- **서브이슈 제목·Goal** — **하이레벨 컨셉 언어**. 에픽 체크리스트에 붙는 한 줄 요약과 같은 레벨. 다른 사람이 제목만 봐도 무엇을 하는지 이해 가능.
- **서브이슈 `## 구현 스펙` 이하** — 여기서만 구체적. 파일 경로, 클래스·함수 이름, 상태 전이, ENV 값, 테스트 목록 등 구현 디테일 전부.

구현 언어가 컨셉 층(에픽·서브이슈 제목·Goal)으로 올라오면 기획 리뷰·PR 리뷰·재진입 문맥이 모두 코드에 먼저 묶여서, 비개발자나 다음 세션 에이전트가 이슈를 **자기 수준으로 재해석할 여지**를 잃는다. 이 규율이 깨지면 에픽 body는 결국 구현 상세의 사본이 되고, 유지 불가.

## When

- 피처가 ≥2개 독립 PR로 분해 가능 (서로 block하지 않음)
- 작업이 단일 세션을 넘어 재진입 필요
- 복수 실행자(사람·AI 에이전트) 교대 투입

**Skip:** 단일 PR로 끝나는 작업 — `z` 바로 호출.

## Process

### P1 — Create epic

플랫폼 native epic/parent 타입으로 생성 (GitHub: `reference/github.md` §1; Jira: `reference/jira.md` §2). 제목: `[scope] <한 줄 컨셉 목표> — epic`.

**제목 언어**: 구현 용어 금지. "5-block migration" 같은 내부 자말이 아니라 "한 턴 = 5 블록으로 수렴" 같이 사용자·리뷰어가 읽어서 이해 가능한 컨셉 문장.

Body 섹션 (순서 고정, 다른 섹션 추가 금지):

1. **Goal** — 1~2문단. WHY. HOW는 쓰지 않음. 파일·클래스·함수 이름 금지.
2. **Design Reference** — 설계 문서 링크. 없으면 섹션 생략.
3. **Checklist** — 체크박스 + 서브이슈 링크. 1 체크 = 1 서브이슈. 각 항목은 서브이슈 제목(하이레벨 컨셉)과 동일 표현.
4. **Done-Done** — 검증 가능한 완료 조건. 사용자 가시 관점으로.
5. **Out of Scope** — 명시적 제외. 컨셉 레벨로.

본문에 **금지**: 구현 상세 / 파일 경로 / 코드 스니펫 / 리뷰 답변 / 설계 논의 / "진행 상황" 섹션.

템플릿: `reference/templates.md` §epic.

### P2 — Create sub-issues

체크리스트 아이템마다 서브이슈 1개 **즉시** 생성. 나중은 오지 않음.

**제목 언어**: `[scope] <phase ID> — <한 줄 컨셉>`. "P2 — B2 계획 블록 분리" 같이. 구체 심볼(`TurnSurface.renderTasks`, `SOMA_UI_5BLOCK_PHASE` 등) 제목에 금지.

Body 섹션 (순서 고정):

**Above the line (하이레벨 컨셉)**

1. **Parent** — 에픽 링크
2. **Goal** — 이 phase만의 목표. 1문단. **WHY·WHAT 중심, 하이레벨 컨셉 언어**. 파일·클래스·함수 이름 금지. 독자가 구현 맥락 없어도 이해 가능해야 함.
3. **In Scope / Out of Scope** — 컨셉 레벨 bullet. 사용자·기능 관점 표현.

**Below the line (구현 스펙 격리)**

4. `---` horizontal rule (경계선, 필수)
5. **`## 구현 스펙`** — 이 섹션 아래에서만 구체 표현 허용. 하위 `###` 섹션:
   - **File Map** — 수정/신규 파일 표
   - **Test Plan** — Unit / Integration / Regression
   - **Risks / Mitigations** — 표 권장
   - **PR 요건** — Branch 이름, CI, 리뷰, deploy, phase 특정 검증
   - **Dependency** — 선행·후행 서브이슈

위 구조를 어기면 PR description의 `## Goal`이 코드 요약으로 변질되고, 기획 리뷰·휴먼 리뷰·재진입 문맥이 전부 구현에 묶인다.

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
8. **언어 층**: 에픽 전체 + 서브이슈 제목 + 서브이슈 `## 구현 스펙` 위쪽은 **하이레벨 컨셉 언어만**. 구체 심볼(파일 경로, 클래스/함수 이름, ENV 변수, 코드 스니펫, TS 타입)은 `## 구현 스펙` 아래에서만 허용. 위반 시 그 서브이슈는 재작성 후 머지 허용.

## Integration

- **진입 트리거**: 유저가 복수 phase 피처 요청, 또는 `z` phase1이 multi-PR 판정.
- **후속 스킬**: 서브이슈 작업 → `z`; 완료 공지 → `es`.
- **플랫폼 문법**: `reference/github.md` · `reference/jira.md`.
- **병렬성**: 독립 서브이슈는 별도 worktree/branch. 동일 파일을 건드리는 서브이슈는 직렬 (서브이슈 body의 dependency 표기 또는 에픽 Checklist 순서).
- **트래커가 parent-child 미지원**: 체크리스트 링크 + 제목 프리픽스 + 본문 `Parent:` 한 줄로 동일 효과.
