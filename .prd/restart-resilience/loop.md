# loop — restart-resilience 구현 드라이브

Status: planned · 라운드 1 (계획 승인 대기) · ssot = [`ssot.md`](ssot.md) · 스펙 = [`../38-restart-resilience-spec.md`](../38-restart-resilience-spec.md) ·
아키텍처 = [`../39-restart-resilience-architecture.md`](../39-restart-resilience-architecture.md) · 에픽 https://github.com/2lab-ai/soma-work/issues/1434

## 라운드 1 — 네 PR

계획은 2026-11-25 trinity 3엔진이 만장일치로 승인했다(3/5 라운드, 기록은 에픽 댓글). 소유자 승인 뒤 시작한다. PR마다 사고를 재현하는
RED 테스트를 먼저 쓰고, 수정하고, 기존 회귀를 다시 돌리고, CI(sanitize 포함)를 통과시킨다. W1 · W2 · W3은 파일이 서로소라 병렬,
W4는 W2 · W3 머지 뒤.

| ID | 작업 단위 | Status | 브랜치 · 워크트리 | 이슈 | 다음 |
|---|---|---|---|---|---|
| W1 | 계정 저장소 — 직렬화 · 손상 처리 · 기동 대기 | 🚪 | `fix/1435-cct-lock-compromise` · `.worktrees/fix-1435-cct-lock-compromise` | #1435 | 승인 뒤 RED: A1 · A2(인스턴스 둘) · A3 |
| W2 | 본문 판별 — 메시지 하나 전체 규칙 | 🚪 | `fix/1436-content-guard-anchor` · `.worktrees/fix-1436-content-guard-anchor` | #1436 | 승인 뒤 RED: A4 · A5 · A6, 오판 고정 픽스처 교체 |
| W3 | 오류 재시도 — 전용 머리 · 사유 · 제목 · 대시보드 | 🚪 | `fix/1437-error-retry-not-restart` · `.worktrees/fix-1437-error-retry-not-restart` | #1437 | 승인 뒤 RED: A7 |
| W4 | 계정 풀 대기 — 원래 대기 보존 · 두 확인 지점 | 🔴 | `fix/1438-goal-honors-pool-window` · `.worktrees/fix-1438-goal-honors-pool-window` | #1438 | W2 · W3 머지 뒤 RED: A8 · A9 |

## 인수 gap

| ID | 인수 (38 §5) | Status | WU | 증거 |
|---|---|---|---|---|
| A1 | 잠금 손상에도 생존 | 🔴 | W1 | — |
| A2 | 두 작성자 보존 | 🔴 | W1 | — |
| A3 | 기동 대기 | 🔴 | W1 | — |
| A4 | 인용 답변 보존 | 🔴 | W2 | — |
| A5 | 진짜 거부는 그대로 | 🔴 | W2 | — |
| A6 | one-shot 인용 | 🔴 | W2 | — |
| A7 | 재시도는 재시도로 | 🔴 | W3 | — |
| A8 | 계정 풀 대기 준수 | 🔴 | W4 | — |
| A9 | 사람 우선 | 🔴 | W4 | — |
| A10 | dev 실측(‹소유자 dev 호스트›, ‹고객 dev 호스트›는 정기 배포 뒤 관찰만) | 🔴 | 전부 | — |

## build facts

출처: `package.json` 스크립트와 `.github/workflows/ci.yml`(2026-11-25 읽음). 이 워크스트림에서는 아직 로컬로 돌려 보지 않았다 — W1 착수 때 실측해 이 절을 고친다.

- 의존성: `npm ci` (워크트리마다).
- 빌드 = 린트 + 패키지 + 타입 검사: `npm run build` (`biome check` → `build:somalib` → `build:packages` → `tsc` → 프롬프트 복사). 새 `src/prompt/*.prompt`는 이 복사로 번들에 들어간다.
- 테스트 게이트(CI와 같음): `npm run test:release` (`vitest run --pool=forks --isolate --maxWorkers=1 --testTimeout=30000 --hookTimeout=120000`). 일반 `npm test`는 전역 교체 테스트끼리 새어 거짓 빨강이 날 수 있다(CI 주석).
- 좁은 반복: `npx vitest run <파일>`. 패키지(`packages/*`)를 고쳤으면 `npm run build:packages` 뒤에 돌린다(테스트가 `dist/`로 `@soma/*`를 푼다).
- 공개 레포 sanitize: 커밋 메시지 · 파일 · 브랜치 이름에 호스트 · 고객 이름을 쓰지 않는다(CLAUDE.md "공개 레포").

## 다음 착수점

- 소유자의 계획 승인(에픽 #1434). 승인되면 W1 · W2 · W3을 각자 워크트리에서 시작한다.
