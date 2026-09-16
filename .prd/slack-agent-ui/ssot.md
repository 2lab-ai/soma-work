# SSOT — Slack Agent UI 재설계 + 유저 메시지 큐

Status: planned (문서 계약 확정, 제품 게이트 미실행)
Date: 2026-09-14
Scope: **현재 임무 = 이 PRD의 구현 + 검증 + 프리뷰 배포(work-m64 제외) + Chrome 화면 검증.**
"문서만"은 PRD 작성 세션에 한정됐던 과거 제한이며 현재 임무가 아니다(→ §1.1).

## 1. 유저 원문 지시 (verbatim — source mandate, 수정 금지)

아래는 이 작업을 만든 **원 지시 전문**이다. 요약이 아니라 원문이며, 한 글자도 바꾸지 않는다.

```text
여기까지 내용으로 /using-dotprd 로 먼저 정의해주고
해당 내용으로 구현해주고 work-m64빼고 배포해줘

단, 다음은 수정해줘.
1. 유저의 추가 메세지가 그냥 무시되면 안되고 모델의 턴이 끝나면 처리되야하는데

지금 네가 말한 내용은

---
유저: 진행중인거 알려줘?

하네스: Zhou Yu (Beta) VIP AGENT
10:03 AM
진행 중 · 게이트 재실행 대기 (5/6) · 마지막 활동 41초 전 · 중지하려면 헤더의 중지 버튼
---

이게 아니라 이렇게 되야함
---
Zhou Yu (Beta) VIP AGENT
10:03 AM
진행 중 · 게이트 재실행 대기 (5/6) · 마지막 활동 41초 전
Queue
- 진행중인거 알려줘?      [Steering now]
---

이런식으로 유저가 보낸 메세지가 자연스럽게 처리되지 않고 큐에 쌓이는데  Send now로 스티어링을 유저가 선택할 수 있게해줘.

여기까지 구현해줘
```

### 1.1 스코프 이력 (verbatim 보존 — 과거 제한 vs 현재 임무)

PRD 작성 세션의 범위를 좁혔던 지시 (**그 세션에 한정**):

```text
여기까지 .prd로 만들어줘
```

같은 세션의 사용자 확인: "PRD까지만 유지". 그 다음 지시:
"아니 병신아 PRD까지는 작업 끝냈잖아 PRD를 구현하는 goal을 설명해줘 필요한 정보 (링크) 모두 포함해서".

**"문서만"은 작성 세션에만 유효했던 제한이다.** §1 원 지시(구현 + work-m64 제외 배포)는 철회된 적이 없고,
현재 유저 지시로 **활성**이다 — 구현 + 검증 + 프리뷰 배포(work-m64 제외) + Chrome 화면 검증.
작성 세션의 "실행하지 않았다" 문구를 구현 금지 지시로 재사용하지 않는다. §1 원문은 수정 금지로 남는다.

작성 기준 SHA: `7546179677e4dfb671a55f077b0b578693f064e4`. 문서 속 좌표·버전·상태는 리드이지 현재 진실이
아니며, 읽는 세션이 재검증한다(본 개정에서 재검증한 좌표 = §4, §5).

## 2. 목표 화면 (유저가 제시한 정확한 시각 예시)

원 지시의 "이게 아니라 이렇게 되야함" 블록 = 목표 상태:

```
Zhou Yu (Beta) VIP AGENT
10:03 AM
진행 중 · 게이트 재실행 대기 (5/6) · 마지막 활동 41초 전
Queue
- 진행중인거 알려줘?      [Steering now]
```

거부된 현행 동작(원 지시의 "지금 네가 말한 내용은" 블록) = 하네스가 상태 질문에 즉답하고 메시지를
소비하며, 헤더 끝에 `· 중지하려면 헤더의 중지 버튼`을 붙이는 형태. 이 형태는 채택하지 않는다.

- 버튼의 **canonical label = `Send now`**. 위 예시의 `Steering now`는 같은 동작을 가리키는 유저 표기 동의어다.
  구현 시 하나의 액션 ID로 통일하고, 문구는 canonical을 쓴다.
- 상태 줄은 (단계) · (실제 마지막 활동 시각) 구성. 하트비트가 아니라 **실제 진행**에서 파생돼야 한다.

## 3. 계약 (Contract)

### 3.1 Enqueue
- 큐는 **실행 중일 때만** 개입한다. idle 상태에서 온 일반 메시지는 지금처럼 즉시 dispatch되며,
  이때 이미 `paused`인 followup 항목은 그대로 `paused`로 남는다(자동 재개 없음) → A26 / A27.
  "실행 중" 판정의 SSOT는 **새 큐**다. `canStartRequest`(`packages/slack/src/request-coordinator.ts:173-174`)는
  "시작 가능"만 말하므로 보관 보장으로 쓰지 않는다.
- 실행 중 도착한 일반 후속 메시지는 — 상태 질문(`진행중인거 알려줘?`) 포함 — **모두 큐에 들어간다.**
  harness가 대신 답하고 소비해 버리는 경로(answer-and-consume) 금지. 현재 실행 auto-abort 금지.
- 큐 UI 리시트를 올리기 **전에 durable 저장이 먼저** 성립해야 한다(UI가 보이는데 항목이 없는 상태 금지).
- 세션별 FIFO. sequence 번호 + event dedup(같은 Slack 이벤트 재전송은 1개 항목).
- enqueue 시점에 원문 텍스트를 **가공하지 않는다.** goals/auth/cwd/model을 바꾸지 않는다.
- 첨부(files)는 처리 시점까지 보존한다.
- capacity는 설정값이며 **기본 100**. 읽기는 `SOMA_FOLLOWUP_QUEUE_CAPACITY` 타입드 accessor 1곳뿐
  (`rules/config.md:8` 타입드 getter 1회 선언, `:12` `SOMA_` 프리픽스). 도메인 코드의 `process.env` 직접 읽기 금지.
  초과 시 **명시적 거절**(사용자에게 보이는 거절), 조용한 폐기 금지.
  기본값 100은 실측 근거 없는 **되돌릴 수 있는 선택**이다(→ §8 R1).

### 3.2 Drain 경계 (언제 처리하나)
- 경계 = **현재 모델 턴의 완결 + 정리(cleanup)가 끝난 직후, autogoal 연속 실행보다 먼저.**
  - adapter가 자신의 continuation 체인을 양보(yield)한다.
  - coordinator가 기존 슬롯을 CAS로 해제한다.
  - 항목 1개를 atomic claim 하고 **새 user dispatch로 시작**한다
    (원 author/text/files/context 보존, `isUserInput` 유지).
- 경계가 **아닌 것**: `tool_result` 경계, "goal 전체가 무기한 끝날 때까지".
- Security ASK 대기 / stop / error 상태에서는 drain을 **일시정지**한다.

### 3.3 Send now
- 선택한 **그 항목 하나만** 앞당긴다.
- baseline 동작: 항목을 **abort보다 먼저 `reserved`로 예약**한 뒤 → 현재 실행을 **명시적으로 interrupt →
  teardown 완료를 기다린 뒤 → 같은 컨텍스트에서 새 user dispatch**(예약분 승격, 재claim 없음).
  SDK 실행 중 라이브 주입(live injection)이 가능하다고 **주장하지 않는다**(미검증).
- 중단으로 끊긴 부분 출력은 **삭제하지 않고 `user-interrupted` 태그로 보존**한다. error로 표기하지 않으며,
  stale 휴리스틱 결과와 무관하게 이 라벨을 유지한다.
- 나머지 항목은 FIFO 순서를 유지한다.
- drain과의 경쟁 / 더블클릭: **승자 1개**. stale epoch 요청은 거절.
  - (설명 — 새 요구가 아니라 위 한 줄의 계약을 푼 것) **epoch = 세션의 턴 세대 카운터.** 버튼 페이로드와
    예약 항목에 함께 찍히고, 새 dispatch가 시작될 때 증가한다. 클릭 epoch 가 현재 epoch 과 다르면 stale =
    거절이며, 거절은 항목을 **소비하지 않는다**(큐에 그대로 남는다).
  - 같은 epoch 비교가 **표면 쓰기에도 적용된다**: 끝나가는 옛 턴의 지연 쓰기(late write)는 새 턴의 상태 줄·
    표면을 덮어쓰지 못하고 자기 위치(옛 턴 블록)에만 남는다(A28). A12의 "승자 1개"와 **같은 epoch 값**을 쓴다.
- **원 작성자 보존**: 큐 항목은 다른 사람이 쓴 메시지일 수 있다. dispatch는 항상 **enqueue 시점의
  author/text/files/context 그대로** 실행한다. `Send now`를 누른 사람은 **인가 주체일 뿐**이며
  작성자를 대체하지 않고, 어떤 필드도 클릭자 값으로 다시 쓰지 않는다.

### 3.4 권한
- enqueue = 기존 메시지 제출 권한으로 충분. 열람은 같은 스레드 ACL — **새 가시성 생성 없음.**
- Send now = 클릭 시점에 기존 `canInterrupt` 확인 + dispatch 시점에 실행 권한 확인.
  거부되면 항목은 **큐에 남는다**(소실 금지).

### 3.5 소유·저장·복구
- 큐는 `@soma/slack` 패키지가 소유하는 서비스로 두고, 루트 adapter에 **주입**한다(전역 싱글톤 금지).
- 저장 경로는 common의 env 경로 규약을 따르고, 쓰기는 **검증된 atomic temp+rename 패턴을 재사용**한다
  (실측 근거: `packages/process-shared/src/mcp-tool-grant-store.ts:121`).
  `rules/config.md`가 이름을 부르는 공용 헬퍼(`atomicWriteJson`)는 **현재 저장소에 구현이 확인되지 않았다**
  (기준 SHA에서 `rg atomicWriteJson --type ts` 매치 0). 따라서 이는 **목표(target) 헬퍼 이름**이며,
  없으면 규칙에 맞춰 신설한다 — 기존 API로 취급하지 않는다.
  현재 U2a에서 `packages/common/src/atomic-json.ts`(`atomicWriteJson:91`, `readJsonWithBackup:200`)가
  **작성 중**이다 — 미커밋·게이트 미실행이므로 완성된 의존성으로 인용하지 않는다.
- **로드 실패를 조용히 빈 큐로 떨어뜨리지 않는다** (`rules/config.md:11`, `:37`): `JSON.parse` 실패는
  최소 WARN 로그 + `.bak` 폴백. 폴백까지 실패하면 큐를 "비어 있음"으로 렌더하지 않고 **degraded로 표시**한다
  (빈 큐 렌더 = 유저에게는 "내 메시지 사라짐"과 구분 불가).
- 상태: `queued` / `reserved` / `claimed` / `dispatched` / `resolved` / `failed` / `uncertain` / `paused` / `cancelled`.
  - `reserved` = `Send now`가 **abort보다 먼저** 잡아 둔 명시적 예약. 아직 dispatch 시작 전이며 부작용이 없다.
    05 §2/§4의 reserve-before-abort를 상태 기계에 드러내기 위한 분리다(→ §8 R2).
  - 예약/claim **롤백은 같은 seq로 `queued` 복귀** — FIFO 순서 불변, seq 재발급 없음(→ §8 R5).
- 재시작 시:
  - `queued` → 복원하되 **paused**, 유저 resume 전까지 자동 dispatch 금지.
  - `reserved` → **paused**. 예약은 dispatch가 아니다(**아직 디스패치되지 않았다**) — 블라인드 승격 금지.
  - `claimed` / `dispatched` → `uncertain`으로 표시. **블라인드 재실행 금지**(부작용 발생 여부 불명, → §8 R6).
  - 확인된 `failed` → 명시적 retry만.
- stop, 세션 종료 = 큐를 freeze + 사유를 화면에 표시. 유저의 **명시적 resume** 전까지 자동 dispatch 없음.
  이때 항목은 재생(replay)되지 않고 상태로 확정된다(= A31이 정본이고 A17은 이 분기를 가리킨다):
  - `reserved` 항목, 그리고 `claimed`이지만 **아직 시작되지 않은** 항목 → `paused`.
  - **실행 중이었다가 중단된**(`dispatched`) 항목 → `uncertain`. 결과가 확인된 경우에만 `resolved`/`failed`로 확정.
  - 그 외 `queued` 항목 전부 → `paused`.
  - "stop이면 전부 paused"로 뭉뚱그리지 않는다 — 실행 중이던 항목을 paused로 적으면 거짓말이 된다.
- 세션 삭제 = **terminal이 아닌 모든 상태**(`queued`/`reserved`/`claimed`/`dispatched`/`paused`/`uncertain`)의
  항목을 **보이게 취소**(`cancelled`)하고 히스토리를 남긴다.
- 권한 거부는 `paused`가 아니다: 항목은 `queued`로 잔류 + 거부 사유 표시. paused는 유저의 명시적 resume으로만
  풀린다(A29 — 두 상태를 같은 문구로 표시하지 않는다).

### 3.6 GoalQueue와의 관계
- 기존 GoalQueue는 별도 레이블 `Goals`로 유지. 두 큐를 합치지 않는다.
- 우선순위: 다음 안전 경계에서 **followup 큐가 먼저**, 그 다음 autogoal.
  레벨을 가로지르는 암묵적 FIFO를 만들지 않는다.
- 귀결을 명시한다: 사람의 후속 메시지가 계속 들어오면 **autogoal은 설계상 계속 밀린다.**
  이는 의도된 동작이며 공정성(fairness) 보장이 아니다. 유저 FIFO를 바꾸는 bounded-fairness 류 장치를
  **지어내지 않는다.**

## 4. 검증된 사실 (SHA `7546179677e4dfb671a55f077b0b578693f064e4`)

경로는 basename이 아니라 **repo-root 상대 실경로**로 적는다. 같은 basename이 `src/slack/…`에도 존재하는
이중 출처 구간이 있으므로(패키지 추출 진행 중), 아래 라인 근거는 `packages/slack/src/…` 기준이다.

| 위치 | 사실 |
|---|---|
| `packages/slack/src/pipeline/session-initializer.ts:1368-1401` | `canInterrupt`이면 supersede/stall-timeout으로 abort, 아니면 로그만 남기고 **그래도** setController/updateInitiator 진행. "조용한 drop"이 아니다. |
| `packages/slack/src/pipeline/session-initializer.ts:203` | stale 임계값 90초. |
| `packages/slack/src/request-coordinator.ts:80-85` | map overwrite (start path). |
| `packages/slack/src/request-coordinator.ts:121-134` | `expectedController` CAS — 정리(cleanup) 단계. |
| `packages/slack/src/request-coordinator.ts:151-158` | abort 경로. |
| `packages/slack/src/request-coordinator.ts:173-174` | `canStartRequest` true — **실제 큐 보장 아님.** |
| `src/agent-session/v1-query-adapter.ts:119-158` | continuation 루프. |
| `src/agent-session/v1-query-adapter.ts:166-195` | `isUserInput`은 최초 dispatch에만. |
| `src/slack-handler.ts:693-713` | goalQueue는 별개 경로. |
| `packages/slack/src/pipeline/stream-executor.ts:2497` | `finally`에서 `endTurn('completed')` — 업무적 성공 증거 아님. |
| `packages/slack/src/turn-surface.ts:341` | 리터럴 `is thinking...` (말줄임표 포함). |
| `packages/slack/src/stream-processor.ts:348` | idle 기본 2h. |
| `packages/slack/src/mcp-status-tracker.ts:176` | cleanup이 in-memory. |
| `.github/workflows/deploy.yml:40-71` ("Resolve deploy targets") | `:49`가 채널에 따라 `PRODUCTION_DEPLOY_TARGETS`(deploy/prod) 또는 `PREVIEW_DEPLOY_TARGETS`(그 외)를 고르고, `:53-71`이 그 변수의 **모든** 줄(`{runner-label}:{target-dir}`)을 matrix로 확장한다. **필터 없음**, 0건이면 error exit. |
| `.github/workflows/deploy.yml:117-127` | deploy job은 `matrix.runner_label`을 self-hosted 라벨로 그대로 사용. |
| `rg -n 'work-m64'` (repo, `.prd` 제외) | 매치 **0** — 토폴로지는 repo 밖 Actions variables에 있어 canonical alias를 in-repo 증거로 해결할 수 없다. |
| `rules/config.md:11`, `:37` | 로드 실패 시 WARN 로그 + `.bak` 폴백 의무(조용한 빈값 금지). |
| `rules/config.md:8`, `:12` | 새 env는 설정 모듈의 타입드 getter 1회 선언 + `SOMA_` 프리픽스. |
| `packages/process-shared/src/mcp-tool-grant-store.ts:121` | 검증된 atomic temp+rename 저장 패턴(재사용 대상). |

`thread-surface` 등 그 외 표면은 이전 조사 대상이었을 뿐, 여기서 root cause를 확정하지 않는다(미검증 주장 금지).

## 5. 배포 안전 (현재 임무 — 프리뷰 채널 한정)

- **"work-m64 제외"는 아직 구현돼 있지 않다.** 워크플로에 target 필터가 없다(§4 `deploy.yml:40-71`).
  구현됐다고 주장하지 않는다.
- 성립 조건(순서대로):
  1. `PREVIEW_DEPLOY_TARGETS`(및 대조용 `PRODUCTION_DEPLOY_TARGETS`)를 **읽기 전용**으로 열거.
  2. 각 줄의 `{runner-label}`을 실제 host alias와 대조해 **work-m64의 canonical 이름 + alias 전수**를 확정.
  3. 프리뷰 한정 per-run allowlist 메커니즘을 확정.
- 3)이 **워크플로 파일이나 repo variable 변경을 요구하면 별도 리뷰·승인 대상**이다 — 배포 토폴로지 변경은
  이 임무 밖의 다른 배포 채널에도 영향을 준다(→ §8 R7).
- 미상 target이 하나라도 남으면 **fail closed**: 무필터 `main:deploy/dev` push 금지.
- prod 채널(`deploy/prod`)은 이 임무 밖 — 유저 게이트 유지.

## 6. 참고 자료 상태
- `http://localhost:8763/slack-agent-ui-mockup.html` — **과거에 만든 제안(proposal) 문서이지 실제 화면 캡처가 아니다.**
  Queue / `Send now` 반영 전이며, 본 문서와 충돌하는 부분은 철회됨.
- 실제 화면 근거 = 과거 Chrome 스크린샷뿐. **현재 임무에는 배포 후 Chrome 화면 검증이 포함된다**(loop.md 절차 5).
- 외부 정적 문서 3건과 채택 게이트는 04 §4.3에 모아 둔다 — 모두 capability 검증 전(A35).
- 현재 `package.json:53-54` = `@slack/bolt` 4.7.0, `@slack/web-api` ^7.15.1(디스크 실측 동일, `@slack/types` 2.20.1).
  **task/plan 타입은 이미 설치본에 있다** — `@slack/types/dist/chunk.d.ts:22,:30`(plan_update·task_update),
  `block-kit/blocks.d.ts:21,:305,:339`(TaskCardBlock·PlanBlock), `web-api/dist/types/request/chat.d.ts:198`
  (`task_display_mode`). 없는 것은 **agent session lifecycle**뿐(`web-api/dist/methods.d.ts`에 `agents` 매치 0).
  따라서 업그레이드는 Agent Sessions 채택 시에만 게이트다. **타입 존재 ≠ 렌더 — live 채택은 전부 NOT TESTED.**
- `agent_view`는 비가역 성격이라 **별도 승인** 대상이며, 원 배포 요청에 포함돼 있었더라도 본 범위에 넣지 않는다.

## 7. 리뷰 상태
이원 리뷰에서 나온 핵심 지적(안전한 턴 경계, drain 전 슬롯 해제, durable 큐, 배포 target 선택)은
위 계약에 반영했다. **기아(starvation) 방지는 주장하지 않는다** — §3.6대로 autogoal이 밀리는 것은
의도된 결과다. **최종 리뷰 승인은 받지 않았다.** 제품 게이트는 전부 미실행(loop.md §게이트).

## 8. Tensions / Rulings (되돌릴 수 있는 결정과 그 비용)

| # | 긴장 | 판정 (reversible) | 비용 / 되돌리는 법 |
|---|---|---|---|
| R1 | capacity 기본값에 실측 근거가 없다 | 기본 **100**, `SOMA_FOLLOWUP_QUEUE_CAPACITY`로 조정 | 근거 없는 숫자. env 한 줄로 변경 가능, 재컴파일 불필요 |
| R2 | reserve-before-abort(05 §2)가 상태 enum에 없었다 | `reserved`를 **명시 상태**로 추가 | 저장 스키마·UI 문구 1종 증가. 롤백하면 reserved가 claimed에 흡수돼 "예약만 됨"이 관측 불가해진다 |
| R3 | 재시작 시 `reserved` 처리: paused냐 uncertain이냐 | **paused** — 예약은 dispatch가 아니라 부작용이 없다 | 유저 resume 1회 필요. `claimed`/`dispatched`는 원안대로 `uncertain` 유지 |
| R4 | stop 시 A17의 "전부 paused" vs A31의 분기 | **A31 분기가 정본**, A17은 A31을 참조 | 문구 2곳 동기화 부담. 합치면 실행 중이던 항목을 paused로 오기재한다 |
| R5 | 예약/claim 롤백 시 seq 재발급 | **같은 seq로 `queued` 복귀** (FIFO 불변) | seq는 dedup 키와 분리돼야 한다. 재발급하면 나중 항목이 앞선다 |
| R6 | 크래시 후 `claimed` 판정 | **원안 유지 = `uncertain`** (부작용 여부 불명) | 사람 확인 1회. paused로 낙관하면 중복 실행 위험 |
| R7 | work-m64 제외를 워크플로 수정으로 풀 것인가 | 이번 임무에선 **미결** — 읽기 전용 열거가 먼저, 변경은 별도 승인 | 승인 왕복 1회. 무단 변경은 다른 채널 배포까지 바꾼다 |
