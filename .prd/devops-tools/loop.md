# loop — devops-tools 구현 드라이브

Status: in-progress (라운드 1 = 코드, 닫힘 · main 머지 `2da8f4e4` 2026-10-27 · 라운드 2 = 라이브 · D1–D6 = ① 확정 2026-10-26) · AS-IS = [`../14-devops-tools-as-is.md`](../14-devops-tools-as-is.md) · TO-BE = [`../15-devops-tools-to-be.md`](../15-devops-tools-to-be.md) ·
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
브로커를 설치하고 설정을 넣기 전까지 봇에 생기는 변화는 하드 거부(사람 gh 계정 키 꺼내기·키체인 덤프·브로커 경로 접근) 하나다. 순서:
1. WU0 — dev2 시험용 포지키를 받는 대로.
2. WU7 — 첫 단계 = dev 배포 후 각 대상의 `bot is running` 줄로 버전·시각 확인(배포 잡 결론만으로 판정하지 않는다). 나머지는 유저 준비물이 오는 대로.
3. WU8.

## 라운드 2 — 라이브 (2026-10-27 열림)

순서: WU0(Cloudflare 플랫폼 가정 확정 — Q1·Q2가 실패하면 설계로 돌아간다) → WU7 → WU8.

| WU | 하는 일 | 파일 소유 | RED로 먼저 고정할 것 |
|---|---|---|---|
| WU0 Cloudflare 첫 시험 (라이브) | dev2 포지키 1개로 16 §6 Q1 기능·Q2 환경 경계·Q3 같은 계정 권한 상한 + IP 조건 표기 | 운영 원장 | Q1·Q2 통과 시 stage0·stage2 키 요청, Q3 결과는 피해 범위로 보고; Q1·Q2 실패 = 계획 복귀 |
| WU7 설치 (`work-m64` dev, 라이브) | 전용 Slack 앱 설치(매니페스트 = `install/slack-app-manifest.json`), 봇 유저 홈의 Slack CLI 로그인 확인, sudo로 `install/install.sh --bot-user <봇>`(고정 해시 공식 node·gh만 받음) → policy.json 채움 → 비밀 stdin 입력 → 재실행(exit 0) → 봇 재시작 | 운영 원장 (코드는 WU7a로 닫힘) | (라이브) 상세 §4 A2–A18, 봇 토큰 ✅ 무효, 카드 `edited`/`text` 필드 유무, 카드 게시 지연 < 30초, 계정 단위 lease가 존 권한에 미치는 범위 |
| WU8 이관·닫기 (라이브) | 세션 env `GITHUB_TOKEN` 재확인 + 세션 밖 작업(크론·배포 스크립트·LaunchAgent)의 gh 사용 조사 → `work-m64`·`work-m16` 봇 유저 gh 사람 계정 로그아웃(D6), server-tools `permission` 추가(D5) + 새 턴·진행 중 스레드 실측 + 공지 | 배포 설정(코드 변경 없음) | (라이브) A14, A19 |

## 열린 질문

- `[가정]` member 계정 = `<member 계정 메일>` — DM 질문에 답이 없었다. WU7에서 그 계정 토큰을 입력받을 때 확인한다.
- 유저 준비물 시점: WU0 = dev2 시험용 포지키 1개(시험 후 삭제). WU7 = 브로커 전용 Slack 앱 설치, org-admin 계정 토큰 재발급(`admin:org`),
  환경별 포지키 3개(새로 발급해 브로커 입력에 바로), `work-m64` sudo 1회.
