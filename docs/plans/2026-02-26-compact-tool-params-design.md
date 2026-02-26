# Compact Mode Tool Parameter Display + In-Place MCP Status

## Problem

1. Compact mode에서 MCP/tool call이 함수명만 표시되어 파라미터 정보 없음
2. MCP 호출 시 메시지 2개 생성 (tool call + status tracker) → 중복/혼란
3. 배치 tool call 시 in-place 업데이트가 마지막 tool만 남기는 버그

## Design

### Part 1: Compact Parameter Display

`formatOneLineToolUse`에서 모든 tool에 generic parameter 표시:

```
⏳ 🔌 MCP: llm → chat (model: opus, prompt: "Fix the…")
⚪ 🔧 WebSearch (query: "React hooks 2026")
```

- `formatCompactParams(input, budget=60)` helper 추가
- 짧은 값(string/number/boolean, ≤50자) 우선, 최대 2개
- 이미 파라미터 표시하는 tool (Bash, Read, Edit 등) 제외

### Part 2: In-Place MCP Status (Compact Only)

**아이콘 구분:**
- MCP/Task → `⏳` (비동기)
- Read/Edit/Bash 등 → `⚪` (동기)

**Compact mode에서:**
1. `mcpStatusDisplay.startStatusUpdate` 호출 스킵 (별도 메시지 안 만듦)
2. 결과 도착 시 원본 메시지를 `🟢 ... — duration`으로 업데이트

**Duration 전달:**
- `tool-event-processor.endMcpTracking` → duration 반환
- 새 콜백 `onCompactDurationUpdate(toolUseId, duration)` → stream-processor가 재업데이트

### Part 3: Batch Message Fix

같은 ts 공유하는 tool들의 라인을 전부 재구성:

```
⏳ 🔌 MCP: llm → chat (model: opus)
🟢 🔌 MCP: github → search (query: "fix") — 1.2s
```

- `toolCallMessageTs` 구조를 ts → Map<toolUseId, info>로 변경
- 업데이트 시 같은 ts의 모든 라인 재구성
