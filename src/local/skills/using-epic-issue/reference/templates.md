# Templates — using-epic-issue 부속

P1·P2에서 복사해 쓰는 마크다운. 섹션 순서·이름은 SKILL.md §P1·§P2가 소유 — 여기서 바꾸면 안 됨.

## Epic

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

## Sub-issue

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
