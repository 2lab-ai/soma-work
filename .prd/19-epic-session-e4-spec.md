# 19 — 에픽 세션 · 자식 세션 (E4): 계획 트리 · 자식 만들기 · 진행 이벤트 · 에픽 레인

Status: 확정 R3 (trinity R3 grok·fable 만장일치 APPROVE; 비차단 P3 반영) · Date: 2026-11-01 · 기준 main `43cbc1da` · 프로그램: 에픽 세션 · 자식 세션 (#594)
선행: MVP-A0(.prd/17) 슬랙 없는 태스크 · E2(.prd/18) 슬랙은 알림 창구. 출시 조건은 .prd/17 §5에서 확정했다.

## 0. 한 줄 정의

대시보드에서 **에픽 태스크**를 만들면, 에픽이 서버에 **계획 트리**(에픽 → 이슈 → 서브이슈)를 쓰고, 노드마다 **자식 태스크**를 만들어 맡깁니다. 자식이 끝나거나 사람 입력이 필요해지면 **정확히 그 에픽**이 깨어나 다음 단계를 진행합니다. 대시보드에는 에픽 레인이 생깁니다: 계획 트리 · 노드별 자식 카드 · 진행도 바.

에픽이 아닌 태스크와 슬랙 세션은 지금 그대로입니다.

읽는 순서:
1. §1 지금 무엇이 막나 (코드 근거)
2. §2 결정
3. §3 MVP 범위와 미루는 것
4. §4 분해
5. §5 시험 목록
6. §6 모르는 것

## 프로그램 지도

```
에픽 세션 프로그램
├─ MVP-A0 #594  슬랙 없는 태스크 (main, dev)
├─ E2   #652  슬랙은 알림 창구 (①–⑦ main, ⑧ #671 · ⑨ #672 승인)
├─ E3        세션 간 포크 질문 (병행, E4의 선행 조건 아님)
└─ E4        에픽 세션 · 자식 세션   ← 이 문서
   ├─ ①  관계 필드 (kind · parentTaskId · planNodeId · childTaskIds) + 색인 + 호스트 전용 생성 — 호출자 없음
   ├─ ②  계획 트리·이벤트 스키마 (plan · epicEvents 정화 = 검증, 노드 상태 계산)
   ├─ ③  트리 실행 슬롯 (A0 소유자 슬롯 옆에 트리 슬롯 · 트리별 시작 창 · 비용 상한)
   ├─ ④a 에픽 호스트 도구 서버 + plan_write · child_status + 새 작업 API kind(유저 플래그 뒤)
   ├─ ④b spawn_child · instruct_child — 여기서 켜짐
   ├─ ⑤  자식 → 부모 진행 이벤트 (결과와 같은 변경 · 재시작 2차 패스)
   ├─ ⑥  부모 깨우기 (턴 시작 저장에서 소비 · 유휴 drain · 부팅 스캔)
   ├─ ⑦  수명 규칙 (done 전까지 아카이브 면제 · 부모 닫기 = 자식 먼저 취소)
   ├─ ⑧  대시보드 서버 (에픽 묶음 · epicState · 진행도)
   ├─ ⑨  대시보드 클라이언트 (에픽 레인 · 계획 트리 · 작성 창 "에픽")
   └─ ⑩  using-epic-tasks 전환 + 회귀 · dev 실측
```

## 1. 지금 무엇이 막나 [CODE]

근거 지도: 세션 폴더 `e4-map.md`(2026-11-01 Explore, a427db93 기준).

### 1.1 태스크 모델

- `createTask`(`src/session-registry.ts:1160-1203`)가 `task:<taskId>`를 엄격 저장하고, 저장이 실패하면 지우고 throw합니다.
- 새 영속 필드 하나를 넣으려면 약 12곳을 고쳐야 합니다: 타입, `SerializedSession`, 저장 필터, 직렬화, 로드·정화, 재시작 보정, 로드 중 아카이브, `ArchivedSession`·`sessionToArchive`, 되살리기, `CreateTaskInput`·런처 입력, 색인, 보드(`e4-map.md` §1.5).
- `sessions.json`은 저장할 때마다 통째로 다시 씁니다(`:2808-3016`). 그래서 부모와 자식의 변경은 엄격 저장 한 번에 함께 커밋할 수 있습니다.
- 아카이브에는 `lastTurnOutcome`이 없습니다. 슬랙 없는 태스크의 아카이브 키는 `task:<taskId>`(`session-registry.ts:2857-2859`)라 `exists(key)`로 있는지만 알 수 있습니다(`src/session-archive.ts:45-217`).
- 결과 커밋의 되돌리기 스냅샷(`previous`, `:743-750`)도 고칠 곳입니다: 결과 경로에 새 필드가 생기면 실패한 저장이 메모리에 그 필드를 남기지 않게 스냅샷에 넣어야 합니다.

### 1.2 실행 상한 — 막는 요소 1

- 컨트롤러는 **소유자당 체인 1개**만 돌립니다(`task-turn-controller.ts:147, 156-161`, 429). 10분에 10번 시작 창도 있습니다(`:143-144`).
- `spawn_child`는 부모 체인이 도는 중에 불립니다. 그래서 지금 규칙으로는 모든 자식 시작이 429입니다.

### 1.3 호스트 도구 — 막는 요소 2

- 태스크 턴에는 model-command·cron·권한 MCP가 붙지 않습니다(`src/mcp-config-builder.ts:171-215, 466-488`; `src/claude-handler.ts:2281-2287`).
- model-command는 stdio 서버라 레지스트리에 닿지 못합니다(ImportGraph 규칙, `verification/LEDGER.md:13`). 응답 문자열을 되돌려 주는 구조라 자식 ID를 동기로 돌려줄 수도 없습니다.
- 같은 프로세스 안 SDK MCP 서버 선례가 있습니다: `permission-prompt`(`mcp-config-builder.ts:296-330`), 인시던트 도구(`src/incident/sdk-options.ts:39-66`). 신원을 클로저에 묶어 두므로, 모델 입력으로는 신원을 바꿀 수 없습니다.
- 정책 훅은 모든 태스크 턴에 걸립니다. 비게이트 `mcp__` 도구는 통과합니다(`tool-policy.ts:273-281`). `tool-policy.ts`는 Lean 모델 대상(T2)이라 고치지 않습니다.

### 1.4 깨우기

- 호스트가 소유자 신원으로 시작하는 길은 이미 있습니다: `controller.start({sessionKey, text, actorUserId: ownerId})`(런처 `task-launcher.ts:191`, E2 입구).
- 그 길의 제약:
  - 턴이 돌고 있으면 409(`:209-211`)
  - 명령 꼴 텍스트는 400(`:200-202`)
  - 텍스트는 사용자 입력으로 실행된다(`:293`)
- 유휴 콜백은 메모리에만 있습니다(`session-registry.ts:1643-1678`). 크론 깨우기는 슬랙 전용이고, 스레드가 안 맞으면 같은 채널의 다른 세션으로 넘어갑니다(`cron-scheduler.ts:337-354`). `wakeFromSleep`도 채널 키입니다(`session-registry.ts:1311`; .prd/17 §5의 `:750`은 claude-handler 래퍼 위치).
- 잠든 태스크는 `beginTaskTurn`이 깨웁니다(`:833`).

### 1.5 자식 종료를 잡을 곳

- `applyTaskTurnOutcome`의 `settle.ends` 분기가 좋습니다(`:759-778`). 체인의 마지막 결과를 엄격 저장하는 곳이라 부모 이벤트를 같은 저장에 쓸 수 있습니다.
- 태스크 알림 리스너는 슬롯이 하나뿐이고 E2 전달기가 씁니다(`:515, 597-612`). `addTaskNotice`는 `originThread`가 없으면 아무 일도 하지 않습니다(`:725-730`). 그래서 자식 이벤트는 새 경로가 필요합니다.

### 1.6 대시보드

- 크론 레인이 본보기입니다: `planCronLane`(`dashboard.ts:15604-15653`), `paintCronLaneCards`(`:8122-8151`), `#cron-lane`(`:5616`).
- `<ui-agent-tree>`와 `<ui-task-plan>`은 이미 로드됩니다(`:4494, 4706`).
- 새 작업 API(`POST /api/dashboard/new-task`, `destination:'task'`, `new-task.ts:342-374`)에는 `kind`가 없습니다.
- `src/conversation/dashboard.ts`는 17,761줄입니다(43cbc1da, D11 재작성 금지, .prd/17).

### 1.7 using-epic-tasks

- 지금 이 스킬은 "오너 페이지 1개(패널 6개) + 주기 예약 + 사건 즉시 갱신"(`reference/epic-drive.md:27-45`)과 "작업자 1 = 워크트리 1 = PR 1"(`:71`)로 일합니다. "HTML"이라는 말은 없지만, 실제로는 html 스킬과 크론으로 그 페이지를 유지합니다.
- 계약 시험이 문구를 고정하고 있고(`using-epic-tasks-drive.test.ts:92-293`), 바꾸면 플러그인 버전을 올려야 합니다.

## 2. 결정 (R1)

| # | 결정 | 근거 |
|---|---|---|
| D1 | **에픽 = `kind: 'epic'`인 슬랙 없는 태스크. 자식 = 일반 태스크 + `parentTaskId` + `planNodeId`.** 부모·자식은 태스크 ID로 가리키고 슬랙 키를 쓰지 않습니다. `kind`는 **호스트만** 정합니다(`createTask({kind})`는 런처의 에픽 생성과 `spawn_child`만 부름 — 모델 입력·대시보드 요청 원문으로는 정하지 못함). 만든 뒤 바꾸지 않습니다. 자식은 `kind: 'epic'`일 수 없습니다(깊이 1). 부모는 자식 ID를 **덧붙이기만 하는 목록** `childTaskIds`로 들고 있어, 자식이 닫히거나 아카이브되어도 셀 수 있습니다(아카이브 조회 없음). 기록자는 `createTask({parentTaskId})` 하나입니다(호출자는 `spawn_child`): 자식을 만드는 **같은 메모리 변경·같은 엄격 저장** 안에서 부모 기록에 덧붙이고, 저장이 throw하면 자식과 부모의 덧붙임을 함께 되돌립니다(`createTask`의 되돌리기 `:1193-1199`를 넓힘). 실패한 생성이 유령 ID를 남기지 않습니다. 상한 검사는 덧붙이기 전 길이로 하고, 목록은 줄이지 않습니다. | .prd/17 §5, grok P2, fable P2-10 |
| D2 | **계획 트리는 에픽 기록의 필드 `plan`입니다(엄격 저장).** 노드: `id`(에픽 안에서 유일한 짧은 slug, 다시 쓰지 못함), `title`(≤200자), `kind`(`issue`/`sub`), `parent`, `body`(선택, ≤2,000자), `accepted?: {by: 'epic' \| 'owner', at}`. 노드 50개까지. 에픽 수준 `done?: {by, at}`. 쓰기는 검증을 거친 교체입니다: 자식이 붙은 노드는 지울 수 없고, 노드 ID를 다른 노드에 다시 쓸 수 없고, 교체가 노드 ID를 유지하면 `accepted`도 유지됩니다(생략으로 지워지지 않음). 노드 상태는 저장하지 않고 계산합니다(D5). 정화기가 곧 검증기입니다(로드·쓰기 같은 함수). | grok P2, fable P2-12 |
| D3 | **자식 만들기 = 에픽 턴 전용 호스트 도구.** 같은 프로세스 안 SDK MCP 서버 `epic`(`createSdkMcpServer` + `tool()`, 선례 `mcp-config-builder.ts:296-330`). **붙는 조건(코드)**: `executionContext.origin === 'task' && executionContext.kind === 'epic' && !executionContext.parentTaskId`. `kind`·`parentTaskId`는 `executionContextForTask`가 저장 기록에서 읽어 `TaskExecutionContext`에 싣습니다(빌더는 세션을 받지 않음, `:129-133`). `allowedTools`에 `mcp__epic__*`를 넣습니다(`legacy` 모드의 태스크 턴에는 권한 프롬프트 서버가 없음, `:205-207, 466-488`). 핸들러가 쓰는 호스트(레지스트리·런처·컨트롤러)는 `setEpicHost(...)` 지연 세터로 `index.ts`가 꽂습니다(순환 의존 끊기, `setAgentConfigs` `:122` 선례). **도구 인자에는 신원이 없습니다**(소유자·권한 모드·관리자·taskId 없음 — 인시던트 도구 `sdk-options.ts:14-18`과 같은 원칙). 신원은 턴을 만들 때 클로저에 잡고, 핸들러는 실행할 때마다 부모 기록을 다시 읽습니다. `tool-policy.ts`는 고치지 않습니다(비게이트 `mcp__`는 통과, `:273-281, 342-350`). 깊이 1의 집행은 "자식 턴 구성에 `epic` 서버가 없다"는 구성 단언 시험입니다. | grok P1-5, fable P1-3 |
| D4 | **소유자와 폴더는 호스트가 정합니다.** 자식 소유자 = 부모 `ownerId`. 폴더 `folder?`는 상대 경로만: (a) 생략 → 새 `session_*`(런처의 `createFreshDirectory`), (b) 부모 작업 폴더 안의 하위 경로 → 새 리졸버(부모 실경로 안 포함, `..`·심볼릭 링크로 밖 금지) → `taskDirectoryFor`. 런처의 "이름" 규칙(`task-launcher.ts:146-157`)은 재사용하지 않습니다. **겹침 거절**: 실행 중인 형제 자식의 폴더와 실경로가 같거나 어느 한쪽이 다른 쪽의 **경로 세그먼트** 접두사(`startsWith(`${x}/`)`, `task-launcher.ts:104` — `session_1`과 `session_10`은 겹치지 않음)면 거절합니다. `spawn_child`와 `instruct_child`(유휴 형제를 다시 돌릴 때) 둘 다 시작 전에 검사합니다. 노드 하나에는 라이브 자식 하나입니다. 권한 모드·관리자 여부는 부모 소유자의 것이고 도구 인자로 못 바꿉니다. | .prd/17 §5, grok P2, fable P2-15 |
| D5 | **진행도는 서버가 기록한 자식 상태로 계산합니다.** 노드 상태 = 그 노드의 라이브 자식 상태: `none`(자식 없음) · `running`(`working`) · `needs-input`(결과 `waiting`, 또는 열린 승인 이벤트가 있음) · `finished`(체인 결과 `completed`) · `failed` · `cancelled` · `interrupted` · `closed`(자식이 닫힘). 결과 enum은 `completed \| failed \| cancelled \| waiting \| interrupted`(`task-turn-outcome.ts:14`)이고 위 표가 유일한 대응입니다. `finished`는 "이번 실행이 문제없이 끝남"이지 승인이 아닙니다. **받아들임(`accepted`)은 에픽 도구 `plan_write`만** 표시하고(`by: 'epic'`), 자식은 못 합니다(자식에는 `epic` 서버가 없음). 소유자 클릭은 MVP 밖이고, `by` 필드 덕에 나중에 스키마 변경 없이 얹습니다. 진행도 바 = `accepted`/전체 + 상태 분포. 자식이 쓴 "완료" 문장은 정보입니다. | .prd/17 §5, grok P1-1·P1-2, fable P2-12 |
| D6 | **자식 → 부모 이벤트는 자식 결과와 같은 메모리 변경으로 부모 기록 `epicEvents`에 붙습니다.** 자리: `applyTaskTurnOutcome`의 `settle.ends` 분기(`session-registry.ts:759-778`). 같은 변경이므로: 엄격 저장이 성공하면 둘이 함께 영속, throw로 되돌리면 둘이 함께 되돌림(`previous` 스냅샷에 부모 `epicEvents` 포함, `:743-750`), 저장이 모두 실패해 결과를 메모리에 보관(`holdUnsaved`, `:711-718`)하면 이벤트도 함께 보관되고 다음에 성공하는 아무 저장(깨우기의 턴 시작 저장 포함)이 둘을 같이 싣습니다. 이벤트 ID = `자식 taskId + 체인 ID`(결정적). 이벤트 필드: 자식 ID·노드 ID·결과 enum·체인 ID·턴 ID·시각·상태(`pending`/`delivered`)·`consumedBy?`(소비한 **부모 체인 ID**). **본문·`reason`·질문 문구·제목은 넣지 않습니다**(throw 메시지가 그대로 들어가는 필드라 주입 경로, `task-turn-runner.ts:293-296`). 이 밖의 생산자: (a) **재시작 보정** — 로드 루프에서 `interrupted`로 보정한 자식을 모아 두고 **루프 뒤 2차 패스**에서 부모 이벤트를 붙인 다음 로드 후 저장에 싣습니다(파일에서 자식이 부모보다 앞일 수 있음, `:3503-3537`). 이미 메모리에 보관됐다 사라진 이벤트와 ID가 같아 하나로 합쳐집니다. (b) **대화 생성 실패** — runner가 체인 정보 없이 실패를 커밋하던 곳(`task-turn-runner.ts:240-244`)에 `input.chain`을 넘겨 체인 끝으로 만듭니다(E2 알림의 같은 구멍도 닫힘). (c) **승인 대기** — 자식의 승인 요청은 체인 끝이 아니므로 태스크 승인자의 사건에서 `needs-input` 이벤트를 엄격 저장으로 붙입니다(쓰기 실패해도 승인은 진행, 로그만). 승인 리스너는 단일 슬롯(`claude-handler.ts:812-816`)이고 E2 전달기가 쥐므로(`index.ts:1248`) 교체하지 않고 `index.ts`에서 둘을 함께 부르는 하나의 리스너로 **합성**합니다. 같은 `approvalId`의 `resolved` 사건(또는 그 체인의 끝)이 그 `needs-input`을 닫습니다. 노드 상태 우선순위: 자식이 `working`이 아닐 때는 체인 결과, `working`이면 열린 승인 > `working`. 이 이벤트는 **부모를 깨우지 않습니다**(승인은 대시보드 전용, 부모가 할 일이 없음 — 진행도에만 반영). (d) **자식 닫기** — ⑦의 닫기 처리에서 `closed` 이벤트(깨우지 않음). 부모가 없거나 닫혔으면 버리고 로그를 남깁니다. `epicEvents`는 에픽당 100개까지이고, 넘으면 `delivered`부터 지우고 그래도 넘으면 자식별 최신 하나로 합칩니다. | .prd/17 §5, grok P0-2·P1-1, fable P1-4·P1-6·P2-7·P2-8·P2-14 |
| D7 | **부모 깨우기 = 영속 대기열 drain, 소비 표시는 부모 턴 시작과 같은 저장.** `beginTaskTurn(sessionKey, turnId, chainId, consume?: {epicEventIds})`가 체인의 첫 턴 시작과 함께 그 이벤트들을 `delivered` + `consumedBy = chainId`로 같은 엄격 저장에 쓰고, 저장이 실패하면 함께 되돌립니다(`:813-851`의 `previous`에 `epicEvents`). 그래서: 시작이 거절되면(409/429/503) 이벤트는 `pending` 그대로, 시작 저장 뒤 크래시하면 이벤트는 이미 소비됨. 단, **재시작 보정이 깨우기 체인을 `interrupted`로 만들면 `consumedBy === session.openChain`인 이벤트를 `pending`으로 되돌려** 다음 부팅 스캔이 다시 깨웁니다(이벤트가 처리되지 않은 채 사라지지 않음). 키가 턴이 아니라 체인인 이유: 홉마다 턴 ID가 새로 나고(`task-turn-runner.ts:225, 252`), 압축 홉 커밋 뒤 재실행 전에 죽으면 `activeTaskTurnId`가 비어 보정 턴이 `restart:<now>`가 됩니다(`session-registry.ts:754, 3512`) — 보정이 쥔 것은 `openChain`(`:3522`)입니다. 이 규칙으로 깨우기는 **최소 한 번**입니다: 커밋 전에 끊긴 깨우기는 다시 옵니다(자식 생성은 멱등이라 안전). 깨우기 턴이 홉 예산을 다 써서 끝나도 이벤트는 `delivered` 그대로입니다(같은 이벤트로 자동 재깨우기 없음). **계기**: (1) 부모 체인 종료 뒤 유휴 — 운영 호출자가 없는 단일 슬롯 `onIdleAfterDrainHook`(`:535-542`)을 E4가 씁니다(크론의 `registerOnIdle`과 분리), (2) 이벤트가 붙은 직후, (3) 부팅 스캔(웹 서버 기동 뒤). drain은 커밋 경로 밖(`queueMicrotask`)에서 돌아 `applyTaskTurnOutcome` 안에서 컨트롤러가 재진입하지 않습니다. 계기 둘이 겹쳐도 `admit`이 첫 await 전에 `chains`를 채우므로 한쪽은 409이고 그 쪽 이벤트는 `pending`으로 남아 다음 drain이 봅니다(`task-turn-controller.ts:226-258`). drain은 깨우는 이벤트(`needs-input`의 승인 사건·`closed` 제외)가 `pending`이고 부모가 라이브·유휴·`!done`일 때만 시작합니다. **텍스트는 고정 템플릿**이고 ID·노드 ID·결과 enum·개수만 씁니다: `Epic wake: 3 events — node-a:finished, node-b:failed, node-c:needs-input. Read details with child_status.` 제목·질문·reason·`final` 없음. `/`·`%`로 시작하지 않습니다(`:200-202`). 상세는 `child_status`(도구 결과 — 신뢰하지 않는 입력이지만 새 사용자 턴이 아님). 크론 깨우기와 `wakeFromSleep`은 쓰지 않습니다. | .prd/17 §5, grok P0-3·P1-6·P3, fable P0-1·P1-4·P2-9 |
| D8 | **부모 → 자식: `instruct_child(childId, instruction)`, 읽기: `child_status(childId?)`.** 지시는 대시보드 지시 경로(`controller.start`)를 부모 소유자 신원으로 재사용합니다. 지시는 평문이고, `/`·`%`로 시작하면 도구가 이유를 붙여 거절합니다(컨트롤러의 400을 숨기지 않음). 자식이 도는 중이면 409를 그대로 돌려줍니다(대기열 없음, MVP). 자식이 질문을 기다릴 때(`waiting`) 지시하면 **그 질문을 대체합니다**(`:232-243`) — 부모가 자식의 질문에 답하는 길입니다. `child_status()` 인자 없음 = 계획 트리 + 노드별 상태 + `accepted` + 각 자식의 결과 enum. `child_status(childId)` = 그 자식의 상태와 마지막 `final` 발췌(작업 로그, E2 D8과 같은 읽기). 계획은 시스템 프롬프트에 넣지 않습니다(캐시, `build-stream-options.ts:779-812`). 포크 질문은 E3입니다. | briefing, grok P1-4·P2, fable P2-11·P2-14 |
| D9 | **상한.** (a) 에픽당 자식 7개 — `childTaskIds` 길이(닫히거나 아카이브된 자식 포함, 제품 정책). 같은 노드에 라이브 자식이 있으면 `spawn_child`는 새로 만들지 않고 그 ID를 돌려줍니다(멱등 키 `(parentTaskId, planNodeId)`). 그 노드의 자식이 닫힌 뒤 다시 만들면 새 자식이고 7개에 셉니다. (b) 깊이 1(자식 턴에 `epic` 서버 없음). (c) **트리 슬롯** — A0의 `ownerChain`(일반 태스크 1개)은 바이트 단위로 그대로 두고, 그 옆에 `ownerTree: Map<ownerId, {root: sessionKey, running: Set<sessionKey>}>`를 둡니다. 소유자는 일반 태스크 1개와 에픽 트리 1개를 동시에 돌릴 수 있습니다. 표는 아래 §2.1. (d) **트리별 시작 창** — 트리 안 시작(자식 생성·지시·깨우기)의 호출자는 모델과 호스트이므로 A0 창(10분 10번)에서 빼되, 트리마다 10분 30번 창을 둡니다. (e) **비용 상한** — 트리 누적 비용(부모 + 모든 자식 `taskUsage` + 진행 중 사용량, `tokenUsageOf` `dashboard.ts:1975-2017`의 식)이 상한(유저 설정 `epicCostLimitUsd`, 기본 50)을 넘으면 `spawn_child`·`instruct_child`·자동 깨우기를 거절하고 카드에 표시합니다. 소유자의 수동 지시는 막지 않고, 그 턴 시작이 대기 이벤트를 함께 소비합니다(D7의 `consume`) — 막다른 길 없음. | .prd/17 §5, grok P0-1, fable P1-2·P1-5 |
| D10 | **수명.** (a) **면제** — 에픽이 라이브 ∧ (`!done` ∨ 실행·대기 중인 자식이 있음)인 동안 에픽과 자식은 잠들어도 아카이브하지 않습니다(sweep `:2619-2621`, 로드 중 아카이브 `:3155-3162` 둘 다, 별표와 같은 자리). `done` = 노드가 1개 이상이고 모두 `accepted`(계산), 또는 `plan_write({done: true})`. 빈 계획은 `done`이 아닙니다. 실행·대기(`working`/`waiting`) 중인 자식이 있으면 `plan_write({done: true})`는 거절합니다. `plan_write({done: false})`로 되돌릴 수 있습니다(면제가 다시 켜짐). `done` 뒤와 에픽이 닫힌 뒤에는 트리 전체가 일반 시계를 따릅니다. (b) **부모 닫기** — 대시보드 닫기 경로(`POST /api/dashboard/session/:key/close` → 닫기 핸들러. E2 #672가 `src/task-turn/task-close.ts`로 뽑아 둠 — ⑦은 #672 머지 뒤)에서: 실행 중인 자식마다 먼저 자식 기록에 `closedBy: {by: 'parent', at}`를 **즉시 엄격 저장**으로 적고, 그다음 `controller.close(child)`를 부릅니다(abort 사유는 기존 `session-close` 그대로 → 결과 `cancelled`). 새 abort 사유는 만들지 않습니다 — 새 사유는 `RequestAbortReason`·`STOP_CLASS_ABORT_REASONS`·`KNOWN_ABORT_REASONS`·`QUIET_ABORT_REASONS`·`decide()`·`abandonOutcome` 여섯 곳을 지나야 하고(하나라도 빠지면 홉 중간 abort가 `interrupted`가 됨), `packages/slack`을 건드립니다. 카드와 진행도는 `closedBy`로 "부모가 닫음"을 그립니다(결과 enum은 `cancelled`). 그다음 부모를 닫습니다. 자식 abort가 `closeWaitMs`(60초) 안에 안 끝나면 슬롯은 풀리고 카드는 재시작 보정까지 `working`으로 남습니다(사실대로 표시). 자식 카드는 지우지 않고 `parentTaskId`를 유지하며 일반 시계를 따릅니다. 닫힌 부모는 깨우지 않습니다(drain이 거절). 연쇄 삭제는 없습니다. `beforeSessionDelete` 슬롯(`slack-handler.ts:960`)은 건드리지 않습니다. (c) **자식 닫기** — 같은 핸들러에서 부모에 `closed` 이벤트를 엄격 저장으로 붙인 뒤 닫습니다. | .prd/17 §5 미정 → 확정, grok P1-3, fable P1-5·P2-13 |
| D11 | **대시보드.** 보드에서 자식 카드는 에픽 묶음 안에만 보입니다(크론 레인처럼 열에서 빠짐). ~~에픽 레인: 에픽 카드마다 계획 트리(`<ui-task-plan>`) · 노드별 자식 카드 · 진행도 바.~~ **2026-11-02 변경(#725, 오너 결정):** 보드 위 전역 에픽 레인은 없앱니다. 자식 카드는 에픽 카드 바로 밑(같은 열, 또는 같은 DONE 날짜 묶음)에 `↳ #노드`를 달고 붙습니다. 계획 트리는 에픽 카드를 열면 보입니다. 진행도는 카드의 steps가 보여 줍니다. 부모 카드 상태는 서버가 계산한 `epicState`(자식 하나라도 돌면 `running`, 열린 질문·승인이 있으면 `needs-input`)입니다 — 부모 자신은 자식이 도는 동안 `idle`이기 때문입니다. 자식 카드를 누르면 A0 카드 그대로입니다. 서버(⑧)와 클라이언트(⑨)는 PR을 나눕니다. | briefing, fable P3-18 |
| D12 | **에픽 만들기.** 새 작업 API(`POST /api/dashboard/new-task`, `destination:'task'`)에 `kind: 'epic'`을 더합니다(서버·런처 입력). ④a에서 들어가되 **유저 플래그 뒤**(E2 `slackTaskEntry`와 같은 패턴, 기본 꺼짐)이므로 ④부터 dev에서 API로 끝까지 돌려볼 수 있습니다. 작성 창의 "에픽" 선택은 ⑨입니다. 슬랙에서 에픽 만들기는 미룹니다. | fable P2-10 |
| D13 | **using-epic-tasks 전환.** 대시보드 에픽 태스크 안에서 돌 때(`epic` 서버가 있을 때)는 "오너 페이지 + 크론 갱신" 대신 `plan_write` → `spawn_child` → 깨우기마다 `child_status` → `instruct_child`/`plan_write(accepted)` → `done`으로 일합니다. 슬랙 세션·로컬에서는 지금 방식을 유지합니다. 계약 시험을 갱신하고 플러그인 버전을 올립니다. | e4-map §6 |
| D14 | **슬랙·공개 범위.** 에픽과 자식은 슬랙을 부르지 않습니다(A0 T9). E2로 슬랙에서 만든 태스크는 에픽이 될 수 없습니다. 깨우기 텍스트·`child_status`에는 자식의 도구 입력·권한 요청 내용이 없고, 자식 `final` 발췌는 같은 소유자에게만 갑니다. | A0, E2 D14 |

### 2.1 실행 슬롯 표 (D9 c·d)

| 시작 | 슬롯 검사 | 시작 창 | 해제 |
|---|---|---|---|
| 일반 태스크 시작·답 | A0 그대로: `ownerChain`(1개, 429) | A0 창(10분 10번) | A0 그대로(`done.finally`, `close` 타임아웃) |
| 에픽 루트 시작(런처의 에픽 생성 · 깨우기 · 소유자 지시 · 답) | 소유자가 **다른** 트리를 쥐고 있으면 429. 같은 트리면 `!chains.has(root)`(아니면 409) | 런처의 에픽 생성은 A0 창, 나머지는 트리 창(10분 30번) | `done.finally`와 `close` 타임아웃 두 곳에서 `running`에 있을 때만 루트 제거, 비었을 때만 `ownerTree` 항목 삭제(늦게 온 `finally`가 새 항목을 지우지 않음, `:261-262`와 같은 방식) |
| 자식 시작(`spawn_child`·`instruct_child`·소유자 지시·답) | 같은 트리의 자식 실행 수 < 3(아니면 429) · 비용 상한(D9 e, 소유자 지시는 예외) | 트리 창 | `done.finally`와 `close` 타임아웃 두 곳에서 `running`에 있을 때만 그 자식 제거, 비었을 때만 항목 삭제(다른 구성원은 건드리지 않음) |
| 모든 시작, 서비스 종료 중 | 503(`stopAccepting`) | — | — |

`canStart(ownerId, text, tree?)`에 트리 인자를 더합니다(런처와 `spawn_child`가 씀). 부모 체인이 끝나도 자식이 돌면 트리 슬롯은 남습니다.

## 3. MVP 범위와 미루는 것

**MVP**: ①–⑩. 에픽 하나가 계획을 쓰고, 자식 최대 7개(동시 3개)를 만들고, 자식이 끝나거나 질문하면 깨어나 다음 노드를 맡기거나 답하고, 모든 노드를 받아들이면 `done`. 대시보드에서 트리·진행도를 봅니다. 재시작에도 관계·이벤트가 살아 있습니다.

**미루는 것**: 자식 대기열 · 포크 질문(E3) · 슬랙에서 에픽 만들기·에픽 결과 슬랙 알림 · 깊이 2 · 에픽 간 의존 · 자식 자동 재시도 · 소유자 `accepted` 클릭 · 비용 상한 관리자 UI.

## 4. 분해 (PR당 테스트 포함 약 500줄, 넘으면 착수 전에 쪼갬)

1. **① 관계 필드.** 스칼라 `kind`·`parentTaskId`·`planNodeId`·`childTaskIds`를 고칠 곳 전부에 넣습니다(타입, `SerializedSession`, 저장 필터, 직렬화, 로드·정화, 로드 중 아카이브, `ArchivedSession`·`sessionToArchive`, 되살리기, `CreateTaskInput`, 보드 카드 필드). 부모 → 자식 색인. 호스트 전용 `createTask({kind, parentTaskId, planNodeId})`. 호출자 없음, 에픽이 아닌 태스크는 바이트 단위로 같음.
2. **② 계획 트리·이벤트 스키마.** `plan`·`epicEvents` 필드와 정화기(= 검증기, D2), `setEpicPlan`, 노드 상태 계산(D5), `done` 계산. 호출자 없음.
3. **③ 트리 실행 슬롯.** §2.1 표, 트리 창, 비용 상한 판정, `canStart` 트리 인자.
4. **④a 에픽 서버 + 읽기·계획 + 에픽 만들기.** `epic` SDK 서버, 붙는 조건(D3), `allowedTools`, `setEpicHost`, `plan_write`·`child_status`, 새 작업 API `kind`(유저 플래그 뒤, D12).
5. **④b 자식 만들기·지시.** `spawn_child`(멱등·7개·폴더 리졸버·겹침, D4·D9 a), `instruct_child`(D8). **여기서 켜집니다.**
6. **⑤ 진행 이벤트.** `settle.ends` 분기·`previous` 스냅샷·`holdUnsaved`, 재시작 2차 패스, 대화 생성 실패의 체인 전달, 승인 사건 → `needs-input`(D6).
7. **⑥ 부모 깨우기.** `beginTaskTurn(..., consume)`, 보정 시 `consumedBy` 되돌리기, 계기 3개, 고정 템플릿(D7).
8. **⑦ 수명 규칙.** `done` 전 면제, 부모·자식 닫기(`closedBy: parent` + 기존 `session-close`), 자식 닫기의 `closed` 이벤트(D10).
9. **⑧ 대시보드 서버.** 에픽 묶음·`epicState`·진행도 전달(D11).
10. **⑨ 대시보드 클라이언트.** 에픽 레인(크론 레인 본보기), 계획 트리, 진행도 바, 작성 창 "에픽".
11. **⑩ 스킬 전환 + 회귀·dev 실측.** D13, 기존 태스크·슬랙 경로 행렬, 재시작 주입, dev 실측.

## 5. 시험 목록

- **①**
  - 새 필드가 저장·재시작·아카이브·되살리기를 거쳐 남는다.
  - 형식이 틀린 값은 버린다.
  - 부모 → 자식 색인은 로드 때 다시 만든다.
  - 에픽이 아닌 태스크는 바이트 단위로 같다.
  - `kind`는 호스트 경로로만 정해진다.
- **②**
  - 노드 50·제목 200·본문 2,000 초과, 중복 ID, 자식 붙은 노드 삭제, ID 재사용은 거절하고 기록은 그대로다.
  - ID를 유지한 교체는 `accepted`를 유지한다.
  - 노드 상태는 D5 표대로만 나온다.
  - 노드가 1개 이상이고 모두 `accepted`면 `done`이다. 빈 계획은 `done`이 아니다.
- **③**
  - 에픽 루트가 돌 때 자식 시작은 허용, 다른 트리는 429, 일반 태스크는 A0대로.
  - 부모 체인이 끝나도 자식이 돌면 트리 슬롯이 유지된다.
  - 4번째 동시 자식은 429.
  - `close` 타임아웃은 그 구성원만 해제한다.
  - 트리 창은 10분 30번.
  - 비용 상한 초과 → 자동 시작 거절, 소유자 지시는 통과.
  - 종료 중이면 503.
  - A0 회귀 행렬은 바뀌지 않는다.
- **④a**
  - `epic` 서버는 에픽 턴에만 있다. 일반 태스크·자식 턴·슬랙 세션의 구성에는 없다(구성 단언).
  - `allowedTools`에 들어 있어 `legacy` 모드에서도 묻지 않는다.
  - `plan_write`·`child_status()` 왕복.
  - 플래그가 꺼져 있으면 새 작업 API `kind:'epic'`은 거절된다.
- **④b**
  - 같은 노드 두 번 → 자식 1개.
  - 생성 중 부모 abort → 재호출이 같은 자식 ID.
  - 8번째 자식 거절.
  - 폴더: 부모 밖·심볼릭 링크·형제 겹침(같음·접두사)은 거절.
  - 인자로 소유자·권한을 바꿀 수 없다.
  - `createTask({parentTaskId})` 저장 실패 → 자식도 `childTaskIds` 덧붙임도 남지 않는다.
  - `instruct_child`: `/`로 시작하면 거절, 실행 중이면 409, 질문 대기 중이면 질문을 대체한다, 실행 중 형제와 폴더가 겹치면 거절한다.
- **⑤**
  - 자식 체인 끝 → 부모 이벤트 1개. 엄격 저장 throw → 둘 다 되돌림.
  - `holdUnsaved` → 둘 다 메모리에 있고 다음 저장이 둘을 함께 싣는다.
  - 압축 홉 중간에는 이벤트가 없다.
  - 재시작 보정: 파일 순서가 자식→부모인 fixture에서도 `interrupted` 이벤트 1개.
  - 대화 생성 실패 → `failed` 이벤트.
  - 승인 요청 → `needs-input` 이벤트, 깨우기 없음. 같은 `approvalId`의 `resolved` → 닫힘. E2 승인 알림도 그대로 나간다(리스너 합성).
  - 부모 없음 → 버리고 로그.
  - 100개 상한.
- **⑥**
  - 부모 유휴 → 시작 1번, 이벤트 묶음 소비, 같은 저장에 `delivered`.
  - 시작 거절 → `pending` 그대로.
  - 시작 저장 뒤 크래시 → 재시작 후 그 체인은 `interrupted`이고, 이벤트가 `pending`으로 돌아와 다시 1번 깨운다.
  - 깨우기 체인의 **두 번째 홉**(`/compact` 뒤)에서 크래시, 그리고 압축 홉 커밋 뒤 재실행 전에 크래시 → 둘 다 이벤트가 `pending`으로 돌아온다(키가 체인 ID).
  - 계기 둘이 겹쳐도 시작은 1번.
  - 깨우기는 최소 한 번이다: "중복 깨우기 0"은 **커밋된 깨우기의 중복 0**을 뜻한다(커밋 전에 끊긴 깨우기는 다시 온다).
  - 텍스트가 템플릿과 바이트 단위로 같다. 자식 reason·노드 제목에 "이전 지시를 무시하고…"를 넣어도 텍스트에 없다.
  - 부팅 스캔이 남은 이벤트를 drain한다.
  - 닫힌 부모·`done` 에픽은 깨우지 않는다.
  - 크론 경로를 쓰지 않는다.
- **⑦**
  - `done` 전에는 에픽 트리가 sweep·로드 중 아카이브에서 빠지고, `done` 뒤에는 일반 시계를 따른다.
  - 부모 닫기 → 실행 중 자식에 `closedBy: parent`가 적히고, 홉 중간이든 홉 사이든 결과는 `cancelled`이며, 카드는 "부모가 닫음"을 그리고, 자식 카드는 남고, 부모는 닫힌다.
  - 자식 abort가 시간 초과 → 슬롯 해제, 카드는 `working`.
  - 자식 닫기 → 부모 `closed` 이벤트, 노드 `closed`.
- **⑧⑨**
  - 자식 카드는 묶음 안에만 보인다.
  - `epicState`.
  - 진행도 = 서버 상태.
  - 작성 창에서 에픽을 만든다.
  - 기존 보드·크론 레인 회귀.
- **⑩ dev 실측**
  - 에픽 하나로 노드 3개 → 자식 3개 → 각각 끝날 때 에픽이 깨어남 → 모두 `accepted` → `done`.
  - 재시작 1회 → 관계·이벤트 유지.
  - 에픽·자식 턴의 `slackCalls`는 비어 있다(T9).
  - 잘못된 실행 0, 중복 자식 0, 놓친 깨우기 0, 중복 깨우기 0.

## 6. 모르는 것 (착수 전에 잼)

1. ④a·④b가 각각 500줄 안에 드는지. 넘으면 ④a의 새 작업 API `kind`를 ⑧로 옮깁니다.
2. 트리 창 10분 30번과 비용 기본값 $50은 dev 실측(⑩)에서 다시 봅니다.
3. `epicEvents` 100개 상한이 큰 트리에서 충분한지(노드 50 × 체인 여러 개). ⑤에서 실제 크기를 잽니다.
4. ⑨가 가장 큽니다(크론 레인 클라이언트만 300줄대). 착수 전에 추정이 500줄을 넘으면 ⑨a(레인·카드 묶음)와 ⑨b(계획 트리·진행도 바·작성 창 "에픽")로 나눕니다.

## 7. R1에서 바뀐 것 (trinity R1 grok·fable)

- **D9 c (grok P0-1, fable P1-2).** "에픽 트리 = 소유자 슬롯 하나"를 버렸습니다. A0 `ownerChain`은 그대로 두고 `ownerTree` 트리 슬롯을 따로 둡니다. 시작 창 면제 대신 트리 창을 둡니다(호출자가 모델이므로 폭주 상한, fable).
- **D7 소비 표시 (grok P0-3, fable P0-1).** `beginTaskTurn(consume)`이 같은 저장에 씁니다. 보정 시 `consumedBy`를 되돌립니다. 고정 템플릿을 씁니다(grok P1-6, fable P1-4).
- **D6 (grok P0-2, fable P1-6·P2-7·P2-8·P2-14).** 결과와 같은 메모리 변경(`holdUnsaved` 포함, `previous` 스냅샷)으로 기록합니다. 재시작 보정은 2차 패스로 합니다. 대화 생성 실패에 체인을 전달합니다. 승인은 기록만 하고 깨우지 않습니다. `reason`은 넣지 않습니다. grok의 "`holdUnsaved`는 붙이지 않음" 안과 fable의 "보관에도 붙임" 안이 갈렸는데, fable 안을 택했습니다. 재시작 없이 나중 저장이 결과를 실으면 grok 안에서는 부모 이벤트가 영영 생기지 않기 때문입니다. 재시작 시에는 보정 이벤트와 ID가 같아 하나가 됩니다.
- **D5·D2 (grok P1-2, fable P2-12).** `accepted`는 에픽 도구만, `by` 기록, 교체에도 유지합니다.
- **D10 (grok P1-3, fable P1-5·P2-13).** `done` 상태, 자식 먼저 `parent-close` 취소, 카드 유지, 닫기 핸들러에서 처리합니다.
- **D3 (grok P1-5, fable P1-3).** 붙는 조건을 코드로, `TaskExecutionContext.kind`, `allowedTools`, `setEpicHost`, 신원 없는 인자.
- **D4·D9 a (grok P2, fable P2-15).** `childTaskIds`, 새 폴더 리졸버, 같음·접두사 겹침.
- **D8 (grok P1-4·P2, fable P2-11·P2-14).** `child_status()`가 트리를 읽습니다. 지시는 평문입니다. 질문 대체를 명시했습니다.
- **분해 (grok P1-4, fable P2-10).** ①을 스칼라와 ②의 구조체로 나누고, ④를 a/b로 나눴습니다. 에픽 만들기 API를 ④a에 넣었습니다(플래그 뒤).
- **R3 (grok·fable APPROVE + P3 반영).** ⑦ 문구 정정, 노드 상태 우선순위 명확화, `closedBy`는 `close` 전에 별도 즉시 엄격 저장(결과 변경의 `previous` 롤백에 얹지 않음).
- **R2 (grok APPROVE + P2 3건, fable P1 2건 + P2 4건 + P3 4건).**
  - `consumedBy`는 체인 ID입니다(fable P1-1: 다홉 깨우기 유실).
  - 부모 닫기는 새 abort 사유 대신 `session-close` + `closedBy: parent`입니다(fable P1-2: 새 사유는 여섯 곳을 지남). grok의 "카드가 스스로 닫힌 것으로 읽힘" 우려는 `closedBy`로 해소합니다.
  - `childTaskIds`는 `createTask` 저장 안에서 기록합니다.
  - 실행 중 자식이 있으면 `done`을 거절하고, 빈 계획은 `done`이 아닙니다.
  - 승인 리스너를 합성하고 `resolved`로 닫습니다.
  - 폴더 겹침은 세그먼트 접두사로 보고, 지시할 때도 검사합니다.
  - 루트 행도 두 곳에서 해제합니다.
  - 깨우기는 최소 한 번이라고 명시했습니다.
  - ⑨는 나눌 조건을 적었습니다.
- **§1 사실 정정 (fable P3-16).** 런처 시작 위치는 `:191`, `dashboard.ts`는 17,761줄, 아카이브 키는 `task:<id>`.
