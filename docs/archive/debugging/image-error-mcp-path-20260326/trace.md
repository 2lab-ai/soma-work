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

PR #79는 자연어 경고에 의존했으나, **구조적 차단이 없어 모든 경로에서 여전히 실패한다.**

### 핵심 통찰: "경고"는 차단이 아니다

PR #79의 `formatFilePrompt`는 이미지에 대해 "Do NOT attempt to read it with the Read tool"이라 경고하지만, **Path를 그대로 노출**한다.
첫 DM에서 이미지만 보내면 프롬프트가 `"Please analyze the uploaded files."` + `Path: /tmp/...image.png`이 되어,
Claude가 경고를 무시하고 Read를 시도한다. 대화 중에는 텍스트가 있어 Read할 필요가 없으니 터지지 않았던 것.

| 경로 | PR #79 수정 | 문제 | 이번 PR 수정 |
|------|:---:|------|:---:|
| 직접 업로드 → `formatFilePrompt` | ⚠️ 경고만 | Path 노출 → Claude가 Read 시도 | ✅ Path 제거 |
| Thread hint → `getThreadContextHint` | ⚠️ 경고만 | 자연어 → 구조적 강제력 없음 | ✅ (MCP 쪽에서 구조적 차단) |
| 에러 발생 시 → `shouldClearSessionOnError` | ✅ | 사후 조치 (예방 아님) | ✅ 유지 |
| MCP `download_thread_file` | ❌ 미수정 | "Supports images" + "Use Read tool" | ✅ 이미지 다운로드 차단 |
| MCP `get_thread_messages` | ❌ 미수정 | 이미지에도 download URL 노출 | ✅ URL 제거 + is_image 플래그 |

### 에러 재현 시퀀스 — 경로 1: 직접 업로드 (첫 DM)

```
1. 유저가 DM으로 이미지만 전송 (텍스트 없음)
2. formatFilePrompt → "Please analyze the uploaded files." + Path 노출
3. Claude → Read(image_path) → API 400 "Could not process image"
4. shouldClearSessionOnError → 세션 클리어
5. 매 요청마다 이미지가 다시 업로드되면 반복
```

### 에러 재현 시퀀스 — 경로 2: MCP 경유 (스레드 멘션)

```
1. 유저가 이미지 첨부된 스레드에서 봇 멘션
2. Claude → get_thread_messages() → 이미지 파일 메타 + url_private_download 수신
3. Claude → download_thread_file(image_url) → 성공, hint: "Use Read tool"
4. Claude → Read(image_path) → API 400 "Could not process image"
5. shouldClearSessionOnError → 세션 클리어
6. 다음 요청 → 2번부터 반복
```

## Fix Plan (구조적 차단 원칙)

**원칙: Path/URL을 노출하지 않으면 Claude는 Read할 수 없다. 경고문이 아니라 데이터 자체를 차단한다.**

1. **`formatFilePrompt`** (file-handler.ts): 이미지 파일의 Path 완전 제거
2. **`download_thread_file` 도구 설명** (slack-thread-mcp-server.ts): "Supports images" 제거, 이미지 다운로드 요청 시 차단
3. **`handleDownloadFile` 응답**: 이미지 파일 감지 시 다운로드 거부 + 메타데이터만 반환
4. **`formatSingleMessage` 파일 메타**: 이미지 파일의 `url_private_download` 제거, `is_image` 플래그 추가
