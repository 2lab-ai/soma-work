# loop — devops-tools 구현 드라이브

Status: in-progress (라운드 1 · D1–D6 = ① 확정 2026-10-26) · AS-IS = [`../14-devops-tools-as-is.md`](../14-devops-tools-as-is.md) · TO-BE = [`../15-devops-tools-to-be.md`](../15-devops-tools-to-be.md) ·
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

코드 단위 전부 구현·단위별 독립 리뷰·수정 완료(라운드 1 닫힌 WU = `loop.done.md`). 남은 순서:
1. 머지 전 trinity(진행 중) → 반드시 고칠 것 반영 → 전체 게이트 재실행.
2. 공개 레포 푸시 준비: 계획 커밋 히스토리에 승인 위조 경로 구체 위치가 남아 있으므로 새 브랜치에 커밋을 합쳐 올린다 → PR → CI·Sanitize Gate → 머지.
3. WU0(dev2 시험용 포지키를 받는 대로) → WU7(설치·라이브) → WU8.

## 라운드 1 — 진행 중 (2026-10-26 열림, 브랜치 `feat/devops-tools`)

순서: **WU0 먼저**(Cloudflare 플랫폼 가정 확정 — 답이 설계를 바꿀 수 있다) ∥ **WU1**(프로토콜·인자 스키마가 나머지의 계약) →
WU2–WU5 병렬(에이전트당 WU 1개) → WU6 → 머지 → WU7·WU8 라이브.

| WU | 하는 일 | 파일 소유 | RED로 먼저 고정할 것 |
|---|---|---|---|
| WU0 Cloudflare 첫 시험 (라이브, 구현 전) | dev2 포지키 1개로 16 §6 Q1 기능·Q2 환경 경계·Q3 같은 계정 권한 상한 + IP 조건 표기 | 운영 원장 | Q1·Q2 통과 시 stage0·stage2 키 요청, Q3 결과는 피해 범위로 보고; Q1·Q2 실패 = 계획 복귀 |
| WU7 설치 (`work-m64` dev, 라이브) | 전용 Slack 앱 설치(매니페스트 = `install/slack-app-manifest.json`), 봇 유저 홈의 Slack CLI 로그인 확인, sudo로 `install/install.sh --bot-user <봇>`(고정 해시 공식 node·gh만 받음) → policy.json 채움 → 비밀 stdin 입력 → 재실행(exit 0) → 봇 재시작 | 운영 원장 (코드는 WU7a로 닫힘) | (라이브) 상세 §4 A2–A18, 봇 토큰 ✅ 무효, 카드 `edited`/`text` 필드 유무, 카드 게시 지연 < 30초, 계정 단위 lease가 존 권한에 미치는 범위 |
| WU8 이관·닫기 (라이브) | 세션 env `GITHUB_TOKEN` 재확인 + 세션 밖 작업(크론·배포 스크립트·LaunchAgent)의 gh 사용 조사 → `work-m64`·`work-m16` 봇 유저 gh 사람 계정 로그아웃(D6), server-tools `permission` 추가(D5) + 새 턴·진행 중 스레드 실측 + 공지 | 배포 설정(코드 변경 없음) | (라이브) A14, A19 |

## 열린 질문

- `[가정]` member 계정 = `<member 계정 메일>` — DM 질문에 답이 없었다. WU7에서 그 계정 토큰을 입력받을 때 확인한다.
- 공개 레포 푸시: 지금 문서에 승인 위조 경로의 구체 위치가 있다. 첫 푸시 전에 구체 위치를 운영 저장소의 비공개 계획 파일로 옮기고
  원리(봇과 같은 OS 유저 안의 승인은 믿을 수 없다)만 남긴다.
- 유저 준비물 시점: WU0 = dev2 시험용 포지키 1개(시험 후 삭제). WU7 = 브로커 전용 Slack 앱 설치, org-admin 계정 토큰 재발급(`admin:org`),
  환경별 포지키 3개(새로 발급해 브로커 입력에 바로), `work-m64` sudo 1회.
