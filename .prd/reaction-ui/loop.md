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

## 검증 (관측 기반)
- 09 스펙 §3 인수 기준 1–6을 2lab.ai Slack에서 Claude in Chrome으로 실측, 스크린샷 + 봇 로그.

## gap matrix
| 갭 | 상태 |
|---|---|
| 카드 → 리액션 | 미착수 |
| 리액션 컨트롤 | 미착수 |
| 커스텀 이모지 등록 | 이미지 생성됨(`reaction-ui/assets`), 등록 미착수 |
| 앱 `reactions:read` + `reaction_added` | 확인 미착수 |
