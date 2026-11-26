# work-queue — done (append-only)

Loop: ./loop.md · Each round close appends one block at the bottom; nothing above it ever changes (`loop-lint.py` C2 compares against git). Rows here are snapshots (Last Measured frozen at move time). A later pass is a `re-verified` line in a loop.md round section; a regression reopens as a new loop.md row with Source `regression:<ID>`.

## R1 — closed 2026-11-19

- measured 9✅ · result: one keyed work queue merged (PR https://github.com/2lab-ai/soma-work/pull/1380, merge `b489d453`) and deployed to the owner dev host (v0.3.97-dev) · closed rows: W1–W8, G1 · commit/PR: https://github.com/2lab-ai/soma-work/pull/1380

### Closed rows

| ID | 작업 단위 | Status | 증거 |
|---|---|---|---|
| W1 | 원장: keys · config · ledger · store (`somalib/work-queue`, process-shared 재export) | ✅ | 원장 48 GREEN. 저장소는 R3 리뷰 뒤 `node:sqlite`(트랜잭션 하나 · OS 잠금)로 교체, 4개 프로세스 동시 쓰기 60/60 유실 0(8회 반복) |
| W2 | MCP 서버 `work-queue` + 리졸버 · config builder · 패키지 등록 | ✅ | MCP 18 + e2e GREEN. 배포된 바이너리 두 스레드 실측: running → CONFLICT(wq-1) → queued #1 → 다른 레인 독립 → NOT_HOLDER → done이 wq-2로 넘김 |
| W3 | 호스트 `WorkQueueHost`(`src/work-queue/host.ts`) + index.ts 조립 | ✅ | host 19 GREEN. 소유자 dev 호스트에서 `data/work-queues.sqlite3`(WAL) 생성 확인 |
| W4 | 옛 장치 제거: #726 게이트 · v1 `env-run-queue` | ✅ | 옛 카드 버튼 "만료" 응답 테스트 GREEN |
| W5 | hand-off 추적 + 끝 = `whenFree` · 목표 루프 · 후속 질문 술어 | ✅ | hand-off 48 GREEN |
| W6 | 보드: `queueWait` · 보라 태그 · i18n | ✅ | 보드 테스트 GREEN (화면 실측은 loop.md W9c) |
| W7 | 레인 소비자: `deploy.prompt` · `deploy-qa` · RUN_ENV_SKILL · CLAUDE.md · architecture.md | ✅ | 프롬프트 · 스킬 계약 테스트 GREEN |
| W8 | 게이트: tsc · biome · vitest · Lean · 리뷰 · PR | ✅ | CI 최종 head `ec89fa99`: quality-gates · lean-verify · scan · review-of-legends 전부 통과. 리뷰 R1(독립 9건) · R2(봇 10건) · R3(봇: 설정 · 잠금) 반영 |
| G1 | v1 PR의 기준선 밖 실패 테스트 | ✅ | 원인 확인: env-skill-handoff-host 6건은 v1 싱글턴 큐 탓 → v1 제거로 해소. 나머지(display-lang · incident-ingress)는 병렬 부하 타임아웃 · main에서도 같은 실패(기준선) |

### Round section (as it was in loop.md)

라운드 1 — 원장 · MCP · 호스트 · 옛 장치 걷어내기. 리뷰 라운드: R1 독립 리뷰(재시작 유예 · 미통지 차례 · 큐 이름 정규화 · 늦은 답 재확인 · hand-off 경합 · 잠금 탈취 · deliver 계약 · stamp) → R2 리뷰 봇(설정 재읽기 실패를 "큐 없음"으로 캐시 · 레코드 검증 · 동시 프로세스 테스트) → R3 리뷰 봇(잠금 PID 재사용 · 복구 경합 → 저장소를 `node:sqlite`로 교체, `workQueues: []` 옛 끄기 보존) → CI Node 20(`node:sqlite` 없음) → 그런 런타임은 큐를 끄고 `QUEUE_UNAVAILABLE`, 호스트 · MCP 테스트는 메모리 저장소. sanitize: 예시 Jira 키 형식이 금지 패턴이라 브랜치 히스토리를 `ABC-n`으로 고쳐 씀.

## R2 — closed 2026-11-19

- measured 2✅ · result: the owner dev host runs `deploy:dev` · `qa:dev`; a live run with three real sessions passed A2 · A3 · A5 · A6 (refusal, purple 큐 대기 board card, idle turn given back, host wake with no user input) · closed rows: W9a, W9c · commit/PR: this round's docs PR (round 2 live evidence)

### Closed rows

| ID | 작업 단위 | Status | 증거 |
|---|---|---|---|
| W9a | 소유자 dev 호스트 설정 `workQueues {"deploy":["dev"],"qa":["dev"]}` | ✅ | 2026-11-19 20:31 KST 봇이 직접 넣음(백업 · 권한 600 유지). 재시작 없이 다음 호출부터 `queue_list` = `deploy:dev` · `qa:dev` (MCP가 호출마다 설정을 다시 읽는다) |
| W9c | 실측: 호스트 깨우기(A5) · 일 안 하는 차례 반납(A6) · 보드 보라 `큐 대기`(A3) | ✅ | 대시보드에서 만든 테스트 세션 A · C와 이 작업 세션으로 2026-11-19 KST에 실측(아래 Round section의 시각표). 보드 캡처 · 두 스레드 원문 · 원장 상태 · 호스트 로그로 확인 |

### Round section (as it was in loop.md)

라운드 2 — 두 호스트에서 켜고 실측. 소유자 dev 호스트(v0.3.97-dev) 실측, 2026-11-19 KST:

- 20:31 설정 `workQueues {"deploy":["dev"],"qa":["dev"]}` 반영 → `queue_list`가 두 큐를 보인다(재시작 없음).
- 20:34:25 테스트 세션 A(대시보드 새 작업, autogoal · autoz 끔)가 `queue_enter qa:dev [ABC-901]` → `wq-1` running(position 0).
- 20:34:37 작업 세션이 `[ABC-901, ABC-902]`로 들어가려 하자 → `CONFLICT`, 잡은 쪽(`wq-1`, A의 스레드)을 알려 준다(A2). 그 뒤 `[ABC-902]`만으로 들어가 `wq-2` queued #1, 바로 `queue_cancel`(대기 역할은 C에게: 보드의 보라 표시는 턴이 없는 세션에만 붙는다).
- 20:35:42 테스트 세션 C가 `queue_enter qa:dev [ABC-902]` → `wq-3` queued #1. C의 답: "차례가 오면 호스트가 이 스레드를 깨웁니다 … 그 전까지는 아무것도 하지 않고 턴을 끝냅니다" — 질문 · 폴링 · 크론 없음.
- 20:35 보드(`/api/dashboard/sessions` + 화면 캡처): C = `working` 열, `activityState: idle`, `queueWait {kind: queued, queue: qa:dev, position: 1}`, 카드는 보라 테두리에 `큐 대기 · qa:dev · #1`. A = `working` 열, `qa:dev · 진행 중`(보라 아님). 응답 필요 열에는 둘 다 없다(A3).
- 20:39:32 A가 턴을 끝내고(20:34:30) 5분 → 호스트 로그 `Work queue entry released by the host {entry: wq-1, reason: holder-idle}`, A 스레드에 `⏹ 작업 큐 qa:dev 차례를 돌려놓았습니다 (wq-1 · 세션이 일을 하지 않음)`(A6).
- 20:39:32 같은 틱에 `Work queue turn came — waking the holder {entry: wq-3}` → 20:39:35 C 스레드에 호스트 턴 `[work-queue] Your turn in qa:dev: entry wq-3 (ABC-902) runs now …` → C가 `queue_done {"entry":"wq-3"}`(원장 20:39:43 `done`)을 부르고 "QA 완료 (ABC-902)"를 답한다. 사람 입력 0(A5).
- 끝난 뒤 원장: 진행 · 대기 0, ended = wq-2 cancelled · wq-1 released(holder-idle) · wq-3 done. 두 카드는 `완료` 열에 `queueWait` 없음. 테스트 카드 A · C는 대시보드에서 닫았다(20:42).

## R3 — closed 2026-11-26

- measured 1✅ · result: the customer dev host runs the v1 lanes since its 2026-11-20 scheduled deploy — its ledger holds 22 deploy · QA entries (2026-11-23..26: 19 ended done/cancelled/released, one running), so `queue_list` shows `deploy:dev2` · `qa:dev2` in use · closed rows: W9b · commit/PR: this round's v2 branch (docs only for R3)

### Closed rows

| ID | 작업 단위 | Status | 증거 |
|---|---|---|---|
| W9b | 고객 dev 호스트: 설정(dev2 · stage0) + 코드 배포 | ✅ | 2026-11-26 그 호스트의 `data/work-queues.sqlite3`를 읽기만으로 확인(rev 45): `wq-1`…`wq-22`, `deploy:dev2` · `qa:dev2` 항목이 2026-11-23부터 줄을 서고 끝났다(`done` 15 · `cancelled` 2 · `released` 4 · 진행 1). 고객 환경 배포 · QA는 일으키지 않았다 |

### Round section (as it was in loop.md)

라운드 3 — 고객 dev 호스트에서 켜기. 소유자 dev 호스트는 라운드 2에서 실측을 통과했다(loop.done.md R2). 남은 것은 고객 dev 호스트 하나였다. 설정은 2026-11-19에 넣었고(백업 · 권한 600 유지), 코드는 2026-11-20 19:00 KST 정기 배포로 들어갔다. 2026-11-26 원장을 읽어 확인했다(위 행). 같은 날 대화 기록에서 v1이 풀지 못한 일을 찾았다: 그 호스트의 실제 QA 레인은 환경 유저의 개인 스킬이 직접 잡는 파일 잠금이라 바쁘면 한 줄로 끝나고 아무도 다시 부르지 않는다(2026-11-24 00:53Z · 2026-11-25 13:14Z) — v2(SSOT_4–5, 라운드 4)의 출발점.

## R4 — closed 2026-11-26

- measured 7✅ · result: v2 merged (one line core, lanes by name with no configuration, `queue_try`, same work fails fast in the personal queue, the 작업 큐 section under the CRON lane with `작업 큐 | 개인별 큐`, admin hands, one-at-a-time history) and live on the owner dev host; A12–A16 observed with real sessions, screenshots, ledger and host log; live QA found three gaps, fixed in https://github.com/2lab-ai/soma-work/pull/1450 · closed rows: W10–W16 · commit/PR: https://github.com/2lab-ai/soma-work/pull/1446 (`46cccaf3`), https://github.com/2lab-ai/soma-work/pull/1447 (`0afa18d2`), https://github.com/2lab-ai/soma-work/pull/1450 (`100871b9`)

### Closed rows

| ID | 작업 단위 | Status | 증거 |
|---|---|---|---|
| W10 | 줄 규칙 `line.ts` · 레인 원장 v2(이름으로 생기는 레인 · try · putFirst · 내역 · v1 이전) · `keysInText` | ✅ | somalib 64 GREEN. 실측: 배포 직후 v1 원장(`qa:dev`, 11-19 항목 3개)이 `qa-dev` 레인 내역으로 읽혔다 |
| W11 | MCP `queue_try` · 설정 없는 레인 · 고정 레인 | ✅ | MCP 14 GREEN. 실측 A12 · A13(아래 시각표) |
| W12 | 호스트 `manage` · `views` · `/api/dashboard/work-queues` GET · POST | ✅ | host 28 · 보기 2 · 라우트 4 GREEN. 실측 A16: 관리자 모드 꺼짐 403, `돌려놓기` → 다음 차례 깨움 |
| W13 | 개인 큐: 키 · 같은 작업 거절 · 그래도 시작 · 내역 · `lineView` | ✅ | 개인 큐 · 인그레스 · Slack GREEN. 실측 A14(거절 · 일부 겹침 진행 · 대기 · 한도 원복 자동 시작). `그래도 시작` 실클릭은 loop.md W17 |
| W14 | 보드 작업 큐 칸(작업 큐 \| 개인별 큐) · 대기 카드 이동 · 24시간 막대 · 설정 탭 내역 | ✅ | 클라이언트 14 · 설정 20 GREEN. 실측 A15 캡처. 실측이 찾은 틈 3개(대기 카드의 관리자 버튼 없음 · 설정 내역의 `admin:U…` · 개인 큐 거절 이유 영어)는 #1450 |
| W15 | 소비자: `deploy.prompt` · `deploy-qa` 이름 · 공통 규칙(바쁜 레인 = 줄 서기) | ✅ | prompt-builder 49 · 예산 21 · deploy-qa 64 GREEN. 실측: 테스트 세션이 `queued`면 한 줄 쓰고 턴을 끝냈고 차례에 깨워져 이어 갔다 |
| W16 | 실측: 소유자 dev 호스트 배포 → A12–A16 | ✅ | v0.3.123-dev(`0afa18d2`)에서 A12–A16, #1450 재배포 뒤 `먼저 진행` 재실측 — 아래 시각표 |

### Round section (as it was in loop.md)

라운드 4 — v2 실측. 소유자 dev 호스트 v0.3.123-dev(`0afa18d2`, 배포 job runner = 그 호스트, Verify 통과, 재시작 뒤 세션 4개 시작 · 거절 0), 2026-11-26 UTC. 테스트 세션은 대시보드 새 작업(autogoal · autoz 끔, 일반 채널):

- 04:15:32 A12 — 이 작업 세션이 `queue_enter {queue: "qa-wq-probe", keys: ["WQ-901"]}` → `running`, `created: true`(설정 없음, `wq-4`).
- 04:16:20 A13 — 테스트 A의 `queue_try qa-wq-probe [WQ-902]` → `busy`, 앞 = `wq-4`(WQ-901). `queue_list`: 원장 그대로(대기 0).
- 04:17:48 A12 — 테스트 B가 이름을 `qa:wq-probe` 그대로 `queue_enter` → 같은 레인 `queued` #1(`wq-5`). 04:18:30 테스트 C `[WQ-904]` → #2(`wq-6`). 둘 다 한 줄 쓰고 턴을 끝냈다.
- 04:19 A15 — 보드: B · C 카드가 보드 칸(`kanban` 데이터)에 없고 작업 큐 칸 `qa-wq-probe` 상자에 `큐 대기 · qa-wq-probe · #1/#2`로 있다. 탭 배지 `작업 큐 2`.
- 04:24 A16 — 관리자 모드 꺼짐: `POST …/wq-6/first` → 403 "관리자 모드를 켠 관리자만…", 버튼 0개. 켜면 진행 줄에 `돌려놓기`. 대기 카드에는 `먼저 진행`이 없었다 → 원인: 세션 카드 본문은 페이지가 그리는 slot이라 element의 data `actions`가 그려지지 않는다 → #1450.
- 04:34:44 A16 — 관리자 `돌려놓기`(진행 줄 버튼) → 호스트 로그 `Work queue entry managed by an admin {wq-4, release}` · `Work queue turn came — waking the holder {wq-5}`, 이 스레드에 `⏹ 작업 큐 qa-wq-probe 차례를 돌려놓았습니다 (wq-4 · 관리자가 돌려놓음)`. 04:35:00 B "B 완료 (WQ-903)"(`queue_done`) → 04:34:55 `waking {wq-6}` → 04:35:27 C "C 완료 (WQ-904)". 사람 입력 0.
- 내역(보드 · 설정 표): `wq-4` 04:15:32→04:34:44 돌려놓음(관리자) · `wq-5` 04:34:44→04:34:53 완료 · `wq-6` 04:34:53→04:35:23 완료 — 앞 항목이 끝난 뒤에만 다음이 시작, 24시간 막대 겹침 없음.
- 04:38:22 A13 — 빈 레인 `queue_try qa-wq-try [WQ-910]` → `running`, `created`; `queue_done` → `done`.
- 04:39:32 A14 — 테스트 D(`WQ-905`, 150초 작업) 진행 중 테스트 E "WQ-905 다시 해줘" → 1초 만에 `⛔ 같은 작업이라 시작하지 않았습니다`(D 스레드 링크, `그래도 시작` 버튼, 30분), 로그 `the same work is already running or waiting — not started`, 개인 내역 `refused`. 04:41:19 테스트 F "WQ-905 and WQ-906"(키 하나만 겹침) → 정상 진행.
- 04:42:03–04:42:18 A15(개인) — Z의 한도를 15초간 1로: 테스트 G가 개인별 큐 #1로 대기(보드 칸에 없음, 개인별 큐 탭에 카드 · `다음 차례 — … 끝나면 바로 시작`), 한도 원복 즉시 시작 → 04:42:51 "G 시작".
- 테스트 카드 A–G는 대시보드에서 닫았다. 화면 캡처는 작업 스레드(Slack)에 남겼다.
- #1450 재배포(v0.3.125-dev, `100871b9`) 뒤, 05:11–05:16: 이 세션 `qa-wq-probe [WQ-920]` 진행(`wq-8`), 테스트 H `[WQ-921]` #1(`wq-9`) · I `[WQ-922]` #2(`wq-10`). 관리자 모드로 I 카드를 펼치면 액션 바 = `먼저 진행 · 대기에서 빼기 · 중지 · Slack`. 05:14:09 `먼저 진행` → 로그 `managed by an admin {wq-10, first}`, 대기 = `wq-10 #1 · wq-9 #2`. 05:15:23 `queue_done wq-8` → `waking {wq-10}` → 05:15:34 "I 완료" → 05:15:32 `waking {wq-9}` → 05:15:41 "H 완료". 설정 표: `wq-4 … 돌려놓음 관리자`. 테스트 J(이 세션이 쥔 `2lab-ai/soma-work#1445`) → ⛔, 개인 내역 이유 `same-work` = "같은 키가 다른 스레드에서 진행 중이거나 대기 중"(#1450 전 기록은 영어 문장 그대로 남는다). 카드 정리 · 관리자 모드 원복.
