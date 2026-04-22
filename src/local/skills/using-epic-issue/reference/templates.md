# Templates — using-epic-issue 부속

P1·P2에서 복사해 쓰는 마크다운. 섹션 순서·이름은 SKILL.md §P1·§P2가 소유 — 여기서 바꾸면 안 됨.

**언어 규율 (SKILL.md Invariant 8)**

- Epic 템플릿 전체 + Sub-issue 템플릿 `## 구현 스펙` **위쪽**: 하이레벨 컨셉 언어만.
- Sub-issue 템플릿 `## 구현 스펙` **아래**: 구체 심볼(파일 경로, 클래스·함수 이름, ENV 변수, 코드 스니펫) 허용.
- 경계선 `---`는 필수. 구현 디테일이 위로 새어 나가는 1차 방벽.

## Epic

```markdown
## Goal

<1~2문단. WHY 중심. 사용자 가치. 하이레벨 컨셉 언어. 파일·클래스·함수·ENV 변수 금지.>

## Design Reference

- <선택: 설계 문서 링크. 없으면 이 섹션 제거>

## Checklist

- [ ] <phase 1 컨셉 한 줄> — <서브이슈 링크>
- [ ] <phase 2 컨셉 한 줄> — <서브이슈 링크>
- [ ] <phase 3 컨셉 한 줄> — <서브이슈 링크>

## Done-Done

- <검증 가능한 조건. 사용자 가시 관점.>
- <검증 가능한 조건>

## Out of Scope

- <명시적 제외. 컨셉 레벨.>
```

## Sub-issue

```markdown
## Parent

<에픽 이슈 링크>

## Goal

<1문단. 이 phase만의 목표. **하이레벨 컨셉 언어**. WHY·WHAT 중심. 파일·클래스·함수·ENV 변수·코드 스니펫 금지. 독자가 구현 맥락 없어도 이해 가능해야 함.>

## In Scope

- <컨셉 레벨 bullet. 사용자·기능 관점.>

## Out of Scope

- <제외. 컨셉 레벨.>

---

## 구현 스펙

### File Map

| 파일 | 역할 | 변경 유형 |
|---|---|---|
| <경로> | <역할> | new / modify |

### Test Plan

- Unit: <목록>
- Integration: <목록>
- Regression: <목록>

### Risks / Mitigations

| Risk | L | Mitigation |
|---|---|---|
| <리스크> | L/M/H | <완화책> |

### PR 요건

- Branch: `<branch 이름>`
- Base: `main`
- CI: <green 조건>
- Deploy: <flip·soak 조건>
- PR 본문에 `Closes <서브이슈 번호>`

### Dependency

- 선행: <서브이슈·PR>
- 후행: <서브이슈·PR>
```

> **체크**: Sub-issue 템플릿 위쪽 3 섹션(Parent·Goal·Scope)만 읽어서 이 phase가 무엇을 하는지 설명 가능해야 함. 못 하면 Goal을 컨셉 레벨로 재작성.
