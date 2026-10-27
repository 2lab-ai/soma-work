# loop — devops-tools 구현 드라이브

Status: in-progress (라운드 1 = 코드, 닫힘 · main 머지 `2da8f4e4` 2026-10-27 · 라운드 2 = 라이브: WU0 닫힘, WU7 진행 중 — 브로커 가동·봇 연결, 어드민 ✅ 라이브 실행 대기 · D1–D6 = ① 확정 2026-10-26) · AS-IS = [`../14-devops-tools-as-is.md`](../14-devops-tools-as-is.md) · TO-BE = [`../15-devops-tools-to-be.md`](../15-devops-tools-to-be.md) ·
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
1. WU7 남은 라이브 항목 — 어드민이 카드에 ✅ → lease → `cf_api` GET → `cf_lease_revoke`(Cloudflare `GET` 404 확인), 봇 토큰 ✅ 무효 확인.
2. stage0 · stage2 포지키(아래 열린 질문), org-admin 토큰 `admin:org` 재발급.
3. WU8.

## 라운드 2 — 라이브 (2026-10-27 열림)

순서: WU0(닫힘, `loop.done.md`) → WU7 → WU8.

WU7 측정(2026-10-27, `work-m64` dev):
- 설치 1회차 = 점검표 FAIL 1(새로 만든 그룹에 "nested groups") → 원인 = macOS 15.6.1 `dscl . -read <레코드> <없는 속성>`이 stderr "No such key" + exit 0 → PR #491(조회 실패도 FAIL, 셈 실측화, 테스트 2건) 머지 `b21f07fb`.
- PR #491 브랜치 머리로 만든 묶음으로 재설치 = FAIL 0 · WARN 1(운영자 = 봇 유저, 운영자 결정) · 데몬 running · 소켓 `0660 _somadevops:soma-devops` · `check-policy` valid · 비밀 4개(gh 2 · Slack 앱 1 · Cloudflare dev2 1) 입력. 이동 경로(운영 콘솔 스크립트 기준): Slack·Cloudflare 키 = 발급 화면 Copy → 운영자 Mac 클립보드 → ssh stdin → `ingest`(직후 클립보드 비움), gh 토큰 = 대상 호스트 안 파이프(`gh auth token -u <계정>` → `ingest`). 파일·명령 인자·출력에 값을 쓰는 단계 없음. 첫 Cloudflare 입력은 시험 중 클립보드가 바뀌어 다른 값(43바이트)이 들어갔고, 길이 + Cloudflare verify(토큰 id·active) 확인 뒤 다시 입력해 덮어씀 → 클립보드 경유 입력은 verify 확인 후에만.
- 봇: `config.json`에 `devops-tools.permission`(도구 8개 = read) → `service.sh restart` + `verify-restart` 통과. 비관리자 세션 = "Permission-gated server blocked — no active grant", 관리자 = 전면 허용.
- 봇 유저에서 MCP 서버 직접 호출: `list` 정상, `gh_read` 두 계정 정상, `gh auth token` = `policy-denied`.
- 봇 모델 → `cf_lease_request` → 전용 앱 카드가 어드민 DM에 게시(요청→게시 약 2.4초) ×3, 모두 5분 만료 `not-approved (expired)` · 실행 0 · lease 0.

| WU | 하는 일 | 파일 소유 | RED로 먼저 고정할 것 |
|---|---|---|---|
| WU7 설치 (`work-m64` dev, 라이브) | 설치·비밀 입력·봇 연결 끝(위 측정). 남은 것 = 어드민 ✅ 라이브 실행, stage0·stage2 포지키, org-admin `admin:org` | 운영 원장 (코드는 WU7a로 닫힘) | (라이브) 측정됨: A16(어드민 세션 `cf_lease_request` → 카드, ✅ 전 실행 0) · A10 카드 내용(환경·권한·존·수명·사유·요청자) · A7 일부(`auth` 거부) · A2 일부(grant 없는 비어드민 세션에 서버 미등록 — 안내 문구는 미확인) · 카드 게시 지연 < 30초(약 2.4초). 미측정: A2 안내 문구, A3(read grant 유저), A4, A5, A6, A7 나머지, A8, A9, A10 ✅ 이후, A11, A12, A13, A15, A17, A18, 봇 토큰 ✅ 무효, 카드 `edited`/`text` 필드 유무, 계정 단위 lease가 존 권한에 미치는 범위 |
| WU8 이관·닫기 (라이브) | 세션 env `GITHUB_TOKEN` 재확인 + 세션 밖 작업(크론·배포 스크립트·LaunchAgent)의 gh 사용 조사 → `work-m64`·`work-m16` 봇 유저 gh 사람 계정 로그아웃(D6), server-tools `permission` 추가(D5) + 새 턴·진행 중 스레드 실측 + 공지 | 배포 설정(코드 변경 없음) | (라이브) A14, A19 |

## 열린 질문

- stage0 포지키: 운영자 브라우저 세션(포지키를 만드는 계정으로 로그인된 Chrome)이 연결돼 있어야 만든다 — 2026-10-27 22시 그 기계가 꺼져 있었다.
- stage2 포지키: stage2 Cloudflare 계정에 포지키를 만들 운영 계정이 아직 멤버가 아니다 → 계정 소유자의 초대가 먼저다.
- org-admin 토큰: 현재 scope = `gist` · `read:org` · `repo` · `workflow` → 조직 멤버 추가·삭제(`gh_org_member`)는 `admin:org`로 재발급해야 동작한다. 레포 협업자 부여는 `repo` + 레포 admin 권한으로 동작.
- dev2 포지키는 WU0 시험에 쓴 키를 그대로 브로커 포지키로 썼다(계획의 "시험 후 삭제" 대신). WU0 form 검사 출력: 계정 소유 · status active · `expires_on` 없음 · 자체 권한 그룹 = Account API Tokens Write 하나.
