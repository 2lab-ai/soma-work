---
name: using-epic-issue
description: "여러 phase/sub-task로 쪼개지는 큰 피처 작업 시 트리거. 에픽 이슈 본문에 작업 로그 누적 금지 — 체크리스트와 서브이슈 링크만 유지. 기존 #525처럼 댓글 축적되어 추적 불가해지는 실패를 방지."
---

# using-epic-issue

## Core Principle (비타협)

**에픽 이슈 본문 = 체크리스트 + 서브이슈 링크만.**

작업 상세/설계/리뷰 로그는 **서브이슈와 PR에만** 축적. 에픽 본문·댓글에 축적 금지.

왜: 에픽 본문에 댓글이 쌓이면 다음 작업 시작 시 "어디까지 했고 뭐가 남았는지" 판독 불가 → 에픽이 쓰레기통이 됨. 본 스킬은 그 실패 사례(#525 9-comment epic rot)에 대한 직접 대응.

## When to Use

- 피처가 ≥2개 phase/sub-task로 분해됨
- 각 sub-task가 독립 PR로 나올 수 있음 (서로 block하지 않음)
- 전체 진행률을 한 곳에서 추적해야 함

**Skip if:** 단일 PR로 끝나는 작업. 이 경우 바로 `z`로 간다.

## Process

### Phase 1 — 에픽 이슈 생성

1. 제목 포맷: `[scope] <한 줄 목표> — epic` (예: `[slack-ui] Agents UI 5-block migration — epic`)
2. 본문 섹션 (이 순서 고정):
   1. **Goal** — 1~2 문단. WHY 중심, HOW는 서브이슈에.
   2. **Design Reference** — 상세 설계 문서/이슈 링크 (있으면). 없으면 생략.
   3. **Checklist** — 체크박스 + 서브이슈 링크 (각 phase 1줄).
   4. **Done-Done 기준** — 무엇이 만족되면 에픽 close인지.
   5. **Out of Scope** — 명시적으로 제외된 것.
3. 라벨: `epic` (없으면 신규 생성).
4. **금지:** 구현 상세, 파일 경로, 리뷰 답변, 진행 로그를 본문에 넣는 것.

### Phase 2 — 서브이슈 생성 (체크리스트 = 서브이슈)

각 체크리스트 아이템마다 1개 서브이슈를 **즉시** 만든다.

1. 제목 포맷: `[epic #<N>] <phase 이름>` (예: `[epic #660] P2 B2 plan 블록 배선`)
2. 본문 섹션:
   1. **Parent** — `부분: #<에픽번호>` (GitHub sub-issue 기능 활용)
   2. **Goal** — 이 phase만의 목표
   3. **In Scope / Out of Scope** — 명확한 경계
   4. **File Map** — 수정/신규 파일 경로 표
   5. **Test Plan** — unit/integration/regression
   6. **Risks & Mitigations**
   7. **PR 요건** — verify 기준
3. 에픽 체크리스트 아이템에 서브이슈 URL 백링크 추가.
4. **금지:** 서브이슈 본문에 phase N+1의 내용 포함.

### Phase 3 — 작업 선택 & 진행

1. 에픽 열고 **미완 체크박스 중 dependency 해결된 것** 하나 고른다.
2. 해당 서브이슈 URL을 `$z <URL>` 로 입력해 `z` 스킬에 위임한다.
3. `z`가 phase1~5를 돌며 PR까지 내준다.
4. **금지:** 작업 진행 중 에픽 본문 수정 (rename 제외). 모든 로그는 서브이슈/PR에.

### Phase 4 — 머지 & 에픽 체크

1. PR 머지 → PR의 `Closes #<sub>`로 서브이슈 자동 close.
2. 에픽 체크리스트 `[ ]` → `[x]` 1줄만 edit. 다른 본문 건드리지 말 것.
3. 머지 summary 코멘트는 **서브이슈**에 남기고 에픽에는 남기지 않는다.
4. 모든 체크박스 `[x]`가 되면 Done-Done 기준 검증 후 에픽 close.

## Anti-patterns (절대 금지)

| ❌ 금지 | ✅ 대신 |
|---|---|
| 에픽 본문에 "진행 상황" 섹션 추가 | 서브이슈 상태(open/closed) + 체크박스로 표현 |
| 에픽에 codex/gemini 리뷰 결과 붙임 | 해당 PR 코멘트에 남김 |
| 에픽에 구현 계획 v1/v2/v3 누적 | 설계 이슈 별도 생성, 에픽에선 링크만 |
| 한 서브이슈가 2+개 phase 처리 | 1 phase = 1 서브이슈 = 1 PR |
| 서브이슈 없이 에픽에서 바로 PR | 반드시 서브이슈 통해서만 |
| 에픽 본문을 구현 중 계속 수정 | 체크박스 전환만 허용 |

## Templates

### 에픽 이슈 템플릿

```markdown
## Goal

<1~2 문단. WHY. 사용자 가치. HOW는 서브이슈에.>

## Design Reference

- <optional: 설계 문서/이슈 링크>

## Checklist

- [x] <phase 1 이름> — #<sub-issue-1>
- [ ] <phase 2 이름> — #<sub-issue-2>
- [ ] <phase 3 이름> — #<sub-issue-3>

## Done-Done 기준

- <검증 가능한 기준 1>
- <검증 가능한 기준 2>

## Out of Scope

- <명시적 제외 항목>
```

### 서브이슈 템플릿

```markdown
## Parent

부분: #<epic-number>

## Goal

<이 phase 하나의 목표. 1 문단.>

## In Scope

- <구체 항목>

## Out of Scope

- <명시적 제외>

## File Map

| 파일 | 역할 | 변경 유형 |
|---|---|---|
| `path/to/x.ts` | ... | new/modify |

## Test Plan

- Unit: <목록>
- Integration: <목록>
- Regression: <목록>

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| ... | ... | ... |

## PR 요건 (verify)

- [ ] CI green
- [ ] codex ≥95, 0 P0/P1
- [ ] <phase 특정 verify 항목>
```

## Invariants (위반 시 롤백)

1. **에픽 본문의 "Checklist" 섹션 외 영역**은 에픽 생성 후 수정 금지 (제목/라벨 rename 예외).
2. **하나의 체크리스트 아이템 = 하나의 서브이슈 = 하나의 PR.**
3. **서브이슈 close 전 에픽 체크 `[x]` 금지.**
4. **에픽 close 전 모든 서브이슈 close 필수.**
5. **에픽 댓글은 "서브이슈 분할 핸드오프" 같은 메타 전환 1회만 허용.** 진행 보고 댓글 금지.

## Integration

- **입력 트리거:** 유저가 복수 phase 피처를 요청하거나, `z` 스킬이 phase1에서 "multi-PR이 필요함"을 판정했을 때.
- **후속 스킬:** 서브이슈 작업 진행은 `z` 스킬에 위임. 체크리스트 업데이트 후 `es`로 완료 공지.
