# loop — work-queue 구현 드라이브

Status: in-progress · 라운드 4 (v2) · ssot = [`ssot.md`](ssot.md) SSOT_1–5 · 스펙 = [`../36-work-queue-spec.md`](../36-work-queue-spec.md) ·
아키텍처 = [`../37-work-queue-architecture.md`](../37-work-queue-architecture.md) · 완료 원장 = [`loop.done.md`](loop.done.md)

## 라운드 4 — v2: 한 줄 규칙 · 설정 없는 레인 · try · 작업 큐 칸 · 개인 큐 같은 작업 거절

브랜치 `feat/work-queue-v2` (워크트리 없이 세션 클론 하나 — 파일 소유가 한 줄로 이어져 나눌 단위가 없다).

| ID | 작업 단위 | Status | 다음 |
|---|---|---|---|
| W10 | 줄 규칙 `line.ts` · 레인 원장 v2(이름으로 생기는 레인 · try · putFirst · 내역 · v1 이전) · `keysInText` | 🟡 | 커밋 `ef37be14`. somalib 64 GREEN. 리뷰 · PR 대기 |
| W11 | MCP `queue_try` · 설정 없는 레인 · 고정 레인 | 🟡 | 14 GREEN. 리뷰 · PR 대기 |
| W12 | 호스트 `manage` · `views` · `/api/dashboard/work-queues` GET · POST | 🟡 | host 28 · 보기 2 · 라우트 4 GREEN. 리뷰 · PR 대기 |
| W13 | 개인 큐: 키 · 같은 작업 거절 · 그래도 시작 · 내역 · `lineView` | 🟡 | 개인 큐 108 · 인그레스 17 · Slack 12 GREEN. 리뷰 · PR 대기 |
| W14 | 보드 작업 큐 칸(작업 큐 \| 개인별 큐) · 대기 카드 이동 · 24시간 막대 · 설정 탭 내역 | 🟡 | 클라이언트 8 · 설정 19 GREEN. 화면 실측(소유자 dev 호스트 배포 뒤 캡처) 대기 |
| W15 | 소비자: `deploy.prompt` · `deploy-qa` 이름 · 공통 규칙(바쁜 레인 = 줄 서기) | 🟡 | 계약 113 · 예산 21 GREEN. 리뷰 · PR 대기 |
| W16 | 실측: 소유자 dev 호스트 배포 → A12–A16 | 🔴 | 머지 뒤 `$user:dev`. 테스트 세션 둘로 `qa-wq-probe` 레인(A12 · A13 · A15 · A16), 같은 키 두 스레드(A14). 캡처 · 원장 · 로그 |

## build facts

- 패키지 먼저 빌드: `npm run build:packages && npm run build:somalib` (안 하면 `@soma/common/logger`를 못 찾고, somalib 테스트가 옛
  `.js`를 읽는다).
- 게이트: `npx tsc --noEmit` · `npx biome check <files>` · `npx vitest run`.
- `src/conversation` 전체를 한 번에 돌리면 병렬 부하로 서버 테스트 몇 개가 시간 초과로 떨어진다(2026-11-26: 9파일 · 17건) — 파일별로
  돌리면 전부 통과. 판정은 파일별 재실행으로 한다.
- 대시보드 클라이언트 테스트는 `renderDashboardPage` 템플릿을 잘라 `cook`한다: 페이지 마크업과 첫 `<style>` 안에 `${…}`를 넣으면
  수십 개 파일이 깨진다 — 마크업은 `dashboard.ts`에 그대로 쓰고 CSS는 자기 `<style id="…">` 블록에.
- `node:sqlite`는 Node 22.5부터 — CI(Node 20)에서는 SQLite 저장소 테스트만 건너뛴다.
