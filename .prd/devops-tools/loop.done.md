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
