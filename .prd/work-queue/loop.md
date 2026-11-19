# loop — work-queue 구현 드라이브

Status: in-progress · 라운드 2 · ssot = [`ssot.md`](ssot.md) · 스펙 = [`../36-work-queue-spec.md`](../36-work-queue-spec.md) ·
아키텍처 = [`../37-work-queue-architecture.md`](../37-work-queue-architecture.md) · 완료 원장 = [`loop.done.md`](loop.done.md) ·
PR https://github.com/2lab-ai/soma-work/pull/1380 (머지 `b489d453`) · 이슈 https://github.com/2lab-ai/soma-work/issues/1379

## 라운드 2 — 두 호스트에서 켜고 실측

| ID | 작업 단위 | Status | 다음 |
|---|---|---|---|
| W9a | 소유자 dev 호스트 설정 `workQueues {"deploy":["dev"],"qa":["dev"]}` | 🚪 | 봇은 배포 디렉터리 config.json을 못 쓴다(샌드박스) → 소유자 할 일 카드. 처리되면 `queue_list`가 `deploy:dev` · `qa:dev`를 보인다 |
| W9b | 고객 dev 호스트: 설정(dev2 · stage0) + 코드 배포 | 🟡 | 설정은 2026-11-19에 넣음(백업 · 권한 600 유지). 코드는 2026-11-20 19:00 KST 정기 배포로 들어간다 — 그 뒤 `queue_list` 확인 |
| W9c | 실측: 호스트 깨우기(A5) · 일 안 하는 차례 반납(A6) · 보드 보라 `큐 대기`(A3) | 🔴 | W9a 뒤 소유자 dev 호스트에서 두 스레드로 |

## build facts

- 패키지 먼저 빌드: `npm run build:packages && npm run build:somalib` (안 하면 `@soma/common/logger`를 못 찾는다).
- 게이트: `npx tsc --noEmit` · `npx biome check <files>` · `npx vitest run`.
- `somalib/` 테스트는 옆의 컴파일된 `.js`를 먼저 읽는다: `.ts`를 고쳤으면 `npm run build:somalib` 뒤에 돌린다(안 하면 옛 코드로 GREEN/RED가 나온다).
- `node:sqlite`는 Node 22.5부터 — CI(Node 20)에서는 SQLite 저장소 테스트만 건너뛴다.
- 배포된 MCP 바이너리 스모크: `/opt/soma-work/dev/packages/mcp-servers/work-queue/dist/work-queue-mcp-server.js`를 임시 `SOMA_DATA_DIR` · `SOMA_CONFIG_FILE` · 스레드 둘(`SOMA_WORK_QUEUE_CONTEXT`)로 띄워 JSON-RPC로 부른다.
