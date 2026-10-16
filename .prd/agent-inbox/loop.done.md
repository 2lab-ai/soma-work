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

## R2 — closed 2026-10-16T23:40+09:00

- measured G1✅ G4✅ G5✅ · 코드 = PR #285(WU-B 알림 게이트 · WU-T 상단 바·작업 로그 행) → main `291472fa` → 프리뷰 PR #286 → `deploy/dev` `31d535b0`(v0.2.1159), Deploy run 38912315787 prepare·t2·t3 success(t1은 러너 오프라인으로 대기)

### Closed rows

| ID | 갭 | Status | 검증 증거 (v0.2.1159) |
|---|---|---|---|
| G1 | 보드 3칸·카드·펼침·List·반응형 (§3.1, §5) | ✅ | t2 봇 로그 `bot is running! [v0.2.1159 (31d535b)]` 14:03:01Z · 보드 1280/1024/820/390px 전부 `scrollWidth == innerWidth` · 상단 바 대조 시트: 1280·1024 한 줄(라벨 온전), 820 두 줄(nav 다음 줄), 390 상태 점 + 44px 터치 대상(라벨 온전) |
| G4 | minimal 스레드 = 헤더·task·최종 답변만 (§3.2-2~5) | ✅ | 헤더 `:mute: minimal` 스레드에서 배포(23:03:09 KST 재시작 알림) 뒤 Slack 답글에 `🔄 Goal not yet complete`가 없고, 같은 대화 작업 로그에 `notice` seq 1001 ts 1792159399429 `🔄 Goal not yet complete (eval-model verdict)…` 기록 — 같은 시간대 다른 대화 3건의 작업 로그에도 `notice` 기록 |
| G5 | 작업 로그 저장·API·WS·패널 (§3.3, §3.1-7) | ✅ | `?session=` 딥링크 → 카드 펼침 + 패널 열림, 작업 로그 500항목(limit 창) · 도구 행 `▸mcp__model-command__run{…}` / `✓mcp__model-command__runok` — 도구명 1회 |

### Round section (as it was in loop.md)

## 라운드 2 — 프리뷰 실측 결함 (2026-10-16)
R1 리시트(`loop.done.md` R1)를 v0.2.1158 프리뷰에서 뜨다가 나온 결함 3건. 칸 행 G1·G4·G5는 이것이 닫힐 때 함께 닫는다.

| WU | 브랜치 · 워크트리 | 결함 | 소유 파일 |
|---|---|---|---|
| WU-B 스킬 배너 | `fix/minimal-skill-banner` · `.worktrees/fix-minimal-skill-banner` | minimal 스레드에 `$skill`/자동 스킬 RPG 배너가 게시됨(배포 직후 활성 스레드 실측) — `SKILL_INVOCATION` 마스크를 안 봄 | `src/slack/commands/skill-force-handler.ts`, `src/slack-handler.ts`(배너 게이트만), `docs/misc/guides/verbosity-matrix.md` + 테스트 |
| WU-T 상단 바·작업 로그 행 | `fix/dashboard-topbar-worklog` · `.worktrees/fix-dashboard-topbar-worklog` | 820px에서 상단 바 줄바꿈, 390px에서 라벨 잘림 · 작업 로그 도구 행에 도구명이 두 번(`▸ Read Read …`, `✓ Glob Glob ok`) | `src/conversation/dashboard.ts` 템플릿(`.topbar` CSS, `renderWorkLogEntry`) + 대시보드 테스트 |

### R2 기록
- WU-B 범위 확장(같은 미니멀 표면, 스펙 §3.2-5): 배포 직후 minimal 스레드에 `🔄 Goal not yet complete (eval-model verdict)`(Reason·Remaining 목록)도
  게시됨 → `🔄`·`▶️ Starting next queued goal`·`🤖 Autogoal`을 `STATUS_MESSAGE`(compact 이상)로 게이트. `✅ completed`·`⏸️`·`⏹️`는 전 수준 게시.
  6개 호출 지점 = `src/slack/session-notice.ts` 하나(전 수준 작업 로그 `notice` 기록, 플래그 있을 때만 게시). 세션 없는 `$skill` = 요청자 기본 수준.
- 리뷰(변경 묶음별 gpt-6-astra + opus): WU-B 둘 다 APPROVE(문서 3곳 + 느린 슬래시 테스트 import를 `beforeAll`로 — 반영 후 재확인 APPROVE).
  WU-T 3라운드 — 선택된 긴 유저 이름 하드컷, ≥1024px nav가 계정 묶음을 넘어 admin 토글 ON/OFF를 가림(클릭이 로그아웃으로), 셰브런 클릭 사각,
  WebKit 320px 가로 넘침, WebKit select 높이 18px — 전부 수정 후 둘 다 APPROVE. 리뷰어 자체 프로브 1,872 조합: 겹침·넘침·hit-test 실패 0.
- 게이트(합본 트리): build 0 · 대상 vitest(알림 8파일/178, 대시보드 4파일/257) · lint 0 · 브라우저 하네스 107/107(Chromium+WebKit, 320–1280px).
  전체 `npm test`의 5초 타임아웃 4건은 같은 부하(load avg 120–140)에서 Slack 변경 없는 트리도 실패(교대 A/B) — 부하 탓, CI는 green.
- PR #285 → main `291472fa`(scan·quality-gates·lean-verify pass) → 프리뷰 PR #286.

## 열린 gap
| ID | 갭 | Status | R2 남은 일 |
|---|---|---|---|
| G1 | 보드 3칸·카드·펼침·List·반응형 (§3.1, §5) | 🟡 | 보드는 1280/820/390 실측 통과, 상단 바(WU-T) 재캡처 |
| G4 | minimal 스레드 = 헤더·task·최종 답변만 (§3.2-2~5) | 🟡 | 서술·도구 메시지 없음은 실측 통과, 스킬 배너(WU-B) |
| G5 | 작업 로그 저장·API·WS·패널 (§3.3, §3.1-7) | 🟡 | 딥링크 패널 64항목·실시간 증가 실측 통과, 도구 행 중복(WU-T) |
