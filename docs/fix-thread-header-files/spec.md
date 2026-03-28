# Spec: Fix Thread Header Files Invisible on Mid-Thread Initiation

## Problem Statement

mid-thread DM으로 봇을 이니시에이팅할 때, thread root message(header)에 첨부된 이미지/파일의 메타데이터가 모델에게 전달되지 않는다.

## Root Cause

두 가지 결함이 복합 작용:

1. **`fetchMessagesBefore` root skip**: `slack-mcp-server.ts:620`에서 `if (m.ts === this.context.threadTs) continue;`로 root message를 명시적으로 건너뜀. Legacy mode에서 root의 파일 메타데이터가 완전 누락.

2. **Thread-awareness hint 유도 오류**: `stream-executor.ts:196-209`의 hint가 "(before/after 개수 지정)"으로 legacy mode를 유도. Array mode(root 포함)가 아닌 legacy mode 사용을 촉진.

## Solution

### Fix 1: `fetchMessagesBefore`에서 root message skip 제거
- Line 620의 `if (m.ts === this.context.threadTs) continue;` 제거
- Root message도 "before" 결과에 포함되어 파일 메타데이터 전달

### Fix 2: Thread-awareness hint 개선
- Array mode를 기본 안내로 변경
- Root message(offset 0) 파일 확인을 명시적으로 지시
- Legacy mode 언급 제거 또는 하위 안내

## Scope

- **Size**: small (~20 lines)
- **Files affected**: 2 production files + tests
- **Risk**: Low — legacy mode의 root skip 제거는 기존 동작 개선이며 regression 가능성 낮음

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Root message in legacy mode | Include (remove skip) | Root는 thread의 첫 메시지이며 "before anchor" 범위에 당연히 포함되어야 함 |
| Hint default mode | Array mode | Tool description에서 이미 "Array mode (default)"로 정의됨. Hint도 이에 맞춰야 함 |
| Image content access | Metadata only (유지) | 이미지 바이너리 읽기는 API 에러 발생. 메타데이터 확인 + 유저 질문이 현재 최선 |

## Non-Goals

- 이미지 콘텐츠 직접 인식 (Claude Vision 통합은 별도 이슈)
- Array mode / Legacy mode API 구조 변경
