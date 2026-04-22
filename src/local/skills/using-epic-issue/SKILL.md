---
name: using-epic-issue
description: "복수 phase/서브태스크로 분해되는 피처를 에픽+서브이슈로 추적하는 규율. 에픽은 상태, 서브이슈는 실행 — 설계·리뷰·로그를 에픽 본문에 축적하는 순간 추적이 망가진다. 복수 PR, 복수 세션, 복수 실행자(사람·AI 에이전트) 환경에서 에픽 본문 부패와 재진입 불가 상태를 방지. 플랫폼 중립 — GitHub 문법은 `reference/github.md`, Jira는 `reference/jira.md`."
---

# using-epic-issue

## Core Principle

**에픽은 상태. 서브이슈는 실행. 섞지 마라.**

에픽 body = 체크리스트 + 서브이슈 링크만. 설계 논의, 구현 상세, 리뷰 응답, 진행 로그는 **서브이슈와 PR에만** 축적.

왜 비타협인가:

- 에픽 body가 로그 저장소가 되면 "지금 어디까지 됐고 뭐가 남았나"를 한눈에 판독할 수 없다. 에픽의 유일한 가치는 진입 즉시 전체 상태를 드러내는 것이다.
- AI 에이전트는 세션이 끊기고 컨텍스트가 휘발된다. 상태의 single source가 이슈에 없으면 다음 실행자(사람·다른 에이전트)는 처음부터 다시 파악해야 한다. 재진입이 성립하지 않는다.
- 긴 컨텍스트 누적은 에이전트 판단력을 떨어뜨린다 ("context rot"). 에픽을 인덱스로 유지하면 서브이슈 단위로 컨텍스트가 격리된다.

근거:
- Plan-then-act (탐색→계획→구현→커밋) — <https://docs.anthropic.com/en/docs/claude-code/common-workflows>
- Context rot — <https://www.mindstudio.ai/blog/context-rot-ai-coding-agents-explained>
- Epic 사이즈 제한 — <https://www.atlassian.com/agile/tutorials/epics>

플랫폼별 문법은 `reference/<platform>.md`.

## When

- 피처가 ≥2개 독립 PR로 분해 가능 (서로 block하지 않음)
- 작업이 단일 세션을 넘어 재진입 필요
- 복수 실행자(사람·AI 에이전트) 교대 투입
- 전체 진척을 한 곳에서 추적 필요

**Skip:** 단일 PR로 끝나는 작업 — 에픽은 오버헤드. `z` 바로 호출.

## Process

### P1 — Create epic

플랫폼 native epic/parent 타입으로 생성. 제목: `[scope] <한 줄 목표> — epic`. Body 섹션 (이 순서 고정, 다른 섹션 추가 금지):

1. **Goal** — 1~2문단. WHY. 사용자 가치. HOW는 쓰지 않음.
2. **Design Reference** — 상세 설계 문서 링크. 없으면 섹션 자체 생략.
3. **Checklist** — 체크박스 + 서브이슈 링크. 1 체크 = 1 서브이슈.
4. **Done-Done** — 검증 가능한 완료 조건.
5. **Out of Scope** — 명시적 제외.

본문에 **금지**:
- 구현 상세, 파일 경로, 코드 스니펫
- 리뷰 답변, 설계 논의
- "진행 상황" 섹션, 작업 로그

플랫폼별 에픽 타입/라벨/sub-issue 관계 성립 문법은 `reference/<platform>.md`.

### P2 — Create sub-issues

체크리스트 아이템마다 서브이슈 1개 **즉시** 생성. 아이템만 만들고 서브이슈를 나중에 채우지 않음 — 나중은 오지 않음.

Body 섹션 (고정):

1. **Parent** — 에픽 링크
2. **Goal** — 이 phase만의 목표. 1문단.
3. **In Scope / Out of Scope** — 경계 명시
4. **File Map** — 수정/신규 파일 표
5. **Test Plan** — Unit / Integration / Regression
6. **PR 요건** — 머지 통과 조건 (CI, 독립 리뷰, phase 특정 검증)

서브이슈 크기는 sprint 이내. 초과 시 즉시 재분해. 서브이슈 본문에 phase N+1 내용을 섞지 않음.

### P3 — Execute

1. 에픽 열고 미완 체크박스 중 dependency 해결된 1개 선택.
2. 그 서브이슈 URL로 `$z <sub-URL>` — 작업의 유일한 진입점.
3. 모든 설계 논의·리뷰·진행 로그는 **서브이슈 댓글과 PR 리뷰**에.
4. 에픽 body는 편집하지 않음.

AI 에이전트 위임 시 **서브이슈 body만** 컨텍스트로 전달. 에픽 전체를 넘기면 scope 초과 작업 가능성.

### P4 — Merge & tick

1. PR에 `Closes <서브이슈>` — 머지 시 서브이슈 자동 close (플랫폼 문법은 reference).
2. 에픽 체크박스 `[ ]` → `[x]` — **해당 1줄만** edit. 다른 섹션 금지.
3. 머지 요약 코멘트는 **서브이슈/PR**에만. 에픽 댓글 금지.
4. 전 체크박스 `[x]` → Done-Done 검증 → open 서브이슈 0 확인 → 에픽 수동 close.

## Invariants (위반 = rollback)

1. 에픽 body의 Checklist 외 영역은 생성 후 수정 금지 (제목·라벨 rename 예외).
2. 1 체크박스 = 1 서브이슈 = 1 PR.
3. 서브이슈 close 전 체크박스 `[x]` 금지.
4. 에픽 close 전 전체 서브이슈 close.
5. 에픽 댓글 = "서브이슈 분할 완료" 같은 메타 전환 1회만. 진행 보고 금지.

## Anti-patterns

| ❌ | ✅ |
|---|---|
| 에픽 body에 "진행 상황"/"로그" 섹션 | 서브이슈 상태 + 체크박스 |
| 에픽에 리뷰·설계 v1/v2 누적 | 별도 설계 문서, 에픽은 링크만 |
| 1 서브이슈가 2+ phase 처리 | 1 phase = 1 서브이슈 = 1 PR |
| 서브이슈 없이 에픽에서 직접 PR | 반드시 서브이슈 경유 |
| 구현 중 에픽 body 수정 | 체크박스 토글만 |
| AI 에이전트에 에픽 전체 위임 | 서브이슈 단위로 컨텍스트 격리 |

## Templates

### Epic body

```markdown
## Goal

<1~2문단. WHY 중심. 사용자 가치.>

## Design Reference

- <선택: 설계 문서 링크. 없으면 이 섹션 제거>

## Checklist

- [ ] <phase 1 이름> — <서브이슈 링크>
- [ ] <phase 2 이름> — <서브이슈 링크>
- [ ] <phase 3 이름> — <서브이슈 링크>

## Done-Done

- <검증 가능한 조건>
- <검증 가능한 조건>

## Out of Scope

- <명시적 제외>
```

### Sub-issue body

```markdown
## Parent

<에픽 이슈 링크>

## Goal

<1문단. 이 phase만의 목표.>

## In Scope

- <구체 항목>

## Out of Scope

- <제외>

## File Map

| 파일 | 역할 | 변경 유형 |
|---|---|---|
| <경로> | <역할> | new / modify |

## Test Plan

- Unit: <목록>
- Integration: <목록>
- Regression: <목록>

## PR 요건

- [ ] CI green
- [ ] 독립 리뷰 통과
- [ ] <phase 특정 검증>
```

## Integration

### 진입 트리거

유저가 복수 phase 피처 요청, 또는 `z` phase1이 multi-PR 판정하는 순간 본 스킬 진입. 판단 기준: "작업이 한 PR로 깔끔히 끝나는가." 아니면 에픽.

### 후속 스킬

- 서브이슈 작업 → `z`
- 완료 공지 → `es`

### AI 에이전트와의 결합

- **컨텍스트 격리**: 에이전트에게 에픽이 아니라 **서브이슈 body만** 전달. 에픽은 사람/오케스트레이터 레이어.
- **상태 소스 고정**: 에이전트가 중간 상태를 로컬 파일·메모에 두지 않고 **이슈 댓글 또는 PR draft**에 반영. 세션이 끊겨도 이슈만 보고 재진입 가능해야 함.
- **병렬성**: 독립 서브이슈는 별도 worktree/branch에서 병렬 실행 가능. 단 동일 파일을 건드리는 서브이슈는 직렬로 묶음 (체크리스트 순서 또는 본문 dependency 명시).
- **에픽 편집 권한**: 실행 에이전트에 에픽 body 편집 권한 주지 않음. 체크박스 토글도 오케스트레이터/사람이 수행. Invariants 1, 5가 자동 보호됨.

### 도구별 구현

GitHub·Jira·Linear·GitLab 등 각 트래커의 parent-child 생성, 자동 close 문법, 라벨 관습은 도구마다 다름:

- GitHub: `reference/github.md`
- Jira: `reference/jira.md`

원칙은 도구 무관. 트래커가 parent-child를 지원하지 않으면 체크리스트 링크 + 제목 프리픽스 + 본문 `Parent:` 한 줄로 동일한 효과.
