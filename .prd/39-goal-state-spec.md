# 39 — goal 상태 스펙: 숨은 상태를 이름 있는 상태와 전이로

Status: in-progress · 작성 2026-11-26 · trinity R1 반영(2026-11-26) · 현재 상태 = [38-goal-state-as-is.md](38-goal-state-as-is.md) ·
아키텍처 = [40-goal-state-architecture.md](40-goal-state-architecture.md) · ssot = [goal-state/ssot.md](goal-state/ssot.md)

> 요약: goal 동작을 여섯 개의 명시적 상태로 다시 적는다 — 턴 점유, goal 위치, 활성 goal의 루프 단계, 루프 구동기(지금 하는 일과
> 미뤄 둔 다음 일), 재시작 복구, 그리고 이것들이 함께 정하는 화면 칸. 각 상태는 한 모듈이 갖고, 바꾸는 길은 그 모듈의 전이뿐이며,
> "지금 어떤가"는 한 함수가 답한다. 사람이 보는 동작은 그대로 두고, 숨은 상태 때문에 생긴 버그(38 §3)만 고친다.

## 0. 미니맵

```
39 goal 상태 스펙
├─ 1. 지시                    ─ ssot SSOT_2 원문
├─ 2. 목표 · 비목표
├─ 3. 명시 상태               ─ S1 턴 점유 · S2 goal 위치 · S3 루프 단계 · S4 구동기 · S5 재시작 복구 · S6 화면 칸
├─ 4. 불변식 (I1–I7)          ─ 코드가 어디서든 지키는 것(테스트가 매 전이 뒤 검사)
├─ 5. 결정 (D1–D17)           ─ 고르는 데 근거가 필요했던 것
├─ 6. 인수 시나리오 (A1–A26)   ─ 끝났다고 말할 조건(살아 있음 · 버그 고정 · 이행)
└─ 7. 범위 밖
```

읽는 법: 무엇이 생기는지는 §3, 깨지면 안 되는 규칙은 §4, 왜 그렇게 정했는지는 §5, 완료 조건은 §6.

## 1. 지시

원문은 [goal-state/ssot.md](goal-state/ssot.md) SSOT_2: goal 관련 비슷한 버그가 계속 난다 → goal 코드 전체를 리팩토링·폴리싱,
숨은 상태머신을 찾아 명확한 상태로 처리. SSOT_1(재시작 뒤 도는 턴이 '완료·대기'로 보임, PR #1458)은 이 계열의 한 사례다.

## 2. 목표 · 비목표

목표

- G1 — goal의 상태 하나하나가 이름 있는 타입으로 존재한다. 필드 조합이나 집합 소속으로 추론하지 않는다.
- G2 — 각 상태는 한 모듈이 소유하고, 그 상태를 바꾸는 길은 그 모듈의 전이 함수뿐이다(계약 테스트가 직접 쓰기를 막는다).
- G3 — 같은 질문에는 한 함수가 답한다: "턴이 도는가", "세션이 구동되는가", "루프가 지금 무엇을 하고 다음에 무엇을 하기로 했나",
  "주인에게 무엇을 묻고 있나", "이 세션의 재시작 복구는 어디까지 왔나", "카드는 어느 칸인가".
- G4 — 38 §3의 버그를 고친다. 각각 인수 시나리오 하나로 고정한다(§6). 38의 X 항목은 코드 경로 분석이다 — 그 WU의 RED 테스트가
  재현하지 못하면 그 항목은 고칠 것이 아니라고 38에 적고 뺀다.
- G5 — 기존 goal 테스트는 통과한다(동작 보존). §5 결정이 의도적으로 바꾸는 관측값(예: D5의 완료 goal 위치)은 같은 PR에서 그
  테스트를 새 관측값으로 바꾸고, PR 본문에 결정 ID와 함께 적는다.

비목표

- 평가 프롬프트·판정 기준, cap 기본값, 연속 턴 문구 같은 goal의 "정책"은 바꾸지 않는다. 평가 횟수 계측(`evalAttemptCount`)도 그대로 둔다.
- 누가 goal에 손댈 수 있나(주인 규칙 4가지, 38 인벤토리 D S5)는 권한 문제라 `rules/permission.md`의 수렴 작업으로 넘긴다.
- Lean 모델(T2)은 만들지 않는다. 대신 전이 표를 그대로 돌리는 표 테스트를 둔다.

## 3. 명시 상태

### S1 — 턴 점유 (런타임, 저장 안 함)

디스패처의 실행(run) 하나가 턴 하나를 나르고, 그 실행에는 단계가 있다.

```
RunPhase(key) = none | preparing | running | settling
  none       슬롯이 비었다
  preparing  디스패치가 받아들여져 슬롯을 잡았고, 턴이 아직 시작하지 않았다(반응 · 파일 · 라우팅 · 세션 초기화)
  running    턴이 돈다: 요청 컨트롤러가 있거나, 이 프로세스의 턴 런타임이 working이라고 했다
             (이어하기 · `/compact` 재생이 바로 뒤따르는 다리 사이도 여기다)
  settling   이 실행의 마지막 다리를 턴 런타임이 idle · waiting으로 끝냈고, 실행이 아직 슬롯을 놓지 않았다(팔로업 정리 · 보고)

turnHeld(key) = RunPhase ∈ { preparing, running } ∨ 요청 컨트롤러가 있다
driven(key)   = RunPhase ≠ none ∨ LoopState(key) ≠ idle ∨ 미뤄 둔 다음 일(S4)이 있다 ∨ 재시작 복구가 이 세션을 쥐고 있다(S5)
```

- 실행 단계의 표시는 이 프로세스의 턴 런타임이 `activityState`를 바꿀 때(`setActivityState`) 메모리에만 남고 실행 세대로 묶인다.
  디스크에서 읽은 값과 호스트 복구 코드가 쓴 값은 표시가 아니다 — 재시작 직후에는 표시가 없고, 낡은 `working`이 게이트를 막지 않는다.
- 다리(leg) 규칙: 한 실행이 여러 다리를 돌 때, 이어지는 다리 사이에는 턴 런타임이 `working`을 유지하므로 `running`이다. 마지막 다리의
  끝만 `settling`이다. 같은 실행 안에서 새 다리가 시작하면(`/compact` 재생 등) `settling → running`으로 돌아간다. 늦게 도착한 앞
  다리의 끝은 지금의 `goalTurnOrder`(먼저 시작한 다리의 늦은 끝을 거른다)가 그대로 거른다 — 이 순번이 S1의 다리 카운터다.
- 턴 끝 트리거(`handleAssistantTurnCompleteForGoal`)는 바로 그 `settling` 동안 발화한다. 그래서 `settling`은 `turnHeld`가 아니다 —
  세면 루프가 자기 턴 때문에 영영 돌지 못한다(trinity R1에서 고친 원안의 결함).
- "주인 질문이 열렸나"는 별도 질문이다: `ownerQuestionOpen(session)` = 행동 패널이 선택을 기다림 ∨ 질문이 걸려 있음.
- `activityState`는 표시용이다. 루프 · 복구 코드는 이것을 조건으로 읽지 않는다(크론 · 대시보드는 S5 · S6의 규칙대로 쓴다).

### S2 — goal 위치와 수명 (저장)

| 위치 | 담는 goal의 status | 뜻 |
|---|---|---|
| 슬롯(`session.goal`) | `active` | 지금의 goal. 루프가 이것을 굴린다 |
| 슬롯 | `paused` = **hold** `{ why }` | 지금 goal에서 멈췄고 대기열이 그 뒤에서 기다린다. `why` = `cap-cancelled` · `stopped-with-queue` · `opening-cancelled`(D6) |
| 대기열(`goalQueue`) | `queued` | 차례를 기다린다. 승격될 때 새 실행으로 다시 시작한다 |
| 선반(`goalPaused`) | `paused` | 주인이 옆으로 치웠다. 대기열을 막지 않는다 |
| 히스토리(`goalHistory`) | `complete` | 끝났다. 슬롯에는 남지 않는다(D5) |

```
          enqueue                promote                 complete
 (new) ─────────────▶ queued ─────────────▶ active ─────────────────▶ complete(history)
   │                    ▲                   │  ▲  │
   │ activate           │ resume(next)      │  │  │ hold(why)
   └───────────────────▶│                   │  │  ▼
                        │          pause    │  │  hold(slot) ──release──▶ active
                        └──── shelf ◀───────┘  │                 └─delete(opening-cancelled)─▶ 사라짐
                               │   resume(now) │
                               └───────────────┘
 delete: 어느 위치에서든 → 사라짐(슬롯이면 대기열 머리 승격)   clear: 전부 비움   /new · /renew: 슬롯 · 대기열 · 선반을 비움(D11)
```

한 `goalId`는 정확히 한 위치에만 있다.

- 완료 · 삭제 · 일시정지가 슬롯을 비우면 **같은 전이**가 대기열 머리를 승격한다(지금 `advanceGoalQueue`와 같다). 승격된 goal은 그
  전이에서 첫 턴이 받아들여지거나(`opening`) 루프가 깨어난다 — 대기열이 멈춘 채 남지 않는다(I5).
- 제어 흐름은 위치와 단계를 `placeOf(session, goalId)` · `phaseOf(goal)`로만 읽는다. `status === 'paused'`를 직접 읽으면 hold와
  선반이 다시 섞인다(H2가 읽기 쪽에서 돌아온다).

### S3 — 활성 goal의 루프 단계 (저장, 슬롯의 `active` goal에만)

```
GoalPhase =
  | opening                                   첫 턴이 받아들여졌고 아직 모델에 닿지 않음
  | running                                   턴이 돌거나, 다음 턴 끝이 판정한다
  | retrying { until, attempt, reason }       판정 호출이 일시 실패 — 시각까지 기다렸다 다시 판정
  | asking   { ask: cap{ roundId, openedAt, dmRef? } | stall{ stall } }   주인에게 묻는 중
  | stopped  { why, at }                      사람이 다시 열 때까지 굴리지 않음
      why = 'judge-failed'     판정 호출 재시도 소진
          | 'start-failed'     이어하기가 시작하지 못함
          | 'resume-failed'    자동 재개가 같은 실패를 반복(#948)
          | 'person-stopped'   사람이 턴을 멈췄다(`user-stop` · `user-interrupted`) — 사람의 말이 마지막 말
```

```
 opening ──첫 턴이 모델에 닿음──▶ running ◀──────────── 사람의 말 · 답(계속) · resume · max 상향(asking(cap)일 때)
                                   │  ▲  ▲
          판정: continue(+1) ──────┘  │  └── 재시도 시각 도래 ── retrying ◀── 판정 호출 일시 실패
          판정: complete ──▶ (S2) complete        │ 소진
          판정: 같은 실패 ──▶ asking(stall)         ▼
          판정: 다음 이어하기가 필요한데 한도 소진 ──▶ asking(cap)     stopped(judge-failed)
          이어하기 시작 실패 ──▶ stopped(start-failed)     자동 재개 반복 실패 ──▶ stopped(resume-failed)
          사람의 멈춤(user-stop · user-interrupted) ──▶ stopped(person-stopped)
 (종료 중단 `shutdown`은 단계를 바꾸지 않는다 — 재시작 복구가 끊긴 턴으로 이어받는다. 턴 교체 `supersede`도 바꾸지 않는다 — 새 턴의
  끝이 구동한다. 세션 닫기 `session-close`는 세션이 끝나므로 구동할 것이 없다. 이 셋은 "이번 구동만 건너뜀"이다.)
 stopped ──사람의 말 · goal resume──▶ running
```

- 한도 소진은 판정 결과가 정한다: 완료도 같은 실패도 아니고 **다음** 이어하기가 필요한데 `continuationCount ≥ maxContinuations`일
  때만 `asking(cap)`이다. 한도 1에서 첫 이어하기를 보낸 직후(1/1)는 아직 `running`이다.
- "판정 중"은 단계가 아니다. 판정은 프로세스 안에서만 살아 있으므로 S4의 상태다. 재시작은 그것을 지운다.
- cap 질문에서 "질문이 열림"(단계)과 "DM이 전달됨"(`dmRef`)은 다르다. 같은 라운드에서 DM이 아직 전달되지 않았으면 다시 보낼 수
  있다 — 판정 · 알림을 다시 하지 않는 것과 별개다.
- 대기열 · 선반 · 히스토리의 goal은 단계가 없다(I2).

### S4 — 루프 구동기 (런타임, 세션마다)

```
LoopState    = idle | queued{ runs } | judging{ goalId, epoch } | injecting{ goalId, epoch, token }
PendingDrive = none
             | judge  { cause: 'turn' | 'kick', waitFor: 'slot-release' | 'followups' }    다시 판정할 일
             | inject { goalId, epoch, spent, waitFor: 'slot-release' }                   판정이 끝나 넣기만 남은 이어하기
AutoResume   = available | spent                                                           실패한 턴의 자동 재개 1회
```

- `injecting`은 이어하기가 받아들여져 슬롯을 잡을 때까지만이다. 슬롯을 잡으면 S1의 턴이 된다.
- **미뤄 둔 다음 일(PendingDrive)** 은 "턴은 끝났는데 루프를 언제 깨울지"다. 지금 이름 없는 집합 셋이 나눠 갖고 있다:
  팔로업이 자동 goal보다 먼저(`followupDeferredGoalSessions` → `judge{waitFor: followups}`), 텍스트 없는 턴은 슬롯이 풀린 뒤
  (`followupSlotHeldGoalSessions` → `judge{waitFor: slot-release}`), 펜스에서 버려진 이어하기의 재구동(`goalDriverKickOnRelease` →
  `judge{cause: kick}`, PR8 뒤에는 `inject`). 세션마다 최대 하나다(I6).
  - `judge`: 조건이 풀리면 루프 실행 하나를 넣고 소비된다. 슬롯이 풀렸는데 팔로업이 남아 있으면 소비하지 않고 `waitFor: followups`로
    바뀐다 — 사람의 팔로업이 자동 goal보다 먼저다.
  - `inject`: 슬롯이 풀리면 같은 goal · 에폭 ∧ 단계 `running` ∧ ¬`turnHeld`일 때 한 번만 넣는다(다시 판정하지 않는다). 그 사이 goal이
    바뀌거나, 사람의 턴 · 팔로업이 오거나, 종료가 시작되면 취소하고 `spent`면 횟수를 돌려준다 — 그 턴의 끝이 다시 구동한다.
  - 판정 중에 온 킥(`goal max` 등)은 루프의 직렬 실행이 받는다: 지금 판정 뒤에 다시 판정하는 실행이 하나 줄 선다. 턴이 돌고 있으면
    그 턴의 끝이 구동하므로 따로 남기지 않는다.
- **자동 재개(AutoResume)**: 실패로 끝난 턴(`error` · `stall-timeout`)은 한 번 자동 재개된다(`available → spent`). 텍스트를 남긴 턴이나
  사람의 말이 `available`로 되돌린다. `spent`에서 또 실패하면 goal 단계 `stopped(resume-failed)`가 되고 저장된다 — 재시작이 다시
  굴리지 않는다. `AutoResume`은 런타임이다(지금 `goalErrorResumeSpent`와 같이 재시작에서 초기화된다).
- 판정 결과는 **적용 직전**에 다시 확인한다: 같은 goal · 같은 에폭 ∧ ¬`turnHeld`. 판정 중 턴이 시작됐으면 결과를 버리고 그 턴의
  끝이 다시 판정한다. 판정 중 에폭이 움직였고(예: `goal max`) goal이 아직 `running`이면 결과를 버리고 다시 판정하는 실행(직렬 실행에 줄 서는 킥)을 남긴다 —
  에폭을 옮긴 쪽이 구동하지 않아도 goal이 멈추지 않는다(X5).
- 이어하기는 `settling`인 슬롯에 넣지 않는다 — `PendingDrive{waitFor: slot-release}`로 미뤘다가 슬롯이 풀리면 넣는다(지금의
  "버리고 · 환급하고 · 다시 깨우기"를 대신한다).
- 재시도 타이머는 `{goalId, epoch}`에 묶이고 goal이 바뀌면 취소된다.

### S5 — 재시작 복구 (부팅마다)

```
BootPhase      = loading → recovering → live
RecoveryRecord = { raw: { activityState, wasWorkingAtShutdown, personStopped }, cut: boolean,
                   resume: none | pending | started | failed | stopped-by-person, refunded: boolean }
```

- 로드는 디스크의 원본(`activityState` · 종료 기록 · 사람의 멈춤)을 레코드에 먼저 담는다. 정상 종료 표지가 없는 크래시에서도
  저장된 `working`이 그대로 복구 입력이다.
- 그 뒤 표시용 `activityState`를 레코드에서 정한다: 재개를 기다리는(`resume: pending`) 세션은 `working`(재개 중), 질문이 실제로
  열린 세션은 `waiting`, 나머지는 `idle`. 재개가 시작되면 턴 런타임이 이어받고, 재개가 실패 · 거절되면 복구가 `releaseRecovered`
  하나로 `idle`을 쓴다(훅 없이 — 사람이 멈춘 일을 크론이 깨우지 않게). 재시작 게이트용 강제 `idle` 직접 쓰기 2곳(재시작 패스 · 인계)이 이 하나로 바뀐다. 멈춘 준비의 정리와 `/new` 리셋의 `idle`은 이름 있는 전이로 따로 남는다(훅을 건너뛰는 이유가 다르다).
- 재개를 기다리는 동안 그 세션은 `driven`이다: 크론 · 사용자 작업 큐 · 루프 킥이 그 세션에 끼어들지 않는다(지금도 저장된
  `working`이 크론을 막는다 — 그 효과를 이름 있는 상태로 유지한다).
- 복구 결정 `decideRecovery(record, goal, driven)`의 출력은 지금 패스가 하는 일 전부다: 끊긴 이어하기 환급 · 텍스트 없이 판정된 가짜
  stall 정리 · 비어 있는 슬롯 뒤 대기열 승격 · 대기 중인 에러 재시도 회수 · 팔로업 재개 표시 · `retrying` 재시도 재무장(판정 없이 남은
  창으로) · 루프 킥 · 아무것도 안 함. cap DM 재작성 저널 정리는 결정 밖의 효과로 남는다.
- 복구 패스는 `recovering` 끝에 세션마다 한 번 돈다. 크래시 복구 알림이 실패해도 돈다. 나중의 인계(재개가 시작 못 함)도 같은 결정
  함수를 지난다. 결정 입력: 레코드 · goal 단계 · `driven`. 사람의 멈춤 이후 끊긴 goal은 `stopped(person-stopped)`로 두고 굴리지 않으며,
  `opening` goal은 첫 턴에 맡긴다.

### S6 — 화면 칸 (투영, 저장 안 함)

카드 칸은 아래 순서로 처음 맞는 규칙이 정한다. goal은 기존 규칙(에픽 · 작업 큐 · 수면 · 권한/질문)을 바꾸지 않고, 기존 규칙이
"한가함(DONE)"이라고 할 때만 그것을 다듬는다.

1. 기존 규칙: 에픽 상태 → 사용자 작업 큐 대기 → 수면 · 종료 → 열린 질문 · 권한 · 승인(응답 필요) → 레인 대기(작업 큐 칸)
2. `turnHeld` 또는 재개 대기(S5 `pending`) → 진행 중
3. 슬롯의 active goal이 `asking` 또는 `stopped`(판정 실패 · 시작 실패 · 재개 실패) → 응답 필요(+ 이유). `stopped(person-stopped)`는 5로 간다
4. 슬롯의 active goal이 `opening` · `retrying` · `running`이고 `driven`(판정 · 주입 · 미뤄 둔 다음 일 포함) → 진행 중
5. 그 밖 → 한가함. hold는 일시정지 칩, `stopped(person-stopped)`는 멈춤 칩.

## 4. 불변식

테스트는 모든 전이 뒤에 `assertGoalInvariants`로 I1–I4를 검사하고, 루프 · 복구 표 테스트는 I5–I7을 검사한다. 운영에서는 위반을 경고
로그로 남기고 고치지 않는다.

- I1 — 위치와 status가 §S2 표와 맞는다. 한 `goalId`는 한 위치에만 있다.
- I2 — 단계(`GoalPhase`)는 슬롯의 `active` goal에만 있다.
- I3 — `asking(cap)`이면 `continuationCount ≥ maxContinuations`이다(한 방향. 역은 성립하지 않는다).
- I4 — goal의 뜻(목표 · 한도 · 위치 · 단계)을 바꾸는 전이는 에폭을 올리고, 에폭을 올리는 길은 하나다(재시도 창도 같이 정리).
- I5 — 슬롯의 `active` goal이 `running`이면 세션은 `driven`이거나, 그 상태를 만든 전이가 루프를 깨운다(구동 의무). 대기열 머리를 승격한 전이는 그 goal의 첫 턴을 받아들이거나 루프를 깨운다.
- I6 — 미뤄 둔 다음 일은 세션마다 최대 하나이고, 조건이 풀리면 정확히 한 번 소비된다. 슬롯이 풀렸는데 팔로업이 남으면 `judge`는 팔로업을 기다리게 바뀌고, `inject`는 취소 · 환급된다.
- I7 — 루프는 `turnHeld`인 동안 판정을 시작하지 않고, 판정 결과를 적용하지 않고, 이어하기를 넣지 않는다.

## 5. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D1 | "턴이 도는가"는 `turnHeld`(실행 단계 `preparing`·`running` ∨ 컨트롤러), "세션이 구동되는가"는 `driven` 하나로 답한다. `activityState`는 루프 · 복구 게이트에서 빠진다 | 가장 이른 시계(슬롯)를 보되 끝난 턴의 정리(`settling`)는 빼야 턴 끝 트리거가 산다. X1 · X2 · PR #1458 계열 |
| D2 | 루프 게이트 = 슬롯의 active goal ∧ 단계 ∈ {`running`, `retrying`} ∧ ¬`turnHeld` ∧ ¬주인 질문 ∧ ¬호스트 대기(자동 압축 예외 유지) ∧ ¬중단 잠금 ∧ ¬종료 중. `retrying`은 남은 창이면 재시도를 다시 걸고, 창이 지났으면 판정한다 | 게이트가 cap 질문을 모르던 X4를 단계가 막는다. 재시작 뒤 재시도 재무장 경로를 잃지 않는다 |
| D3 | 로드는 디스크 원본을 복구 레코드에 담은 **뒤** 표시용 `activityState`를 레코드에서 정한다(S5). 강제 `idle` 직접 쓰기 4곳은 `releaseRecovered` · 멈춘 준비의 정리 둘로 줄고, 둘 다 이름 있는 전이다 | 크래시 입력 보존 · 재개 대기 표시 · 크론 차단을 유지하면서 프록시를 없앤다 |
| D4 | "판정 중"(`pendingEval`)은 저장하지 않는다 — S4의 런타임 상태다 | 로드마다 지워지던 필드. 소유자 확인이 10곳에 흩어져 있었다 |
| D5 | 완료된 goal은 슬롯에서 내려가 히스토리에만 있다. 표면("최근 완료")은 **같은 PR**에서 히스토리를 읽게 바뀐다 | 이중 저장(X13)과 이중 집계를 없앤다 |
| D6 | "슬롯의 paused"는 **hold** `{why}` 하나의 뜻이고 만드는 길도 하나(`holdCurrentGoal`)다. 첫 턴 취소는 `hold(opening-cancelled)` → 삭제의 두 단계를 유지한다: 다음 goal의 첫 턴 승인이 실패하거나 중간에 죽어도 취소된 goal은 hold로 남아 다시 돌지 않는다 | 만드는 곳마다 필드가 달랐다(38 §2.3). 취소 안전장치는 지금 계약을 그대로 이름 붙인 것 |
| D7 | 한도 소진 = `asking(cap)`(S3 규칙). `goal max n`: `asking(cap)`이고 n > 카운터면 질문을 닫고(DM 재작성) `running` + 구동; `running`이고 n ≤ 카운터면 `running` 그대로 — 다음 판정이 이어하기를 원할 때 묻는다 | X5 · X16. #581에서 시도했다 되돌린 명시 상태를 단계로 다시 둔다 |
| D8 | 재시도 소진 · 이어하기 시작 실패 · 자동 재개 반복 실패 · 사람의 멈춤(`user-stop` · `user-interrupted`만)은 `stopped{why}`로 저장한다. 앞의 셋은 카드에 응답 필요 + 이유로, 사람의 멈춤은 한가함 + 멈춤 칩으로 보인다(사람이 스스로 멈춘 일로 응답 필요를 띄우지 않는다). 사람의 말 · `goal resume`이 다시 연다. 종료 · 턴 교체 · 세션 닫기 중단은 단계를 바꾸지 않는다 | X7 · X18. 지금은 알림이나 메모리 집합만 남고 goal은 active였다 |
| D9 | goal을 바꾸는 표면은 모두 `commitGoalChange` 하나로 끝난다: 에폭 · 프롬프트 무효화 · 저장 · 대시보드 방송 · 효과 · 구동 의무. 단 cap 답처럼 저장 전에 지켜야 할 순서가 있는 전이는 그 순서를 전이가 선언한다(저널 → 결정 저장 → DM 재작성, 저장 실패면 질문 복원) | 같은 일을 하는 사본 4개(38 인벤토리 D)를 합친다. X5 · X9. cap 답의 2단계 약속은 일반 순서로 바꾸지 않는다 |
| D10 | 되돌리기(스냅샷 복원)는 은퇴한 질문을 되살리지 않는다 — 모든 되돌리기가 같은 함수를 쓴다 | X8. 지금은 일시정지 되돌리기만 그렇다 |
| D11 | `/new` · `/renew`는 슬롯 · 대기열 · 선반을 비운다(히스토리는 남긴다). 보관은 대기열도 담는다. 봇 스레드 이동은 대기열 · 선반 · 히스토리를 옮기고, 열린 질문은 닫고 에폭을 올린다 | X10 · X11 · X12 |
| D12 | `goal resume`은 cap 또는 stall로 멈춘 goal과 `stopped` goal을 다시 굴린다(cap ✅와 같은 결과). `goal done`은 이미 완료된 goal을 건드리지 않는다. Slack 🗑️는 그 줄이 보였던 위치를 보낸다. 자동 goal은 대기열이나 선반에 goal이 있으면 시작하지 않는다 | X13 · X14 · X15 · X16 |
| D13 | 복구 패스는 사람의 멈춤 이후 끊긴 goal을 `stopped(person-stopped)`로 두고, 첫 턴이 남은(`opening`) goal은 첫 턴에 맡긴다 | X18 · X19 |
| D14 | 대시보드 칸은 S6의 순서로 정한다. goal은 기존 규칙이 DONE이라고 할 때만 다듬는다 | X17 · SSOT_1. 기존 칸 규칙과의 우선순위를 명시한다 |
| D15 | 판정 결과는 적용 직전에 같은 goal · 에폭 ∧ ¬`turnHeld`를 다시 확인한다. 실패하면 버리고, goal이 아직 굴릴 상태면 다시 판정하는 실행(직렬 실행에 줄 서는 킥)을 남긴다 | 판정 중 턴이 시작되면 완료 · stall을 그 턴 아래에서 적용하던 경로(인벤토리 B 5.5 · 5.6)와 X5 |
| D16 | 재개를 기다리는 세션(S5 `pending`)은 `driven`이다. 크론 · 사용자 작업 큐는 지금처럼 그 세션에 끼어들지 않는다 | 로드 때 표시를 정리해도 크론이 재개 직전 세션에 턴을 넣지 않게(지금은 저장된 `working`이 그 일을 했다) |
| D17 | 저장 모양을 바꾸는 동안(PR7~PR10) 새 코드는 단계와 옛 필드를 함께 쓴다. 로드 규칙: 옛 표현이 있는 단계(`opening` · `retrying` · `asking` · `running`)는 **항상 옛 필드에서 다시 계산한다**(구버전의 변경은 그 필드에만 남는다 — 첫 턴 시작 · 재시도 무장 · cap 열기는 에폭 · `updatedAt` · 횟수를 바꾸지 않는다). 옛 표현이 없는 `stopped` · hold `why`만 단계 옆의 지문(`{epoch, updatedAt, continuationCount}`)이 옛 필드와 같고 옛 필드가 "아무것도 없음"일 때 믿는다. id 없는 옛 cap 라운드는 id 없이 유지한다(옛 DM 버튼이 답할 수 있게). 옛 필드 쓰기는 PR10에서 지운다 | 구버전으로 되돌렸다 다시 올리는 배포에서 낡은 단계를 믿지 않고, 구버전이 표현 못 하는 상태는 지운다고 다시 돌지 않게 |

## 6. 인수 시나리오

각 시나리오는 테스트 하나 이상으로 고정한다(실행 → 기대 관측). "실측"은 소유자 dev 배포 뒤 대시보드에서 확인한다.

살아 있음(정상 경로 — 게이트 입력을 흉내 내지 않고 실제 디스패처 슬롯 타이밍으로 시험한다. WU1의 머지 조건)

| ID | 실행 | 기대 |
|---|---|---|
| A23 | 텍스트를 남긴 goal 턴이 끝난다(실행이 아직 슬롯을 쥔 채 턴 끝 트리거 발화) | 루프가 `settling`에서 판정을 시작한다(PR2 머지 조건). 이어하기가 실행이 끝난 뒤 한 번 들어간다(PR8 머지 조건 — 그 전까지는 지금처럼 펜스에서 버려졌다가 다시 깨운다) |
| A24 | 텍스트 없는 goal 턴이 끝난다 | 판정 없이 지난 공백을 다시 쓰고, 실행이 끝난 뒤 이어하기가 한 번 들어간다 |
| A25 | 이어하기 · `/compact` 재생이 뒤따르는 다리 사이 | 루프가 다리 사이에서 판정하지 않고, 마지막 다리의 끝에서 한 번 판정한다 |
| A26 | 팔로업이 줄에 있는 채 goal 턴이 끝난다 | 팔로업이 먼저 돌고, 줄이 빈 뒤 루프가 한 번 돈다 |

버그 고정

| ID | 실행 | 기대 | 고치는 것 |
|---|---|---|---|
| A1 | 슬롯을 잡았고 컨트롤러가 아직 없는 세션에 루프를 깨운다 | 판정하지 않는다(`turnHeld` — `preparing`) | X1 |
| A2 | 재시작 인계 시점에 사람의 턴이 슬롯을 잡고 있다 | `activityState`를 쓰지 않고, 환급 · 킥하지 않는다 | X2 |
| A3 | 재시작 패스 시점에 루프가 판정 중이다 | 다시 깨우지 않고, 재개 표시를 남기지 않는다 | X3 |
| A4 | `asking(cap)` goal에 킥 · 재시작 패스가 온다 | 판정 · 알림을 다시 하지 않는다. DM이 아직 전달되지 않은 라운드면 같은 라운드의 DM만 다시 보낸다 | X4 |
| A5 | 10/10 cap 질문이 열린 goal에 `goal max 20` · 판정 중에 `goal max 20` | 질문이 닫히고(DM 재작성) 루프가 다시 돈다 · 폐기된 판정 뒤 루프가 다시 돈다 | X5 |
| A6 | 이어하기 알림을 올리는 사이 종료가 시작된다 | 이어하기를 넣지 않고 횟수를 돌려준다. "다시 보내주세요"가 없다 | X6 |
| A7 | 판정 호출이 최초 + 재시도 3회 모두 일시 실패 · 이어하기 시작 실패 · 실패한 턴의 자동 재개 뒤 또 실패 | 단계 `stopped(why)`, 카드 응답 필요 + 이유. 재시작 뒤에도 그대로. 사람의 말이 다시 연다. 첫 실패의 자동 재개는 그대로 한 번 돈다 | X7 |
| A8 | cap 질문이 열린 goal을 지우고, 승격 goal의 첫 턴 승인이 거절된다 | 되돌린 goal에 cap 질문이 없다 | X8 |
| A9 | 재시도 대기 중 목표를 수정 · cap에 답한다 | 재시도 창이 사라지고 루프가 바로 판정할 수 있다 | X9 |
| A10 | goal A + 대기 B에서 `/new` 후 재시작 | B가 승격되지 않는다(대기열이 비었다) | X10 |
| A11 | 대기 goal이 있는 세션을 보관했다 되살린다 | 대기 goal이 그대로 있다 | X11 |
| A12 | 대기 · 선반 goal이 있는 세션이 봇 스레드로 옮겨진다 | 모두 옮겨지고 열린 질문은 닫힌다 | X12 |
| A13 | 평가 모델이 끝낸 goal에 `goal done` | 기록이 바뀌지 않는다 | X13 |
| A14 | 옛 `goal` 메시지의 대기 줄 🗑️를 승격 뒤에 누른다 | "위치가 바뀌었다" 응답, 도는 goal은 그대로 | X14 |
| A15 | 선반에 goal이 있고 자동 goal이 켜진 세션에 잡담 한 줄 | 새 goal이 생기지 않는다 | X15 |
| A16 | cap 정지 goal에 `goal resume` | 예산을 돌려받고 다시 돈다 | X16 |
| A17 | 판정이 끝나 이어하기를 넣기 직전(주입 중 · 슬롯 해제를 기다리는 미뤄 둔 일) 대시보드 카드 | 진행 중 칸 | X17 |
| A18 | 주인이 `!`로 멈춘 뒤 재배포 | 복구 패스가 그 goal을 굴리지 않는다(`stopped(person-stopped)`) | X18 |
| A19 | 첫 턴이 대기 중인 goal이 있는 채로 재시작 | 루프가 첫 턴 전에 이어하기를 넣지 않는다 | X19 |
| A20 | 모든 전이 표(S2 · S3 · S4 · S5 · S6)를 표 테스트로 돈다 — 완료 · 삭제 · 일시정지의 대기열 승격, `retrying`의 재시작 재무장 포함 | 표의 다음 상태와 같고, 매 전이 뒤 불변식 통과 | G1–G3 |
| A21 | 계약 테스트: 단계 · status · 위치 · 에폭 필드를 전이 모듈 밖에서 쓰는 코드, 그 필드를 `phaseOf` · `placeOf` 밖에서 제어 흐름으로 읽는 코드, `activityState`를 조건으로 읽는 goal · 루프 · 복구 코드 | 0건 | G2 |
| A28 | goal 턴이 종료(`shutdown`)로 끊긴 뒤 재시작한다 · 턴 교체(`supersede`)로 끊긴다 | 재시작이 이어받아 다시 돈다 · 새 턴의 끝이 구동한다. 어느 쪽도 `stopped`가 아니다 | F1(R2) |
| A22 | 실측: 소유자 dev에 배포 → 대시보드에서 goal을 만들고 한도 1로 이어하기까지 돌린 뒤 재시작 | 재시작 중 카드가 진행 중에 있고, 끝나면 cap 질문이 한 번만 뜨며, `goal max`를 올리면 다시 돈다 | SSOT_1 · G4 |

이행(WU4의 머지 조건)

| ID | 실행 | 기대 |
|---|---|---|
| A27 | 세 왕복: 신 → 신(바뀐 것 없음), 신 → 구(바뀐 것 없음) → 신, 신 → 구(goal을 바꿈) → 신. 셋째의 변경: `goal max`(에폭이 오름), 구버전에서 첫 턴이 모델에 닿음(`openingPending`만 지움), 구버전에서 판정 재시도 무장(재시도 필드만 씀). fixture: `stopped` · hold `why`(옛 표현 없음), 어긋난 옛 필드, id 없는 cap 라운드와 그 옛 DM 버튼, 슬롯 · 히스토리 중복 완료 | 앞의 둘은 단계를 그대로 보존한다. 셋째는 구버전의 변경을 따른다 — `opening`은 `running`이 되고 재시도는 `retrying`이 된다(D17). id 없는 라운드는 옛 DM 버튼으로 답할 수 있다. 손실 0 |

## 7. 범위 밖

- 주인 규칙 통합(누가 답 · 삭제 · 수정할 수 있나) — `rules/permission.md`의 남은 위반으로 둔다.
- 평가 프롬프트 · 판정 기준 · cap 기본값 · 연속 턴 문구 · `evalAttemptCount` 계측.
- 다시 배달된 goal 첫 턴을 거르는 인그레스 중복 제거(`skippedGoalOpenings`, `goalIntakeSeen`) — Slack 재전송 처리이지 goal 상태가 아니다.
- 대시보드 시각 디자인. 칸과 칩의 규칙만 바꾼다(S6). Slack `goal` 블록을 같은 투영으로 묶는 일은 작으면 WU7에서 하고, 크면 뒤로 미룬다.
