# loop.done — goal-state (append-only)

## R0 — closed 2026-11-26T19:45+09:00

- 스펙 고정: 38 현재 상태(H1–H6 · X1–X19) · 39 스펙(S1–S6 · I1–I7 · D1–D17 · A1–A28) · 40 아키텍처(모듈 · WU 7개 · PR 10개 · 계약 6규칙).
  trinity 4라운드(grok · astra · fable) — R1–R3 모두 APPROVE-WITH-CHANGES, 지적 반영 커밋 뒤 R4 만장일치 APPROVE. 브랜치
  `prd/goal-state-machine` HEAD `939bab87`.

### Closed rows

| ID | 작업 단위 | Status | 증거 |
|---|---|---|---|
| R0.1 | goal 히든 상태 실측 4영역 | ✅ | `.prd/research/goal-state-inv-*.md` 4편 → 38 §H1–H6 |
| R0.2 | 38 현재 상태 | ✅ | `.prd/38-goal-state-as-is.md` — 히든 상태머신 6개 · 고친 이력 X1–X19 |
| R0.3 | 39 스펙 | ✅ | `.prd/39-goal-state-spec.md` — S1–S6 · I1–I7 · D1–D17 · A1–A28 |
| R0.4 | 40 아키텍처 | ✅ | `.prd/40-goal-state-architecture.md` — 모듈 지도 · 계약 · 이행 표 · PR1–PR10 · 계약 6규칙 |
| R0.5 | trinity 리뷰 → 고정 | ✅ | R4 만장일치 APPROVE(astra · fable · grok, MUST-FIX none). 반영 커밋 d37b3577 · d2174eec · bf92684a · 9fcd0e6e · 969e3228 · 79f29633 · 939bab87 |

## R1 — closed 2026-11-26

PR1–PR10(40 §4)과 리뷰 라운드(PR11)를 머지하고 ‹소유자 dev 호스트›에 네 번 배포했다(한 번은 다른 작업의 배포에 실려 갔다). 숨은 상태머신 H1–H6이 S1–S6의 주인 모듈로
옮겨졌고, 경계 계약 6규칙이 모두 켜져 있다(`src/__tests__/goal-state-boundary.contract.test.ts` — 남은 예외 목록은 줄기만 한다).

### Closed rows

| ID | 작업 단위 | Status | 증거 |
|---|---|---|---|
| R1.1 | PR1 · WU1 점유 모듈(동작 보존) + A23–A26 기준선 + 계약 규칙 2 | ✅ | https://github.com/2lab-ai/soma-work/pull/1487 · `50a76cb4` |
| R1.2 | PR2 · WU1 게이트 교체 · 로드 레코드 · releaseRecovered (X1–X3) | ✅ | https://github.com/2lab-ai/soma-work/pull/1490 · `d83d5c90` |
| R1.3 | PR3 · WU2 모델 · 읽기 한 곳(phaseOf · placeOf) (X4) | ✅ | https://github.com/2lab-ai/soma-work/pull/1493 · `642560e0` |
| R1.4 | PR4 · WU3 전이 이동(goal/machine.ts), 에폭은 bumpEpoch만 (X9) | ✅ | https://github.com/2lab-ai/soma-work/pull/1494 · `502d6469` |
| R1.5 | PR5 · WU3 커밋 한 길(goal-commit.ts), `goal max`가 cap 정지를 다시 돌림 (X5 · A5) | ✅ | https://github.com/2lab-ai/soma-work/pull/1495 · `4a36d394` |
| R1.6 | PR6 · WU3 표면 수정 (X10–X16) | ✅ | https://github.com/2lab-ai/soma-work/pull/1497 · `65c9f149` |
| R1.7 | PR7 · WU4 저장 모양(phase · 지문 · 완료 goal은 히스토리만 · hold why) (D4–D6 · D17 · A27) | ✅ | https://github.com/2lab-ai/soma-work/pull/1498 · `6239cf67` |
| R1.8 | PR8 · WU5 stopped{why} 기록 · 종료 중 주입 없음 (X6 · X7 · A28) | ✅ | https://github.com/2lab-ai/soma-work/pull/1499 · `5e297da1` |
| R1.9 | PR9 · WU6 재시작 복구(restart-recovery.ts) (X18 · X19) | ✅ | https://github.com/2lab-ai/soma-work/pull/1500 · `f915efb4` |
| R1.10 | PR10 · WU7 보드 칸(goal/board.ts · S6 · D14) · 문서 §States (X17 · A17) | ✅ | https://github.com/2lab-ai/soma-work/pull/1502 · `6f27c399` |
| R1.11 | PR11 · 리뷰 라운드(31건: P1 3 · 결함 P2 2 · 테스트 공백 9 · 계약 3 · P3) | ✅ | https://github.com/2lab-ai/soma-work/pull/1503 · `e236b65d` |

### 실측 (‹소유자 dev 호스트›)

- 배포 — `d83d5c90`(PR1+PR2), `f915efb4`(PR1–PR9), `655577ec`(PR10, 다른 작업의 배포), `e236b65d`(PR11).
- 재시작 패스(13:42:22Z): 재시작이 끊은 턴 5개는 각자의 재개 턴 하나로만 이어졌고("carried by the resume of their cut
  turn"), 질문을 기다리던 4개는 `waiting` 그대로 루프를 돌리지 않았다. goal 관련 WARN · ERROR 0.
- 새 빌드의 첫 저장(13:47:01Z): 슬롯에 `complete`로 남아 있던 goal 51개 → 0개(D5, 히스토리 중복 id 0). 활성 goal 9개 모두
  `phase` + `phaseFp`(asking 4 · running 5). 디스크의 `pendingEval` 0(D4). `sessions.json` 7.13 MB → 6.82 MB.
- 보드(로컬 대시보드 보드 API, 읽기 전용): PR10이 올라간 뒤 goal 카드마다 `goalBoard`와 `phase`가 실렸다 —
  턴이 도는 goal 5개는 RUNNING(`why: turn`, phase running), stall 질문 4개는 NEEDS YOU(`why: stall`, 질문이 열린 시각).
  2초 폴링(14:27–14:41Z)에서 턴과 다음 이어하기 사이 구간을 네 번 잡았다: 턴이 끝나 표시가 `idle`이 된 뒤에도 카드는
  RUNNING에 남았고 `why`가 turn → driven(판정 · 주입, `autoResume: goal-eval`) → turn(이어하기 준비) → working으로 이어졌다
  (X17 · A17 — 전에는 이 10–30초가 DONE이었다). 같은 실패가 두 번 난 goal 두 개는 stall 질문으로 NEEDS YOU로 옮겨 갔고, 한
  번은 표시가 아직 `idle`일 때 goal이 먼저 칸을 옮겼다(S6 규칙 3).

### 남긴 것

R2(loop.md): 옛 필드 함께 쓰기 제거는 되돌릴 빌드가 남지 않을 때까지 보류, A22의 대시보드 생성 흐름은 사람이 로그인한
브라우저가 필요, Slack `goal` 블록 투영은 선택.
