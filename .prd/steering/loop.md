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

## 라운드 2 — 외부 리뷰 반영 (2026-09-17, trinity-fallback2/opus ×5, gpt-6-astra 429)

| 단위 | 리뷰 판정 → 수정 커밋 | 닫힌 결함(요지) |
|---|---|---|
| A adapter | REQUEST CHANGES(5) → a0b492d5, 58785234, 25a65fed; 재리뷰 6/7 CLOSED + M6 닫음 | `interrupt({cancelQueued:true})`는 런타임이 지원(타입만 누락) → `interrupt_cancel_queued_v1` 광고 시 사용; `queued_turn_count`를 카운트 권위로(미계상분은 discarded); 0/absent=consumed는 healthy success 결과에서만, 그리고 health 게이트가 count 분기보다 먼저; 채널 `seal()` 후 스냅샷; 정산 2초 바운드; 정산 1회; 파생 세션키 폴백 삭제; 러너 계약에 `sessionKey`. |
| B queue | REQUEST CHANGES(3) → 82225ccf; 재리뷰 패키지 층 CLOSED | Send now 실패 경로(reserve 거부·interrupt 실패)에서 같은 uuid로 re-steer(`restoreSteer`), stop은 steered→`uncertain`(재시작은 paused+메모), 예약 중 steer는 `busy` 거부, `unsteerAll` sweep, 스토어 불변식(steered⇒uuid, 유일, 비어있지 않음). |
| C pipeline | REQUEST CHANGES(2) → D·A 수정에 흡수 | 정산 키 방향(세션키 우선, not-found면 슬롯키), 러너 계약 `sessionKey`, refresh 비동기화. |
| D host | REQUEST CHANGES(4+1) → 58785234, 4afe4e46 | 컨트롤 명령·`%`지시문은 스티어 금지(큐 경유 re-route), 스티어는 Send now interrupt 정책(owner/initiator) 통과 시만, 모든 settled 턴에서 steered 잔여 sweep(양 버킷, idle 가드), cancel tri-state(withdrawn/already-dequeued/unreachable→큐 복귀), 정산 키 폴백, 정직한 영수증, 임시파일 전 경로 정리, 편집 알림 문구·eviction, Send now 복원 시 첨부 보존. |
| E surface | approve → 0d9977a5(후속) | 표시 순서 컴파일타임 exhaustive, 컴팩트 미리보기 강조문자 중화(상태 라벨 스푸핑 차단). |

리뷰가 반려한 항목: "옵션 1개 overflow는 Slack이 거부" — `blocks.validate` 실측 `{"ok":true}`.
잔여(SHOULD, PR 본문 명기): interrupt-failed 경로가 피해 턴의 종료와 겹치면 `not-found`→restore→sweep→재실행 창(좁음); 마이그레이션 중 소스 스레드에서 들어온 항목은 슬롯 버킷에 살아 같은 패스에서 드레인되지 않고 다음 턴을 기다림; Resume 시 `uncertain` 안내는 비동결 세션에서도 출력.

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
