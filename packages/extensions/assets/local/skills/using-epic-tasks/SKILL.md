---
name: using-epic-tasks
description: "유저의 구현 요청을 받으면 decision-gate로 규모를 판정한 뒤 3 케이스로 라우팅. Case A (이슈 1 + PR 1, tier ≤ large), Case B (에픽 + 서브이슈 N + PR N, tier = xlarge), Case C (에픽 여러 개 분량이면 중지·쪼개기 요청, tier ≥ xxlarge). 작업 시작 전 decision-gate 통과 필수. 각 산출물 본문은 using-ha-thinking의 층 규율을 따른다."
---

# using-epic-tasks

## 전제

- `decision-gate` — 규모(switching cost) 판정
- `using-ha-thinking` — 각 산출물 본문의 언어 규율

## Core

유저 요청 → `decision-gate` 호출 → 반환된 tier로 케이스 결정.

| tier | 케이스 | 산출물 |
|---|---|---|
| ≤ large (≤~100 lines) | **Case A** | 이슈 1 + PR 1 |
| xlarge (~500 lines) | **Case B** | 에픽 1 + 서브이슈 N + PR N |
| ≥ xxlarge (≥~1000 lines) | **Case C** | 없음 — 유저에게 쪼개기 요청 후 중지 |

**작업 시작 전 반드시 케이스 판정.** 판정 없이 에픽·이슈 생성 금지.

### Tier 판정 휴리스틱 (line 수 예측이 어려울 때)

유저 요청 단계에서 실제 diff 라인 수를 알기 어렵다. 아래 대체 신호를 사용.

| 신호 | xxlarge 가중치 |
|---|---|
| 수정 대상 모듈 ≥ 5 | +1 |
| 의존 층 ≥ 3 (DB · API · UI · auth · billing 등) | +1 |
| 외부 API 계약 또는 DB 스키마 변경 | +1 |
| 배포 유닛 ≥ 2 (서비스·워커·CI) | +1 |
| 신규 제품 표면 (새 인증 스택, 새 빌링 시스템 등) | +1 |

**≥ 2개 충족** 시 xxlarge 판정, Case C. 1개면 xlarge 후보로 Case B + `decision-gate` 재검토.

## Case A — 단일 이슈

**When**: tier < xlarge. 한 PR로 완결되는 작업.

**Flow**:
1. 이슈 생성 — 제목, Goal, Scope, Done
2. PR 생성 — body에 `Closes #<이슈번호>`
3. 머지 → 이슈 자동 닫힘

**산출물**: 이슈 1, PR 1.

**Escape — tiny/small fix**:

tier가 `tiny (~5 lines)` 또는 `small (~20 lines)`이면 **이슈 생성 생략 가능**. PR 1개만으로 진행하고 PR description에 컨셉 한 줄 + 구현 요약을 담는다. 이슈 오버헤드는 `medium (~50 lines)` 이상에서만 의미 있음.

단, 다음 중 하나라도 해당되면 tier와 무관하게 이슈 생성:
- 유저가 최초에 "이슈부터 열어라" 같이 명시 요청
- 리뷰·배포 이력 추적이 필요한 변경 (API 계약·DB 마이그레이션 등)
- 여러 PR에 걸쳐 진행될 가능성

**예**: "로그인 실패 시 에러 메시지 개선" → medium tier → Case A (이슈 포함).
"변수명 typo 수정" → tiny → Case A escape (PR만).

**템플릿**: `reference/templates.md` §Case A.

## Case B — 에픽 + 서브이슈

**When**: tier == xlarge. 1 PR에 못 담지만 1 에픽 단위로 계획 수립 가능.

**Flow**:
1. **에픽 생성** — 제목, Goal, Checklist 자리, Done, Out of scope. Body에 구현 토큰 금지.
2. **서브이슈 N개 즉시 생성**. 각 서브이슈는 Case A 크기(≤ large). 초과 시 즉시 재분해.
3. 에픽 Checklist에 서브이슈 링크.
4. 각 서브이슈마다 PR 생성 → 머지 → 서브이슈 닫힘.
5. 모든 서브이슈 닫히면 에픽 Done 조건 확인 후 닫기.

**산출물**: 에픽 1, 서브이슈 N, PR N.

**서브이슈 개수 상한**: N ≤ 5~7 권장. **N ≥ 8이면 xxlarge로 상향 조정**하고 Case C로 이동. 7개를 넘어가면 첫 서브이슈 머지 시점에 마지막 서브이슈 맥락이 drift 시작 — 재작업 비용이 원래 분해 비용을 넘는다.

**예**: "Auth 모듈 Session → JWT 전환" → xlarge → Case B (서브이슈 ~5개).

**템플릿**: `reference/templates.md` §Case B.

## Case C — 중지·분해 요청

**When**: tier ≥ xxlarge. 여러 에픽 분량.

**Flow**:
1. **작업 시작 금지.** 에픽·이슈 하나도 만들지 않음.
2. 3명 리뷰(self + `oracle-reviewer` + `oracle-gemini-reviewer`)로 가능한 분해 구조 초안.
3. 유저에게 보고 — "이 요청은 에픽 N개 분량입니다. 이렇게 쪼개는 것을 제안합니다: [에픽 목록]. 승인하시겠습니까?"
4. 유저 승인 후 — 각 에픽을 독립 세션에서 Case B로 처리.

**산출물**: 없음. 요청 반려 + 분해 제안.

**왜 중지하는가**: 한 세션이 일관된 맥락으로 설계할 수 있는 상한을 넘는다. 첫 에픽만 만들고 나머지 맥락 없이 진행하면 다음 에픽들이 첫 에픽에 부정합으로 쌓인다 — 재작업 비용이 원래보다 크다.

**예**: "전체 Billing 시스템 리뉴얼" → xxlarge+ → Case C.

**템플릿**: `reference/templates.md` §Case C.

## 규율

1. **decision-gate 먼저.** tier 판정 없이 이슈·에픽 생성 금지. 단, **tier는 진입 스킬(`z` phase0)이 이미 호출한 결과**를 받아 쓴다 — using-epic-tasks가 decision-gate를 **재호출하지 않는다** (중복 방지).
2. **케이스 승격 금지.** Case A를 에픽으로 부풀리지 않는다. 오버헤드만 는다.
3. **케이스 하향 금지.** tier가 xlarge면 단일 PR로 처리하지 않는다. PR 하나가 500 lines를 넘으면 리뷰 품질이 무너진다.
4. **Case C는 반드시 중지.** 억지 진행 금지. 유저 승인 없이 첫 에픽 생성 금지.
5. **각 산출물은 `using-ha-thinking` 규율.** 에픽·서브이슈 제목·Goal엔 구현 토큰(파일 경로, 함수명, ENV) 금지. 리프(PR 또는 서브이슈 `## 구현 스펙` 이하)에만 허용.
6. **에픽 body 부패 금지.** 진행 로그, 리뷰 응답, 설계 논의 → 서브이슈·PR에 쌓고 에픽 body는 Checklist + Goal + Done만 유지.
7. **서브이슈 상한 N ≤ 7.** 8개 이상이면 xxlarge로 상향 → Case C.

## Anti-patterns

- decision-gate 건너뛰고 즉시 에픽 생성
- 진입 스킬(`z` phase0)이 이미 판정한 tier를 무시하고 using-epic-tasks에서 재판정 (중복 호출)
- "어쩐지 큰 일 같다"고 Case C를 Case B로 억지 시작
- 서브이슈 없는 에픽 / 체크리스트 빈 에픽
- 에픽 제목·Body에 구현 토큰
- 한 PR에 xlarge 이상 담기 (리뷰 불가)
- Case A짜리 작업에 에픽 씌우기
- 서브이슈 8개 이상 쪼개기 (xxlarge 신호 무시)
- tiny/small fix에 이슈 강제 (불필요한 오버헤드)

## Integration

- **진입점 2-hop**: 모든 구현 요청은 `z` 스킬을 통과 → `z` phase0에서 `decision-gate` 호출 → tier 확정 → `using-epic-tasks` 호출 (tier 전달) → Case A/B/C 분기.
- **중복 호출 금지**: using-epic-tasks는 phase0이 전달한 tier를 신뢰. 자체적으로 decision-gate 재호출하지 않음.
- **본문** — 각 산출물은 `using-ha-thinking` 규율 적용.
- **플랫폼 문법** — `reference/github.md`, `reference/jira.md`.
- **템플릿** — `reference/templates.md`.
- **후속 스킬** — 서브이슈/이슈 작업 → `z`; 완료 공지 → `es`.
- **병렬성** — 독립 서브이슈는 별도 worktree/branch. 동일 파일 건드리는 서브이슈는 직렬 (서브이슈 body의 Dependency 표기 또는 에픽 Checklist 순서).
