# Bug Trace: PR #79 미수정 — "Could not process image" 에러 루프 지속

## AS-IS: PR #79 머지 후에도 이미지가 포함된 스레드에서 "Could not process image" API 400 에러가 반복 발생
## TO-BE: 이미지 파일이 스레드에 첨부되어 있어도 에러 없이 정상 동작 (이미지는 메타데이터만 참조)

## Phase 1: Heuristic Top-3

### Hypothesis 1: `download_thread_file` MCP 도구가 이미지 파일도 Read하라고 안내
- `slack-thread-mcp-server.ts:175` → 도구 설명: `"Supports images, PDFs, text files, etc."` — Claude에게 이미지 다운로드를 유도
- `slack-thread-mcp-server.ts:483` → 응답 hint: `"Use the Read tool to examine this file."` — 이미지든 뭐든 무조건 Read하라고 안내
- Claude가 `get_thread_messages`로 스레드 조회 → 이미지 파일 첨부 발견 → `download_thread_file` 호출 → 다운로드 성공 → hint 따라 Read 호출 → API 400 에러
- **✅ 확인됨 — PR #79가 이 경로를 완전히 놓침**

### Hypothesis 2: `getThreadContextHint()`의 경고가 모델에 의해 무시됨
- `stream-executor.ts:203` → "이미지 파일은 Read 도구로 직접 읽지 마세요" 경고 존재
- 그러나 이 경고는 자연어 힌트일 뿐, 구조적 차단이 아님
- `download_thread_file` 도구 설명(line 175)이 "Supports images"라고 말하면, 도구 설명이 hint보다 우선됨
- **✅ 부분 확인 — 힌트는 있으나 구조적 강제력 없음**

### Hypothesis 3: `get_thread_messages`가 이미지 파일의 `url_private_download`를 그대로 노출
- `slack-thread-mcp-server.ts:378-385` → 모든 파일에 대해 `url_private_download`를 반환
- 이미지 파일도 다운로드 URL이 노출되어 Claude가 다운로드 시도 가능
- **✅ 확인됨 — 이미지 파일에도 다운로드 URL 노출**

## Root Cause Summary

PR #79는 세 가지 경로를 수정했으나, **네 번째 경로(MCP 도구 경유)**를 놓쳤다:

| 경로 | PR #79 수정 여부 | 설명 |
|------|:---:|------|
| 직접 업로드 → `formatFilePrompt` | ✅ | 이미지를 Read하지 않도록 메타데이터만 포함 |
| Thread hint → `getThreadContextHint` | ✅ | "이미지 Read 금지" 자연어 경고 추가 |
| 에러 발생 시 → `shouldClearSessionOnError` | ✅ | 세션 클리어로 무한 루프 차단 |
| **MCP `download_thread_file`** | **❌ 미수정** | 도구 설명이 이미지 지원 명시, 응답이 무조건 Read 유도 |
| **MCP `get_thread_messages`** | **❌ 미수정** | 이미지 파일에도 다운로드 URL 노출 |

### 에러 재현 시퀀스 (수정 후에도 발생)

```
1. 유저가 이미지 첨부된 스레드에서 봇 멘션
2. Claude → get_thread_messages() → 이미지 파일 메타 + url_private_download 수신
3. Claude → download_thread_file(image_url) → 성공, hint: "Use Read tool"
4. Claude → Read(image_path) → API 400 "Could not process image"
5. shouldClearSessionOnError → 세션 클리어
6. 다음 요청 → 2번부터 반복 (세션은 새로 시작되나 같은 스레드이므로 동일 루프)
```

## Fix Plan

1. **`download_thread_file` 도구 설명** (line 175): 이미지는 메타데이터만 반환한다고 명시
2. **`handleDownloadFile` 응답** (line 475-487): 이미지 파일 감지 시 다운로드하지 않고 메타데이터만 반환. hint에서 Read 유도 제거
3. **`formatSingleMessage` 파일 메타** (line 378-385): 이미지 파일의 `url_private_download` 제거, 대신 "이미지는 다운로드 불가" 안내 추가
