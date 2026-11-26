# loop — goal-state 구현 드라이브

Status: R1 closed 2026-11-26 (PR1–PR10 + 리뷰 라운드, 머지 · dev 배포 · 실측 — [`loop.done.md`](loop.done.md) R1) ·
R2 open (아래 셋, 모두 조건 대기) · ssot = [`ssot.md`](ssot.md) SSOT_1–2 · 닫힌 라운드 = [`loop.done.md`](loop.done.md) ·
현재 상태 = [`../38-goal-state-as-is.md`](../38-goal-state-as-is.md) · 스펙 = [`../39-goal-state-spec.md`](../39-goal-state-spec.md) ·
아키텍처 = [`../40-goal-state-architecture.md`](../40-goal-state-architecture.md)

## R2 — R1 뒤에 남은 것

| ID | 작업 | Status | 조건 · 이유 |
|---|---|---|---|
| R2.1 | 옛 필드 함께 쓰기 제거(40 §3 · D17): 저장은 `phase`만, 로드는 `phase`를 펼친다 | ⏸ 조건 대기 | `phase`를 못 읽는 빌드(PR7 #1498 이전)가 기록을 다시 읽을 수 있는 동안 지우면 안 된다: 그 빌드가 goal의 첫 턴을 시작하면 `openingPending`만 지우는데, `phase`만 있는 기록은 `opening`으로 남아 루프가 그 goal을 영영 몰지 않는다(A27 4행). 조건 = PR7을 포함한 prod 릴리스 뒤 1주, 되돌릴 빌드가 남지 않았을 때. 그때 cap 질문의 저장 모양도 라운드 필드를 품도록 넓힌다 |
| R2.2 | A22 전체 흐름(대시보드에서 goal 생성 → 한도 1 → cap 질문 한 번 → `goal max`로 재개 → 재시작 중 카드 칸) | ⏸ 사람 필요 | 대시보드 새 작업은 Slack으로 로그인한 사람만 만든다. 봇이 쓰는 브라우저 도구는 대시보드에 로그인돼 있지 않고, 로그인은 2단계 인증 코드에서 멈춘다(사람만 넣을 수 있다). R1은 그 대신 서버 쪽 실측으로 닫았다(loop.done R1 · 실측) |
| R2.3 | Slack `goal` 블록을 같은 투영(`goalCardPhase`)으로 | 💤 선택 | 39 §범위 밖 "작으면 WU7" — WU7은 보드 칸까지만 했다 |

## build facts

- 패키지 먼저 빌드: `npm ci --cache /tmp/<uid>/npm && npm run build:packages && npm run build:somalib`.
- 게이트: `npx tsc --noEmit` · `npx biome check <files> --diagnostic-level=error` · `npx vitest run <files>`.
- 봇 샌드박스 안 전체 `npx vitest run`은 부하(load avg 30+)로 시간 초과 실패가 섞인다(2026-11-26: 85건 · 30파일, 모두 이 변경과
  무관) — 판정은 바뀐 코드를 쓰는 파일별 재실행 + CI quality-gates.
- 봇이 자주 재시작된다(다른 세션의 dev 배포): 한 번에 9분 넘게 붙잡지 말고, 진행은 이 파일과 커밋으로 남긴다.
- zsh: `$F`로 파일 목록을 넘기면 한 인자가 된다 — 경로를 그대로 쓴다.
