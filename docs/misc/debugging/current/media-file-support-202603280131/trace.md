# Bug Trace: Media File Support — Video/Audio files rejected as "Unsupported file type"

## AS-IS: .mp4 등 영상/오디오 파일 업로드 시 "Unsupported file type: .mp4" 에러 발생
## TO-BE: 모든 이미지와 영상/오디오 파일이 인식되고 메타데이터가 올바르게 전달되어야 함

## Phase 1: Heuristic Top-3

### Hypothesis 1: file-handler.ts에서 video/audio 카테고리 누락
- `src/file-handler.ts:176` → `isImageFile()`: `mimetype.startsWith('image/')` 만 체크
- `src/file-handler.ts:180` → `isTextFile()`: text/* 및 application/json 등만 체크
- **isVideoFile(), isAudioFile() 메서드 없음**
- `src/file-handler.ts:222-232` → else 분기: "This is a binary file. You may try reading it with the Read tool"
- → AI가 .mp4를 Read 시도 → 바이너리 읽기 실패 → AI가 자체적으로 "Unsupported file type" 에러 생성
- ✅ **Confirmed**: 영상/오디오가 "binary" 취급되어 AI에게 잘못된 안내 발생

### Hypothesis 2: download_thread_file에서 video/audio 미차단
- `mcp-servers/slack-mcp/slack-mcp-server.ts:707-720` → `isImageFile()` 체크만 수행
- 이미지만 블록하고 video/audio는 다운로드 허용
- AI가 다운로드 후 Read 도구로 .mp4 읽기 시도 → 실패
- ✅ **Confirmed**: video/audio도 Read 불가한데 블록하지 않음

### Hypothesis 3: formatSingleMessage에서 video/audio 미인식
- `mcp-servers/slack-mcp/slack-mcp-server.ts:671-685` → `isImageFile()` 체크만
- 이미지: url_private_download 제외, "do NOT download" 노트 추가
- 영상/오디오: url_private_download 포함 → AI가 다운로드 시도
- ✅ **Confirmed**: video/audio에 대한 가이드 없음

## Conclusion: 3가지 모두 복합 원인

에러 메시지 자체는 코드에 없음 — AI 에이전트가 .mp4 파일을 Read하려다 실패한 후 자체 생성한 메시지.

### Fix Plan

1. **`src/file-handler.ts`**:
   - `isVideoFile(mimetype)`, `isAudioFile(mimetype)` 추가
   - `formatFilePrompt()`: video/audio를 image와 유사하게 처리 (경로 제공 안 함, 메타데이터만)
   - `validateImageContent()`: SVG, BMP, TIFF 등 추가 포맷 magic bytes 추가

2. **`mcp-servers/slack-mcp/slack-mcp-server.ts`**:
   - `isMediaFile()` 함수 추가: image + video + audio 통합 체크
   - `handleDownloadFile()`: video/audio도 블록 (Read 불가하므로)
   - `formatSingleMessage()`: video/audio 파일에 대한 적절한 노트 추가
   - `download_thread_file` tool description 업데이트

3. **테스트 업데이트**:
   - `file-handler.test.ts`: video/audio 파일 포맷 테스트
   - `slack-mcp-server.test.ts`: video/audio 블록 테스트
   - `slack-mcp-upload.test.ts`: 기존 테스트 유지
