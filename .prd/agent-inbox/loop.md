# loop — Agent inbox 보드 + Slack 미니멀

Status: in-progress · 스펙 = [`../10-agent-inbox-board-spec.md`](../10-agent-inbox-board-spec.md) · SSOT = [`ssot.md`](ssot.md)

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

## 라운드 1 — 계획 (2026-10-16)
| WU | 브랜치 · 워크트리 | 스코프 | 소유 파일 |
|---|---|---|---|
| WU-S Slack 미니멀 | `feat/slack-minimal-worklog` · `.worktrees/feat-slack-minimal-worklog` | §3.2 전부 + §3.3 방출 훅 | `packages/slack/src/output-flags.ts`, `work-log.ts`(신규), `stream-processor.ts`, `pipeline/stream-executor.ts`, `tool-event-processor.ts`, `src/deploy/migrate-all-users-minimal-once.ts`(신규), `src/index.ts`(이관 배선만) + 테스트 |
| WU-W 작업 로그 서버 | `feat/dashboard-worklog-api` · `.worktrees/feat-dashboard-worklog-api` | §3.3 저장·API·WS, §3.4-3 로그인 복귀 | `src/conversation/work-log.ts`(신규), `work-log-routes.ts`(신규), `web-server.ts`, `dashboard.ts`(서버 쪽 broadcast 함수만, 템플릿 금지), `oauth.ts`, `src/index.ts`(provider 배선만) + 테스트 |
| WU-L 스레드 링크 | `feat/thread-dashboard-link` · `.worktrees/feat-thread-dashboard-link` | §3.4-1·2 | `packages/slack/src/thread-header-builder.ts`, `surface-config.ts`, `pipeline/session-initializer.ts`, `config.default.json`, `src/index.ts`(URL provider 배선만) + 테스트 |
| WU-D 보드 UI | `feat/agent-inbox-dashboard` · `.worktrees/feat-agent-inbox-dashboard` | §3.1, §4, §5 | `src/conversation/dashboard.ts` 템플릿(CSS·HTML·클라이언트 JS) + 대시보드 테스트 |

머지 순서: WU-S → WU-W → WU-D → WU-L (2026-10-16 변경 — WU-D가 `?session=` 소비자를 가지므로 링크를 내보내는 WU-L보다 먼저; WU-D는 작업 로그 API를 소비).

## 열린 gap
| ID | 갭 | 상태 |
|---|---|---|
| G1 | 보드 3칸·카드·펼침·List·반응형 (§3.1, §5) | open |
| G2 | 모션 계약 (§4) — FLIP 이동 프레임 시퀀스 리시트 | open |
| G3 | 3a 이관 n/N·m/M 로그 (§3.2-1) | open |
| G4 | minimal 스레드 = 헤더·task·최종 답변만 (§3.2-2~5) | open |
| G5 | 작업 로그 저장·API·WS·패널 (§3.3, §3.1-7) | open |
| G6 | 스레드 맨 위 링크 + 로그인 복귀 (§3.4) | open |
