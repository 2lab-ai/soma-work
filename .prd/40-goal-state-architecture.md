# 40 — goal 상태 아키텍처: 상태마다 주인 모듈 하나, 작업 단위 일곱 개

Status: in-progress · 작성 2026-11-26 · 스펙 = [39-goal-state-spec.md](39-goal-state-spec.md) ·
현재 상태 = [38-goal-state-as-is.md](38-goal-state-as-is.md) · 드라이버 = [goal-state/loop.md](goal-state/loop.md)

> 요약: 39의 다섯 상태를 다섯 모듈에 하나씩 둔다. goal 자체(위치 · 단계 · 전이 · 불변식 · 화면 투영)는 `@soma/slack/goal/`
> 한 폴더에 순수 코드로 모으고, 호스트는 턴 점유 · 루프 구동기 · 재시작 복구 세 모듈로 그것을 돌린다. 일은 PR 일곱 개로
> 나눠 앞 PR이 다음 PR의 바닥이 되게 순서를 정했다 — 읽는 쪽을 먼저 한 곳으로 모으고, 쓰는 쪽을 모으고, 저장 모양을
> 바꾸고, 마지막에 구동기 · 복구 · 화면을 갈아 끼운다.

## 0. 미니맵

```
40 goal 상태 아키텍처
├─ 1. 모듈 지도              ─ 상태 하나 = 주인 모듈 하나
├─ 2. 모듈별 계약            ─ 공개 함수와 누가 부르나
├─ 3. 저장 모양과 이행        ─ 옛 필드 → 새 단계, 로드 때 한 번
├─ 4. 작업 단위 (WU1–WU7)    ─ 범위 · 파일 · 시나리오 · 위험
├─ 5. 순서와 게이트
└─ 6. 지키는 규칙            ─ 계약 테스트가 깨뜨리는 경계
```

읽는 법: 어디에 무엇이 생기는지는 §1·§2, 디스크 모양이 어떻게 바뀌는지는 §3, 어떤 PR이 무엇을 하는지는 §4.

## 1. 모듈 지도

```
@soma/slack/goal/                         ← goal 자체. 순수(호스트·Slack·타이머 없음). stream-executor도 여기서 가져간다
├─ model.ts        S2 · S3 타입의 유일한 정의 (SessionGoal · GoalPhase · GoalAsk · 위치)
├─ phase.ts        phaseOf(goal) — 단계 하나의 답 (WU2: 옛 필드에서 계산 → WU4: 저장된 단계를 그대로)
├─ machine.ts      모든 전이: enqueue · activate · promote · complete · pause · hold · release · resume · delete ·
│                  clear · judge 결과 적용 · retry · ask · answer · retire · userWord · setMax · editObjective ·
│                  openingStarted · revive · moveThread · resetConversation …  → 결과 = { change, drive }
├─ invariants.ts   assertGoalInvariants(session) — 39 §4 I1–I4
├─ loop-decision.ts 순수 결정: decideLoopStep(입력) → skip | arm-retry | reuse | judge,  applyVerdict(goal, verdict) → 다음 단계
└─ view.ts         goalView(session, runtime) — Slack 블록 · 대시보드 카드가 함께 쓰는 투영

src/slack/                                ← 호스트. 상태를 돌리고 효과(게시·DM·주입·저장)를 낸다
├─ session-occupancy.ts   S1: turnHeld · ownerQuestionOpen · driven
├─ goal-commit.ts         commitGoalChange — 에폭 · 프롬프트 무효화 · 저장 · 방송 · 구동 의무를 한 번에
├─ goal-loop-controller.ts S4: LoopState · 실행기(결정은 loop-decision이, 효과는 여기서)
└─ restart-recovery.ts    S5: BootPhase · RecoveryRecord · 복구 패스 · 인계
```

지금 있는 파일이 어디로 가나:

| 지금 | 간다 |
|---|---|
| `packages/slack/src/session-goal.ts` (타입 사본 + 큐·일시정지 전이) | `goal/model.ts` + `goal/machine.ts`. 옛 경로는 재export 한 줄(규칙 `rules/packaging.md`) |
| `src/types.ts`의 `SessionGoal`·상태 유니언·기본값 | `goal/model.ts` 재export |
| `src/slack/goal-continuation.ts` · `goal-cap-decision.ts`(상태 부분) · `goal-stall.ts`(상태 부분) · `session-goal-lifecycle.ts`(이행) | 상태 부분은 `machine.ts`, 이행은 `machine.ts`의 `loadGoalState`. DM 재작성 · 질문 회수 같은 효과는 호스트에 남는다 |
| `src/slack/goal-completion-evaluator.ts`의 `shouldRunGoalIdleDriver` · `decideGoalEvalOutcome` · `apply*` | `loop-decision.ts`. 평가 호출 · 프롬프트는 evaluator에 남는다 |
| `SlackHandler`의 슬롯 검사 사본 4개 · `isHostTurnFree` · 재시작 집합 3개 + 플래그 · 강제 `idle` 쓰기 4곳 | `session-occupancy.ts` · `restart-recovery.ts`. 쓰기 4곳은 사라진다(D3) |
| `GoalHandler.persistGoalChange` · `persistHostGoalMutation` · cap 답의 수동 저장 · 수정 모달의 직접 쓰기 | `goal-commit.ts` 하나 |
| 대시보드 `placeOnBoard`의 goal 관련 판단 · `goal-blocks.ts`의 상태 낱말 | `goal/view.ts` |

## 2. 모듈별 계약

### session-occupancy (S1)

```ts
interface SessionOccupancy {
  turnHeld(key: string): boolean;                 // 슬롯(이동된 슬롯 포함) ∨ 요청 컨트롤러
  ownerQuestionOpen(session): boolean;            // actionPanel.waitingForChoice ∨ pendingQuestion
  driven(key: string): boolean;                   // turnHeld ∨ loop.stateOf(key).kind !== 'idle'
}
```

부르는 곳: 루프 게이트, 복구 패스 · 인계, 후속 질문, 사용자 작업 큐, 대시보드 "턴이 도는가", 디스패치 펜스. "턴이 도는가"를
다른 신호로 답하는 코드는 계약 테스트가 막는다(§6).

### goal/machine (S2 · S3)

- 모든 전이는 `(session, input) → GoalChange`다. `GoalChange`는 무엇이 바뀌었는지와 함께 `drive: 'kick' | 'turn-will' | 'none'`
  (구동 의무 I5)과 `effects`(은퇴한 질문 · DM 재작성 · 질문 회수처럼 호스트가 내야 할 효과의 목록)를 돌려준다.
- 전이는 에폭을 직접 올리지 않는다 — `bumpEpoch` 하나만 쓰고, 그것이 재시도 창도 정리한다(I4).
- 되돌리기는 `undoChange(session, snapshot, change)` 하나다. 이미 낸 효과(은퇴한 질문)는 되살리지 않는다(D10).

### goal-commit (호스트)

```ts
commitGoalChange(session, change, { reason }): void
// 1) 프롬프트 무효화  2) 저장  3) 대시보드 방송  4) change.effects 실행(DM 재작성 · 질문 회수)
// 5) change.drive === 'kick'이면 loop.kick(key) — 단 occupancy.driven(key)이면 건너뛴다
```

모든 표면(명령 · 버튼 · 대시보드 · SET_GOAL · 자동 goal · 첫 메시지 goal · 열기 취소)이 이것으로 끝난다.

### goal/loop-decision + goal-loop-controller (S4)

```ts
type LoopState = { kind: 'idle' } | { kind: 'queued'; runs: number }
  | { kind: 'judging'; goalId; epoch } | { kind: 'injecting'; goalId; epoch; token };
decideLoopStep({ goal, phase, occupancy, questionOpen, hostWait, halted, shuttingDown, cause, evidence, now })
  → { kind: 'skip'; why } | { kind: 'arm-retry'; inMs } | { kind: 'reuse'; reason } | { kind: 'judge' }
applyVerdict(goal, verdict, { stallAllowed, reused }) → GoalChange   // continue · complete · ask(cap) · ask(stall)
```

- 컨트롤러는 결정을 실행만 한다: 판정 호출, 알림 게시, DM, 이어하기 주입. 알림을 기다린 뒤 주입하기 직전에 결정을 다시
  확인한다(에폭 · 종료 · `turnHeld`) — X6.
- `injecting`은 이어하기 턴이 슬롯을 잡는 순간 끝난다(디스패처의 "받아들임" 신호). 토큰으로 겹치는 주입을 구분한다.
- 재시도 타이머는 `{goalId, epoch}`에 묶이고 핸들을 갖는다. goal이 바뀌면 `commitGoalChange`가 취소한다.

### restart-recovery (S5)

```ts
class RestartRecovery {
  phase: 'loading' | 'recovering' | 'live';
  recordFor(key): RecoveryRecord;             // 로드 때 종료 기록에서
  runPass(): void;                            // recovering 끝에 한 번 — 세션마다 decideRecovery(record, goal, occupancy)
  handBack(key): void;                        // 재개가 시작 못 함 — 같은 결정 함수
}
```

크래시 복구 알림이 실패해도 패스는 돈다(`.then`이 아니라 `.finally`). 사람의 멈춤 · `opening`을 결정 입력으로 받는다(D13).

### goal/view

`goalView(session, runtime)` → `{ current?: { status, phase, label, counts }, column, chips, recentComplete?, queue, shelf }`.
대시보드 서버 투영과 Slack `goal` 블록이 같은 값을 그린다. 대시보드 클라이언트의 재계산은 이 값을 읽게 바꾼다.

## 3. 저장 모양과 이행

WU4가 디스크 모양을 바꾼다. 그 전까지(WU1–WU3)는 옛 필드를 그대로 저장하고 `phaseOf`가 옛 필드에서 단계를 계산한다.

| 옛 필드 | 새 모양 |
|---|---|
| `openingPending` | `phase: { kind: 'opening' }` |
| `pendingEval` | 저장 안 함(S4 런타임, D4) — 로드 때 버린다(지금과 같음) |
| `evalBackoffUntil` · `evalDispatchRetryCount` · `evalRetryReason` | `phase: { kind: 'retrying', until, attempt, reason }` |
| `capDmPendingAt` · `capDecisionId` · `capDmRef` | `phase: { kind: 'asking', ask: { kind: 'cap', roundId, openedAt, dmRef? } }` |
| `stall` | `phase: { kind: 'asking', ask: { kind: 'stall', stall } }` |
| (없음 — 알림만) | `phase: { kind: 'stopped', why, at }` |
| 위 아무것도 없음 | `phase: { kind: 'running' }` |
| 슬롯의 `status:'complete'` | 슬롯에서 내리고 히스토리에만(D5) |
| 슬롯의 `status:'paused'`(세 가지 필드 모양) | hold 한 모양(D6): 재시도 · 질문 없음, `heldTaskIds` 있음 |

이행은 `loadGoalState(serialized)` 하나가 로드 · 되살리기 · 보관 읽기에서 모두 한다. 저장은 새 모양만 쓴다. 되돌리기 배포에
대비해 WU4 첫 배포는 옛 필드도 함께 **쓴다**(읽지는 않는다) — 한 번 뒤 다음 PR에서 그 쓰기를 지운다(§5).

## 4. 작업 단위

각 WU = 서브이슈 1 · 브랜치 1 · PR 1. 모두 시험 먼저(RED) → 구현(GREEN) → 기존 goal 테스트 전부 통과 → 리뷰 → 머지.

| WU | 이름 | 범위 | 시나리오 | 위험 · 대응 |
|---|---|---|---|---|
| WU1 | 턴 점유 한 곳 | `session-occupancy.ts`; 루프 게이트에서 `activityState` 제거(+ 주인 질문 · `turnHeld`); 로드가 레코드를 만든 뒤 `activityState` 정리(D3); 강제 `idle` 쓰기 4곳 삭제; 슬롯 검사 사본 · `isHostTurnFree` · 복구/인계/멈춤 정리의 신호를 `turnHeld`/`driven`으로 | A1 · A2 · A3(구동 부분) | 게이트 입력이 바뀐다 → 기존 게이트 테스트를 표로 옮겨 같은 결과 확인 |
| WU2 | goal 모델 한 곳 + 단계 읽기 | `goal/model.ts`(타입 이동, 사본 제거) · `goal/phase.ts`(`phaseOf`, 옛 필드에서 계산) · `goal/invariants.ts`; cap 질문 판정 7곳 · stall 판정 · 한도 소진 추론을 `phaseOf`로; 게이트가 단계 `running`만 통과 | A4 · A16(읽기) · A20 일부 | 타입 이동으로 import가 많이 바뀐다 → 옛 경로 재export로 한 번에 깨지지 않게 |
| WU3 | 전이 한 곳 + 커밋 한 길 | `goal/machine.ts`로 전이 이동 · 직접 쓰기 제거(명령 · 버튼 · 수정 모달 · 열기 취소 · 리셋 · 되살리기 · 스레드 이동); `goal-commit.ts`; `bumpEpoch` 하나; 되돌리기 하나; 표면 수정 D11 · D12 | A5 · A8 · A9 · A10–A16 · A21 | 가장 크다 → machine 이동(동작 그대로)과 표면 수정(동작 변경)을 커밋으로 나누고 리뷰도 그 단위로 |
| WU4 | 저장 모양 바꾸기 | `phase` 저장 · 완료 goal 슬롯에서 내림(D5) · hold 한 모양(D6) · `pendingEval` 저장 중단 · `loadGoalState` 이행 · 옛 필드 함께 쓰기(되돌리기 대비) | A20(이행 표) · 불변식 I1–I3 | 디스크 모양 → 실제 `sessions.json` 사본으로 로드 · 저장 · 다시 로드를 시험(이행 손실 0) |
| WU5 | 루프 구동기 명시 | `loop-decision.ts` 순수 결정 · `LoopState` · 주입 직전 재확인 · `stopped` 단계 · 타이머 취소 · reuse를 eval 횟수에서 제외 | A6 · A7 · A17(루프 부분) · A20 | 루프 시간 순서 → 가짜 시계 · 가짜 디스패처로 표 테스트 |
| WU6 | 재시작 복구 명시 | `restart-recovery.ts` · 레코드 · 패스 · 인계 한 결정 함수 · 사람의 멈춤 · `opening` · 크래시 알림 실패에도 패스 | A2 · A3 · A18 · A19 | 부팅 순서 → index.ts 부팅 단계를 그대로 재현하는 테스트 |
| WU7 | 투영 · 문서 · 실측 | `goal/view.ts` · 대시보드 칸 규칙(D14) · Slack `goal` 블록 · `docs/goal-command/spec.md` 상태도 · 38–40 shipped · dev 배포 실측 | A17 · A22 | 화면 → 대시보드 클라이언트 하네스 테스트 + 실측 스크린샷 |

옛 필드 함께 쓰기 정리(WU4의 되돌리기 대비)는 WU7 PR에서 지운다.

## 5. 순서와 게이트

```
WU1 ──▶ WU2 ──▶ WU3 ──▶ WU4 ──▶ WU5 ──▶ WU6 ──▶ WU7
(점유)  (읽기)   (쓰기)   (저장)   (구동기)  (복구)   (화면·실측)
```

- 순서의 이유: 읽는 쪽을 한 곳으로 모아야(WU2) 쓰는 쪽을 모을 때(WU3) 영향 범위가 보이고, 쓰는 쪽이 한 곳이어야(WU3)
  저장 모양을 바꿀 수 있다(WU4). 구동기와 복구는 단계 · 점유가 명시된 뒤에야 단순해진다.
- WU마다: `npx tsc --noEmit` · `npx biome check` · 바뀐 코드를 쓰는 테스트 파일 전부 · CI quality-gates · 리뷰 → 머지 →
  소유자 dev 배포 → 그 WU의 시나리오 중 실측 가능한 것 확인.
- WU4는 배포 뒤 재시작을 한 번 지나서(`sessions.json` 새 모양으로 저장 → 다시 로드) 다음 WU로 간다.

## 6. 지키는 규칙 (계약 테스트)

`src/__tests__/goal-state-boundary.contract.test.ts`(WU1에서 만들고 WU마다 넓힌다):

1. `activityState`를 조건으로 읽는 goal · 루프 · 복구 코드가 없다(WU1).
2. 슬롯 · 컨트롤러로 "턴이 도는가"를 직접 묻는 코드는 `session-occupancy.ts`뿐이다(WU1, 예외 목록은 이유와 함께 파일에).
3. goal의 status · 단계 필드 · 카운터 · 에폭에 쓰는 코드는 `goal/machine.ts`뿐이다(WU3).
4. goal 변경 뒤 저장 · 방송은 `goal-commit.ts`뿐이다(WU3).
5. `SessionGoal` 정의는 `goal/model.ts` 하나다(WU2).
