# loop — env-access 구현 드라이브

Status: in-progress (라운드 1 — WU0–WU5 · WU6a 머지, WU5 라이브 통과 2026-11-13, WU6b는 운영자 단계 대기) · AS-IS = [`../23-env-access-as-is.md`](../23-env-access-as-is.md) ·
TO-BE = [`../24-env-access-to-be.md`](../24-env-access-to-be.md) · 아키텍처 = [`../25-env-access-architecture.md`](../25-env-access-architecture.md) ·
ssot = [`ssot.md`](ssot.md)

## 라운드 1 — 설계 문서 · 에픽 · WU1 착수 (2026-11-12 열림)

계획: WU0(이 문서들)을 PR로 올린다 → 에픽 #1207과 서브이슈 #1208–#1214 (만듦, 2026-11-12) → WU1부터 PR 하나씩.

| ID | WU | Status | 이슈 | 브랜치 | 스코프 | 끝상태 확인 |
|---|---|---|---|---|---|---|
| WU0 | 설계 문서 | ✅ | #1208 | `docs/env-access-prd` (PR #1215 머지) | `.prd/23-25`, `.prd/env-access/` | PR 머지 |
| WU1 | 비밀 저장소 + 전원 거부 + fail-closed 샌드박스 | ✅ | #1209 | `feat/env-access-secrets` (PR #1218 머지, dev 배포·실측 2026-11-12) | 25 §5 WU1 | 25 §5 WU1 + dev 실측 |
| WU2 | 어드민 샌드박스 프로필 + 어드민 쓰기 경계 + ssh는 MCP로만 | ✅ | #1210 | `feat/env-access-admin-sandbox` (PR #1240 머지, dev v0.3.32 배포·실측 2026-11-13 — 결과는 #1210 댓글) | 25 §5 WU2 + #1218 리뷰가 넘긴 두 길(`sandbox off` Bash, 배포 설정 쓰기) | 25 §5 WU2 + 두 길의 적대적 테스트 |
| WU3a | 환경 사용자(`envUser`) + `gh_pr`(view·approve·merge) + 감사 원장 + 비어드민 거부 | ✅ | #1211 | `feat/env-access-env-users` (PR #1248 머지 `046d77a08`, #1211 닫음 2026-11-13; dev 실측은 dev 배포 뒤) | 25 §5 WU3 중 gh·원장 | 조건 충족 PR만 승인·머지, 원장 의도→결과, dev 실측 |
| WU3b | `login`(환경 계정 → 세션). `$env:<id>:<skill>` 호출·별도 스킬 저장소는 WU4가 대체 — 환경 스킬 = 환경 플러그인 스킬을 server-tools `skills`로 묶음, 이전은 WU5 | ✅ | #1211 | `feat/env-access-login` (PR #1250 머지 `ac89e9142`; dev 실측은 dev 배포 뒤) | 25 §5 WU3 나머지 | `login` 세션으로 환경 API 200(dev 실측), 비밀번호·세션이 원장·오류에 없음(`server-tools-login.test.ts`) |
| WU4 | 환경 grant + 4버튼 + 정책 단계 | ✅ | #1212 | `feat/env-access-env-grants` (PR #1249 머지 `07896281b`, #1212 닫음; 흐름 테스트 6건 증거는 #1212 댓글; 라이브는 고객 dev 호스트 환경 절 설정 뒤) | 환경 = server-tools `envUser`+`skills`, `perEnvironment` grant, 카드 수락·거절·이 스킬 항상·이 환경 전체 항상, 환경 서버의 server-tools는 그 환경 grant로 | 비어드민 카드 1장 → "환경 전체 항상" → 다음 카드 0장 (`env-skill-approval-flow.test.ts`), dev 실측 |
| WU5 | 배포·QA 스킬 이전 + 배포 → QA 연결 | ✅ | #1213 (닫음 2026-11-13) | `feat/env-access-skills` (PR #1251 머지) → SSOT_5로 바뀐 길: 환경 유저 = 샌드박스 없는 어드민, 기존 다른 유저 스킬·크론 실행 요청 흐름 (PR #1271 머지 `2f221fbf3`) + 라이브에서 나온 고침 PR #1274(메모리 저장소가 `env:` ID를 받음, 머지 `2af59ebea`) | 환경 유저 `env:<org>-dev2` · `env:<org>-stage0`의 개인 스킬(deploy·QA)과 stage0 크론 owner = `env:<org>-stage0` | 고객 dev 호스트 라이브: 비어드민 요청 → 어드민 DM 카드 4버튼 → "전체 항상" → 새 스레드 `env:<org>-dev2` 세션(샌드박스 꺼짐) → 환경 계정 로그인·QA pass(17:59–18:13 UTC) · 다음 호출은 카드 없음 |
| WU6 | 브로커 제거 | 🟡 | #1214 | 6a `feat/env-access-cf` (PR #1252 머지 `d7e771ebb`) → 6b `chore/env-access-remove-broker` (PR #1253 draft — 운영자 단계 뒤 머지) | 6a: server-tools `cf_api`(환경 범위 토큰, 존 한정, 쓰기 원장) — 브로커 임대 대체. 6b: 운영자가 토큰을 `secrets/`로 옮기고 브로커 `uninstall.sh`를 돌린 뒤 `packages/devops-broker`·`devops-tools`·`src/devops`·대시보드 카드·`deploy.prompt`/QA 스킬의 브로커 경로 삭제(가드의 브로커 경로는 호스트 정리 뒤) | 정기 작업 봇 PR 승인 카드 0장, 배포 번들 하나 |

## 라이브 확인 (2026-11-13, 고객 dev 호스트)

- 1차 15:31 UTC: 카드 → 어드민 "전체 항상" → 핸드오프 · 새 스레드 · 샌드박스 꺼짐까지 통과, 모델 호출 전에
  `Invalid userId for memory storage: env:<org>-dev2`로 실패 → PR #1274.
- 2차 15:58 UTC 요청: 카드 없이 실행. Claude 풀 429(호스트 전체)로 두 번 미뤄진 뒤 17:59 자동 재시도에서 18:13까지 돌아
  QA 레인 잠금 · git 수집 · 환경 계정 로그인 · API · 화면 · Jira 코멘트 · 리포트 업로드를 마침. 판정 pass.
- stage0 크론 owner는 `env:<org>-stage0` (첫 실행 11-14 19:00 UTC).
- 워크플로 점검에서 나온 것: 크론 tick이 새 스레드 크론의 턴 전체를 기다려, 20:00 UTC 정기 작업이 6–8시간 도는 동안
  다른 크론 약 10개가 catch-up 창(60분) 밖으로 밀려 매일 사라졌다(11-07부터) → PR #1275.
- 11-14 사고: 1단계 실행 뒤 플릿 배포가 `secrets/`를 통째로 지웠다(`deploy/protected-paths.txt`에 없었다, WU1부터).
  비밀을 못 푼 dev2 · stage0이 server-tools에서 빠져 dashboard에서 띄운 QA가 `Unknown server: dev2`로 멈췄다 → PR #1290
  (목록에 `secrets/` + 동작 테스트, rsync 제외 패턴을 최상위로 고정 — `data/`가 ui-ux 스킬의 `data/`까지 빼고 있었다).
  운영자 스크립트는 배포본 목록에 `secrets/`가 없으면 1단계를 거부하고, 새 Cloudflare 토큰이 살아 있으면 옛 `soma-env-<env>-*`를 지운다.
- 같은 QA가 Z 세션(샌드박스)에서 돈 이유: 대시보드 `$` 메뉴에 환경 유저 스킬이 없어 환경 플러그인 스킬(`$<org>-env:post-deploy`)을 골랐다
  → PR #1291(메뉴에 `$<env>:<skill>`을 환경 이름 묶음으로). 손으로 친 `$<env>:<skill>`은 대시보드에서도 이미 핸드오프된다.

## 열린 질문

| ID | 질문 | Status | 기본값 |
|---|---|---|---|
| Q1 | 컨테이너 배포처럼 샌드박스를 띄울 수 없는 호스트에서 `failIfUnavailable: true`를 어떻게 다룰지 | 🟡 | WU1에서 배포 대상 호스트별로 샌드박스 가능 여부를 실측하고, 불가한 곳은 배포 설정으로 명시적으로 끄게 한다(조용한 fail-open 금지) |
| Q2 | 고객 레포 배포 브랜치에 PR 승인 규칙을 걸지 (24 §6 남는 위험) | 🚪 | 어드민 결정 대기. 이번 스코프 밖 |

## 게이트 (build facts — WU1에서 실측해 갱신)

25 §6.

- **출시 게이트 (PR #1218 리뷰 R4, 2026-11-12):** 실제 비밀은 WU2(#1210)가 배포되고 그 적대적 테스트가 통과한 뒤에
  `secrets/`로 옮긴다. 그 전에는 어드민이 샌드박스를 끈 세션의 Bash, 어드민 모델이 배포 설정을 고쳐 참조를 돌리는 길이 남아 있다.
  **2026-11-13 갱신:** WU2가 배포돼도 게이트는 닫힌 채다 — 세부를 비공개로 둔 샌드박스 탈출 두 건(#1242, #1241)이 고쳐지고
  dev에서 확인될 때까지. 둘 다 #1240 이전부터 main에 있던 것이고 #1240이 넓히지 않는다.
  **2026-11-13 정정 — 게이트는 닫힌 채다.** v0.3.34(PR #1260) 배포 뒤 첫 세션만 시작됐고, 그 뒤 모든 세션이
  `session-project-config must stay empty but holds .claude`로 거부됐다. CLI 2.1.321은 샌드박스를 초기화할 때마다
  프로젝트 설정 루트에 원자적 쓰기 스테이징 디렉터리 `.claude/.cc-writes`(0700)를 만드는데, #1244의 검사가 "완전히 빈"
  루트만 받았기 때문이다. dev는 v0.3.32로 롤백됐다. 첫 세션에서 잰 "실측 통과"(#1242 설정 경로, #1241 npx 로그 0개)는
  두 번째 세션 시작을 보지 않은 확인이라 철회했다(#1242 다시 열림, 정정은 각 이슈 댓글). 교훈: 세션 시작에 걸린 수정의
  라이브 확인은 세션 둘 이상의 시작으로 한다. 샌드박스 안에서 도는 프로브는 CLI의 샌드박스 초기화가 실패해 이 디렉터리를
  만들지 않으므로, 이런 부류는 호스트에서 잰다.

- **WU2 리뷰가 남긴 후속 (PR #1240):**
  - #1242: 세션 시작 때 CLI가 읽는 파일을 통한 샌드박스 탈출 → `projectConfigRoot`를 빈 `DATA_DIR` 디렉터리로(브랜치 `fix/env-access-1242`).
    첫 시도(시작 전 격리 + 쓰기 거부)는 리뷰에서 같은 유저의 다른 세션이 가드와 시작 사이에 다시 심을 수 있어(fable R1) 버렸다.
  - 어드민 샌드박스 실측(2026-11-13)에서 나온 것:
    - `ps`·`pgrep` 막힘(sysmond) — 세션 안 `verify-restart`가 멈춘다.
    - `.git/config` 쓰기 막힘 — upstream 추적 설정 불가(`git switch -c … --no-track`, `git push`로 우회).
    - 세션 안에서 soma-work 전체 테스트를 돌리면 다른 `/tmp/<uid>`를 쓰는 테스트들이 EPERM으로 실패한다(CI는 샌드박스 밖이라 영향 없음)
      — 테스트 하네스가 `os.tmpdir()` 아래만 쓰게 고칠 후보.
    - ssh 금지 판정(soma-lib `isSshCommand`, `\bssh\b`)이 명령 글자 어디든 ssh라는 단어가 있으면 막는다(grep 패턴, 커밋 메시지,
      문서 heredoc). WU2 전에는 어드민이 빠져 있어 드러나지 않았다 → 명령 위치만 보는 판정으로 바꾸는 별도 PR.
  - #1241(세부 비공개): stdio MCP 런처가 샌드박스 밖에서 모델이 쓸 수 있는 설정을 읽는다. 캐시를 `options.env`로 옮기는 고침은
    같은 부류라 쓰지 않는다(astra R2).
  - 샌드박스 세션의 모델에게 "홈 캐시는 읽기 전용, 설치는 `--cache /tmp/{uid}/npm`"을 알리는 프롬프트 한 줄(fable R3 P2).
    지금은 CLI의 Bash 도구 설명에 나오는 샌드박스 쓰기 목록으로만 알 수 있다.
  - `ssh_exec`를 비동기 `spawn`으로(review-of-legends R4 P2; 타임아웃·출력 초과 때 원격 명령이 남을 수 있다는 안내는 #1240에 들어감). 지금은 server-tools의 `logs`처럼 `spawnSync`라서,
    최대 600초 동안 그 세션의 다른 server-tools 호출이 멈춘다(server-tools는 세션마다 따로 뜨는 stdio 자식이다).
  - 쓰기 보호·자격 파일 읽기 금지는 CLI가 거부 규칙을 훅보다 먼저 적용한다는 사실에 기댄다(spec 07 §6a-2, 실측 2.1.321).
    CLI를 올릴 때마다 `scripts/verification/probe-cli-deny-before-hooks.mjs`를 다시 돌린다.

## 다음 착수점

WU0–WU5 · WU6a · #1242 · #1241 머지(2026-11-13). dev는 v0.3.32로 롤백된 상태다. 남은 것:
0. #1242 시작 검사 수정: 루트에 CLI 자신의 `.claude/.cc-writes`만 허용하고 그 밖은 거부한다. 수정이 머지되기 전에는 추가 배포를 하지 않는다. 머지 뒤 dev 재배포 → 세션 둘 이상의 시작 + #1242 · #1241 재확인 → 출시 게이트 열림.
1. 샌드박스 권한 번들(sandbox off를 능력별로 나눠 어드민이 유저 · 어드민 그룹 · 전체에 grant) — 플랜 A/B 유저 선택 대기.
2. 운영자: 고객 dev 호스트 `config.json` `server-tools.<dev2|stage0>`에 `envUser` · `skills` · `github`(`$secret` · `repos` · 조건표 · `readRefs` = 통합·배포 브랜치) · `web.logins` · `cloudflare`(`$secret` · `zones`, 필요하면 `parts` — rulesets · firewall · filters · pagerules · custom_hostnames · healthchecks는 다른 시스템 자격이 담길 수 있어 opt-in), 고객 스킬 저장소 QA 프로필 `github.server` · `qaEnv.logins`, 토큰 · 비밀번호 → `secrets/`.
3. 라이브: 비어드민 `$<env>:post-deploy` → 어드민 카드 4버튼 → "환경 전체 항상" → 다음 카드 0장 · dev2 배포 → QA 리포트(비밀번호 노출 0).
4. 운영자(고객 dev 호스트 하나 — owner-mac에는 브로커 없음): #1290 배포 → 운영자 스크립트 1단계 다시(토큰 → `secrets/`, 환경별 Cloudflare 토큰, config 참조; 브로커 유지) → #1286 배포 뒤 환경 유저의 `gh_pr` 쓰기 첫 성공(`env-audit.jsonl` done) → 2단계 `--uninstall`(브로커 Slack 봇 토큰 revoke, `uninstall.sh --purge`, launchd not found) → #1253(WU6b) 머지 → #1214 닫기 → 가드의 브로커 경로 정리.
5. 원격 셸 금지 오탐: 셸 파서로 좁히는 #1245는 리뷰마다 새 우회가 나와 보류(draft). 경계를 샌드박스로 옮기는 #1255로 간다.
