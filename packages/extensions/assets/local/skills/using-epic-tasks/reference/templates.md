# Templates

`using-epic-tasks`의 3 케이스별 템플릿. 섹션 순서·이름은 SKILL.md가 소유 — 여기서 바꾸지 않음.

## 언어 규율 (공통)

- 에픽·서브이슈 제목 + Goal + Scope → **하이레벨 컨셉 언어**. 파일 경로, 함수·클래스 이름, ENV 변수, 코드 블록 금지.
- PR body 또는 서브이슈 `## 구현 스펙` 이하 → 구체 토큰 허용.
- 경계선 `---`는 한 산출물 안에 두 층을 섞을 때만. 가능하면 산출물을 분리.
- 상세: `using-ha-thinking`.

---

## Case A

### A-1. Issue Template

```markdown
## Goal
<1문단. 왜·무엇. 컨셉 언어.>

## Scope
- In: <포함 항목>
- Out: <제외 항목>

## Done
- <검증 가능한 조건. 사용자 가시 관점.>
```

### A-2. PR Template

```markdown
## Summary
<이슈 Goal을 구현 관점에서 한 줄로 재서술>

Closes #<이슈번호>

---

## 구현 스펙

### File Map
| 파일 | 역할 | 변경 |
|---|---|---|

### Test Plan
Unit / Integration / Regression

### PR 요건
- Branch: `<branch 이름>`
- CI: <green 조건>
```

---

## Case B

### B-1. Epic Template

```markdown
## Goal
<1~2문단. 왜·무엇. 컨셉 언어만. 구현 토큰 금지.>

## Design Reference
- <선택: 설계 문서 링크. 없으면 섹션 제거.>

## Checklist
- [ ] <서브이슈 제목 그대로> — #<번호>
- [ ] <서브이슈 제목 그대로> — #<번호>
- [ ] <서브이슈 제목 그대로> — #<번호>

## Done-Done
- <사용자 가시 관점 검증 조건>

## Out of Scope
- <명시적 제외. 컨셉 레벨.>
```

**Epic body 금지 사항**: 구현 상세, 파일 경로, 코드 스니펫, 리뷰 답변, 설계 논의, "진행 상황" 섹션.

### B-2. Sub-issue Template

```markdown
## Parent
- Epic: #<번호>

## Goal
<1문단. 이 phase만의 목표. 컨셉 언어. 구현 맥락 없이도 이해 가능해야 함.>

## In / Out of Scope
- In: <컨셉 레벨 bullet>
- Out: <컨셉 레벨 bullet>

---

## 구현 스펙

### File Map
| 파일 | 역할 | 변경 |
|---|---|---|

### Test Plan
- Unit: <목록>
- Integration: <목록>
- Regression: <목록>

### Risks / Mitigations
| Risk | L | Mitigation |
|---|---|---|

### PR 요건
- Branch: `<branch 이름>`
- CI: <green 조건>
- Closes #<서브이슈 번호>

### Dependency
- 선행: <서브이슈·PR>
- 후행: <서브이슈·PR>
```

**체크**: Parent + Goal + Scope 세 섹션만 읽어서 이 phase가 무엇을 하는지 설명 가능해야 함. 못 하면 Goal을 컨셉 레벨로 재작성.

### B-3. PR Template (thin)

서브이슈에 구현 스펙이 이미 있으므로 PR은 얇게.

```markdown
## Summary
<서브이슈 Goal 재서술 한 줄>

Closes #<서브이슈 번호>
```

구현 디테일이 서브이슈 작성 후 바뀌었으면, PR이 아니라 **서브이슈를 업데이트**. 서브이슈가 single source of truth.

---

## Case C

에픽·이슈 생성 안 함. 유저에게만 보낸다.

### C-1. 중지 보고 Template

```markdown
## 진단

이 요청은 switching cost **xxlarge (~1000+ lines)** 로 판정됩니다.
한 에픽 단위로 처리할 수 없습니다.

## 제안 분해

- **Epic 1**: <컨셉 제목> (~N lines, xlarge)
- **Epic 2**: <컨셉 제목> (~N lines, xlarge)
- **Epic 3**: <컨셉 제목> (~N lines, xlarge)

각 에픽은 독립 세션에서 Case B로 처리됩니다.

## 3-Person Review Consensus

- self: <의견>
- oracle-reviewer: <의견>
- oracle-gemini-reviewer: <의견>

합의: <2/3 또는 3/3 합의 요약>

## 요청

- 위 분해에 동의하시면 **승인** 회신 → 각 에픽 독립 진행
- 분해를 다르게 하시려면 에픽 경계를 재지정해 주세요
- 범위 자체를 줄이시려면 Case B로 축소 가능한 최소 단위를 지정해 주세요

분해 승인 전까지 에픽·이슈·PR 하나도 만들지 않습니다.
```
