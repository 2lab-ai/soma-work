# Spec: mcp-servers/ 독립성 확보 (src/ 의존 제거)

## Problem
PR #130에서 MCP 서버들을 `src/` → `mcp-servers/`로 추출했으나, `../../src/`에 대한 import 7개를 그대로 남김.
배포 환경에는 `src/`가 번들에 포함되지 않아 **전체 내부 MCP 서버**(permission, llm, model-command, cron)가 crash.

## Goal
`mcp-servers/` 디렉토리가 `src/`에 대한 직접 import 없이 독립적으로 동작.

## Scope
| Size | medium (~50 lines changed) |
|------|---------------------------|

## Affected Imports (7개, 5파일)

| File | Import | From |
|------|--------|------|
| `permission/permission-mcp-server.ts:6` | `sharedStore, PendingApproval, PermissionResponse` | `../../src/shared-store.js` |
| `permission/permission-mcp-server.ts:7` | `SlackPermissionMessenger` | `../../src/permission/index.js` |
| `cron/cron-mcp-server.ts:18` | `CronStorage, isValidCronExpression, isValidCronName` | `../../src/cron-storage.js` |
| `model-command/model-command-mcp-server.ts:11` | `getDefaultSessionSnapshot, listModelCommands, normalizeSessionSnapshot, runModelCommand` | `../../src/model-commands/catalog.js` |
| `model-command/model-command-mcp-server.ts:12` | `validateModelCommandRunArgs` | `../../src/model-commands/validator.js` |
| `model-command/model-command-mcp-server.ts:13-17` | `ModelCommandContext, ModelCommandListResponse, ModelCommandRunResponse` | `../../src/model-commands/types.js` |
| `model-command/model-command-mcp-server.ts:18` | `WorkflowType` | `../../src/types.js` |
| `_shared/mcp-client.ts:3` | `Logger` | `../../src/logger` |

## Strategy: src/ 모듈을 _shared/로 복사

모든 의존 모듈이 depth 0~2로 얕음. `mcp-servers/_shared/`에 필요한 모듈을 복사하고 import 경로를 변경.

### 복사 대상
1. `src/types.ts` → `_shared/types.ts` (WorkflowType enum만 필요하므로 필요한 것만 추출)
2. `src/logger.ts` → `_shared/logger.ts` (mcp-client.ts용)
3. `src/shared-store.ts` → `_shared/shared-store.ts` (permission 서버용)
4. `src/permission/slack-messenger.ts` → `_shared/slack-messenger.ts` (permission 서버용)
5. `src/cron-storage.ts` → `_shared/cron-storage.ts` (cron 서버용)
6. `src/model-commands/types.ts` → `_shared/model-commands/types.ts`
7. `src/model-commands/catalog.ts` → `_shared/model-commands/catalog.ts`
8. `src/model-commands/validator.ts` → `_shared/model-commands/validator.ts`

### 제약
- 복사된 코드는 `src/`와 동기화 필요 (장기적으로는 공유 패키지로 분리 고려)
- `mcp-servers/` 내에서 `../../src/` import가 0개여야 함
- 기존 테스트 전체 통과

## Acceptance Criteria
1. `grep -r '../../src/' mcp-servers/` 결과가 0건
2. `npx tsx mcp-servers/permission/permission-mcp-server.ts` 가 module not found 없이 시작
3. `npx vitest run` 전체 통과
4. `npx tsc --noEmit` 통과
5. 배포 환경(`/opt/soma-work/dev`)에서 MCP 서버 정상 동작
