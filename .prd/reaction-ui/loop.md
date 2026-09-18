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
| 카드 → 리액션 | 구현(WU2, `src/slack/followup-reactions.ts` + 호스트 `syncFollowupReactions`), 실측 대기 |
| 리액션 컨트롤 | 구현(WU1 라우터 `reaction_added` + WU3 `handleFollowupReactionControl`, 버튼과 같은 정책), 실측 대기 |
| 커스텀 이모지 등록 | 완료 2026-09-18 15:10 — 2lab.ai에 `:ui_send_now:` `:ui_cancel:` 등록(Chrome, "has been added and is ready for use") |
| 앱 `reactions:read` + `reaction_added` | 완료 — 2lab.ai dev 앱 스코프에 `reactions:read` 기존재(auth.test 헤더), `reaction_added` 봇 이벤트 구독 추가·저장(재설치 불필요). **production(iq) 앱은 미적용** — prod 배포 전 같은 두 항목 + 커스텀 이모지 2개 필요 |
| `queue` 명령 카드 | 버튼 제거(텍스트 행) — 컨트롤은 리액션만 |
