# loop — goal-state 구현 드라이브

Status: in-progress · 라운드 0(스펙 고정) · ssot = [`ssot.md`](ssot.md) SSOT_1–2 ·
현재 상태 = [`../38-goal-state-as-is.md`](../38-goal-state-as-is.md) · 스펙 = [`../39-goal-state-spec.md`](../39-goal-state-spec.md) ·
아키텍처 = [`../40-goal-state-architecture.md`](../40-goal-state-architecture.md)

## R0 — 스펙 고정 (코드 전)

| ID | 작업 단위 | Status | 다음 |
|---|---|---|---|
| R0.1 | goal 히든 상태 실측: 데이터 모델 · 루프/평가기 · 호스트 연동 · 사용자 표면 4영역 | 🟡 | 실측 결과를 38에 모은다 |
| R0.2 | 38 현재 상태(히든 상태 목록 + 고친 이력) | 🔴 | R0.1 뒤 |
| R0.3 | 39 스펙(명시 상태 · 전이 · 인수 시나리오) | 🔴 | R0.2 뒤 |
| R0.4 | 40 아키텍처(모듈 경계 · WU 분해 · 순서) | 🔴 | R0.3 뒤 |
| R0.5 | 스펙 외부 리뷰(trinity) → 고정 | 🔴 | R0.4 뒤 |

## build facts

- 패키지 먼저 빌드: `npm ci --cache /tmp/<uid>/npm && npm run build:packages && npm run build:somalib`.
- 게이트: `npx tsc --noEmit` · `npx biome check <files> --diagnostic-level=error` · `npx vitest run <files>`.
- 봇 샌드박스 안 전체 `npx vitest run`은 부하(load avg 30+)로 시간 초과 실패가 섞인다(2026-11-26: 85건 · 30파일, 모두 이 변경과
  무관) — 판정은 바뀐 코드를 쓰는 파일별 재실행 + CI quality-gates.
- 봇이 자주 재시작된다(다른 세션의 dev 배포): 한 번에 9분 넘게 붙잡지 말고, 진행은 이 파일과 커밋으로 남긴다.
