# loop — 유저 메시지 스티어링 구현 드라이브

Status: planned · 스펙 = [`../06-user-steering-spec.md`](../06-user-steering-spec.md) · ssot = [`ssot.md`](ssot.md)

## 게이트 (build facts, 2026-09-17 실측)
`npm run build` · `npx tsc --noEmit` · `npm test -- --maxWorkers=2`(기본 concurrency는 timeout flake 이력) · `npm run smoke:mcp-bins` · `npm run smoke:assets` · 외부 리뷰 trinity(유닛 번들당 3엔진). 배포는 유저 지시("마음대로 배포하지 말고") — **머지 후에도 유저 OK 전 배포 없음**.

## 라운드 0 — 리서치·스펙 (완료 2026-09-17)
- Explore 추적: 현재 경로 전부 턴 중단 또는 턴 종료 대기, 스트리밍 입력 미사용(06 §1).
- Librarian: 스트리밍 입력 모드가 유일한 정식 통로, `interrupt()`/`still_queued`/`cancel_async_message`/`command_lifecycle` 표면 정리(06 §2). 미문서 `priority` 배제.

## 라운드 1 — 계획 (유저 결정 D1–D3 후 착수)

| WU | 스코프 | 파일 소유 | RED 시나리오 |
|---|---|---|---|
| WU1 adapter | `query({prompt: AsyncIterable})`로 전환, Query 핸들 보관, 입력 채널 push/close, `interrupt()` + AbortController 폴백, `user_message_uuids`/`command_lifecycle` 이벤트 노출 | `src/claude-handler.ts`, `src/agent-runtime/claude-code/build-stream-options.ts`, `src/agent-session/v1-query-adapter.ts` + 테스트 | 채널에 push한 uuid가 turn 프레임에서 관측됨; interrupt 후 still_queued 반환 |
| WU2 queue+dispatcher | 상태 `steered` 추가, `steer()`/`markConsumed()`/`unsteer()`; claimNext는 steered 제외; Send now가 interrupt 경유 | `packages/slack/src/followup-queue*.ts`, `followup-dispatcher.ts` + 테스트 | 상태 전이 CAS, 재시작 시 steered→paused |
| WU3 processor | `user_message_uuids`/`command_lifecycle` 관측 → consumed 통지 | `packages/slack/src/stream-processor.ts`, `pipeline/stream-executor.ts` + 테스트 | uuid 매칭 1회, 중복 무시 |
| WU4 host | ingress: queued 즉시 auto-steer 호출(정책 D1/D2), `message_changed` → Edit, Cancel의 steered 분기(`cancel_async_message`) | `src/slack-handler.ts`, `src/slack/event-router` 연동, `followup-actions.ts` + 테스트 | S1·S2·S5 호스트 레벨 |
| WU5 surface | `steered` 표시 문구, 최하단 패널(별도 브랜치 `feat/queue-panel-tail` 합류) | `thread-surface.ts`, `followup-queue-blocks.ts` | S6 |

## 라운드 1 — 실행 기록 (2026-09-17, 브랜치 `feat/queue-auto-steer`)

| WU | 커밋 | 게이트 | 계약 대비 편차 |
|---|---|---|---|
| WU1 adapter (+ 소비 정산) | 7cf18869, d4122e22 | 18 files / 185 tests, tsc 0 | SDK 0.3.251엔 `user_message_uuids`·`command_lifecycle` 프레임 없음 → `result.queued_turn_count` + `interrupt()` 영수증으로 정산(06 §6-6). `interrupt()` 인자 없음 → 생존 uuid는 `cancelAsyncMessage`로 회수 시도 후 `discarded`. |
| WU2 queue+dispatcher | 39e3f4f4 | 3 files / 219 tests | `sendNow`는 steered 항목을 먼저 unsteer(CAS) 후 reserve. `item-consumed` notice 추가. |
| WU3 processor | b213ca00 | 12 tests | `onSteerLifecycle`은 side-band(플러시 없음), 예외는 processor에서 흡수. `sessionKey`를 `streamAgentEvents` 6번째 인자로 전달. |
| WU4 host | e7f66d90 | 4 files / 242 tests; 전체 10704 passed | **Send now의 interrupt는 AbortController(자식 프로세스 kill) 유지** — push된 사본이 이중 실행될 수 없게 하는 가장 단순한 보장. 06 §6-4의 `query.interrupt()` 전환은 R1 실측 후 재검토. 첨부는 `processFiles`+`formatFilePrompt` 경로 텍스트(base64 아님). 편집 알림은 항목당 1회. |
| WU5 surface | (진행 중) | — | `steered` 라벨 `전달됨 · 모델이 다음 툴 호출에서 읽음`, 메뉴 [Send now, Cancel], 헤더 breakdown `전달 N`. 최하단 컴팩트 패널은 PR #224(3b0ebd99)로 main 합류. |

## 검증 (관측 기반)
- 로컬: 위 게이트 + SDK 스트리밍 입력 모의(uuid 프레임) 테스트.
- 실측: 2lab.ai Slack(fable dev, 단독 인스턴스)에서 S1·S2·S4를 실제 스레드로 1회씩 — 스트림 메시지 수·패널 상태·헤더 문구를 API 덤프로 리시트. iq 워크스페이스는 Socket Mode 이벤트가 work-m64 hot-spare에 고정돼 검증 불가(2026-09-17 실측).

## gap matrix
| 갭 | 상태 |
|---|---|
| 툴 호출 사이 스티어링 | 구현(WU1–WU4), 실측 R1(S1/S3) 미완 |
| Cancel | queued/paused/failed/uncertain = PR #224; steered 분기 = WU4(`cancelAsyncMessage` 실패 시 "이미 전달됨" + consumed) |
| Edit | 구현(WU4, `message_changed` → `editQueued`), 실측 S5 미완 |
| 최하단 컴팩트 패널 | main 합류(PR #224) |
| 배포·실측 | 미완 — 프리뷰 배포는 유저 OK 필요("마음대로 배포하지 말고"), 2lab.ai Slack 로그인 또는 유저 실행 |
