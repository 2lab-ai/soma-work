# loop.done — devops-tools 완료 원장 (append-only)

## 라운드 0 — 실측·리서치·스펙 (2026-10-26)

- 4개 배포의 `config.json`·`mcp-servers.json`·`.env` 키 이름·`dist/version.json`을 비밀 필드 가림 스크립트로 수집 → 14 §1.1–1.2.
- 봇 유저 gh 계정·조직 역할·토큰 scope 실측(토큰 값 미출력, 상세는 운영 저장소 비공개 계획 파일). 실행 중 Claude 세션 프로세스 env 이름에 `GITHUB_TOKEN` 확인.
- Cloudflare: 4개 호스트에 CLI 없음, 환경별 계정·키 위치는 운영 원장 대조 → 14 §1.4.
- 코드 추적: 권한 맵 출처(`build-stream-options.ts:212`), grant 검사(`claude-handler.ts:2100`), 승인 핸들러 어드민 검증
  (`mcp-tool-permission-action-handler.ts:44`), 경로 차단(`sensitive-path-filter.ts:28`), gh 명령 규칙 부재 → 14 §1, 15 §1.
- 1차 출처 리서치(Cloudflare 토큰 API, gh 다중 계정, GitHub 권한) → 15 §9 R1–R11, 미확인 3건 명시.
- 산출: `14-devops-tools-spec.md`, `15-devops-tools-architecture.md`, `devops-tools/{ssot,loop}.md`.

## 라운드 0b — 3엔진 리뷰 (2026-10-26, trinity: grok-4.7 · gpt-6-astra · fable)

- R1 3×REVISE: 같은 OS 유저라 기존 승인 경로(응답 파일·grant 파일·소켓)가 위조 가능, gh 파일 플래그로 브로커 비밀 반출, raw API로 레포 삭제·이전 우회,
  lease 사용자 결속 없음, 하드 거부 위치, D6 범위. → D1을 브로커 직접 검증으로, 허용표 방식, REST 쓰기 공집합, graphql 거부.
- R2 3×REVISE: 공유 봇 토큰 카드는 문구 바꿔치기·원복을 배제 못 함, lease 세션 격리는 같은 OS 유저에 대해 거짓, `release create` 위치 인자 업로드,
  Cloudflare 시험 기준 모순·순서, permission 삭제 안내 오류(deny-by-default), 가짜 카드·자칭 요청자·대기 상한 5분. grok의 "`reactions.add` users 인자" 주장은
  1차 출처(docs.slack.dev reactions.add/get)로 반증 → 15 §9 R12.
  → D1 = 브로커 전용 Slack 앱(Web API·리액션), D4 = 봇 안 소지자 권한으로 축소, gh 인자 스키마(위치 인자·stdin), WU0 선행·Q1/Q2/Q3 분리.
- R3 3×APPROVE, MUST-FIX none. fable P1(공지 문구, 최소 scope에서 `im:history` 제거, 레이트리밋 [추정]·Retry-After, 카드 인자 코드 블록·상한,
  앱 설치 차단 분기, 어드민 정본 = 브로커 `admins`) 반영. gpt-6-astra 구현 주의 3건은 loop WU2·WU8 RED에 반영.

## 라운드 1 — 닫힌 WU

| WU | 하는 일 | 결과 |
|---|---|---|
| WU1 계약 + 뼈대 | 소켓 프로토콜, gh 허용표 분류기, 두 패키지 뼈대, mcp-bins 스모크, Lean import-graph 정리 목록 | `81a53c4c` · 테스트 279개(먼저 RED 259개 확인) · tsc·biome·smoke:mcp-bins·sanitize 84개·import-graph 61개 통과(커밋 후 재실행, 2026-10-26 22:53). 추가 발견: gh `--jq`가 환경 변수를 읽을 수 있어 `$ENV`/`env` 거부 |
| WU1b 브로커 공통 | 정책·경로·비밀·상태·원장·CLI | `4e20aaab` 169 tests → 리뷰(gpt-6) REVISE → `b6553b73`(rename 뒤 실패 = 저장소 정지, 원장 찢긴 꼬리 복구·폴더 fsync) |
| WU3 브로커 gh 실행 | gh 실행·가림 | `c8323068` 84 tests → 리뷰(gpt-6) REVISE → `50fe1808`(gh 경로 전 조상 루트 소유 확인, 메모리 감시 실패 = 종료, %XX 가림) · `47cd6a5b`(응답당 가림 1회 컴파일, 1MB 3초→16ms) |
| WU5 MCP 서버 | 키 없는 중계 | `430f036c` 58 tests · `64b2313a`(대기 상한 355초 = SDK 360초 아래, 승인 대기 5분 고정) → 리뷰(gpt-6) REVISE → `3bf92a96`(시간 경과를 '미승인'으로 지어내지 않음, 취소 시점 구분) |
| WU6 봇 배선 | 설정 등록·하드 거부 | `618584d1` 67 tests · `1b7e0c89`(git-credential 거부, Lean 모델 동기화 — 3×2^10 벡터, 증명 약화 없음) → 리뷰(gpt-6) APPROVE |
| WU4 브로커 Cloudflare | 단기 키 수명주기 | `ade0e9d1` 49 tests · `023f363f` → 리뷰(Opus, 탐침) REVISE → `39f8d01d`(정리기 vs 발급 경쟁, include_expired, 원장 실패가 결과를 덮지 않음, JSON 파싱 후 가림) |
| WU2a 승인 카드 | 전용 앱·카드·리액션 | `a3988a1f` 64 tests → 리뷰(Opus, 탐침) REVISE → `2eaf01ed`(카드 생성 속도 제한, 만료 후 ✅ 무효, 고아 승인 취소, 결합 문자 가림) · `e4a2f8f3`(release) |
| WU2b 브로커 본체 | 소켓·라우팅·GitHub 관리·serve | `114d69c3` 99 tests → 리뷰(Opus, 탐침) REVISE → `2eaf01ed`(현재 상태 조회 후 '현재 → 변경' 카드, 결과 불명 재조회, pr merge SHA 필수, 반쯤 열린 연결 정리, abort 사유) · `e4a2f8f3` |
| WU7a 설치 스크립트 | install/uninstall·plist | `b85bb6b9` 14 tests → 리뷰(Opus, 탐침) REVISE(봇 소유 gh/node로 root 실행·토큰 반출 재현) → `81478d9a`(고정 sha256 공식 아카이브만, nobody로 버전 확인, 체크아웃 신뢰 FAIL, 점검표 뒤 부트스트랩, Slack CLI 로그인 FAIL) 23 tests |
| WU1 리뷰 반영 | gh 허용표 | 리뷰(Opus, 탐침) REVISE → `0cef6764`(api 경로 허용표, secret-scanning, 소유자 범위 조회, 카드 문자 제한) 337 tests |

## 라운드 1 — 닫힘: 머지 (2026-10-27)

- 머지 전 trinity(grok-4.7 · gpt-6-astra · fable), 3라운드에서 만장일치 APPROVE.
  - R1: grok APPROVE · gpt-6-astra REVISE(설치 스크립트가 ACL을 보지 않는다, 코드 트리 `find`의 `-print` 우선순위 때문에 검사가 실패할 수 없다) ·
    fable REVISE(`pr merge --auto`가 승인 뒤에도 상시 자동 머지를 남긴다, 허용된 인자를 통째로 기록해 카드 없이 원장이 커진다, 카드 길이 거부에 속도 제한이 없다).
    → `--auto` 제거, 긴 인자는 해시+미리보기로 기록, 카드를 만들기 전에 속도 제한, 설치 시 ACL 제거·남으면 FAIL, `find` 분기 괄호.
  - R2: grok·fable APPROVE · gpt-6-astra REVISE(merge queue가 필요한 레포에서는 gh가 `--auto` 없이도 자동 머지를 고른다).
    → `pr merge`는 gh를 거치지 않고 승인된 SHA에 고정한 REST 머지 한 번으로 실행.
  - R3: 3×APPROVE, MUST-FIX none.
- 공개 레포 푸시: 계획 커밋 히스토리에 승인 위조 경로의 구체 위치가 있어, 공개 `.prd`에는 원리(봇과 같은 OS 유저 안의 승인은 믿을 수 없다)만 남기고
  운영 상태·구체 위치는 운영 저장소의 비공개 계획 파일로 옮겼다. 그 뒤 origin/main `50ad59de` 위 커밋 1개(`e8d76733`)로 다시 잘라 올렸다.
  위 표의 커밋 해시는 합치기 전 로컬 브랜치 기준이다.
- 전체 게이트(합친 커밋): build · tsc · 테스트 15,879 통과/0 실패 · mcp-bins · deploy-bundle 스모크 · lean-verify 통과.
- PR #465: CI lean-verify · quality-gates · Sanitize Gate scan 통과 → 머지 `2da8f4e4`(2026-10-27 04:22 KST).
- 머지 뒤 문서 정리(README 두 벌 · 아키텍처 문서 · CLAUDE.md의 사람 계정 토큰 push 안내 제거)는 후속 문서 PR.

## 라운드 2 — WU0 닫힘 (2026-10-27)

| WU | 하는 일 | 결과 |
|---|---|---|
| WU0 Cloudflare 첫 시험 (라이브) | dev2 포지키 1개로 16 §6 Q1 기능 · Q2 환경 경계 · Q3 같은 계정 권한 상한 + IP 조건 표기 | 9 통과 / 0 실패 / 정보 7. 포지키 = 계정 소유 · 권한 1개(Account API Tokens Write). Q1 = 자식 키가 지정 존만 되고(다른 존 403) 만료가 강제됨(200 → 401). Q2 = 다른 계정 대상 자식 발급 3종 모두 거부(400/403). Q3(정보) = 포지키가 새면 같은 계정 안에서 Account Settings Write 자식까지 만들 수 있다, 자식은 토큰을 관리하지 못한다. 시험용 자식 5개 DELETE → GET 404. 만료된 자식은 기본 토큰 목록에 안 보인다 → 브로커 정리기는 이미 `include_expired`로 조회(WU4). → stage0 · stage2 진행 조건 충족 |
