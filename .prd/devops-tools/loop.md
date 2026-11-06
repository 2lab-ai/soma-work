# loop — devops-tools 구현 드라이브

Status: in-progress (라운드 1 = 코드, 닫힘 · main 머지 `2da8f4e4` 2026-10-27 · 라운드 2 = 라이브: WU0 닫힘, WU7 실승인 1회 통과 2026-11-06 — 남은 것 = 버튼 토큰·`admin:org` 운영자 단계, WU8 = D6·D5 끝 · D1–D6 = ① 확정 2026-10-26) · AS-IS = [`../14-devops-tools-as-is.md`](../14-devops-tools-as-is.md) · TO-BE = [`../15-devops-tools-to-be.md`](../15-devops-tools-to-be.md) ·
아키텍처 = [`../16-devops-tools-architecture.md`](../16-devops-tools-architecture.md) · 상세 = [`research/2026-10-26-detail.md`](research/2026-10-26-detail.md) · ssot = [`ssot.md`](ssot.md) ·
완료 원장 = [`loop.done.md`](loop.done.md)

## 게이트 (build facts — 첫 구현 라운드에서 실측해 갱신)

`npm ci` → `npm run build`(biome check 포함) · `npx tsc --noEmit` · `npm test -- --maxWorkers=2` (sanitize 계약 포함) ·
`npm run smoke:mcp-bins` · `npm run smoke:deploy-bundle` · `bash scripts/verification/lean-verify.sh`(새 MCP 서버는
`verification/lean/SomaVerify/ImportGraph/Proofs.lean` 목록에 넣어야 통과, `import-graph.test.ts`는 커밋된 파일만 본다) ·
PR의 CI + **Sanitize Gate**(리시트는 PR 자신의 체크) · 외부 리뷰 = 작업 단위당 독립 리뷰어 1개 + 머지 전 trinity.
실측(2026-10-26, WU1): 브로커 패키지는 알파벳 순서상 process-shared보다 먼저 빌드돼 자기 build 스크립트에서 process-shared를 먼저 컴파일한다.
브로커 빌드 결과는 일반 deploy 번들에도 실리지만 실행되지 않는다(실행은 루트 소유 사본만).

## 다음 착수점

코드는 main에 있다(PR #465, 라운드 1 기록 = `loop.done.md`). 봇 설정에 `devops-tools` 절이 없으면 도구는 등록되지 않으므로,
설정을 넣은 봇(`work-m64` dev) 말고는 하드 거부(사람 gh 계정 키 꺼내기·키체인 덤프·브로커 경로 접근) 하나만 바뀐다. 순서:
1. 운영자 단계 1회(sudo 비밀번호 1번): 앱 수준 토큰(`connections:write`) 생성 → Slack 확인 → `ingest slack broker-app-socket` → 데몬 재시작 → 브로커 pid의 연결 1개 이상 확인. 같은 자리에서 org-admin 토큰을 `admin:org` 포함으로 다시 받아(버리는 gh 설정 폴더, 키체인 미사용) `ingest gh org-admin`.
2. 버튼 실클릭 1회(카드 → 승인 버튼 → lease → GET → revoke), `gh_org_member` 1회(현재 역할과 같은 `set-role`처럼 바뀌는 것이 없는 호출).
3. WU8 닫기 공지 확인 — 4주 grant 만료(2026-12-04) 전에 계속 쓰는 사용자의 연장 요청이 카드로 들어오는지. (stage0 포지키 = 끝, stage2 = 계획만 — 아래 "stage2 계획")

## 라운드 2 — 라이브 (2026-10-27 열림)

순서: WU0(닫힘, `loop.done.md`) → WU7 → WU8.

WU7 측정(2026-10-27, `work-m64` dev):
- 설치 1회차 = 점검표 FAIL 1(새로 만든 그룹에 "nested groups") → 원인 = macOS 15.6.1 `dscl . -read <레코드> <없는 속성>`이 stderr "No such key" + exit 0 → PR #491(조회 실패도 FAIL, 셈 실측화, 테스트 2건) 머지 `b21f07fb`.
- PR #491 브랜치 머리로 만든 묶음으로 재설치 = FAIL 0 · WARN 1(운영자 = 봇 유저, 운영자 결정) · 데몬 running · 소켓 `0660 _somadevops:soma-devops` · `check-policy` valid · 비밀 4개(gh 2 · Slack 앱 1 · Cloudflare dev2 1) 입력. 이동 경로(운영 콘솔 스크립트 기준): Slack·Cloudflare 키 = 발급 화면 Copy → 운영자 Mac 클립보드 → ssh stdin → `ingest`(직후 클립보드 비움), gh 토큰 = 대상 호스트 안 파이프(`gh auth token -u <계정>` → `ingest`). 파일·명령 인자·출력에 값을 쓰는 단계 없음. 첫 Cloudflare 입력은 시험 중 클립보드가 바뀌어 다른 값(43바이트)이 들어갔고, 길이 + Cloudflare verify(토큰 id·active) 확인 뒤 다시 입력해 덮어씀 → 클립보드 경유 입력은 verify 확인 후에만.
- 봇: `config.json`에 `devops-tools.permission`(도구 8개 = read) → `service.sh restart` + `verify-restart` 통과. 비관리자 세션 = "Permission-gated server blocked — no active grant", 관리자 = 전면 허용.
- 봇 유저에서 MCP 서버 직접 호출: `list` 정상, `gh_read` 두 계정 정상, `gh auth token` = `policy-denied`.
- 봇 모델 → `cf_lease_request` → 전용 앱 카드가 어드민 DM에 게시(요청→게시 약 2.4초) ×3, 모두 5분 만료 `not-approved (expired)` · 실행 0 · lease 0.
- 2026-10-28: 같은 시험 카드 2장과 다른 세션·다른 요청자의 실제 요청 카드(Cloudflare read lease 3, `gh pr review` 1)도 모두 만료. 최근 4장을 조회 시점(16:5x KST)에 `reactions.get`으로 본 결과 리액션 0. ✅ 이벤트를 브로커가 처리하는지는 아직 미검증. 어드민이 전용 앱 DM의 카드를 보는지가 열린 문제(아래 열린 질문).
- 2026-10-28 stage0: 운영 계정(그 계정의 Super Administrator)으로 계정 소유 포지키 생성 — 권한 = Account API Tokens Write 하나, 만료 없음, IP 조건 없음. 화면 캡처 없이 Copy 버튼 위치만 찾아 클릭 → 운영자 Mac 클립보드 → Cloudflare verify(토큰 id·active, 입력 직전 재확인) → `ingest cf stage0`(53 bytes) → 정책에 stage0(존 2개, 권한 그룹 dev2와 같음, 1h/71h) → `check-policy` valid · 비밀 5개 → 브로커 재시작(정책은 기동 때 1회만 읽는다) → `list` = dev2 · stage0.
- 2026-11-04(이 원장 밖): 승인 대기 10분 변경(#898)의 운영 반영 — 정책 `approvalTimeout` 갱신 + 설치 스크립트 재실행. 근거 = 2026-11-06 카드 만료 시각 − 요청 시각 = 600초, 소켓 파일 시각 11-04, 설치본에 버튼 코드(`slack-socket`) 있음.
- 2026-11-06 실승인 1회 통과: 봇 유저가 봇과 같은 MCP 서버를 직접 띄워 `cf_lease_request`(dev2, 존 1개, read, 10분) → 카드 게시 → 어드민 ✅ 리액션(353초 뒤) → lease 발급 → `cf_api GET /zones/<id>/dns_records` = 200 · success → `cf_lease_revoke` = `revoked`(브로커는 포지키 GET 404를 본 뒤에만 이 상태를 쓴다) → `list`에 활성 lease 0. 같은 기간 봇 로그: 카드 36장 `not-approved (expired)`(11-05 봇 세션의 반복 시험 포함) — 이것이 첫 승인.
- 2026-11-06 버튼 토큰 = 없음(sudo 없이 측정): Socket Mode는 토큰이 있으면 기동 때 연결해 계속 유지하는데(`cli.ts` serve), 브로커 pid의 TCP 연결 = 0. 같은 `netstat -anv`가 다른 유저(root 등)의 소켓·pid도 보여 주므로 측정이 유효하다. → 카드에 버튼 없음, 승인은 리액션만.

| WU | 하는 일 | 파일 소유 | RED로 먼저 고정할 것 |
|---|---|---|---|
| WU7 설치 (`work-m64` dev, 라이브) | 설치·비밀 입력·봇 연결 끝(위 측정). 남은 것 = 어드민 ✅ 라이브 실행, stage0·stage2 포지키, org-admin `admin:org` | 운영 원장 (코드는 WU7a로 닫힘) | (라이브) 측정됨: A16(어드민 세션 `cf_lease_request` → 카드, ✅ 전 실행 0) · A10 카드 내용(환경·권한·존·수명·사유·요청자) · A7 일부(`auth` 거부) · A2 일부(grant 없는 비어드민 세션에 서버 미등록 — 안내 문구는 미확인) · 카드 게시 지연 < 30초(약 2.4초). 미측정: A2 안내 문구, A3(read grant 유저), A4, A5, A6, A7 나머지, A8, A9, A10 ✅ 이후, A11, A12, A13, A15, A17, A18, 봇 토큰 ✅ 무효, 카드 `edited`/`text` 필드 유무, 계정 단위 lease가 존 권한에 미치는 범위 |
| WU8 이관·닫기 (라이브) | 세션 env `GITHUB_TOKEN` 재확인 + 세션 밖 작업(크론·배포 스크립트·LaunchAgent)의 gh 사용 조사 → `work-m64`·`work-m16` 봇 유저 gh 사람 계정 로그아웃(D6), server-tools `permission` 추가(D5) + 새 턴·진행 중 스레드 실측 + 공지 | 배포 설정(코드 변경 없음) | (라이브) A14, A19. 2026-11-06: D6 · D5 끝(아래) |

WU8 측정(2026-11-06):
- D6 사전 조사: 세션 밖에서 사람 로그인을 쓰는 작업 = `work-m64`의 고객 문서 동기화 cron 하나(자기 gitconfig의 gh credential helper). 사람 로그인을 숨긴 상태(`GH_CONFIG_DIR` = 빈 폴더)로 각 작업을 돌려 확인: 문서 동기화 = 실패, 다른 자동 배포 fetch = 성공(전역 설정의 앱 토큰), 러너 워크플로 = 잡 토큰. 봇 프로세스(플러그인 fetch)는 `GITHUB_TOKEN` = 앱 토큰, 세션은 #834의 앱 토큰 gh 폴더.
- 문서 동기화 helper를 봇의 앱 토큰 gh 폴더로 바꿈(이전 파일 백업) → 사람 로그인을 숨긴 상태에서 성공, 실제 cron 명령 exit 0. 남는 위험: 봇이 1시간 넘게 멈추면 그 폴더의 토큰이 만료돼 동기화가 멈추고, 봇이 다시 뜨면 3분 안에 돌아온다.
- `gh auth logout`: `work-m64` 2계정, `work-m16` 1계정 → 둘 다 "not logged into any GitHub hosts". 로그아웃은 로컬 설정만 지우고 토큰을 무효화하지 않으므로 브로커 사본은 그대로 — 직후 `gh_read` 두 계정 정상(WRITE · ADMIN), 문서 동기화 exit 0, 자동 배포 fetch 정상, 앱 토큰 gh 정상.
- D5: research §D5 맵(read = list·list_service·list_stack·logs, write = 쿼리 4종)을 `fable-m5max` dev에 적용(백업, 봇의 로더로 `server-tools` gated 확인, 새 턴부터 반영). `work-m64` dev·`work-m16` dev·main은 같은 패치 dry-run만 — `work-m64`에서 고객 개발자 세션이 지금 쓰고 있어(로그 1일치에 쿼리 도구 호출 다수) grant 없이 켜면 진행 중인 작업이 끊긴다.
- 덤: `work-m64`에서 devops-tools에 `permission`이 생긴 뒤로 "게이트 서버가 하나도 없을 때만" 주는 server-tools 일괄 허용이 꺼졌다 — 막히지는 않고(호출마다 검사는 게이트 서버만), bypass가 아닌 사용자에게 확인 창이 뜬다. D5를 켜면 정리된다.
- D5 나머지 3개(같은 날, 운영자 결정 "기존 사용자 4주 grant 먼저 → 켜기 → 공지"): 지금 쓰는 사람 = 최근 28일 에이전트 기록에서 server-tools `tool_use`가 있는 세션 주인. `work-m64` dev = 비어드민 10명, `work-m16` dev·main = 0명(28일 동안 에이전트 턴 0), `fable-m5max` dev = 어드민만. → `work-m64`의 10명에게 server-tools read·write grant를 봇의 grant 저장소 API로 4주(2026-12-04) 부여 → 세 봇에 같은 `permission` 맵 적용(백업) → 봇 모듈로 판정 재현: 어드민 = 허용, grant 사용자 = 허용, grant 없는 비어드민 = 거부 + 권한 요청 안내 → `work-m64` 인프라 채널에 공지 1건(멘션 없음, 우회 방법 없음). A19 = 판정 재현으로 측정(새 턴 실측은 다음 비어드민 턴).

## 열린 질문

- 승인 카드 가시성(2026-11-06: 같은 자리의 카드가 리액션으로 승인됨 — 카드는 보인다. 남은 것은 요청 스레드 링크 #899): 카드는 전용 앱의 어드민 DM에만 게시된다. 이번 시험에서 요청한 봇 세션은 카드 위치를 몰라 "어드민이 카드를 받지 못했다"고 잘못 추정했다 → 요청 스레드에 카드 링크를 남기는 방안 검토(코드 변경, 별도 WU).
- org-admin 토큰: 현재 scope = `gist` · `read:org` · `repo` · `workflow` → 조직 멤버 추가·삭제(`gh_org_member`)는 `admin:org`로 재발급해야 동작한다. 레포 협업자 부여는 `repo` + 레포 admin 권한으로 동작.
- dev2 포지키는 WU0 시험에 쓴 키를 그대로 브로커 포지키로 썼다(계획의 "시험 후 삭제" 대신). WU0 form 검사 출력: 계정 소유 · status active · `expires_on` 없음 · 자체 권한 그룹 = Account API Tokens Write 하나.

## stage2 계획 (SSOT_7 — 이번에는 실행하지 않는다)

- 전제: 운영 계정이 stage2 Cloudflare 계정에 접근할 수 있어야 한다. 2026-10-28 운영 계정 세션의 `/accounts` = dev2 · hq · stage0 세 개 → stage2 계정 없음. 운영 문서상 그 계정 소유자는 제3자 → 소유자가 운영 계정을 Super Administrator(또는 API 토큰 관리 가능 역할)로 초대.
- 순서(stage0과 같음): 계정 소유 포지키 `soma-devops-forge-stage2`(Account API Tokens Write 하나, 만료 없음) → Copy 버튼 클릭만으로 클립보드 → Cloudflare verify(id·active) → `ingest cf stage2` → 정책에 stage2 추가(존·존 ID는 그때 API로 실측, 권한 그룹은 dev2와 같음) → `check-policy` → 브로커 재시작 → `list` → 어드민 ✅ 라이브 시험 1회(read lease → `cf_api` GET → revoke, 404 확인).
- 실행 때 정할 것: stage2의 최대 수명(지금 dev2·stage0 = 71h; stage2는 더 짧게 둘지), edit 접근을 처음부터 열지.
- 범위 밖: stage2에 이미 쓰이는 계정 전체 권한 키(앱 서버 쪽)의 교체·폐기 — 이 기능과 별개.
