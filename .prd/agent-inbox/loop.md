# loop — Agent inbox 보드 + Slack 미니멀

Status: done · 스펙 = [`../10-agent-inbox-board-spec.md`](../10-agent-inbox-board-spec.md) · SSOT = [`ssot.md`](ssot.md)

## 게이트 (build facts)
- 워크트리마다: `npm run build --workspace @soma/slack` → `npx vitest run <touched test files>` → `npm run lint`(tsc --noEmit + biome).
- 머지 전 1회: `npm test` 전체.
- 프리뷰 배포 = `main`을 `deploy/dev`로 머지하는 PR(최근 예: PR #276) → `deploy.yml` → 대상별 `grep 'bot is running' /opt/soma-work/dev/logs/stdout.log | tail -1`.

## 고정 이음매 (스펙 §3.3·§3.4 축자 — WU는 이 이름만 쓴다)
| 이음매 | 이름 |
|---|---|
| 작업 로그 타입 | `packages/slack/src/work-log.ts`: `WorkLogKind`, `WorkLogInput`, `WorkLogEntry` |
| 방출 훅 | `StreamContext.workLog?: (entry: WorkLogInput) => void` |
| executor provider | `streamExecutorProviders.appendWorkLog(conversationId, entry)` (기본 no-op) |
| 저장 | `src/conversation/work-log.ts`: `appendWorkLog(conversationId, input) → Promise<WorkLogEntry>`(디스크 기록 후 resolve, WS 방송도 그 시점), `readWorkLog(conversationId, { afterSeq?, limit? }) → Promise<{ entries, hasMore }>`, 파일 `${DATA_DIR}/worklogs/<conversationId>.jsonl` |
| API | `GET /api/dashboard/session/:conversationId/worklog?afterSeq=&limit=` → `{ entries, hasMore }` (afterSeq 있음 = 그 뒤 첫 limit개·hasMore=더 새 것 있음, `afterSeq=0` = 처음부터; 없음 = 마지막 limit개·hasMore=더 오래된 것 있음). 읽기 = 세션 소유자 + 관리자만(그 외 403, 소유자 없는 대화 = 관리자만), 형식이 틀린 파라미터 = 400 |
| seq | 대화마다 엄격히 증가하되 영구히 건너뛸 수 있다(사이드카가 1000개 단위로 예약, 손상 파일 격리 후 다음 예약 블록부터). 클라이언트 커서는 서버가 확인한 값으로만 전진한다 |
| WS | `{ type: 'work_log', conversationId, entry }` |
| 딥링크 | `/dashboard/<ownerId>?session=<sessionKey>` |
| URL provider | `getDashboardSessionUrl(ownerId, sessionKey): string \| undefined` (src: `src/conversation/web-server.ts`, 뷰어가 listen 중이 아니면 undefined) |
| 헤더 필드 | `dashboardLink`, 라벨 `📋 작업 로그` |
| 로그인 복귀 | 쿠키 `soma_next`(값은 `/dashboard`로 시작하는 같은 출처 경로만) |

## 다음 착수점 · 대기
- 칸 행 G1–G6 전부 닫힘(`loop.done.md` R1·R2). 이 워크스트림의 다음 라운드는 새 결함·새 요구가 생길 때만 연다.
- 대기(유저 게이트): 정식 배포(prod)는 유저가 정한다.
- 범위 밖(2026-10-19 유저 지시, `ssot.md` §스코프 변경): t1 배포. Deploy run 38912315787의 t1 작업은 2026-10-17 14:02Z에 취소돼
  다시 돌지 않는다. 러너가 돌아온 뒤 t1을 대상에 포함한 `deploy/dev` 배포(push 시 대상 지정 없음 = 설정된 전 대상)가 성공하면 t1은
  새 빌드를 받고, 그 기동에서 마커가 없으면 3a 1회 이관이 돈다(2026-10-17 t1 실측: 마커 없음, v0.2.1156). 이관 결과는 그 기동 뒤 확인한다.
