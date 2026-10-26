# Agent Queue → LLM 가용량 · CRON 레인

Status: Phase A(문서) · 2026-10-26 · 기준 main `ff6c9ac` · 이슈 #444 (에픽 #437) · SSOT [`ssot.md`](ssot.md)
앞선 계약: [`../12-cron-lane-and-llm-capacity-spec.md`](../12-cron-lane-and-llm-capacity-spec.md) T4·T5·T7·T9, §6(v2), §7(단순화 카드)

증거 라벨: **[REF]** = affectui.com/components/agent-queue 페이지·docs 청크·데모 CSS·번들(2026-10-26 판독, Pro 항목 — 코드·CSS 미반입) ·
**[CODE]** = 이 저장소 `file:line`(main `ff6c9ac`) · **[SHIPPED]** = 구현 후 표시.

## 0. 한 줄 정의

레퍼런스는 한 카드로 "일이 얼마나 밀려 있나, 어느 워커가 무엇을 처리하나, 지금 제공자가 막아서 멈췄나, 언제 풀리나"를 답한다.
대시보드에서 이 판단은 두 곳에 나뉜다. **LLM 가용량**에서는 llmux 계정이 워커다: 몇 개를 쓸 수 있고, 어느 계정이 한도에 걸렸고,
언제 돌아오는지를 본다. **CRON 레인**에서는 예약 실행이 대기열이다: 다음에 무엇이 언제 돌고, 지금 몇 개가 돌고, 최근 24시간에 몇 번
돌고 몇 번 실패했는지를 본다. 두 섹션은 제자리를 지키고 레퍼런스의 문법(머리 pill과 카운트다운, 숫자 칸, 워커·대기열 마크,
기록 차트, polite 알림 하나)을 함께 쓴다.

## 1. 레퍼런스 해부 [REF]

![ref](assets/ref-agent-queue.jpg)

### 1.1 구조
```
.ui-agq  트레이(radius 20, pad 4) · container ui-agq/inline-size · data-state = idle|live|paused|limited
├─ head (min-h 44): 마크 · "Queue"(600) · 이름(13px muted, 말줄임) · pill · 도구[Pause 토글 · − N + 스테퍼]
└─ card (radius 16)
   ├─ dl.stats 4칸(칸 사이 1px 선): Waiting · Running r/N · Throughput n/min · Wait p95
   ├─ flow — 폭을 재서 절대 배치, 넓으면 왼쪽→오른쪽
   │   ├─ QUEUE n: 맨 앞 칩 3개(종류 아이콘·이름·기다린 시간) + 12px 칸(16px 간격) 우물 + "+N" · 비면 "Nothing waiting"
   │   ├─ WORKERS r/N: 슬롯(높이 40, 간격 6) = 로고·이름 | 레일(높이 28): 진행만큼 자라는 막대, 비면 "Idle"·"Paused"
   │   ├─ DONE n · FAILED n 칸(폭 92)
   │   └─ 잡 층: 잡마다 button(roving) + 고정 카드(dialog)
   └─ chart "Queue depth": y 격자 0·max, 영역+선, 레이트 리밋 구간 음영, 점선 backpressure + 라벨, 지금 점, 축 "96s ago … now"
└─ .sr  aria-live=polite
```
치수: 큐 열 폭 clamp(폭×0.26, 188, 236), 레일 시작 clamp(슬롯×0.4, 112, 164), 차트 높이 112(좁으면 88), 표본 96개.

### 1.2 상태
| 요소 | 상태 | 바뀌는 것 |
|---|---|---|
| 루트 `data-state` | limited > paused > live > idle | pill `Rate limited · 9s`(호박색 배경·테두리) / `Paused` / `Live`(파랑) / `Idle`. limited·live에서 점이 맥박친다 |
| Waiting 칸 | 깊이 > backpressure | 값이 호박색(`data-kind=warn`). Failed 칸 값은 늘 빨강 |
| 잡 | queued·running·done·failed + halted·flash·high·retry | 칩·칸·막대·사라짐 네 모양. halted = 막대가 멈추고 흐려지며 meta `Paused`. 실패 = 빨강 흔들림(420ms). 재시도 = 배지 + 시도 수 |
| 슬롯 | busy / limited | 빈 레일 `Idle`, 제한·일시정지 `Paused`. 리밋이 걸리면 실행 중 막대가 모두 멈추고 호박색 |
| 차트 | 리밋 구간, 선 넘음 | 리밋 구간은 호박색 7% 음영. 선을 넘으면 알림 |

### 1.3 상호작용 · 키보드
- Tab: 잡 층의 정지점은 하나(roving), 다음 Tab은 카드 버튼. 방향키 4개는 실행 중 잡을 슬롯 순서로 돈 뒤 큐를 앞에서부터 돈다. Home·End는 양끝.
- Enter·Space는 카드를 고정하거나 닫는다. Esc는 닫고 포커스를 잡으로 돌린다. 바깥을 누르면 닫힌다. hover에는 미리보기(`role=tooltip`).
- 고정 카드: 아이콘·이름·종류·세부·상태 pill·닫기 + 2열 dl(Waiting/Waited·Running·Position n of N·Worker·Priority·Attempt) +
  오류 줄 + `Move to front`·`Cancel`. 머리: Pause/Resume(`aria-pressed`), 스테퍼 `One worker less/more`(1–8, `output aria-live`).

### 1.4 모션
- 이징은 cubic-bezier(0.22, 1, 0.36, 1) 하나. 위치·크기 이동 560ms. 새 잡은 떨어진다(translateY(-10px) scale(.6) → 0, 520ms, 순서마다
  22ms, 상한 420ms). high 잡은 맨 뒤에 내린 뒤 520ms 동안 앞으로 미끄러진다. 슬롯은 420ms로 나타난다.
- 막대는 560ms로 자라고, 광택이 1500ms linear로 무한히 지나가며, 앞날이 1100ms로 빛난다. 카드는 200ms(translateY(-4px) scale(.97))로 열린다.
- 끝난 잡은 초록으로 한 박자 쉬고 Done으로 날아간다. 실패는 흔들린 뒤 Failed로 가거나 재시도 배지를 달고 큐로 돌아간다.
- 숫자는 새 값으로 부드럽게 바뀌고 차트 스케일은 미끄러진다(`@property --ui-agq-ymax`). 프레임 루프는 움직일 것이 없거나 화면 밖이면 잔다.
- `prefers-reduced-motion`이면 모든 animation·transition을 끈다.

### 1.5 토큰
- 색 역할: tray·card·ink·muted·line·chip·wash. 종류 4색(llm 보라·tool 청록·agent 슬레이트·human 파랑, 각 bg·edge·ink·sq).
  ok·error·warn(라이트 fg `#b85c00`/bg `#fff3e0`, 다크 `#ffa057`). depth(보라 선 + 16–26% 채움).
- 반경: 트레이 20, 카드 16, 슬롯·빈 12, 잡·우물·레일 8, 버튼 9, pill 999.
- 글자: 기본 14/20, stat dt 12 muted, dd 16/600 tabular, 열 머리 12 + 굵은 수, 잡 이름 12.5, meta 11.5, 빈 수 20/600, 축 11.
- 다크: 조상의 `.dark`·`[data-theme=dark]`가 변수를 통째로 바꾼다.

### 1.6 반응형
- 컨테이너 쿼리와 잰 폭을 같이 쓴다. 600 미만: flow를 쌓는다 — 큐가 위, 워커는 마크만 남고 레일이 자리를 차지하며, Done·Failed는 나란히
  높이 40, 큐 머리에 `+N more`. 560 이하: 숫자 4칸 2×2, 이름 숨김. 440 이하: Pause·스테퍼가 한 줄을 따로 쓴다.

### 1.7 접근성
- 잡은 진짜 button. 접근 이름 = 이름, 종류, 기다린·실행 시간과 %, `position n of N`, priority, attempt. 잡 층은 `role=group`
  "Jobs: r running, n waiting". 고정 카드는 `role=dialog` + 닫기 버튼, Esc는 포커스를 잡으로 돌린다.
- polite 영역 하나: 리밋 시작(`…paused for N seconds`)·해제(`Rate limit lifted – workers resumed`), 실패와 사유, 재시도, backpressure 넘음.
  첫 렌더에서는 알리지 않는다. 차트는 `role=img` + 문장 요약(지금 대기·최고·평균·선·리밋 횟수·실패 누계). pill은 limited일 때만 `role=status`.

### 1.8 데이터 계약 · 파생
- props: `jobs {id,name,kind,status,enqueuedAt,priority?,startedAt?,endedAt?,worker?,progress?,estimate?,attempt?,maxAttempts?,detail?,error?}[]`,
  `workers {id,name,detail?}[]`(개수 = 동시성), `rateLimits {from,until,label?}[]`, `paused`, `backpressure`, `window`(120000),
  `totals {done?,failed?}`, `openId`, `onPromote`/`onCancel`, `onPausedChange`, `onConcurrencyChange`, `min/maxConcurrency`(1/8), `title`/`name`.
- Throughput = 지난 60초에 `endedAt`이 든 done 수(/min). Wait p95 = 지난 60초 시작 잡의 (startedAt − enqueuedAt) ∪ 지금 대기 시간을 정렬한
  `[floor(.95n)]`. Done·Failed = `totals` ?? 목록 개수. 차트 y 최대 = max(최고×1.15, 선×1.2, 4)를 nice 목록으로 올림.
- 시간 표기: 10초 미만 `5.6s`, 60초 미만 `13s`, 그 이상 `1m 05s`. 리밋 카운트다운은 올림 초.

## 2. 변경 전 [CODE]

캡처(저장소 밖, 합성 데이터 — 크론 잡 4개와 실행 기록, llmux 2그룹 7계정 중 막힘 3): `harness/shots-agent-queue/before-{light,dark}-{desk,phone}-{folded,open}-{capacity,cron}.png`, `before-*-drawer.png`.

### 2.1 LLM 가용량
- 서버: `GET /api/dashboard/capacity`(`dashboard.ts:2161`) → `readCapacity`(`:702`, TTL 30초·실패 10초, single-flight) → `buildCapacityView`(`capacity-view.ts:512`).
  `CapacityGroupView`(`:98`) = has5h·total·now·week·binding·excluded·tierAssumed·estimated·unmeasured5h·state ok|low|empty|unknown·oldestRefreshAt·events·units.
  `CapacityUnit`(`:56`) = name·tier·tierAssumed·status·now·week·blocked·held·blocks{weekly,fiveHour,cooldownUntil,scopedUntil}·estimated·unmeasured5h·counted·excluded·binding·returnAt. `CAPACITY_LOW_PCT = 20`(`:35`).
- HTML `#capacity`(`dashboard.ts:6106`) = `.sec-toggle` + `#capacity-view`, 늘 접힌 채 시작(`secIsOpen` `:13183`). 접힌 칩
  `renderCapacitySummary`(`:13825`) = 글리프 + `Claude 지금 0.7/3.3 21% · 주 1.7/3.3 54%` + `⚠` 플래그.
- 펼친 카드 `renderCapacityGroup`(`:13867`): `.cap-pname` → 흐린 공개 줄 `capDisclosure`(`:13729`, 예 `4/4 반영(차단 2 포함)`) → 막대 2개
  `capBarRow`(`:13705`, `x / 합계 계정 %` + `다음 …` `capNextShort` `:13692`) → 7일 타임라인 `capTimeline`(`:13768`, ● 위·◆ 아래, 가까우면 합침).
- 다시 그리기 30초(`:15832`), 불러오기 60초(`:15831`). 카운트다운은 그릴 때 정해지는 문자열(`capDur` `:13673`)이라 최대 30초 멈춰 있다.
- 공백: 어느 계정이 막혔고 언제 돌아오는지가 화면에 없다 — 공개 줄의 개수와 타임라인 마커 `<title>`의 이름 목록뿐이다
  (`CapacityUnit.returnAt`·`blocks`는 서버가 주지만 클라이언트가 읽지 않는다). "모두 막힘"은 테두리 색(`.cap-prov.is-empty` `:5357`)과
  글리프로만 드러나고, 20% 기준선은 보이지 않는다. live region이 없다(`dashboard-responsive.test.ts:593`가 칩의 `aria-live` 없음을 고정).

### 2.2 CRON 레인
- 서버: `GET /api/dashboard/cron`(`dashboard.ts:2134`) → `buildCronJobsView`(`cron-view.ts:101`). `KanbanCronJob`(`:50`) =
  id·name·expression·owner·mode·target·model·nextRunAt·lastRunAt·historyCap(20)·runs. `KanbanCronRun`(`:40`) = executedAt·status
  success|failed|queued·executionPath·triggeredBy·error·session{…, activeMs, tokens, costUsd}.
- HTML `#cron-lane`(`dashboard.ts:6140`) = `.cron-lane-bar`(머리 + `.sec-toggle`) + `#cron-groups`. 서랍 `#cron-drawer`(`:6170`).
- JS: `planCronLane`(`:13273`)이 크론 카드를 칸에서 빼 잡별로 묶는다(응답 대기 > 실행 중 > 최신 > nextRunAt). `renderCronLaneHead`(`:13435`) =
  `CRON n` + `● 실행 중 n` · `▲ 응답 필요 n`. `renderCronTileHead`(`:13411`) = 배지·이름·`지난 실행 N`·스케줄 문장·`다음 HH:MM (14h 12m 후)`
  (그릴 때 고정)·12회 막대(`renderCronStrip` `:13401`)·상태 줄, 그 아래 리드 카드(`cronLaneSlots` `:13490`). 서랍 `openCronDrawer`(`:13553`,
  role=dialog, Esc, 포커스 복귀 `:13565`).
- 공백: 타일이 상태 순이라 "다음에 무엇이 언제 도나"를 한 줄로 볼 수 없다. 레인 전체의 처리량·실패 수와 시간 축 기록이 없다. 카운트다운이 멈춰 있다.

### 2.3 둘 다에 없는 것
일시정지·동시성·우선순위·취소 같은 쓰기 경로(대시보드에 크론·llmux 쓰기 라우트가 없다). 진짜 대기열 데이터 — `FollowupQueue`
(`packages/slack/src/followup-queue.ts:334`)는 대시보드에 노출되지 않는다.

## 3. 차이표

| 레퍼런스 요소 | 현재 | 결정 | 근거(데이터 출처 / 불채택 이유) |
|---|---|---|---|
| 한 카드 = 큐→워커→Done | 두 섹션 | **변형 D1** | 크론 실행과 계정을 잇는 데이터가 없다(사람 세션도 같은 계정을 쓴다). 합치면 거짓 인과를 그린다 |
| 머리 pill + 리밋 카운트다운 | 칩 글리프·테두리 색 | **채택 D2·D8·D14** | `units[].blocked`·`returnAt`, `group.state`, `events`(capNextEvent) |
| 살아 있는 카운트다운 | 30–60초 고정 문자열 | **채택 D3** | 같은 epoch(`returnAt`·`nextRunAt`·`events[].at`)를 1Hz로 다시 센다 |
| polite live region | 없음 | **채택 D4** | 그룹 상태·막힘 수 전이, 새 실패 실행, 새 응답 대기 |
| 숫자 4칸 | 없음 | **CRON 채택 D16** / 가용량 **변형**(막대 2개가 그 자리 — 12 §7) | CRON: `nextRunAt`, plan 개수, `runs[].executedAt·status`. 가용량에는 대기열·요청률이 없다 |
| WORKERS r/N + 슬롯 | 공개 줄의 개수뿐 | **변형 D10** | 계정 = 워커. 사용 가능 = `units[].binding`, 상태 = `blocked`·`held`·`excluded`·`unmeasured5h`. 사용량 막대는 넣지 않는다(12 §7) |
| 멈춘 워커 호박색 + 카운트다운 | 없음 | **채택 D10** | `blocks.*` → 사유 단어, `returnAt` → 카운트다운 |
| 고정 카드(dialog) | 계정 없음 / 잡 = 서랍 | **채택 D11**(계정) · **변형 D20**(잡 = 기존 서랍) | `CapacityUnit` 필드 / `KanbanCronJob`·`runs` |
| roving focus | 없음 | **채택 D12** | 계정 마크·대기열 칩 |
| QUEUE 열(기다린 시간) | 타일 안의 `다음 …` | **변형 D17** | 다음 실행 순서 = `nextRunAt` 오름차순, 기다린 시간 대신 남은 시간 |
| Queue depth 차트 | 가용량 7일 미래 타임라인 | **변형 D19**(CRON 24시간 실행 기록) | `runs[].executedAt·status`. 기록이 잘린 구간은 빗금(리밋 음영 자리) |
| 리밋 구간 음영 | 없음 | **채택 D13**(가용량, 모두 막힘일 때) | 지금 → 첫 `dNow`·`dWeek` > 0 이벤트. 12 T9 v1 "지금→복귀 음영"의 복원 |
| 점선 backpressure 선 | 없음 | **변형 D9**(막대의 20% 점선) | `CAPACITY_LOW_PCT` — 그 아래가 `low`(호박색) |
| 반응형 600·560·440 | JS `is-narrow`(<600) | **채택 D7** | 레인 = 컨테이너 쿼리, 가용량 카드 = 기존 `is-narrow` |
| Throughput /min | — | **변형 D16**(24시간 실행 n) | 잡마다 보관 창이 다르다(15분 잡 5시간, 주간 잡 20주) — 기록 창 위의 "시간당"은 무엇의 비율도 아니다. 고정 24시간 + 잘림 `≥` |
| DONE · FAILED 누계 칸 | 잡별 12회 막대 | **불채택**(D16 칸 3·4가 대신) | 시작 이후 누계가 없다. 잡마다 FIFO 20이라 보관 누계는 20×잡수에서 멈춰 거짓이 된다 |
| Wait p95 | — | **불채택** | LLM 요청의 대기 시각이 없다. 크론은 예정 분과 실행 시각의 차이를 기록하지 않는다. 소요 p95도 잡이 만든 세션에만 있어 표본이 치우친다 |
| 종류 색(llm·tool·agent·human) | — | **불채택** | 잡 종류 데이터가 없다. mode·target은 전달 방식이지 일의 종류가 아니다 |
| 진행 막대 · 광택 · 앞날 | 리드 카드 활성 시간 | **불채택** | 세션은 진행률을 보고하지 않는다. 지난 소요로 추정하면 거짓 진척이 된다 |
| Pause / Resume | — | **불채택** | 큐 일시정지 백엔드가 없다. llmux pause는 운영자 설정이다(에픽: 백엔드 신설 금지) |
| 워커 스테퍼 − N + | — | **불채택** | 계정 수는 llmux 설정이고 대시보드는 읽기 전용이다(#803) |
| Move to front / Cancel | — | **불채택** | 크론에 우선순위가 없고 대시보드에 크론 쓰기 라우트가 없다. 세션 Stop은 카드에 이미 있다 |
| 재시도 배지 · priority 미끄러짐 | — | **불채택** | 크론은 재시도하지 않고 우선순위 필드가 없다 |
| 떨어짐·날아감·흔들림·숫자 easing | — | **불채택** | 30–60초 폴링이라 끝난 순간을 보지 못한다. 다시 그릴 때마다 지난 전이를 되풀이하게 된다 |
| pill 맥박 점(무한) | — | **불채택** | 제한은 몇 시간~며칠 간다. 그동안 무한히 깜빡이면 소음이다. 정지 점만 둔다 |

## 4. 계약 (TO-BE)

### 4.1 구조
- **D1 두 섹션, 한 문법.** `#capacity`(stats와 inbox 사이)와 `#cron-lane`(inbox 안, 칸 위)의 자리, 접힘 규칙(가용량 늘 접힘, CRON 840×1000),
  리드 카드 reconciler(T4)를 그대로 둔다. 공통 클래스: `.aq-head`(이름 · `.aq-name` 흐린 이름 · `.aq-pill` · 도구), `dl.aq-stats > .aq-stat > dt+dd`,
  `.aq-col-head`(`라벨 <b>n</b>`), `.aq-mark`(마크 button), `.aq-pop`(고정 카드), `time.aq-left`(카운트다운). 합친 패널은 불채택(§3 첫 줄).

### 4.2 공통
- **D2 pill.** `<span class="aq-pill is-{ok|paused|empty|low|unknown|run|wait}"><i class="aq-dot" aria-hidden="true"></i>문구</span>`. 색은 상태색
  토큰, 배경 14%·테두리 45% 섞기(`.cron-badge`와 같은 공식). live region이 아니다 — 30초마다 다시 그리는 마크업이라 알림은 D4 한 곳에서만 한다.
- **D3 카운트다운.** `<time class="aq-left" role="timer" datetime="ISO" data-aq-at="epoch ms">`. 문구 `aqLeft(atMs, nowMs)`: 하루 이상 `1일 5시간`,
  1시간 이상 `1시간 20분`, 1분 이상 `24분`, 1분 미만 `42초`, 0 이하 `곧`. 분 단위는 버린다(12 T9). `aqTick()`(`setInterval`, 1000)이
  `#capacity`·`#cron-lane` 안의 `[data-aq-at]`만 바뀔 때 쓴다. `document.hidden`이면 쉬고, 틱마다 낭독하지 않는다.
- **D4 알림.** 정적 `<div class="aq-sr" id="aq-live" aria-live="polite" aria-atomic="true">` 하나를 다시 그리는 영역 밖(서랍 다음)에 둔다.
  `aqAnnounce(msg)`. 첫 불러오기는 기준선만 잡는다. 불러오기 한 번에 문장 하나, 우선순위 모두 막힘 > 실패 > 응답 대기 > 풀림 > 20% 선:
  `Claude 계정이 모두 막힘 — 24분 후 복귀` · `Claude 다시 사용 가능 — 계정 2/4` · `Claude 지금 20% 아래 — 0.6/3.3 계정` ·
  `크론 dependency-audit 실패: npm audit timed out…`(오류 80자) · `크론 morning-digest 응답 필요`. 계정 하나하나의 막힘·복귀는 알리지 않는다(실풀 모양 22계정, 12 §6 검증 — 소음).
- **D5 토큰.** 새 변수 `--aq-warn: var(--st-wait)`, `--aq-warn-text`(다크 `#f5a524`, 라이트 `#9a5b00` — 흰 바탕 5.4:1, pill 바탕 4.6:1.
  라이트 `--st-wait` `#c2780a`는 흰 바탕 3.5:1이라 글자에 쓰지 않는다). 둘 다 `[data-theme="light"]` 블록에 덮어쓴다. 나머지는 `--ib-*`·`--st-*`·
  `--cap-now`·`--cap-wk`. 반경: 섹션 14·카드 12(기존), 마크·칩 8, pill 999. 글자: stat dt 12 muted, dd 16/600 tabular, 마크 12.
- **D6 모션.** 마크 상태 변화 = 배경·글자색 `--dur-fade` `--ease-out`. 고정 카드는 `opacity 0→1`·`translateY(-4px) scale(.97)→none`
  (`--dur-fade` `--ease-out`)으로 열리고 즉시 닫힌다. 새 대기열 칩은 `--dur-fade`로 나타나고, 차트 막대 높이는 `--dur-expand`로 바뀐다.
  무한 애니메이션은 없다. reduced-motion 블록(`:5405`)에서 `.aq-*`의 animation·transition을 모두 끈다.
- **D7 반응형.** 가용량 카드는 기존 `is-narrow`(카드 폭 < 600)를 쓴다. CRON 레인은 `container: aqlane / inline-size`: 560 이하 `aq-stats` 2×2(홀수
  열 구분선 없음), 600 미만 대기열 열이 잡 그리드 위로 쌓이고 차트 88, 그 밖은 대기열 `clamp(188px, 26%, 236px)` | 잡 그리드, 차트 112.
  가로 스크롤 0, coarse 포인터에서 마크·칩 44px 이상.

### 4.3 LLM 가용량 = 워커
- **D8 카드 머리.** `.cap-pname` 줄이 `.aq-head`가 된다: `Claude` + `.aq-name` `llmux · 계정 N`(N = `units.length`) + pill. 공개 줄·막대·타임라인은 12 §7 그대로.

  | 순위 | 조건 | pill 문구 |
  |---|---|---|
  | 1 | `unknown` | `◌ 계산 불가` |
  | 2 | `empty` | `✗ 모두 막힘 · {D3} 후 복귀`(가장 이른 `returnAt`, 없으면 `capNextEvent(primary).at`), 둘 다 없으면 `✗ 소진` |
  | 3 | 막힌 계정 p > 0(`counted && blocked`) | `⏸ 제한 p · {D3} 후 복귀`(가장 이른 `returnAt`), 없으면 `⏸ 제한 p` |
  | 4 | `low` | `▲ 부족` |
  | 5 | 그 밖 | `● 사용 가능` |
- **D9 20% 선.** 각 `.cap-bar` 안에 `<i class="cap-low" style="left:20%" title="20% 아래면 부족"></i>`(점선 1px `--ib-muted`). 근거 `CAPACITY_LOW_PCT`.
  클라이언트 `var CAP_LOW_PCT = 20;`이 서버 상수와 같음을 시험이 고정한다. 막대 색은 창 색 그대로(12 §7 "색은 창에만").
- **D10 계정 마크(WORKERS).** 막대 아래·타임라인 위 `.aq-workers`(`role="group"`, `aria-label="Claude 계정 r/N 사용 가능"`). 머리 `.aq-col-head`
  `계정 <b>r/N</b>`, r = `binding`이 있는 unit 수. 마크는 unit마다 하나, llmux 순서 그대로(갱신해도 자리가 안 바뀐다):
  `button.aq-mark.is-{state}` `data-aq-key="{group}|{name}"`.

  | state | 조건(`CapacityUnit`) | 보이는 것 |
  |---|---|---|
  | ok | `binding` | 이름 + 창색 점(`binding` 5h 청록 / 7d 보라) |
  | paused | `counted && blocked` | 호박색 `⏸ 이름 · {사유}` + `returnAt`이면 `{D3}`, 없으면 `복귀 약속 없음` |
  | spent | `counted && !blocked && !binding && !unmeasured5h` | `이름 · 소진` |
  | unmeasured | `unmeasured5h` | `이름 · 5시간 미측정` |
  | held | `excluded=held` | 회색 `이름 · {일시정지·인증 실패·보류}` |
  | out | `excluded=noMeasure·unknownTier` | 점선 테두리 `이름 · {측정 없음·티어 미지정}` |

  사유: `blocks.weekly` 주간 한도 > `fiveHour` 5시간 한도 > `scopedUntil` 모델 한도 > `cooldownUntil` 쿨다운(여럿이면 이 순서의 첫째).
  마크에 사용량 막대·%·티어는 없다 — 12 §7이 뺀 "계정별 막대"는 되살리지 않는다. narrow이면 ok 마크를 `● 사용 가능 r` 하나로 접는다(목록은
  D11 카드). 접근 이름은 보이는 칸만 나열한다: `ai3, Max x5, 5시간 한도, 1시간 20분 후 복귀`.
- **D11 계정 카드.** `.aq-pop[role=dialog][aria-label="ai3 세부"]`가 마크 아래에 뜬다. 폭 min(280, 줄 폭 − 16), x는 [8, W − w − 8]로 자른다
  (narrow면 줄 폭 − 24). 머리: 이름·티어(`Max x5` / `x20 가정` / `티어 미지정`)·상태 pill·`닫기`(`aria-label="닫기"`). 2열 dl: `지금 쓸 수 있음 {now%}` ·
  `이번 주 남음 {week%}` · `먼저 닿는 창 {5시간|일주일}`(`binding`) · `상태 {사유}` · `복귀 {HH:MM} · {D3}`(`returnAt`) · `추정`(`estimated`).
  접힌 ok 마크의 카드는 `이름 · 지금 % · 이번 주 %` 목록이다. "계정분"·"상한"은 쓰지 않는다(12 §7 시험). 한 번에 하나만 연다(`_aqOpen = key`).
  30초 다시 그리기에도 열려 있고, 포커스가 그 안에 있었으면 되돌린다. 바깥 클릭·Esc로 닫고 포커스는 마크로 간다.
- **D12 roving focus.** `[data-aq-rove]` 컨테이너에 위임 keydown `aqRove(e)` 하나. 정지점 하나(마지막에 포커스한 마크, 없으면 첫 마크가 `tabindex=0`).
  ←·↑ 이전, →·↓ 다음, Home·End 끝. Enter·Space는 native button으로 카드를 여닫고, 카드가 열리면 Tab은 `닫기`로 간다. D17 칩도 같은 도우미를 쓴다.
- **D13 모두 막힘 구간.** `state === 'empty'`이면 `capTimeline`이 지금부터 첫 상승(`dNow`, has5h가 아니면 `dWeek` > 0)까지 `<rect class="cap-tl-lim">`
  (`--st-fail` 12% + 빗금 — 12 T9와 `.cap-prov.is-empty` 테두리와 같은 빨강, `<title>모두 막힘 — {HH:MM}까지</title>`)을 그린다. 다른 상태에서는 그리지 않는다.
- **D14 접힌 칩.** 막힌 계정이 있으면 측정값 뒤·`⚠` 플래그 앞에 `<i class="cap-chip-lim">⏸ p · {D3}</i>`. 툴팁·접근 이름에 `제한 p — {D3} 후 첫 복귀`.
  기존 칩 시험의 앞부분 정규식은 그대로 맞는다.

### 4.4 CRON 레인 = 대기열
- **D15 레인 머리.** `CRON n` 뒤의 `● 실행 중 n` · `▲ 응답 필요 n`은 문구 그대로 `.aq-pill is-run` · `.aq-pill is-wait`가 된다.
- **D16 숫자 4칸.** 머리 바로 아래 `#cron-lane-top`의 `.aq-stats`, 펼친 레인에서만 보인다. 각 `dd`의 `title`이 출처를 말한다.

  | 칸 | 값 | 출처 · 파생 |
  |---|---|---|
  | 다음 실행 | `{D3} 후` + `.aq-of` 잡 이름, 없으면 `—`(title `8일 안에 없음`) | `min(KanbanCronJob.nextRunAt)` |
  | 실행 중 | `r<span class="aq-of">/N</span>` | r = `plan.runningCount`, N = `plan.groups.length`(다른 인스턴스 그룹 포함) |
  | 24시간 실행 | `n`, 잘리면 `≥n` | `cronGroupRuns(g)` 중 `status !== 'queued'`이고 `executedAt ≥ now − 24h`. `unrecorded`(기록 전 실행 중 카드) 포함 |
  | 실패 · 24시간 | `f`, f > 0이면 `data-kind=failed`(`--st-fail-text`) | 같은 창의 `status === 'failed'` |

  잘림: `runs.length ≥ historyCap`이고 가장 오래된 `executedAt`이 24시간 안이면 그 잡의 기록은 잘린 것이다 → 값에 `≥`, title에
  `dependency-audit 기록은 보관 한도 20회라 15:04부터`.
- **D17 대기열 열.** `#cron-queue`(`role="group"`, `aria-label="다음 실행 순서"`). 머리 `다음 실행 <b>n</b>`(n = `nextRunAt`이 있는 잡 수). `nextRunAt`
  오름차순 칩 4개 + `+N`(레퍼런스는 칩 3 + 칸). 칩 = `button.aq-q[data-cron-group]`(시계·이름·`{D3}`) — 기존 위임 클릭이 그 잡의 서랍을 연다.
  roving은 D12. 접근 이름 `dependency-audit, 12분 후 실행, 1/4 — 지난 실행 보기`. 비면 `8일 안에 예정 없음`. 다른 인스턴스 그룹은 나오지 않는다.
- **D18 잡 타일.** T5 계약 그대로. `다음 HH:MM (… 후)`의 남은 시간만 `<time class="aq-left" data-aq-at>`로 살린다. 문구는 `14h 12m` → `14시간 12분`(D3로 통일).
- **D19 실행 기록 차트.** `#cron-lane-chart`(그룹 아래), 제목 `실행 기록 · 24시간`. 1시간 24칸(지금으로 끝남), 성공·진행 `--st-done` 위에 실패 `--st-fail`을
  쌓는다. `queued`는 넣지 않는다(D16과 같은 집합). y 최대 = max(최고, 4)를 nice 목록으로 올림, 격자 0·최대. 축 `24시간 전 · 12시간 전 · 지금`,
  칸마다 `<title>HH시 성공 a · 실패 b</title>`. 잘린 잡이 있으면 [24시간 전, 가장 늦은 잘림 시작)에 빗금 `.aq-ch-cut` + `<title>`
  (`이 구간은 {잡} 기록이 보관 한도로 잘려 실제보다 적을 수 있음`) — 레퍼런스 리밋 음영 자리. `role="img"`, 접근 이름
  `지난 24시간 크론 실행 41회, 실패 2회, 가장 많은 시간 18시 6회. 15시 이전은 일부 잡 기록이 잘림.` 높이 112(D7 조건 88).
- **D20 고정 카드 = 기존 서랍.** role=dialog·Esc·바깥 클릭·포커스 복귀 그대로. 레퍼런스의 Position은 서랍 메타 `다음 실행`이 맡고,
  Attempt·Priority는 없다(크론에 필드가 없다). `Move to front`·`Cancel`은 불채택(§3).
- 접힌 레인(12 / 10-24)은 머리와 응답 대기 잡만 보인다. 숫자 칸·대기열·차트는 숨는다.

### 4.5 앞선 계약에서 바뀌는 것
| 앞선 계약 | 바뀐 것 | 이유 |
|---|---|---|
| 12 §7 "뺀 것: … 계정별 막대, 칩 …" | 계정마다 **상태 마크**(D10). 사용량 막대·%·티어는 없고 숫자는 고정 카드(D11)에서만 | 레퍼런스의 핵심 결정은 "어느 워커가 멈췄고 언제 돌아오나"인데, 지금은 막힌 개수만 말한다. 마크는 이름·사유 한 단어·카운트다운만 실어 §7이 거부한 수치 소음을 되살리지 않는다. 좁으면 ok 마크를 하나로 접는다 |
| 12 §7 카드 = 막대 2 + 타임라인 1 | + 머리 pill(D8), 20% 점선(D9), 모두 막힘 음영(D13) | 막대·타임라인은 그대로. 음영은 12 T9 v1 "지금→복귀 음영"의 복원 |
| 12 T9 카운트다운은 그릴 때 고정 | 1Hz로 살아 있음(D3). 분 버림 유지, 1분 미만은 초 | 레퍼런스의 리밋 카운트다운. 1분 미만이 "1분"에 멈추지 않는다 |
| 12 T5 타일 `다음 … (14h 12m 후)` | `14시간 12분 후`(D18) | 가용량 `capDur` 형식과 하나로 |
| 12 T4 레인 = 머리 + 잡 그리드 | + 숫자 4칸, 다음 실행 열, 24시간 차트(D16·D17·D19), 펼쳤을 때만 | 대기열·처리량·기록. 응답 대기 우선 정렬과 리드 카드는 그대로 |

## 5. 시험

새 파일 `src/conversation/__tests__/dashboard-affectui-agent-queue-client.test.ts`. 하네스는 `dashboard-cron-capacity-client.test.ts` 1–60의
cook·clientFn·load, 가용량 입력은 실제 `buildCapacityView` 출력(하네스 `fixtures-agent-queue.ts`와 같은 모양). 표의 시험은 모두 구현 전 RED다
(새 함수·클래스가 없다). 기존 시험은 바꾸지 않고 GREEN을 유지해야 한다.

| # | D | 시험 |
|---|---|---|
| 1 | D1 | 쪽 배치 유지(기존 `page wiring` 4건) + 정적 `#aq-live[aria-live=polite]`가 `#capacity`·`#cron-lane` 밖에 있다. `#cron-lane-top`·`#cron-queue`·`#cron-lane-chart`가 레인 안에 있다 |
| 2 | D2 | `aqPill` 마크업·클래스, `role="status"`·`aria-live` 없음 |
| 3 | D3 | `aqLeft`: 1일 5시간 / 1시간 20분 / 24분 / 42초 / 곧, 분 버림. `aqTick`은 가짜 요소에서 바뀐 것만 쓰고 hidden이면 쉰다 |
| 4 | D4 | `capAnnounceDiff`·`cronAnnounceDiff`: 첫 호출 ''. 모두 막힘 진입·풀림·20% 아래로·새 실패·새 응답 대기의 문장. 카운트다운만 바뀌면 ''. 한 번에 하나(우선순위) |
| 5 | D5 | CSS: `--aq-warn-text` 다크·라이트 정의 + 라이트 블록 덮어쓰기 |
| 6 | D6 | reduced-motion 블록에 `.aq-` 셀렉터의 `animation: none`·`transition: none`. `infinite`가 붙은 `.aq-` 규칙 없음 |
| 7 | D7 | CSS: `@container aqlane (max-width: 560px)` `.aq-stats` 2열, `(max-width: 599px)` 대기열 쌓기 |
| 8 | D8 | `capProvHead`: ok·제한(가장 이른 `returnAt` 카운트다운)·모두 막힘·부족·계산 불가 문구와 우선순위 |
| 9 | D9 | `capBarRow`에 `cap-low` 20% + `CAP_LOW_PCT === CAPACITY_LOW_PCT`(서버 import) |
| 10 | D10 | `capWorkers`: unit 순서, 상태 6종 클래스·단어, `계정 r/N`, 사유 우선순위, narrow에서 ok 접기, 마크에 width 스타일·`%` 없음, "v2 clutter" 금지어(`cap-units` 등·`계정분`·`상한`) 없음 |
| 11 | D11 | `capAccountCard`: dialog·aria-label·닫기, dl 행이 unit 필드에서 온다. 열린 key는 다시 그려도 유지 |
| 12 | D12 | `aqRove`: 가짜 목록에서 ←→↑↓·Home·End로 포커스·tabindex 이동. Esc로 카드를 닫으면 포커스가 마크로 |
| 13 | D13 | `capTimeline`: empty일 때 `cap-tl-lim`이 지금부터 첫 상승까지. ok·low에는 없음 |
| 14 | D14 | `renderCapacitySummary`: 막힌 계정이 있으면 `cap-chip-lim` + 접근 이름. 기존 칩 시험(`dashboard-responsive`) GREEN |
| 15 | D15 | `renderCronLaneHead`: 같은 문구, `aq-pill is-run`·`is-wait` |
| 16 | D16 | `cronStats`: 4칸 값, `≥` 잘림과 title, 실패 칸 빨강, `queued` 제외·`unrecorded` 포함, title의 출처 |
| 17 | D17 | `cronQueue`: `nextRunAt` 순서, 칩 4 + `+N`, `data-cron-group`·`data-aq-at`, 접근 이름, 빈 문구 |
| 18 | D18 | `renderCronTileHead`의 다음 실행에 `<time class="aq-left"`·`data-aq-at`. 나머지 T5 시험 GREEN |
| 19 | D19 | `cronRunChart`: 24칸 합 = D16 값, 실패 쌓기, 잘림 빗금 구간, `role="img"` 요약, narrow 88 |
| 20 | D20 | 서랍 시험(기존) GREEN + 대기열 칩 클릭이 `openCronDrawer`로(위임 경로) |

화면 확인: `harness/serve-agent-queue.ts`(포트 34107) + `shoot-agent-queue.mjs` → `after-*`. 라이트·다크 × 1440·390 × 접힘·펼침 + 서랍 + 계정 카드.

## 6. 범위 밖

- **진짜 대기열**: `FollowupQueue`(바쁜 세션 뒤에 줄 선 메시지)를 노출하면 레퍼런스의 Waiting·Wait p95를 정직하게 채울 수 있다. 새 읽기
  라우트와 서버 시험이 필요해 별도 이슈로 둔다.
- **llmux `in_flight`·`current_by_group`**: 읽은 순간의 값이고 화면은 최대 90초(캐시 30 + 폴링 60) 늦다. "지금 처리 중"으로 그리면 거짓이다.
- 쓰기: 일시정지, 계정 전환·추가(llmux `/switch`는 운영자 몫), 크론 지금 실행·일시정지·삭제(Slack `cron` 표면).
- `0 9 * * 1` 같은 주간 식의 문장화(`cronScheduleLabel`), 형제 인스턴스의 크론 데이터(12 §4).
- 에픽 스펙 `../14-dashboard-affectui-spec.md`은 디스패처가 7개 문서를 모아 쓴다.
