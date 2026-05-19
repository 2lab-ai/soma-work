# Bug Fix: SDK Error Detail Output + Auto-Compact Handling

## Problem Statement

soma-work의 Claude Agent SDK 통합에서 3가지 에러 처리 결함이 있다:

1. **System message 무시**: `stream-processor.ts`가 SDK `system` 타입 메시지를 전혀 처리하지 않음
   - `compact_boundary`, `status: compacting` 등 모든 system 이벤트 drop
   - SDK가 auto-compact를 수행해도 soma-work가 인식하지 못함

2. **Error detail 미출력**: `formatErrorForUser()`가 `error.stderrContent`를 유저에게 보여주지 않음
   - SDK stderr에 실제 에러 원인(rate limit details, context overflow reason 등)이 있음
   - 유저는 generic "process exited with code 1" 같은 메시지만 봄

3. **Result error 무시**: `handleResultMessage()`가 `SDKResultError` subtype을 무시
   - `error_during_execution`, `error_max_turns` 등의 errors[] 배열 유실
   - 에러 상세가 로그에도 남지 않음

## Scope

| File | Change | Size |
|------|--------|------|
| `src/slack/stream-processor.ts` | system message handler 추가 | ~20줄 |
| `src/slack/stream-processor.ts` | handleResultMessage error subtype 처리 | ~15줄 |
| `src/slack/pipeline/stream-executor.ts` | formatErrorForUser에 stderrContent 출력 | ~10줄 |

**Total: ~45줄, medium tier**

## Architecture Decision

- SDK auto-compact은 SDK 내부에서 자동 수행됨. soma-work는 이벤트만 인식하면 됨.
- `compact_boundary` 수신 시 로그 기록 + optional 유저 알림 (세션 컨텍스트 압축됨)
- `stderrContent` 출력 시 민감 정보 제거 (토큰 값 등)

## Dependencies

- `@anthropic-ai/claude-agent-sdk` v0.2.80 (현재 버전, 변경 불필요)
