# 40 — goal 상태 아키텍처: 상태마다 주인 모듈 하나, 작업 단위 일곱 개 · PR 열 개

Status: in-progress · 작성 2026-11-26 · trinity R1 반영(2026-11-26) · 스펙 = [39-goal-state-spec.md](39-goal-state-spec.md) ·
현재 상태 = [38-goal-state-as-is.md](38-goal-state-as-is.md) · 드라이버 = [goal-state/loop.md](goal-state/loop.md)

> 요약: 39의 여섯 상태를 주인 모듈에 하나씩 둔다. goal 자체(위치 · 단계 · 전이 · 불변식 · 화면 투영)는 `@soma/slack/goal/`
> 한 폴더에 순수 코드로 모으고, 호스트는 턴 점유 · 루프 구동기 · 재시작 복구 세 모듈로 그것을 돌린다. 일은 서브이슈 일곱 개,
> PR 열 개로 나눈다 — 동작을 보존하는 이동과 동작을 바꾸는 수정을 다른 PR · 다른 배포로 보내고, 저장 모양을 바꾸는 PR은 그
> 모양을 읽는 화면과 함께 나간다.

## 0. 미니맵

```
40 goal 상태 아키텍처
├─ 1. 모듈 지도              ─ 상태 하나 = 주인 모듈 하나
├─ 2. 모듈별 계약            ─ 공개 함수와 누가 부르나
├─ 3. 저장 모양과 이행        ─ 옛 필드 → 새 단계, 함께 쓰기 기간, 왕복 시험
├─ 4. 작업 단위와 PR         ─ WU1–WU7 · PR 10개 · 범위 · 시나리오 · 위험
├─ 5. 순서와 게이트
└─ 6. 지키는 규칙            ─ 계약 테스트가 깨뜨리는 경계
```

읽는 법: 어디에 무엇이 생기는지는 §1·§2, 디스크 모양이 어떻게 바뀌는지는 §3, 어떤 PR이 무엇을 하는지는 §4.

## 1. 모듈 지도

```
@soma/slack/goal/                         ← goal 자체. 순수(호스트·Slack·타이머 없음). stream-executor도 여기서 가져간다
├─ model.ts         S2 · S3 타입의 유일한 정의 (SessionGoal · GoalPhase · GoalAsk · 위치 · hold why · stopped why)
├─ read.ts          phaseOf(goal) · placeOf(session, goalId) — 제어 흐름이 위치 · 단계를 읽는 유일한 길
├─ machine.ts       모든 전이 → GoalChange { 바뀐 것, drive, effects, order? }
├─ invariants.ts    assertGoalInvariants(session) — 39 §4 I1–I4
├─ loop-decision.ts 순수 결정: decideLoopStep(입력) · applyVerdict(goal, verdict) · decideRecovery(record, goal, driven)
└─ board.ts         goalBoardRefinement(session, runtime) — 39 S6의 goal 규칙(기존 칸 규칙 뒤의 델타)

src/slack/                                ← 호스트. 상태를 돌리고 효과(게시 · DM · 주입 · 저장)를 낸다
├─ session-occupancy.ts    S1: runPhase · turnHeld · ownerQuestionOpen · driven
├─ goal-commit.ts          commitGoalChange — 에폭 · 프롬프트 무효화 · 저장 · 방송 · 효과 · 구동 의무(전이가 선언한 순서대로)
├─ goal-loop-controller.ts S4: LoopState · PendingDrive · 실행기(결정은 loop-decision, 효과는 여기)
└─ restart-recovery.ts     S5: BootPhase · RecoveryRecord · 패스 · 인계 · releaseRecovered
```

지금 있는 것이 어디로 가나:

| 지금 | 간다 |
|---|---|
| `packages/slack/src/session-goal.ts` (타입 사본 + 큐 · 일시정지 전이) | `goal/model.ts` + `goal/machine.ts`. 옛 경로는 재export 한 줄(`rules/packaging.md`) |
| `src/types.ts`의 `SessionGoal` · 상태 유니언 · 기본값 | `goal/model.ts` 재export |
| `goal-continuation.ts` · `goal-cap-decision.ts`(상태 부분) · `goal-stall.ts`(상태 부분) · `session-goal-lifecycle.ts`(이행) | 상태 부분은 `machine.ts`, 이행은 `machine.ts`의 `loadGoalState` / `saveGoalState`. DM 재작성 · 질문 회수 같은 효과는 호스트에 남는다 |
| `goal-completion-evaluator.ts`의 `shouldRunGoalIdleDriver` · `decideGoalEvalOutcome` · `apply*` | `loop-decision.ts`. 평가 호출 · 프롬프트는 evaluator에 남는다 |
| `SlackHandler`의 슬롯 검사 사본 4개 · `isHostTurnFree` · `goalTurnOrder` | `session-occupancy.ts`(`goalTurnOrder`는 다리 카운터로 그대로 옮긴다) |
| `followupDeferredGoalSessions` · `followupSlotHeldGoalSessions` · `goalDriverKickOnRelease` | 컨트롤러의 `PendingDrive` 하나 |
| `goalErrorResumeSpent` | 컨트롤러의 `AutoResume`(런타임) + 두 번째 실패면 goal 단계 `stopped(resume-failed)` |
| 사람의 마지막 말(`GOAL_LAST_WORD_ABORT_REASONS`) | `user-stop` · `user-interrupted` → `stopped(person-stopped)`; `shutdown` · `supersede` · `session-close` → 이번 구동만 건너뜀 |
| 재시작 집합 3개 + 플래그 · `followupResumeMark`의 재시작 부분 · 강제 `idle` 쓰기(재시작 게이트용 2곳) | `restart-recovery.ts`. 멈춘 준비의 정리(`releaseStoppedPreparation`)와 `/new` 리셋의 `idle`은 이름 있는 전이로 남는다 |
| `persistGoalChange` · `persistHostGoalMutation` · cap 답의 수동 저장 · 수정 모달의 직접 쓰기 | `goal-commit.ts` 하나 |
| 대시보드 `placeOnBoard`의 goal 관련 판단 | 기존 규칙은 그대로, 마지막 "한가함" 분기만 `goal/board.ts`가 다듬는다 |

## 2. 모듈별 계약

### session-occupancy (S1)

```ts
type RunPhase = 'none' | 'preparing' | 'running' | 'settling';
interface SessionOccupancy {
  runPhase(key): RunPhase;          // 슬롯(이동된 슬롯 포함) + 이 실행 세대의 턴 런타임 표시
  turnHeld(key): boolean;           // runPhase ∈ {preparing, running} ∨ 요청 컨트롤러
  ownerQuestionOpen(session): boolean;
  driven(key): boolean;             // runPhase ≠ none ∨ loop.stateOf(key) ≠ idle ∨ loop.pendingOf(key) ∨ recovery.holds(key)
  // 입력: registry.setActivityState가 부르는 noteTurnActivity(key, state) — 실행 세대(liveTurnEpoch)로 묶는다
  //       턴 시작 · 끝 훅의 다리 순번(지금의 goalTurnOrder)
}
```

### goal/machine (S2 · S3)

- 모든 전이는 `(session, input) → GoalChange`다. `GoalChange` = 바뀐 것 + `drive: 'kick' | 'opening' | 'turn-will' | 'none'`(구동
  의무 I5) + `effects`(은퇴한 질문 · DM 재작성 · 질문 회수) + 선택적 `order`(저장과 효과의 순서를 전이가 정해야 할 때. cap 답:
  저널 → 결정 저장 → DM 재작성, 저장 실패면 되돌림).
- 에폭은 `bumpEpoch` 하나로만 올린다. 그것이 재시도 창도 정리한다(I4).
- 되돌리기는 `undoChange(session, snapshot, change)` 하나다. 이미 낸 효과(은퇴한 질문)는 되살리지 않는다(D10).

### goal-commit (호스트)

```ts
commitGoalChange(session, change, { reason }): CommitResult
// 기본 순서: 프롬프트 무효화 → 저장 → 방송 → effects → drive
// change.order가 있으면 그 순서. drive: 'kick' → turnHeld면 아무것도 안 한다(그 턴의 끝이 구동한다),
// 아니면 loop.kick(key) — 판정 중이어도 직렬 실행 뒤에 줄 선다(버리지 않는다). PR8 전까지도 지금의 직렬 큐가 같은 일을 한다
```

### goal/loop-decision + goal-loop-controller (S4)

```ts
type LoopState = { kind: 'idle' } | { kind: 'queued'; runs }
  | { kind: 'judging'; goalId; epoch } | { kind: 'injecting'; goalId; epoch; token };
type PendingDrive = undefined
  | { kind: 'judge'; cause: 'turn' | 'kick'; waitFor: 'slot-release' | 'followups' }   // 다시 판정
  | { kind: 'inject'; goalId; epoch; spent: boolean; waitFor: 'slot-release' };        // 판정 끝난 이어하기를 넣기만
type AutoResume = 'available' | 'spent';                                               // 실패한 턴의 자동 재개 1회
decideLoopStep({ goal, phase, turnHeld, questionOpen, hostWait, halted, shuttingDown, cause, evidence, now })
  → skip(why) | arm-retry(inMs) | reuse(reason) | judge
applyVerdict(goal, verdict, { stallAllowed, reused }) → GoalChange    // continue · complete(+승격) · ask(cap) · ask(stall)
```

- 판정 결과를 적용하기 직전과 이어하기를 넣기 직전에 같은 확인을 한다: 같은 goal · 에폭 ∧ ¬`turnHeld` ∧ ¬종료 중(D15, X6).
  실패하면 버리고, goal이 아직 굴릴 상태면 다시 판정하는 실행(직렬 실행에 줄 서는 킥).
- 이어하기를 넣을 때 실행이 `settling`이면 `PendingDrive{inject}`로 미루고, 슬롯이 풀리면 같은 goal · 에폭 ∧ `running` ∧ ¬`turnHeld`일 때
  한 번만 넣는다(다시 판정하지 않는다). 그 사이 goal이 바뀌거나 사람의 턴 · 팔로업 · 종료가 오면 취소하고 `spent`면 돌려준다.
- `judge`는 슬롯이 풀렸는데 팔로업이 남으면 소비하지 않고 `waitFor: followups`로 바뀐다. 판정 중에 온 킥은 직렬 실행이 받는다.
- 재시도 타이머는 `{goalId, epoch}`에 묶이고 핸들을 갖는다. `commitGoalChange`가 goal을 바꾸면 취소한다.

### restart-recovery (S5)

```ts
class RestartRecovery {
  phase: 'loading' | 'recovering' | 'live';
  recordFor(key): RecoveryRecord;       // 로드 때 디스크 원본에서. 그 뒤 표시용 activityState를 레코드로 정한다
  holds(key): boolean;                  // resume === 'pending'
  runPass(): void;                      // recovering 끝에 한 번 (.finally — 알림 실패에도)
  handBack(key): void;                  // 재개가 시작 못 함 — 같은 decideRecovery
  releaseRecovered(key): void;          // 재개 실패 · 거절 → 훅 없이 idle (이름 있는 유일한 길)
}
decideRecovery(record, goal, driven) → { refund?, retireFalseStall?, promoteQueue?, claimRetry?, markFollowupResume?,
                                         rearmRetry?(inMs), kick?, setStopped?(why) }
```

### goal/board

`goalBoardRefinement(session, runtime)`는 `placeOnBoard`가 기존 규칙으로 "한가함"을 고른 뒤에만 부른다(39 S6 4–5). 대시보드 클라이언트의
같은 계산(`pendingAutoResume` · `rootStatusOf` · `epicChildCol`)은 서버 값을 읽게 바꾼다.

## 3. 저장 모양과 이행

WU4가 디스크 모양을 바꾼다. 그 전까지(WU1–WU3)는 옛 필드를 그대로 저장하고 `phaseOf`가 옛 필드에서 단계를 계산한다.

| 옛 필드 | 새 모양 |
|---|---|
| `openingPending` | `phase: { kind: 'opening' }` |
| `pendingEval` | 저장 안 함(S4 런타임, D4) — 로드 때 버린다(지금과 같음) |
| `evalBackoffUntil` · `evalDispatchRetryCount` · `evalRetryReason` | `phase: { kind: 'retrying', until, attempt, reason }` |
| `capDmPendingAt` · `capDecisionId` · `capDmRef` | `phase: { kind: 'asking', ask: { kind: 'cap', roundId, openedAt, dmRef? } }`. id 없는 옛 라운드는 로드 때 id를 받는다 |
| `stall` | `phase: { kind: 'asking', ask: { kind: 'stall', stall } }` |
| (알림 · 메모리 집합뿐 — 옛 표현 없음) | `phase: { kind: 'stopped', why, at }` — 지문이 맞고 옛 필드가 비었으면 보존(D17) |
| 위 아무것도 없음 | `phase: { kind: 'running' }` |
| 슬롯의 `status:'complete'` | 슬롯에서 내리고 히스토리에만(D5). 같은 id가 히스토리에 이미 있으면 하나로 |
| 슬롯의 `status:'paused'`(세 가지 필드 모양) | hold `{why}` 한 모양(D6): 재시도 · 질문 없음, `heldTaskIds` 있음 |

- 이행은 `loadGoalState` 하나가 로드 · 되살리기 · 보관 읽기에서 모두 하고, 저장은 `saveGoalState` 하나가 한다.
- 함께 쓰기(D17): PR7부터 PR10 직전까지 새 코드는 단계와 옛 필드를 함께 쓴다. 로드는 옛 표현이 있는 단계(`opening` · `retrying` ·
  `asking` · `running`)를 항상 옛 필드에서 다시 계산하고, 옛 표현이 없는 `stopped` · hold `why`만 지문(`{epoch, updatedAt,
  continuationCount}`)이 맞고 옛 필드가 "아무것도 없음"일 때 믿는다. id 없는 옛 cap 라운드는 id 없이 둔다. 옛 필드 쓰기는 PR10에서 지운다.
- 왕복 시험(A27, PR7 머지 조건): 신 → 신(무변경), 신 → 구(무변경) → 신, 신 → 구(변경: `goal max` · 첫 턴 시작 · 재시도 무장) → 신.
  fixture는 `stopped` · hold `why`, 어긋난 옛 필드, id 없는 cap 라운드와 옛 DM 버튼, 슬롯 · 히스토리 중복 완료.

## 4. 작업 단위와 PR

서브이슈 = WU(일곱 개). PR은 열 개다 — 리뷰 패널(trinity R1)이 동작 보존 이동과 동작 변경을 다른 PR · 다른 배포로 보내라고 했고,
`using-epic-tasks`의 "서브이슈 1 = PR 1"보다 되돌리기 단위를 우선했다(WU1 · WU3만 PR이 여럿).

| PR | WU | 이름 | 범위 | 시나리오 | 동작 |
|---|---|---|---|---|---|
| 1 | WU1 | 점유 모듈 | `session-occupancy.ts`(실행 단계 · 턴 런타임 표시 · 다리 순번); 슬롯 검사 사본 · `isHostTurnFree` · 인계 · 재시작 패스의 "턴이 도는가"를 모듈로. 루프 게이트는 아직 그대로 | A23–A26 기준선(지금 동작을 실제 슬롯 타이밍으로 고정) | 보존 |
| 2 | WU1 | 게이트 교체 · 로드 레코드 | 루프 게이트: `activityState` → `turnHeld` + 주인 질문(D1 · D2); 로드가 레코드를 만든 뒤 표시를 정함(D3 · D16); 재시작 게이트용 강제 `idle` 2곳을 이름 있는 `releaseRecovered`(같은 효과, 훅 없음)로 — PR9가 그것을 복구 모듈로 옮긴다 | A1 · A2 · A3 · A23(판정 시작) · A24–A26 | 버그 수정 |
| 3 | WU2 | 모델 · 읽기 한 곳 | `goal/model.ts`(타입 이동, 사본 제거) · `goal/read.ts`(`phaseOf` · `placeOf`, 옛 필드에서 계산) · `goal/invariants.ts`; cap 질문 판정 7곳 · stall 판정 · 한도 추론 · `status==='paused'` 읽기를 `phaseOf` · `placeOf`로; 게이트가 `running` · `retrying` 통과(재무장 유지) | A4 · A20 일부 | 보존 + X4 |
| 4 | WU3 | 전이 이동 | `goal/machine.ts`로 전이 이동, `bumpEpoch` 하나, 되돌리기 하나 — 결과가 같은 이동만 | A20 일부 · A21(쓰기) | 보존 |
| 5 | WU3 | 커밋 한 길 | `goal-commit.ts`; 직접 쓰기 제거(명령 · 버튼 · 수정 모달 · 열기 취소 · 되살리기); cap 답의 순서 선언 | A5 · A8 · A9 · A21 | 버그 수정 |
| 6 | WU3 | 표면 수정 | D11 · D12: `/new` · 보관 · 스레드 이동 · `goal resume` · `goal done` · Slack 🗑️ · 자동 goal | A10–A16 | 버그 수정 |
| 7 | WU4 | 저장 모양 + 화면 | `phase` 저장 + 옛 필드 지문 · 완료 goal 슬롯에서 내림과 그것을 읽는 Slack 블록 · 대시보드(D5) · hold 한 모양(D6) · `pendingEval` 저장 중단 · `loadGoalState` · 함께 쓰기 · id 없는 옛 cap 라운드 유지 | A20(이행 표) · A27(세 왕복) · I1–I3 | 결정 D4–D6 · D17 |
| 8 | WU5 | 루프 구동기 | `loop-decision.ts` · `LoopState` · `PendingDrive` judge/inject(집합 셋 대체) · `AutoResume` · 적용 직전 · 주입 직전 재확인 · `stopped` 단계(사람의 멈춤은 `user-stop` · `user-interrupted`만) · 타이머 취소 | A5(판정 중) · A6 · A7 · A17 · A23(주입 시점) · A24–A26 · A28 | 버그 수정 |
| 9 | WU6 | 재시작 복구 | `restart-recovery.ts` · 레코드 · `decideRecovery` · `releaseRecovered` · 사람의 멈춤 · `opening` · `.finally` | A2 · A3 · A18 · A19 | 버그 수정 |
| 10 | WU7 | 칸 · 문서 · 실측 | `goal/board.ts`(D14) · 클라이언트 재계산 정리 · 옛 필드 함께 쓰기 제거 · `docs/goal-command/spec.md` 상태도 · 38–40 shipped · dev 실측 | A17 · A22 | 결정 D14 |

## 5. 순서와 게이트

```
PR1 ─▶ PR2 ─▶ PR3 ─▶ PR4 ─▶ PR5 ─▶ PR6 ─▶ PR7 ─▶ PR8 ─▶ PR9 ─▶ PR10
(점유)  (게이트) (읽기)  (이동)  (커밋)  (표면)  (저장)  (구동기) (복구)  (칸·실측)
```

- 순서의 이유: 읽는 쪽을 한 곳으로 모아야(PR3) 쓰는 쪽을 모을 때(PR4–5) 영향 범위가 보이고, 쓰는 쪽이 한 곳이어야 저장 모양을
  바꿀 수 있다(PR7). 구동기와 복구는 단계 · 점유가 명시된 뒤에야 단순해진다.
- PR마다: `npx tsc --noEmit` · `npx biome check` · 바뀐 코드를 쓰는 테스트 파일 전부 · CI quality-gates · 리뷰 → 머지 → 소유자 dev
  배포 → 그 PR의 시나리오 중 실측 가능한 것 확인. 동작을 바꾸는 PR의 의도된 관측값 변경은 같은 PR에서 테스트를 고쳐 적는다(G5).
- PR2의 머지 조건: A23(판정 시작) · A24–A26이 실제 디스패처 슬롯 타이밍에서 통과. A23의 주입 시점은 PR8의 머지 조건이다(그 전까지는 지금처럼 펜스에서 버려졌다가 다시 깨운다).
- PR7은 배포 뒤 재시작을 한 번 지나서(`sessions.json` 새 모양 저장 → 다시 로드) 다음 PR로 간다.

## 6. 지키는 규칙 (계약 테스트)

`src/__tests__/goal-state-boundary.contract.test.ts`(PR1에서 만들고 PR마다 넓힌다):

1. `activityState`를 조건으로 읽는 goal · 루프 · 복구 코드가 없다(PR2).
2. 슬롯 · 컨트롤러로 "턴이 도는가"를 직접 묻는 코드는 `session-occupancy.ts`뿐이다(PR1, 예외는 이유와 함께 파일에).
3. goal의 status · 단계 필드 · 카운터 · 에폭에 쓰는 코드는 `goal/machine.ts`뿐이다(PR4–5).
4. 그 필드를 제어 흐름으로 읽는 코드는 `goal/read.ts`(`phaseOf` · `placeOf`)를 지난다(PR3).
5. goal 변경 뒤 저장 · 방송은 `goal-commit.ts`뿐이다(PR5).
6. `SessionGoal` 정의는 `goal/model.ts` 하나다(PR3).
