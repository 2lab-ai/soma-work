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
