# loop — work-queue 구현 드라이브

Status: in-progress · 라운드 1 · ssot = [`ssot.md`](ssot.md) · 스펙 = [`../36-work-queue-spec.md`](../36-work-queue-spec.md) ·
아키텍처 = [`../37-work-queue-architecture.md`](../37-work-queue-architecture.md) · 브랜치 `feat/1379-env-run-queue` ·
PR https://github.com/2lab-ai/soma-work/pull/1380 · 이슈 https://github.com/2lab-ai/soma-work/issues/1379

## 라운드 1 — 원장 · MCP · 호스트 · 옛 장치 걷어내기

| ID | 작업 단위 | Status | 다음 |
|---|---|---|---|
| W1 | 원장: keys · config · ledger · store (`@soma/process-shared/work-queue`) | 🔴 | TDD |
| W2 | MCP 서버 `work-queue` + 리졸버 · config builder · 패키지 등록 | 🔴 | W1 뒤 |
| W3 | 호스트 `WorkQueueHost` + index.ts 조립 | 🔴 | W1 뒤 |
| W4 | 옛 장치 제거: #726 게이트(세션 초기화 · 액션 · 블록 · `workQueueId`) · v1 `env-run-queue` | 🔴 | W3와 같이 |
| W5 | hand-off 추적 + 끝 = `whenFree` · 목표 루프 · 후속 질문 술어 | 🔴 | W3 뒤 |
| W6 | 보드: `queueWait` 서버 · 클라이언트 · 보라 태그 · i18n | 🔴 | W5 뒤 |
| W7 | 레인 소비자: `deploy.prompt` · `deploy-qa` · RUN_ENV_SKILL 설명 · CLAUDE.md · architecture.md | 🔴 | W2 뒤 |
| W8 | 게이트: tsc · biome · vitest 전체 · 리뷰 · PR 본문 | 🔴 | 모두 뒤 |
| W9 | 배포 · 설정: 소유자 dev 호스트 `{"deploy":["dev"],"qa":["dev"]}`, 고객 dev 호스트 `dev2` · `stage0` → 실측(A2–A5) | 🔴 | 머지 뒤 |

## build facts

- 패키지 먼저 빌드: `npm run build:packages && npm run build:somalib` (안 하면 `@soma/common/logger`를 못 찾는다).
- 게이트: `npx tsc --noEmit` · `npx biome check <files>` · `npx vitest run`.

## 열린 gap

| ID | gap | Status | 다음 |
|---|---|---|---|
| G1 | v1 PR의 기준선 밖 실패 테스트(dashboard.test · card-filters · display-lang · agent-inbox-client · env-skill-handoff-host)가 v1 탓인지 기준선인지 미확인 | 🟡 | W8에서 origin/main과 비교 |
