# 04 — Slack Agent UI 재설계 + 후속 메시지 큐 (Spec)

Status: planned (구현 미착수 · 게이트 전부 미실행)
Date: 2026-09-14
현재 임무: **구현 + 검증 + 프리뷰 배포(work-m64 제외) + Chrome 화면 검증.** "문서만"은 PRD 작성 세션에
한정됐던 과거 제한이다(근거·verbatim = SSOT §1, §1.1).
SSOT: [`.prd/slack-agent-ui/ssot.md`](slack-agent-ui/ssot.md) · Loop: [`.prd/slack-agent-ui/loop.md`](slack-agent-ui/loop.md)
Architecture: [`.prd/05-slack-agent-ui-architecture.md`](05-slack-agent-ui-architecture.md)

> `.prd/01`–`03`은 다른 브랜치(`prd/plugin-split`)가 예약. 여기로 복사하지 않는다.

## 1. 문제

모델 턴이 도는 동안 유저가 보낸 후속 메시지가 **자연스럽게 처리되지 않는다.** 유저 원문:
"유저의 추가 메세지가 그냥 무시되면 안되고 모델의 턴이 끝나면 처리되야하는데".
동시에 현재 Agent UI는 진행 상황·승인·완료 카드가 섞여 있어 "지금 뭐 하는 중인지"가 한 눈에 안 잡힌다.

## 2. Goals

1. 실행 중 도착한 **모든** 일반 후속 메시지(상태 질문 포함)가 durable 큐에 들어가고, 현재 턴이 끝난 뒤
   **새 user dispatch**로 처리된다.
2. 스레드 상단에 `Queue` 섹션이 보이고, 각 항목에 canonical `Send now` 버튼이 붙는다.
3. `Send now`는 선택 항목 하나만 앞당긴다 — 현재 실행 interrupt → teardown 대기 → 같은 컨텍스트 재디스패치.
4. 스레드 상태 줄이 **단계 + 실제 마지막 활동**을 보여준다(하트비트가 아니라 진행).
5. 진행 스트림 1개로 통합: task/plan/tool 진행 + 결과 + 피드백.
6. 승인(approval)은 일반 액션과 **분리된 컨트롤 경로**, stop은 항상 명시적.
7. 재시작·중단·삭제 시 큐 상태가 거짓말하지 않는다(`uncertain`을 그대로 노출).

## 3. Non-goals

- `agent_view` 활성화 — 비가역, **별도 승인 대상이며 현재 인가돼 있지 않다**(원 배포 요청에 포함돼 있었더라도 제외).
- prod 채널(`deploy/prod`) 배포 — 유저 게이트 유지. 이번 임무의 배포는 **프리뷰 채널 한정**.
- 배포 토폴로지(워크플로 파일·repo variable) 무단 변경 — 필요하면 별도 리뷰·승인(SSOT §5, §8 R7).
- GoalQueue와 followup 큐의 통합.
- 새 가시성·새 권한 스코프 도입.
- 기아(starvation) 방지 / bounded-fairness 장치(SSOT §3.6 — autogoal이 밀리는 것은 의도된 결과).

구현·테스트·라이브 QA는 **더 이상 non-goal이 아니다** — 현재 임무에 포함된다(위 헤더 참조).

## 4. UI 요구

### 4.1 스레드 헤더
```
Zhou Yu (Beta) VIP AGENT
10:03 AM
진행 중 · 게이트 재실행 대기 (5/6) · 마지막 활동 41초 전
Queue
- 진행중인거 알려줘?      [Steering now]
```
- 버튼 canonical label = `Send now` (`Steering now`는 유저 표기 동의어, 액션 ID는 하나).
- "마지막 활동"은 heartbeat가 아닌 **실제 진행 이벤트** 기준.
- ETA를 지어내지 않는다.

### 4.2 본문
- 진행 스트림 1개(tasks/plans/tool progress → 결과 → 피드백).
- 중복 완료 카드 / MCP 성공 로그 스팸 금지.
- 빈 텍스트 fallback: 접근 가능한 **의미 있는** fallback 텍스트를 요구하되 첨부만 있는 메시지는 허용.
  중앙의 rendered-empty 가드로 처리하고, 통짜 거절(blanket rejection)로 막지 않는다.
- 스트리밍 블록 미지원 환경에서는 legacy fallback으로 **Queue/Send now를 보존**한다.
  동작 중인 스트림을 조용히 끄지 않는다.

### 4.3 Slack 플랫폼 채택 (full scope — capability 게이트 통과 시)

SDK 업그레이드와 Agent Sessions / task·plan 블록은 **비목표가 아니라 계획된 전체 스코프**다.
다만 채택은 **capability preflight(A35)를 통과한 뒤에만** 이뤄진다 — 게이트가 red면 아래 fallback으로 간다.
`agent_view`는 이 게이트와 무관하게 제외(별도 승인 대상, 인가 없음).

- 현재 설치본: `package.json:53-54` = `@slack/bolt` 4.7.0, `@slack/web-api` ^7.15.1
  (디스크 실측: web-api 7.15.1, `@slack/types` 2.20.1, bolt 4.7.0).
- **정정 (타입 표면 실측)**: task/plan은 업그레이드 없이도 타입이 있다 —
  `node_modules/@slack/types/dist/chunk.d.ts:22` `plan_update`, `:30` `task_update`;
  `node_modules/@slack/types/dist/block-kit/blocks.d.ts:21` `KnownBlock`에 `TaskCardBlock | PlanBlock` 포함
  (`:305`, `:339`); `node_modules/@slack/web-api/dist/types/request/chat.d.ts:198` `task_display_mode`.
  따라서 "task/plan을 쓰려면 bolt 5.1 / web-api 8.1이 필요하다"는 전제는 **성립하지 않는다.**
- 실제로 빠진 것은 **agent session lifecycle 표면**이다: `node_modules/@slack/web-api/dist/methods.d.ts`에
  `agents` 매치 **0**(현재는 `assistant.threads.*`만). `chat.stopStream`의 `session_status`도 없다.
  → 업그레이드는 **Agent Sessions를 채택할 때만** 게이트다.
- **타입이 있다 ≠ 워크스페이스에서 렌더된다.** 아래 API의 live 채택은 전부 **NOT TESTED**.
- 후보 API surface (채택 전 live 실측 필요):
  - Agent Sessions (세션 단위 스레드 표면) — 상태 줄 + `Queue` 렌더 대상 후보.
  - task card / plan block (2026-02-11 changelog) — 단일 진행 스트림의 task/plan 표현 후보.
  - assistant / agent 메시징 마이그레이션 경로 — 기존 append-only 메시지와의 공존 방식.
- 필요 scope·설정: 신 블록/세션 API가 요구하는 봇 scope와 앱 manifest 변경분을 **먼저 열거**하고,
  새 가시성이 생기지 않음을 확인한 뒤 요청한다. `agent_view`는 제외(비가역, 별도 승인).
- stop 컨트롤: 네이티브 stop이 제공되더라도 **명시적 stop 의미론**(자동 abort 아님)을 유지하고,
  기존 일반 액션 경로와 분리한다.
- result 렌더: 신 블록 채택 시에도 결과·피드백은 하나의 진행 스트림에 귀속되며 중복 완료 카드를 만들지 않는다.
- 레퍼런스(정적 문서, 모두 capability 검증 전):
  https://docs.slack.dev/ai/agent-sessions ·
  https://docs.slack.dev/ai/migrating-to-agent-messaging ·
  https://docs.slack.dev/changelog/2026/02/11/task-cards-plan-blocks
- SDK task status enum과 `assistant_view` 호환성은 **미검증** — 검증 전 코드에 가정으로 넣지 않는다.
- 게이트 실패 시 fallback: 기존 블록으로 `Queue` / `Send now`를 유지한다(동작 중인 스트림을 끄지 않는다).

### 4.4 생존성
- 침묵만으로 10분/30분 하드 abort 하지 않는다. 경고 + liveness 증거를 보이고,
  **도구 실행 중**과 **승인 대기 중**을 구분해 표시한다.
- 호스트 크래시 후 재시작은 orphan active 상태를 reconcile하되 **완료로 표시하지 않는다.**

## 5. Acceptance (전부 **미검증** — 구현 시 유닛별 RED→GREEN으로 증명. 유닛 매핑 = loop.md)

| # | 케이스 | 기대 |
|---|---|---|
| A1 | 실행 중 일반 후속 메시지 도착 | durable enqueue가 **먼저**, 그 다음 Queue UI 리시트. 현재 실행 abort 없음 |
| A2 | 실행 중 상태 질문(`진행중인거 알려줘?`) | 동일하게 enqueue. harness가 대신 답하고 소비하지 않음 |
| A3 | 같은 Slack 이벤트 재전송 | dedup — 항목 1개 |
| A4 | 후속 3개 연속 도착 | 세션별 FIFO, sequence 단조 증가 |
| A5 | 턴 종료 + cleanup 완료 | adapter yield → CAS 해제 → atomic claim 1개 → **새 user dispatch**(`isUserInput` 유지, author/text/files/context 보존) |
| A6 | 턴 종료 시 autogoal 대기 중 | followup이 먼저, 그 다음 autogoal. 암묵적 cross-level FIFO 없음 |
| A7 | tool_result 직후 | drain 하지 않음(경계가 아님) |
| A8 | Security ASK 대기 / stop / error | drain 일시정지 |
| A9 | 큐 3개 중 2번째 `Send now` | 그 항목만 앞당김, 나머지는 FIFO 유지 |
| A10 | `Send now` 클릭 | interrupt → teardown await → 같은 컨텍스트 새 dispatch. 라이브 주입 주장 없음 |
| A11 | 중단된 부분 출력 | `user-interrupted` 태그로 보존, error 아님, stale 휴리스틱과 무관 |
| A12 | `Send now` 더블클릭 / drain과 동시 | 승자 1개, stale epoch 거절 |
| A13 | `Send now` 권한 거부(canInterrupt 실패 또는 dispatch 시점 인가 실패) | 항목은 큐에 **남는다**, 소실 없음 |
| A14 | 첨부 포함 후속 메시지 | 처리 시점까지 첨부 보존, 텍스트 무변형 |
| A15 | capacity 초과 | 명시적 거절 메시지, 조용한 폐기 없음. capacity = `SOMA_FOLLOWUP_QUEUE_CAPACITY` 타입드 accessor, 기본 100 |
| A16 | 프로세스 재시작 | `queued`=복원 후 paused(자동 dispatch 금지), `reserved`=`paused`(예약은 dispatch가 아님, 블라인드 승격 금지), `claimed`/`dispatched`=`uncertain`(블라인드 재실행 금지), `failed`=명시적 retry. 로드 실패 시 WARN + `.bak` 폴백, 조용한 빈 큐 금지 |
| A17 | stop / 세션 종료 | 큐가 freeze + 사유 표시, 유저의 **명시적 resume** 전까지 자동 dispatch 없음. 항목별 상태 확정은 **A31이 정본**("전부 paused"로 뭉뚱그리지 않는다) |
| A18 | 세션 삭제 | 항목이 보이게 취소되고 히스토리 남음 |
| A19 | 관측 — 헤더 상태 줄 | 단계 + **실제** 마지막 활동. heartbeat를 진행으로 표시하지 않음. ETA 없음 |
| A20 | 관측 — 침묵 | 하드 abort 없음. 경고 + liveness 증거, 도구 실행/승인 대기 구분 |
| A21 | 호스트 크래시 재시작 | orphan active 재조정, 완료로 표시하지 않음 |
| A22 | 스트리밍 블록 미지원 | legacy fallback에서도 Queue/Send now 유지 |
| A23 | 첨부만 있는 메시지 | 렌더 허용 + 의미 있는 접근성 fallback |
| A24 | 스레드 post/update/outbox | rate limit 준수 + 재시작 후 idempotent(중복 카드 없음) |
| A25 | 배포 host 제외(work-m64), 프리뷰 채널 | `.github/workflows/deploy.yml:40-71`은 채널 변수의 **모든** 줄을 확장하며 필터가 없다 → 제외는 **미구현**(구현 주장 금지). `PREVIEW_DEPLOY_TARGETS`를 읽기 전용으로 열거 → runner label ↔ host alias 대조로 work-m64 canonical+alias 확정 → 프리뷰 한정 allowlist. 워크플로/변수 변경이 필요하면 **별도 리뷰·승인**. 미상 target 존재 시 **fail closed**(무필터 push 금지) |
| A26 | 실행 중이 아닐 때(idle) 도착한 일반 메시지 | 큐를 타지 않고 **즉시 dispatch**. 큐는 실행 중일 때만 개입한다 |
| A27 | 큐가 `paused`인 상태에서 새 메시지 도착 | 기존 `paused` 항목은 계속 `paused` 유지(자동 재개 없음). 새 메시지는 A26/A1 규칙을 따른다 |
| A28 | 끝나가는 옛 턴의 지연 쓰기(late write)가 새 dispatch 시작 후 도착 | 새 상태/새 턴 표면을 **덮어쓰지 않음**(A12와 **같은 epoch 값**으로 거절), 옛 턴 출력은 자기 위치에 남음 |
| A29 | 권한 거부 vs paused 구분 | 권한 거부 = 항목 `queued` 유지 + 거부 사유 표시(재시도는 권한 해결 후). paused = freeze 상태이며 **유저의 명시적 resume**으로만 풀린다. 두 상태를 같은 문구로 뭉뚱그리지 않는다 |
| A30 | 다른 사람이 쓴 큐 항목을 제3자가 `Send now` | author/text/files/context를 **다시 쓰지 않고** enqueue 시점 값 그대로 dispatch. 클릭자는 인가 주체일 뿐 작성자를 대체하지 않음 |
| A31 | stop 시점 항목 상태 확정(재생 아님) | `reserved` 및 시작 전 `claimed` → `paused`, 실행 중 중단(`dispatched`) → `uncertain`(결과가 확인된 경우에만 `resolved`/`failed`), 나머지 `queued` → `paused` |
| A32 | 진행 스트림 관측 | task/plan/tool 진행 + 결과 + 피드백이 **단일 스트림 1개**. 중복 완료 카드 없음, MCP 성공 로그 스팸 없음 |
| A33 | 승인 요청과 stop | 승인(approval)은 일반 액션과 **분리된 컨트롤 경로**로 렌더. stop은 항상 **명시적**이며 자동 abort로 대체되지 않음 |
| A34 | 큐 관측 지표(§6) | 큐 depth, enqueue/claim/dispatch/resolve/fail 카운트, `uncertain` 잔량, drain latency, `Send now` interrupt latency, 거절 사유별 카운트(capacity/권한/stale epoch)가 노출된다. 마지막 **실제 진행** 타임스탬프는 헤더(A19)와 **같은 소스** |
| A35 | Slack capability preflight(§4.3) | bolt/web-api 실제 설치 버전, Agent Sessions·task/plan 블록, `assistant_view` 호환을 **실측**한 뒤에만 채택. red면 legacy fallback으로 `Queue`/`Send now` 유지(A22). `agent_view`는 **인가되지 않았고 검증 대상에서도 제외** |
| A36 | 패널 최하단 고정 (유저 2026-09-17 "스레드 안에 항상 최하단에") | 봇이 스레드에 새 메시지를 게시하면 결합 패널은 700ms 내 코얼레싱·세션당 ≥3s 간격으로 **삭제 후 재게시**되어 스레드 마지막 메시지가 된다. 패널 메시지는 항상 1개. 패널이 스레드 루트인 봇 발화 스레드는 재게시하지 않는다. 재게시는 A24 intent(markDeleted→beginPost→markSent) 경로 |
| A37 | 컴팩트 레이아웃 (유저 2026-09-17 "좀더 컴팩트하게") | 헤더+상태 ≤4블록. Queue는 context 1줄 + 항목당 section 1블록(`n. 원문 · 상태`) + 우측 overflow 메뉴(Send now / Cancel / Retry / Resume). 페이지 nav는 2페이지 이상일 때만 |
| A38 | Cancel (유저 2026-09-17 "취소 할수 있어야함") | `queued/paused/failed/uncertain` → `cancelled`(이력 유지, 사유 기록). `reserved/claimed/dispatched`는 거부 + "중지 버튼" 안내. 권한 = Send now와 동일(작성자/현재 발화자). 취소는 드레인을 유발하지 않는다 |

## 6. 관측(Observability) 요구 — 검수는 A34

- 큐 depth, enqueue/claim/dispatch/resolve/fail 카운트, `uncertain` 잔량.
- drain latency(턴 종료 → dispatch 시작), `Send now` interrupt latency.
- 거절 사유별 카운트(capacity, 권한, stale epoch).
- 마지막 **실제 진행** 타임스탬프(헤더 표시와 동일 소스).

## 7. Risks / Open questions

- `packages/slack/src/pipeline/stream-executor.ts:2497`의 `finally endTurn('completed')`는 성공 증거가 아니다 —
  drain 트리거를 여기에 직접 매달면 실패 턴에서도 drain된다. 경계 신호를 별도로 정의해야 한다.
- `packages/slack/src/request-coordinator.ts:173-174` `canStartRequest`는 **큐 보장이 아니다.** 새 큐가 실제 SSOT여야 한다.
- `packages/slack/src/mcp-status-tracker.ts:176` in-memory cleanup은 재시작 후 상태 재구성에 영향.
- Slack 신 블록(task/plan) 가용성 미검증 — 채택 전 SDK/워크스페이스 capability 확인 필요(A35).
- work-m64의 canonical runner label은 **repo 안에 증거가 없다**(`rg -n 'work-m64'` 매치 0, `.prd` 제외).
  토폴로지가 Actions repo variable에만 있으므로 A25의 1단계(읽기 전용 열거) 없이는 allowlist를 만들 수 없다.
- `reserved` 상태 신설은 저장 스키마를 바꾼다 — 기존 저장 파일이 없더라도 스키마 버전 필드를 함께 넣지 않으면
  다음 변경 때 같은 문제가 반복된다(SSOT §8 R2).
