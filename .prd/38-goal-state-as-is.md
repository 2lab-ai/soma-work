# 38 — goal 현재 상태: 상태머신이 코드에 숨어 있다

Status: shipped (R1, 2026-11-26 — [goal-state/loop.done.md](goal-state/loop.done.md)) · 실측 2026-11-26 · 기준 커밋 main `cda77e0a` · ssot = [goal-state/ssot.md](goal-state/ssot.md)

> 요약: goal이 선언한 상태는 `status` 하나뿐이고, 루프가 실제로 어디에 있는지(판정 중·재시도 대기·주인 질문 대기·첫 턴
> 대기)는 필드 조합·메모리 집합·타이머·프록시로 흩어져 있다. 같은 질문("턴이 도는가", "cap 질문이 열렸나", "멈춰 있나")에
> 코드 곳곳이 다른 신호로 답하고, 고칠 때마다 한 곳에 신호 하나를 더했다 — 최근 2달 `fix(goal…)` 52건이 그 흔적이다.

## 0. 미니맵

```
38 goal 현재 상태
├─ 1. 숨은 상태머신 다섯 개          ─ 무엇이 어디에 숨어 있나
├─ 2. 같은 질문, 다른 답             ─ 턴이 도는가 · cap 질문 · 일시정지 · 진행 중
├─ 3. 숨은 상태가 만든 버그           ─ 실측으로 찾은 것(재현 시나리오 포함)
├─ 4. 고친 이력이 말하는 것           ─ 한 곳에 신호 하나씩
└─ 5. 증거                           ─ 영역별 인벤토리 4편
```

읽는 법: 무엇이 숨어 있는지는 §1, 왜 버그가 반복되는지는 §2·§4, 이번에 같이 고칠 버그 목록은 §3. 줄 번호·커밋은
§5의 인벤토리에 있다. 목표 모양은 [39-goal-state-spec.md](39-goal-state-spec.md), 구현 모양은
[40-goal-state-architecture.md](40-goal-state-architecture.md).

## 1. 숨은 상태머신 다섯 개

코드에는 상태머신이 여섯 개 있는데, 어느 것도 이름이 없다(H6은 trinity R1이 찾았다).

| # | 상태머신 | 지금 표현 | 어디에 |
|---|---|---|---|
| H1 | 턴 점유 — 이 세션에서 지금 턴이 도는가 | 시계 세 개: 팔로업 슬롯(가장 이름) · 요청 컨트롤러(세션 초기화 뒤) · `activityState='working'`(SDK가 답한 뒤, dev에서 85초 늦은 기록) | 디스패처 · `RequestCoordinator` · 세션 필드(저장됨) |
| H2 | goal 위치·수명 | `status` 4값 + 어느 배열에 있나(`goal`·`goalQueue`·`goalPaused`·`goalHistory`) — 둘이 어긋날 수 있다 | 세션 필드 |
| H3 | 활성 goal의 루프 단계 | `status:'active'` 하나 안에: 첫 턴 대기(`openingPending`) · 판정 중(`pendingEval`) · 재시도 대기(`evalBackoffUntil`·`evalDispatchRetryCount`·`evalRetryReason`) · cap 질문(`capDmPendingAt`·`capDecisionId`·`capDmRef`) · stall 질문(`stall`) · 한도 소진(`continuationCount >= maxContinuations`로 추론) | goal 필드 약 20개 |
| H4 | 루프 구동기의 런타임 | `queues` · `runsWaiting` · `continuedThisRun` · `injecting` · `armedEvalRetries` + 핸들 없는 타이머. 밖으로는 `isActing` 불리언 하나 | `GoalLoopController` 메모리 |
| H5 | 재시작 복구 | `restartCutSessionKeys` · `restartResumedSessionKeys` · `restartGoalPassRan` · `followupResumeMark` + 저장된 `activityState`·`wasWorkingAtShutdown` | `SlackHandler` 메모리 + 세션 필드 |
| H6 | 호스트 구동 보류 — 턴은 끝났는데 루프를 언제 깨울지 | `followupDeferredGoalSessions`(팔로업이 먼저) · `followupSlotHeldGoalSessions`(텍스트 없는 턴은 슬롯이 풀린 뒤) · `goalDriverKickOnRelease`(펜스에서 버려진 이어하기) · `goalErrorResumeSpent`(자동 재개 반복 실패) · 사람의 마지막 말(`GOAL_LAST_WORD_ABORT_REASONS`) | `SlackHandler` 메모리. 최근 수정 #891 · #893 · #948 · #950 · #1061이 여기 몰렸다 |

이 밖에도 goal을 붙잡는 메모리 상태가 `SlackHandler`에 더 있다(`goalTurnOrder` — 다리의 늦은 끝을 거르는 순번, `skippedGoalOpenings` · `goalIntakeSeen` — 재전송된 첫 턴을 거르는 인그레스 중복 제거 …), 모듈 전역 가변 값이 7개
(`capDecisionRetirer` · `resumedFromStall` · cap DM 재작성 저널 · stall 은퇴 리스너 · 루프 재개 함수 · 호스트 goal 액션 함수 ·
`surfaces`), 별도 파일 하나(`goal-cap-dm-sync.json`)가 있다. 타입도 둘이다: `src/types.ts`의 `SessionGoal`과 패키지의 손으로
맞춘 사본 `SessionGoalState` — 이미 어긋났다.

## 2. 같은 질문, 다른 답

### 2.1 "턴이 도는가" — 20곳, 신호가 제각각

| 묻는 곳 | 쓰는 신호 |
|---|---|
| 루프 게이트(`shouldRunGoalIdleDriver`) | 컨트롤러 없음 **그리고** `activityState==='idle'` — 슬롯을 안 본다 |
| 재시작 패스(`resumeActiveGoals`, PR #1458 뒤) | 컨트롤러 또는 슬롯 — 루프 동작은 안 본다 |
| 재시작 인계(`handBackFailedRestartResume`) | 컨트롤러 또는 루프 동작 — 슬롯은 안 본다 |
| 멈춘 준비 정리(`releaseStoppedPreparation`) | 컨트롤러만 |
| 후속 질문 · 사용자 작업 큐 · 대시보드 · 디스패치 펜스 … | 각자 다른 조합(슬롯 검사 사본 4개) |

루프 게이트가 `activityState`를 읽기 때문에 호스트는 재시작 때 `activityState='idle'`을 직접 써서 게이트를 열어 왔다
(재시작 패스 · 인계 두 곳). PR #1458의 버그가 바로 이 쓰기가 살아 있는 턴을 덮은 것이다. 훅을 건너뛰는 직접 쓰기는 두 곳이
더 있지만 이유가 다르다: 사람이 멈춘 준비를 정리할 때(크론 · 루프 훅이 멈춘 일을 깨우지 않게)와 `/new` 리셋.

### 2.2 "cap 질문이 열렸나" — 7가지 판정

`isGoalCapDecisionPending`, 여는 쪽의 중복 검사, 은퇴 방송, 답 처리, 대시보드 카드, 후속 질문, 재시작 DM 정리가 서로 다른
조건을 쓴다. 루프 게이트는 이 중 어느 것도 보지 않는다 — 질문이 열린 채로 킥이 오면 루프가 다시 돌아 "⏹️ … paused"를 또
올린다.

### 2.3 "멈춰 있나" · "일시정지"의 두 뜻

- 한도 소진은 한 곳은 `count >= max`, 다른 곳은 cap 필드로 판단한다. 이 상태를 위한 명시 필드(`capReachedAt`)는 하루 살다
  되돌려졌다(#581 → #585).
- "일시정지"는 저장 위치가 두 곳이다: 슬롯에 남은 `paused`(cap 🛑, 큐가 있을 때의 대시보드 중지, 첫 턴 취소 — 만드는 곳마다
  남기는 필드가 다르다)와 선반(`goalPaused`, ⏸️·`goal pause`). 슬롯 `paused`는 큐를 막는데 Slack 문구는 "자동으로 시작"이라고 한다.
- 완료된 goal은 슬롯과 히스토리에 동시에 있다(메모리에서는 같은 객체, 재시작 뒤에는 두 사본).

### 2.4 "진행 중" — 표면마다 다르게 그린다

대시보드 칸은 `activityState`·평가 상태·큐 대기만 보고 goal은 보지 않는다. 그래서 루프가 잡고 있는 활성 goal이 DONE 칸에
"진행 중" 칩을 달고 앉는다 — SSOT_1의 "완료로 대기 목록에 있는데 실제로는 작업중"과 같은 계열. Slack `goal` 블록은 상태 낱말과
횟수만 보여 주고 stall · cap 질문 · 판정 중 · 첫 턴 대기를 보여 주지 않는다.

## 3. 숨은 상태가 만든 버그 (실측, 이번 작업에서 같이 고친다)

ID는 39의 인수 시나리오가 이어받는다. 증거 줄 번호는 §5 인벤토리. 각 항목은 코드 경로 분석이다 — 고치는 PR의 RED 테스트가
재현하지 못하면 그 항목은 여기에 "재현 안 됨"으로 적고 뺀다.

| ID | 버그 | 시나리오(짧게) | 원인이 된 숨은 상태 |
|---|---|---|---|
| X1 | 시작 중인 턴 옆에서 루프가 판정 | 사람 메시지가 슬롯을 잡았지만 컨트롤러 전 → 킥이 "idle"로 보고 판정 · 완료 처리 | H1 시계 셋 |
| X2 | 재시작 인계가 시작 중인 턴을 덮음 | 인계가 슬롯을 안 봄 → `idle` 직접 쓰기 · 환급 · 킥, 펜스에서 또 환급(예산 +1) | H1 · H5 |
| X3 | 재시작 패스가 판정 중인 루프 옆에서 또 킥 | 패스가 루프 동작을 안 봄 → "변화 없음" 알림 + 재개 표시 오염 | H4 · H5 |
| X4 | cap 질문이 열린 채로 루프가 다시 돎 | 게이트가 cap을 모름 → 킥마다 "paused" 알림 재게시, `evalAttemptCount` 증가 | H3 |
| X5 | `goal max N` 뒤 goal이 멈춤 | 에폭만 올리고 루프를 안 깨움 → 판정 폐기, 아무도 다시 안 돎. 열린 cap 질문도 그대로 | H3 |
| X6 | 종료 중 주입된 이어하기 | 알림 대기 뒤 종료 재확인 없음 → 거절 + 보내지 않은 사용자에게 "다시 보내주세요" + 횟수 손실 | H4 |
| X7 | 재시도 소진 · 주입 실패가 "멈춤"으로 기록 안 됨 | 알림만 "일시정지"라 하고 goal은 active · 구동기 없음 → 카드 DONE + 진행 중 | H3 · H4 |
| X8 | 되돌리기가 이미 은퇴한 질문을 살림 | `goal done`·현재 goal 삭제·계획 goal 되돌리기가 cap/stall 필드를 복원 → 묻는 곳 없이 멈춤 | H3 |
| X9 | 인라인 에폭 증가가 재시도 창을 남김 | 목표 수정 · cap 답 · 되살리기가 `bumpGoalEpoch`를 안 씀 → 안 오는 재확인을 카드가 광고 | H3 |
| X10 | `/new`·`/renew` 뒤 옛 큐가 살아남 | 슬롯만 비움 → 다음 재시작이 옛 goal을 새 대화에 승격 | H2 |
| X11 | 보관이 큐를 버림 | 되살린 세션의 대기 goal 소실(일시정지는 #32ccac71에서만 고침) | H2 |
| X12 | 봇 스레드 이동이 슬롯 goal만 복제 | 큐·선반·히스토리 누락, 열린 질문 id 그대로 복제 | H2 |
| X13 | 완료 goal 이중 저장 | `goal done`이 이미 완료된 goal의 기록을 "직접 완료"로 덮어씀 | H2 |
| X14 | Slack 삭제 버튼이 엉뚱한 goal 삭제 | 기대 위치를 클릭 시점 실상태로 계산 → 옛 메시지의 대기 줄 🗑️가 지금 도는 goal 삭제 | 표면 |
| X15 | 자동 goal이 선반을 무시 | goal 일시정지 뒤 잡담 한 줄이 새 goal로 시작 | H2 |
| X16 | `goal resume`이 cap 정지 goal에 "이미 실행 중" | 같은 정지를 `goal X`는 재개, `goal resume`은 거절 | H3 |
| X17 | 대시보드 칸이 goal을 안 봄 | 루프가 잡은 활성 goal이 DONE 칸 + 진행 중 칩(§2.4) | H1 · H3 |
| X18 | 사람의 멈춤이 재시작을 넘지 못함 | 주인의 `!` 뒤 재배포 → 패스가 goal을 다시 굴림 | H5 |
| X19 | 첫 턴이 아직인 goal을 루프가 굴림 | 재시작 패스가 `openingPending`을 안 봄 → 첫 턴 전에 이어하기 | H3 · H5 |

## 4. 고친 이력이 말하는 것

재시작·구동 범위의 커밋 약 20개는 모두 같은 모양이다: 한 가드에 신호를 하나 더하고, 같은 질문에 답하는 형제 가드는 그대로
둔다. 인계에는 루프 동작을(`c4c5ed3e`), 재시작 패스에는 슬롯을(`bbb70609`), 크래시 복구에는 사람의 멈춤을(`e0a7c707`) 더했다.
명시 상태를 한 번 만들었다가 되돌린 기록도 있다(`capReachedAt`, #581 → #585). 패턴의 원인은 상태가 이름 없이 흩어져 있다는
것 하나다 — 버그 하나를 고치려면 그 상태를 읽는 모든 곳을 알아야 하는데, 그 목록이 코드 어디에도 없다.

## 5. 증거

영역별 인벤토리(기준 커밋 `cda77e0a`, 줄 번호 · 커밋 대응 포함):

- [goal-state-inv-A-model.md](research/goal-state-inv-A-model.md) — 데이터 모델과 순수 전이: 필드 30여 개, 숨은 상태 11개, 의심 지점 23개
- [goal-state-inv-B-loop.md](research/goal-state-inv-B-loop.md) — 루프 구동기와 평가기: 가드 14단계, 루프 런타임 상태 16개
- [goal-state-inv-C-host.md](research/goal-state-inv-C-host.md) — 호스트 연동: "턴이 도는가" 20곳, 재시작 단계와 끼어드는 창 7개
- [goal-state-inv-D-surfaces.md](research/goal-state-inv-D-surfaces.md) — 명령 · 버튼 · 대시보드 · SET_GOAL: 변경 경로와 투영
