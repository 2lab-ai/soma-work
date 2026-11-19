# loop — work-queue 구현 드라이브

Status: in-progress · 라운드 3 · ssot = [`ssot.md`](ssot.md) · 스펙 = [`../36-work-queue-spec.md`](../36-work-queue-spec.md) ·
아키텍처 = [`../37-work-queue-architecture.md`](../37-work-queue-architecture.md) · 완료 원장 = [`loop.done.md`](loop.done.md) ·
PR https://github.com/2lab-ai/soma-work/pull/1380 (머지 `b489d453`) · 이슈 https://github.com/2lab-ai/soma-work/issues/1379

## 라운드 3 — 고객 dev 호스트에서 켜기

소유자 dev 호스트는 라운드 2에서 실측을 통과했다(loop.done.md R2). 남은 것은 고객 dev 호스트 하나다.

| ID | 작업 단위 | Status | 다음 |
|---|---|---|---|
| W9b | 고객 dev 호스트: 설정(dev2 · stage0) + 코드 배포 | 🟡 | 설정은 2026-11-19에 넣음(백업 · 권한 600 유지). 코드는 2026-11-20 19:00 KST 정기 배포로 들어간다 — 그 뒤 그 호스트 세션에서 `queue_list`가 `deploy:dev2` · `deploy:stage0` · `qa:dev2` · `qa:stage0`을 보이는지 확인. 고객 환경 배포 · QA를 증거용으로 일으키지 않는다(목록 확인만) |

## build facts

- 패키지 먼저 빌드: `npm run build:packages && npm run build:somalib` (안 하면 `@soma/common/logger`를 못 찾는다).
- 게이트: `npx tsc --noEmit` · `npx biome check <files>` · `npx vitest run`.
- `somalib/` 테스트는 옆의 컴파일된 `.js`를 먼저 읽는다: `.ts`를 고쳤으면 `npm run build:somalib` 뒤에 돌린다(안 하면 옛 코드로 GREEN/RED가 나온다).
- `node:sqlite`는 Node 22.5부터 — CI(Node 20)에서는 SQLite 저장소 테스트만 건너뛴다.
- 배포된 MCP 바이너리 스모크: `<배포 디렉터리>/packages/mcp-servers/work-queue/dist/work-queue-mcp-server.js`를 임시 `SOMA_DATA_DIR` · `SOMA_CONFIG_FILE` · 스레드 둘(`SOMA_WORK_QUEUE_CONTEXT`)로 띄워 JSON-RPC로 부른다.
- 실측 방법(라운드 2): 대시보드 새 작업으로 테스트 세션 둘(autogoal · autoz 끔)을 만들어 하나는 차례를 잡고 쉬게, 하나는 뒤에 줄 서게 한다. 보라 `큐 대기`는 턴이 없는 세션에만 붙으므로 작업 세션 자신은 대기 역할로 쓸 수 없다. 증거 = `/api/dashboard/sessions`의 `queueWait` · 화면 캡처 · 두 스레드 원문 · 원장(`work-queues.sqlite3`) · 호스트 로그(`WorkQueueHost`). 끝나면 테스트 카드를 닫는다.
