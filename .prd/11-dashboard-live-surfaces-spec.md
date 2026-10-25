# 11 — 대시보드 라이브 표면: 실시간 토큰·비용, task ledger, 모델 전환, 작업 로그 task 그룹, DONE 날짜 그룹

Status: shipped (PR) · Date: 2026-10-22 · 기준 main `43b6b0b5` · 앞선 계약: [`10-agent-inbox-board-spec.md`](10-agent-inbox-board-spec.md)

## 0. 한 줄 정의

접힌 카드는 진행 중인 task와 세션의 총 토큰·API 환산 비용을 턴 중에도 자라는 숫자로 보여 주고, 펼친 카드는 대표 모델 전환
(autocompact가 모델을 따라가고, 넘치면 먼저 compact)·완료된 goal 상세·task별 시간과 툴 호출 수를 보여 주며, 작업 로그는
전부를 task별로 접어 보여 주고, DONE은 끝난 날짜로 묶인다.

## 1. 요건 → 계약 (SSOT 2026-10-22, T1–T12)

| T | 요건 | 계약 |
|---|---|---|
| T1 | 접힌 카드 총 토큰량, 실시간 증가 애니메이션 | `.card-usage` 행. 총 토큰 = 입력+출력+캐시 읽기+캐시 쓰기(`cardTotalTokens`). `.cnt[data-to]` 숫자는 `startCountUp`이 ease-out 900ms로 이전 값에서 센다(첫 페인트·감소·백그라운드 탭·reduced motion은 즉시). |
| T2 | 총 API 환산 비용, 증가 애니메이션 | 같은 행의 `$` 숫자. 서버 `tokenUsage.totalCostUsd` = 확정 합계 + 진행 중 턴 호출(`liveUsage`)을 세션 모델 단가(`calculateTokenCost`)로 환산. |
| T3 | 진행 중 task 이름 + 진행 시간 | `.card-task` 행(RUNNING·NEEDS YOU): `#T<n>` + task 이름 + `task-elapsed`(1Hz 틱). 요약 줄은 같은 task를 반복하지 않는다. |
| T4 | 대표 모델로만 모델 변경 | 펼친 카드 `<select>`(2026-10-25 spec 13: 카드는 컨트롤 줄, 패널은 입력창 옆): `opus[1m]`·`fable[1m]`·`sonnet[1m]`·`sol[1m]`·`astra[1m]`·`grok[1m]`. `grok[1m]` = `grok-4.6`(grok은 1M 변형이 없다: 500k 창, 450k autocompact). `sonnet[1m]` = `claude-sonnet-4-6[1m]`(이번에 허용 목록·alias·750k 프로필 추가). `POST /api/dashboard/session/:key/model { model: <nickname> }`. 그 밖의 값 = 400. |
| T5 | 모델 변경 시 autocompact 변경, 대상 한도 초과면 현재 모델로 compact 후 변경 | 전환은 세션 `/autocompact` 오버라이드를 지워 새 모델의 기준이 적용되고 창을 다시 잡는다(`applyModelSwitch`). 현재 컨텍스트 > 대상 모델 autocompact면 `pendingModelSwitch`를 세우고 소유자의 `compact --yes`를 보낸다. 전환은 그 메시지의 ts(`compactTs`)에 묶여, 그 메시지의 compact 턴만 무장(`armPendingModelSwitch`)한다 → 그 compact 경계에서 전환(`applyPendingModelSwitch`), 경계 없이 그 턴이 끝나면 취소(`settlePendingModelSwitch`). 사이에 낀 다른 compact(auto-compact·직접 입력)는 전환을 건드리지 않는다. `compact --yes`가 다른 턴 뒤 follow-up 큐에 들어갔으면(`FollowupQueue.holdsPending`, stop·재시작으로 멈춘 `paused` 제외) 전환은 그 compact를 계속 기다리고, 실행되지 않은 채 끝났으면(드롭·실패) 즉시 취소한다. 큐에서 기다리는 동안 2초마다 그 항목을 확인해, 실행 가능성이 사라지면(취소·정지·실패) 또는 TTL이 지나면 바로 해제한다(`QUEUED_COMPACT_WATCH_MS`). 대기 전환은 30분(`PENDING_MODEL_SWITCH_TTL_MS`)이 지나면 무효 — 카드의 모델 선택 잠금도 풀린다. 턴 진행 중에는 compact를 시작할 수 없어 409. 카드에 대기 중인 전환을 표시한다. compact 경계를 지난 턴이 중단되면 경계 이전 호출은 점유량에서 빼고(`markLiveUsageBoundary`), 경계 이후 호출 중 가장 큰 것만 점유량 후보로 쓴다(`liveOccupancyCall`) — 비용·합계는 전부 더한다. |
| T6 | goals 펼쳐 이전 완료 goal 상세 열람 | goal 머리 `완료된 goal N개` 버튼(읽기 전용·아카이브 카드도) → 최신순 목록: 목표·완료 시각·소요·토큰·비용·이어하기 횟수·완료 방식·평가 사유. 서버 `KanbanGoal.history`(현재 goal과 중복 제거, 사유 ≤1000자). 아카이브가 `goal`/`goalHistory`를 보존한다. |
| T7 | 완료 task의 사용 시간 + 툴 호출 수 (2026-10-25 spec 13: `전체 task N개 →`는 패널 Tasks를 연다) | task ledger(`src/session/task-ledger.ts`, 세션에 영속): ledger 시계로 시작/완료를 찍고, `tool` 작업 로그 항목마다 진행 중 task의 `toolCalls`+1. 타임라인·패널: `소요 · 툴 N회`. 목록 밖으로 밀려난 완료 task는 `전체 task 보기`로. |
| T8 | task 고유 id | `T<n>` — 세션 안에서 한 번만 주고 재사용하지 않는다(같은 문구의 두 task = 두 id, 사라졌다 돌아온 task = 새 id). 동일성은 직전 목록에서 같은 문구. |
| T9 | 작업 로그 개수 제한 없음 | 최신 창(500) 뒤 `hasMore`면 `wlLoadOlder`가 `afterSeq=0`부터 보유 최소 seq까지 페이지로 전부 가져온다. 복구 페이지 상한 20 → 2000(크기 제한이 아니라 무한 루프 방지 상한). |
| T10 | 작업 로그를 task 하위로 접기/펼치기 | 항목에 `taskId`/`taskTitle`(진행 중 task, 지시·최종 답변은 제외)을 스탬프해 저장·방송. 패널은 task당 머리 1개(`#id`·제목·항목 수·소요·툴 수)로 묶고, 머리는 로빙 탭 순서 안의 행 버튼. 가장 새 그룹은 열린 채로, 나머지는 닫힌 채로 시작한다. |
| T11 | DONE: Today / 어제 / 이전 날짜, 완료 시각 기준 그룹 | 서버 `KanbanSession.doneAt` = 유휴 전환 시각(`activityStateChangedAt`, 이제 영속), 없으면 마지막 활동, 아카이브는 마지막 활동. 클라이언트 `planDoneGroups`가 보는 사람의 달력으로 날짜별 섹션(최신순, 날짜 안도 최신순)을 만든다. 7일 `Show older`는 없어졌다. |
| T12 | 오늘·어제 기본 펼침, 이전 날짜 기본 접힘·클릭해서 펼침 | 기본 열림 = Today·어제. 접힌 날짜는 카드 노드를 두지 않는다. 머리 클릭이 페이지 동안의 선택을 기록한다. 딥링크가 접힌 날짜의 카드를 가리키면 그 날짜를 연다. DONE 배지 = 모든 날짜의 카드 수. |

## 2. 실시간 사용량 경로 (T1/T2)

SDK assistant 메시지의 호출별 usage → `usage` 이벤트에 `lastTurnMessageId` → `StreamProcessor` `onLiveUsage` →
`StreamExecutor`가 `session.liveUsage[messageId]`(턴 단위, 같은 id는 덮어쓰기) 기록 → provider `notifyLiveUsage(sessionKey)` →
`scheduleLiveSessionUpdate`(세션당 1초 1회, 마지막 값은 반드시 도착) → WS `sessionUpdated` → `patchCard` → 카운트업.
턴 결과 usage가 `usage.total*`에 들어가는 순간과 턴 종료 시 `liveUsage`를 지운다. llmux/codex 계열은 호출별 usage를 0으로 보내므로
턴 끝에만 자란다.

## 3. 검증

- 단위: `src/session/__tests__/task-ledger.test.ts`, `src/session/__tests__/model-switch.test.ts`,
  `packages/slack/src/__tests__/{live-usage,model-switch,stream-processor.live-usage}.test.ts`,
  `src/conversation/__tests__/dashboard-live-surfaces{,-client}.test.ts`, `work-log.test.ts`(taskId/taskTitle).
- 실측: Playwright로 실제 페이지(가짜 세션 7개, 작업 로그 1,252건)를 띄워 각 표면을 캡처했다(PR 본문).
