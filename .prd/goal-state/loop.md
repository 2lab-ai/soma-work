# loop — goal-state 구현 드라이브

Status: in-progress · 라운드 1(PR1–PR10) · ssot = [`ssot.md`](ssot.md) SSOT_1–2 · 닫힌 라운드 = [`loop.done.md`](loop.done.md) ·
현재 상태 = [`../38-goal-state-as-is.md`](../38-goal-state-as-is.md) · 스펙 = [`../39-goal-state-spec.md`](../39-goal-state-spec.md) ·
아키텍처 = [`../40-goal-state-architecture.md`](../40-goal-state-architecture.md)

## R1 — PR1–PR10 (40 §4 순서대로, PR마다 머지 → 소유자 dev 배포 → 시나리오 확인)

| ID | 작업 단위 | Status | 다음 |
|---|---|---|---|
| R1.1 | PR1 · WU1 점유 모듈(동작 보존) + A23–A26 기준선 + 계약 규칙 2 | 🟡 | 관련 테스트 재실행 → PR → CI → 머지 → dev 배포 |
| R1.2 | PR2 · WU1 게이트 교체 · 로드 레코드 · releaseRecovered | 🔴 | R1.1 뒤 |
| R1.3 | PR3 · WU2 모델 · 읽기 한 곳(phaseOf · placeOf) | 🔴 | R1.2 뒤 |
| R1.4 | PR4 · WU3 전이 이동(goal/machine.ts) | 🔴 | R1.3 뒤 |
| R1.5 | PR5 · WU3 커밋 한 길(goal-commit.ts) | 🔴 | R1.4 뒤 |
| R1.6 | PR6 · WU3 표면 수정(D11 · D12) | 🔴 | R1.5 뒤 |
| R1.7 | PR7 · WU4 저장 모양 + 화면(D4–D6 · D17 · A27) | 🔴 | R1.6 뒤, 배포 뒤 재시작 1회 |
| R1.8 | PR8 · WU5 루프 구동기(LoopState · PendingDrive · AutoResume) | 🔴 | R1.7 뒤 |
| R1.9 | PR9 · WU6 재시작 복구(restart-recovery.ts) | 🔴 | R1.8 뒤 |
| R1.10 | PR10 · WU7 칸 · 문서 · dev 실측(A22) | 🔴 | R1.9 뒤 |

## build facts

- 패키지 먼저 빌드: `npm ci --cache /tmp/<uid>/npm && npm run build:packages && npm run build:somalib`.
- 게이트: `npx tsc --noEmit` · `npx biome check <files> --diagnostic-level=error` · `npx vitest run <files>`.
- 봇 샌드박스 안 전체 `npx vitest run`은 부하(load avg 30+)로 시간 초과 실패가 섞인다(2026-11-26: 85건 · 30파일, 모두 이 변경과
  무관) — 판정은 바뀐 코드를 쓰는 파일별 재실행 + CI quality-gates.
- 봇이 자주 재시작된다(다른 세션의 dev 배포): 한 번에 9분 넘게 붙잡지 말고, 진행은 이 파일과 커밋으로 남긴다.
- zsh: `$F`로 파일 목록을 넘기면 한 인자가 된다 — 경로를 그대로 쓴다.
