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

## 라운드 2 — 프리뷰 실측 결함 (2026-10-16)
R1 리시트(`loop.done.md` R1)를 v0.2.1158 프리뷰에서 뜨다가 나온 결함 3건. 칸 행 G1·G4·G5는 이것이 닫힐 때 함께 닫는다.

| WU | 브랜치 · 워크트리 | 결함 | 소유 파일 |
|---|---|---|---|
| WU-B 스킬 배너 | `fix/minimal-skill-banner` · `.worktrees/fix-minimal-skill-banner` | minimal 스레드에 `$skill`/자동 스킬 RPG 배너가 게시됨(배포 직후 활성 스레드 실측) — `SKILL_INVOCATION` 마스크를 안 봄 | `src/slack/commands/skill-force-handler.ts`, `src/slack-handler.ts`(배너 게이트만), `docs/misc/guides/verbosity-matrix.md` + 테스트 |
| WU-T 상단 바·작업 로그 행 | `fix/dashboard-topbar-worklog` · `.worktrees/fix-dashboard-topbar-worklog` | 820px에서 상단 바 줄바꿈, 390px에서 라벨 잘림 · 작업 로그 도구 행에 도구명이 두 번(`▸ Read Read …`, `✓ Glob Glob ok`) | `src/conversation/dashboard.ts` 템플릿(`.topbar` CSS, `renderWorkLogEntry`) + 대시보드 테스트 |

## 열린 gap
| ID | 갭 | Status | R2 남은 일 |
|---|---|---|---|
| G1 | 보드 3칸·카드·펼침·List·반응형 (§3.1, §5) | 🟡 | 보드는 1280/820/390 실측 통과, 상단 바(WU-T) 재캡처 |
| G4 | minimal 스레드 = 헤더·task·최종 답변만 (§3.2-2~5) | 🟡 | 서술·도구 메시지 없음은 실측 통과, 스킬 배너(WU-B) |
| G5 | 작업 로그 저장·API·WS·패널 (§3.3, §3.1-7) | 🟡 | 딥링크 패널 64항목·실시간 증가 실측 통과, 도구 행 중복(WU-T) |
