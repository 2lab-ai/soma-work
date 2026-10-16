# Agent inbox 보드 + Slack 미니멀 — done (append-only)

Loop: [`loop.md`](loop.md) · 라운드를 닫을 때마다 맨 아래에 블록 하나를 붙인다. 위쪽은 바꾸지 않는다(`loop-lint.py` C2가 git 기준으로 확인).
행은 옮긴 시점의 스냅샷이다. 나중 재측정 통과는 loop.md 라운드 절의 `re-verified` 줄, 실패는 loop.md 새 행(Source `regression:<ID>`).

## R1 — closed 2026-10-16T19:05+09:00

- measured G2✅ G3✅ G6✅ · G1·G4·G5는 프리뷰 실측에서 결함이 나와 R2로 넘김(loop.md) · 코드 = PR #281(WU-S) · PR #283(WU-W·WU-D·WU-L, #282를 픽스처 키 중립화로 재구성) → main `b4562525` → 프리뷰 PR #284 → `deploy/dev` `bea5adfc`(v0.2.1158), Deploy run 38881174587 t2·t3 success

### Closed rows

| ID | 갭 | Status | 검증 증거 (v0.2.1158) |
|---|---|---|---|
| G2 | 모션 계약 (§4) — FLIP 이동 프레임 시퀀스 리시트 | ✅ | t2 보드 1280px에서 rAF마다 `.card.is-flying` 상자를 기록: RUNNING→DONE 카드 x 441→859, 333ms 동안 중간 표본 19개(ease-in-out 곡선), 65초 뒤 DONE→RUNNING 역방향 이동도 관측. 비행 중 프레임에서 카드가 그림자를 띄운 채 칸 사이에 있고 출발 칸 카드는 올라오고 도착 칸 카드는 내려간다 — 레퍼런스 2.4s 프레임과 대조 시트 |
| G3 | 3a 이관 n/N·m/M 로그 (§3.2-1) | ✅ | t2 봇 로그 `applied (migrated users 13/17, sessions 141/141, marker=…/.all-users-log-minimal-once-2026-10-16.json)` · t3 `migrated users 3/4, sessions 0/0` · t3 재기동(launchctl kickstart) 후 `skipped` |
| G6 | 스레드 맨 위 링크 + 로그인 복귀 (§3.4) | ✅ | 배포 후 활성 스레드 헤더에 `:clipboard: <…/dashboard/<owner>?session=work%3A<channel>%3A<ts>\|작업 로그>` + 헤더 프리셋 1회 이관 로그 `threadheader dashboardLink one-time migration: migrated (arrays changed 3, …)`(t2·t3) · 쿠키 없이 딥링크 → `302 location: /login` + `set-cookie: soma_next=%2Fdashboard%2F…; HttpOnly; SameSite=Lax; Max-Age=1800` · `/login`에 `Slack 스레드에서 dashboard를 입력하면 로그인 링크를 받습니다` · SSO 착지는 `login-return.test.ts` |

### Round section (as it was in loop.md)

## 라운드 1 — 계획 (2026-10-16)
| WU | 브랜치 · 워크트리 | 스코프 | 소유 파일 |
|---|---|---|---|
| WU-S Slack 미니멀 | `feat/slack-minimal-worklog` · `.worktrees/feat-slack-minimal-worklog` | §3.2 전부 + §3.3 방출 훅 | `packages/slack/src/output-flags.ts`, `work-log.ts`(신규), `stream-processor.ts`, `pipeline/stream-executor.ts`, `tool-event-processor.ts`, `src/deploy/migrate-all-users-minimal-once.ts`(신규), `src/index.ts`(이관 배선만) + 테스트 |
| WU-W 작업 로그 서버 | `feat/dashboard-worklog-api` · `.worktrees/feat-dashboard-worklog-api` | §3.3 저장·API·WS, §3.4-3 로그인 복귀 | `src/conversation/work-log.ts`(신규), `work-log-routes.ts`(신규), `web-server.ts`, `dashboard.ts`(서버 쪽 broadcast 함수만, 템플릿 금지), `oauth.ts`, `src/index.ts`(provider 배선만) + 테스트 |
| WU-L 스레드 링크 | `feat/thread-dashboard-link` · `.worktrees/feat-thread-dashboard-link` | §3.4-1·2 | `packages/slack/src/thread-header-builder.ts`, `surface-config.ts`, `pipeline/session-initializer.ts`, `config.default.json`, `src/index.ts`(URL provider 배선만) + 테스트 |
| WU-D 보드 UI | `feat/agent-inbox-dashboard` · `.worktrees/feat-agent-inbox-dashboard` | §3.1, §4, §5 | `src/conversation/dashboard.ts` 템플릿(CSS·HTML·클라이언트 JS) + 대시보드 테스트 |

머지 순서: WU-S → WU-W → WU-D → WU-L (2026-10-16 변경 — WU-D가 `?session=` 소비자를 가지므로 링크를 내보내는 WU-L보다 먼저; WU-D는 작업 로그 API를 소비).
