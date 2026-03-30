# Trace: mcp-servers/ 독립성 확보

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| S1 | _shared/logger: mcp-client.ts의 Logger를 StderrLogger로 대체 | tiny | Ready |
| S2 | _shared/types: src/types.ts에서 필요한 타입 추출 | tiny | Ready |
| S3 | _shared/shared-store: shared-store.ts 복사 + import 수정 | small | Ready |
| S4 | _shared/slack-messenger: SlackPermissionMessenger 복사 | small | Ready |
| S5 | _shared/cron-storage: CronStorage 복사 + import 수정 | small | Ready |
| S6 | _shared/model-commands: types + catalog + validator 복사 | medium | Ready |
| S7 | import 경로 전환: 모든 ../../src/ import → ../_shared/ | small | Ready |
| S8 | 검증: grep 0건 + tsc + vitest + 수동 실행 확인 | small | Ready |

## S1: _shared/logger → StderrLogger 대체

### Trace
- `mcp-servers/_shared/mcp-client.ts:3` → `import { Logger } from '../../src/logger'`
- `Logger`는 `StderrLogger`와 거의 동일한 인터페이스 (debug, info, warn, error)
- `mcp-client.ts:92` → `this.logger = new Logger(name)` → `new StderrLogger(name)`

### Change
- `mcp-client.ts:3` → `import { StderrLogger } from './stderr-logger.js'`
- `mcp-client.ts:82` → type `Logger` → `StderrLogger`
- `mcp-client.ts:92` → `new Logger(name)` → `new StderrLogger(name)`

## S2: _shared/types.ts

### Trace
- `model-command-mcp-server.ts:18` → `import { WorkflowType } from '../../src/types.js'`
- `src/types.ts` 356줄이지만 WorkflowType만 필요
- WorkflowType은 `src/model-commands/types.ts`와 `src/model-commands/catalog.ts`에서도 사용됨
- 추가로 catalog.ts가 사용하는 타입들도 추출 필요: SessionLink, SessionResourceSnapshot, Continuation 등

### Change
- `_shared/types.ts` 생성 — `src/types.ts`에서 mcp-servers가 사용하는 타입만 추출
- 의존하는 타입도 함께 추출

## S3: _shared/shared-store.ts

### Trace
- `permission-mcp-server.ts:6` → `import { sharedStore, PendingApproval, PermissionResponse } from '../../src/shared-store.js'`
- `src/shared-store.ts` (254줄) → 의존: `StderrLogger` (이미 _shared에 있음)

### Change
- `_shared/shared-store.ts` 생성 — `src/shared-store.ts` 복사, import 경로 수정

## S4: _shared/slack-messenger.ts

### Trace
- `permission-mcp-server.ts:7` → `import { SlackPermissionMessenger } from '../../src/permission/index.js'`
- `src/permission/slack-messenger.ts` (112줄) → 의존: `@slack/web-api`, `StderrLogger`

### Change
- `_shared/slack-messenger.ts` 생성 — `src/permission/slack-messenger.ts` 복사, import 경로 수정

## S5: _shared/cron-storage.ts

### Trace
- `cron-mcp-server.ts:18` → `import { CronStorage, isValidCronExpression, isValidCronName } from '../../src/cron-storage.js'`
- `src/cron-storage.ts` (263줄) → 의존: `Logger`, `env-paths` (DATA_DIR 상수)

### Change
- `_shared/cron-storage.ts` 생성 — `src/cron-storage.ts` 복사
- Logger → StderrLogger 대체
- env-paths의 DATA_DIR → 인라인 또는 _shared/env-paths.ts로 추출

## S6: _shared/model-commands/

### Trace
- `model-command-mcp-server.ts:11` → catalog.ts (469줄) → 의존: types.ts, model-commands/types.ts
- `model-command-mcp-server.ts:12` → validator.ts (634줄) → 의존: types.ts, model-commands/types.ts
- `model-command-mcp-server.ts:13-17` → model-commands/types.ts (115줄) → 의존: types.ts

### Change
- `_shared/model-commands/types.ts` — 복사, import 경로 수정
- `_shared/model-commands/catalog.ts` — 복사, import 경로 수정
- `_shared/model-commands/validator.ts` — 복사, import 경로 수정

## S7: Import 경로 전환

### 모든 변경 대상
| File | Old Import | New Import |
|------|-----------|------------|
| `_shared/mcp-client.ts:3` | `../../src/logger` | `./stderr-logger.js` |
| `permission/permission-mcp-server.ts:6` | `../../src/shared-store.js` | `../_shared/shared-store.js` |
| `permission/permission-mcp-server.ts:7` | `../../src/permission/index.js` | `../_shared/slack-messenger.js` |
| `cron/cron-mcp-server.ts:18` | `../../src/cron-storage.js` | `../_shared/cron-storage.js` |
| `model-command/model-command-mcp-server.ts:11` | `../../src/model-commands/catalog.js` | `../_shared/model-commands/catalog.js` |
| `model-command/model-command-mcp-server.ts:12` | `../../src/model-commands/validator.js` | `../_shared/model-commands/validator.js` |
| `model-command/model-command-mcp-server.ts:13-17` | `../../src/model-commands/types.js` | `../_shared/model-commands/types.js` |
| `model-command/model-command-mcp-server.ts:18` | `../../src/types.js` | `../_shared/types.js` |

## S8: 검증

1. `grep -r '../../src/' mcp-servers/` → 0건
2. `npx tsc --noEmit` → 통과
3. `npx vitest run` → 전체 통과
4. `npx tsx mcp-servers/permission/permission-mcp-server.ts` → module not found 없음
5. `npx tsx mcp-servers/cron/cron-mcp-server.ts` → module not found 없음
6. `npx tsx mcp-servers/model-command/model-command-mcp-server.ts` → module not found 없음
