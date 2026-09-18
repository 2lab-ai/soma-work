# loop — 큐 컨트롤 이모지 리액션화

## 게이트 (build facts)
- `npm run build --workspace @soma/slack` → `npx vitest run <touched test files>` → `npm run lint` (tsc --noEmit + biome). 전체 `npm test`는 머지 전 1회.

## 라운드 1 — 계획 (2026-09-18)
| WU | 스코프 | 파일 |
|---|---|---|
| WU1 이벤트 | `reaction_added` 라우팅(봇 자신 제외, 큐 컨트롤 이모지만) | `packages/slack/src/event-router.ts` + 테스트 |
| WU2 표면 | 상태→리액션 전이 모듈, 카드 게시/갱신/삭제 제거, 폴백 이모지 | `src/slack/followup-reactions.ts`(신규), `src/slack-handler.ts` |
| WU3 컨트롤 | 리액션 트랜스포트 → 기존 `handleSendNow`/`handleCancel` 정책 재사용, 봇 리액션 2→1 정리 | `src/slack/actions/followup-actions.ts`, `src/slack-handler.ts` |
| WU4 이모지 | `:ui_send_now:` `:ui_cancel:` 워크스페이스 등록(Claude in Chrome), 앱 스코프/이벤트 확인 | 워크스페이스 설정 |

## 라운드 1 — 실행 기록 (2026-09-18)
- 코더(opus) TDD: 라우터 9 + 표면 24 + 호스트 20 테스트 RED→GREEN, 전체 `npm test` 11103/11103(1 flake: token-manager 10ms sleep, 단독·재실행 그린, 무관 파일).
- 결정: refresh/delete 쌍 → `syncFollowupReactions` 하나로 통합; 역인덱스 `Map<eventKey,{sessionKey,itemId,painted}>`(500 LRU, resolved/cancelled에서 제거); `verifyClick`은 이벤트의 channel + 저장된 item의 thread_ts로 합성(위조 불가 서버 사실만).
- 알려진 축소: freeze 사유는 스레드에 보이지 않음(`queue` 행에만) — §2.1 규칙대로 paused=queued 동일 3개 리액션. `failed`/`uncertain`은 `:warning:`만(컨트롤은 거부만 나오므로 미표시).

## 검증 (관측 기반)
- 09 스펙 §3 인수 기준 1–6을 2lab.ai Slack에서 Claude in Chrome으로 실측, 스크린샷 + 봇 로그.

## gap matrix
| 갭 | 상태 |
|---|---|
| 카드 → 리액션 | 출하(PR #237, v0.2.1144). 실측 R1: 봇 카드 없음, 미드턴 메시지에 `:inbox_tray:` → 즉시 `:white_check_mark:`만 |
| 리액션 컨트롤 | 출하(PR #237 + #239). 실측 R2 PASS(Cancel·Send now 모두). R1: 유저 `:ui_cancel:` → 봇 로그 `reaction_added` 수신 → Cancel 정책 실행(이미 소비된 항목이라 ephemeral "이미 모델에 전달되어 실행 중"). queued 상태의 3-리액션·취소 성공(`:no_entry_sign:`)은 라이브에서 미관측(자동 스티어링이 즉시라 queued 창이 없음) — 단위 테스트로 고정 |
| 커스텀 이모지 등록 | 완료 2026-09-18 15:10 — 2lab.ai에 `:ui_send_now:` `:ui_cancel:` 등록(Chrome, "has been added and is ready for use") |
| 앱 `reactions:read` + `reaction_added` | 완료 — 2lab.ai dev 앱 스코프에 `reactions:read` 기존재(auth.test 헤더), `reaction_added` 봇 이벤트 구독 추가·저장(재설치 불필요). **production(iq) 앱은 미적용** — prod 배포 전 같은 두 항목 + 커스텀 이모지 2개 필요 |
| `queue` 명령 카드 | 버튼 제거(텍스트 행, 힌트 `Send now / Cancel` 또는 `Retry / Cancel`) — 컨트롤은 리액션만 |

## 라운드 1 — 리뷰·출하 (2026-09-18)
- 외부 리뷰(gpt6-zhuge+gpt6-elon, 유닛 A/B/C, 2~3라운드): block → 수정 → merge-with-nits. 반영: 정직한 painted 상태(`no_reaction`/`already_reacted`만 허용), 메시지별 직렬화 페인트, 라이브 항목 축출 없음, reserved/claimed = 영수증만, failed/uncertain = `:warning:`+Retry(`ui_send_now`)+Cancel, 세션 forget 펜스(세대 카운터+직렬 삭제).
- 남은 nit(미반영, 원장): 헬퍼/표면 중복 WARN, `followupForgetGenerations` 미정리, 큐된 forget 삭제가 실행 시 소유권 재확인 안 함, 첫 페인트 중단 회귀 테스트 추가.
- 출하: PR #237 머지(6eeac00) → 프리뷰 배포 run 35319583747 (work-m16·fable 둘 다 `bot is running! [v0.2.1144 (6eeac00)]`).

## 실측 R1 (2026-09-18 16:42–16:49 KST, 2lab.ai `#workspace-soma-work`, Claude in Chrome)
| # | 절차 | 관측 | 판정 |
|---|---|---|---|
| R1-1 | `@봇 sleep 120` 턴 중 스레드 "체크B" | 봇 카드 없음. 내 메시지 리액션 = `✅ 1`만(inbox_tray는 스티어링 즉시 교체). 봇 로그 `item-steered` 07:46:32Z. 응답 `done 체크B` | PASS (§3-1) |
| R1-2 | 모델이 포그라운드 `sleep 100` 안에 있을 때 "체크C" → 내 메시지에 `:ui_cancel:` 클릭 | 봇 로그 `SLACK EVENT RECEIVED: reaction_added` 07:48:35Z → Cancel 정책 → 항목이 직전에 소비됨(`item-consumed` 07:48:35.2Z) → ephemeral `취소하지 못했습니다 — 이미 모델에 전달되어 실행 중입니다`. 리액션 = `✅ 1` + 유저 `ui_cancel 1` | PASS(전송로) / 취소 성공 케이스는 미관측 |
| R1-3 | `queue` 텍스트 행 | (이번 세션 미실행 — 단위 테스트 2건) | n/a |
| 전제 | 2lab.ai: 커스텀 이모지 2개 등록, dev 앱 `reaction_added` 구독 | 완료 | — |
| 전제 | iq 워크스페이스: 이모지 2개(유저가 직접 추가 중) + iq 앱 `reaction_added` 구독 | **미완** — prod 배포 전 필수 | — |

## 라운드 2 — 유저 정정 → 재출하 (2026-09-18 17:00–17:45)
- 정정 원문: "이거 센드 나우나 캔슬할 시간을 안주네 … 스티어링 대기중인거 캔슬 못하게 해놨네" / "아니 대기중인게 왜 스티어링된거야 아직 메세지큐에 쌓인거지". 코드 상태 `steered`(SDK 입력 채널 push)를 유저 어휘 "스티어링됨"으로 오매핑해 대기 중 메시지의 컨트롤을 없앴음(가정 A1). 개입 원장 jargon-or-output-mismatch + using-dotprd "상태 어휘 번역표" 계약 승격.
- PR #239 머지(9f4a164): `steered` = 큐 대기(📥+Send now+Cancel 유지), `resolved`(모델이 읽음)에만 전달완료. 리뷰 merge-with-nits(필수 없음). 프리뷰 run 35323762282, 양 대상 `bot is running! [v0.2.1145 (9f4a164)]`.

## 실측 R2 (2026-09-18 17:34–17:42 KST, 2lab.ai, Claude in Chrome, v0.2.1145)
| # | 절차 | 관측 | 판정 |
|---|---|---|---|
| R2-1 | `@봇 포그라운드 sleep 150` 턴 중 스레드 "체크D" | 보내자마자 내 메시지에 `📥 1` `ui_send_now 1` `ui_cancel 1` (봇 카드 없음) | PASS (TO-BE 그대로) |
| R2-2 | `ui_cancel` 클릭(2) | 즉시 `📥`·`ui_send_now` 제거, 봇 `ui_cancel` 제거(2→1), `🚫 1` 추가; ephemeral `취소했습니다 — 모델에 전달되기 전에 회수했습니다`; 큐 행 `#1 cancelled 사용자가 취소`; 이후 응답에 체크D 없음 | PASS |
| R2-3 | 유저(Z)가 "1234" 후 `ui_send_now` 클릭(08:39:43Z), 다시 "체크E" 후 클릭(08:40:30Z) | 봇 로그 각각 `reaction_added` → `item-unsteered` → `Aborted session user-interrupted` → `run-started`; 응답 `done 체크E`; 큐 행 `#3 resolved`. 첫 항목(#2 "1234")은 두 번째 Send now가 그 실행을 끊어 `uncertain user-interrupted` → `⚠️ + Retry/Cancel` 표시 | PASS (Send now 전송로·정산 규칙대로) |
| R2-4 | 같은 계정으로 이미 눌린 `ui_send_now` 재클릭 | `reaction_removed`만 발생(무시) — 이벤트 없음. 봇 결함 아님 | n/a |
증거: 스크린샷 `reaction-ui-live-2026-09-18/` 45–52, 봇 로그 08:37–08:41Z, 큐 스토어 rows.
