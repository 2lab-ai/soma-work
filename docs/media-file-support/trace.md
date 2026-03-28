# Media File Support (Video/Audio) — Vertical Trace

> STV Trace | Created: 2026-03-28
> Spec: docs/media-file-support/spec.md

## Table of Contents
1. [Scenario 1 — Inbound video/audio file prompt formatting](#scenario-1)
2. [Scenario 2 — Thread download_thread_file media blocking](#scenario-2)
3. [Scenario 3 — Thread message listing media file metadata](#scenario-3)

---

## Scenario 1 — Inbound video/audio file prompt formatting

When a user uploads a video/audio file to Slack, the file-handler must recognize it and format the prompt WITHOUT exposing the file path (preventing AI from attempting Read).

### 1. Entry Point
- Trigger: Slack `file_share` event with video/audio attachment
- Handler: `EventRouter.handleFileUpload()` → `InputProcessor.processFiles()` → `FileHandler.downloadAndProcessFiles()`
- Auth: Slack bot token (existing)

### 2. Input
- Slack file object: `{ name: "video.mp4", mimetype: "video/mp4", size: 12345678, url_private_download: "https://..." }`

### 3. Layer Flow

#### 3a. FileHandler.downloadAndProcessFiles (`src/file-handler.ts:21-36`)
- Iterates files → calls `downloadFile()` per file
- No changes needed here — downloads all files regardless of type

#### 3b. FileHandler.downloadFile (`src/file-handler.ts:38-121`)
- Downloads file buffer from Slack
- Creates `ProcessedFile`:
  - `file.isImage` = `this.isImageFile(mimetype)` → `"video/mp4".startsWith("image/")` = **false** ✓
  - `file.isText` = `this.isTextFile(mimetype)` → **false** ✓
  - **NEW**: `file.isVideo` = `this.isVideoFile(mimetype)` → `"video/mp4".startsWith("video/")` = **true**
  - **NEW**: `file.isAudio` = `this.isAudioFile(mimetype)` → **false**
- Transformation: `SlackFile.mimetype("video/mp4")` → `ProcessedFile.isVideo(true)`
- Transformation: `SlackFile.mimetype("audio/mpeg")` → `ProcessedFile.isAudio(true)`

#### 3c. FileHandler.formatFilePrompt (`src/file-handler.ts:194-239`)
- Current: 3 branches → `isImage` / `isText` / else (binary with path)
- **NEW**: 4 branches → `isImage` / `isVideo||isAudio` / `isText` / else
- **NEW video/audio branch** (inserted after isImage, before isText):
  ```
  if (file.isVideo || file.isAudio) {
    // Same pattern as image: NO path, metadata only
    prompt += `\n## Media: ${file.name}\n`
    prompt += `File type: ${file.mimetype}\n`
    prompt += `Size: ${file.size} bytes\n`
    prompt += `Note: This is a media file (${mediaCategory}). The file path is intentionally withheld. Acknowledge the file by name and metadata.\n`
  }
  ```
- Transformation: `ProcessedFile.isVideo(true)` → prompt contains "Media:" header, NO path

### 4. Side Effects
- Temp file written to disk (existing behavior, unchanged)
- Temp file cleaned up after session (existing behavior, unchanged)

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| Download fails | HTTP error | Logged, file skipped (existing) |
| File too large (>50MB) | Size check | Logged, file skipped (existing) |

### 6. Output
- Prompt string with media metadata (no file path)
- AI agent receives: file name, mimetype, size — sufficient to acknowledge the file

### 7. Observability
- Logger: `FileHandler` — existing logging covers download success/failure

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `formatFilePrompt omits path for video files` | Happy Path | Scenario 1, Section 3c |
| `formatFilePrompt omits path for audio files` | Happy Path | Scenario 1, Section 3c |
| `formatFilePrompt includes Media header for video` | Contract | Scenario 1, Section 3c, ProcessedFile.isVideo → "Media:" |
| `formatFilePrompt still works for images (regression)` | Contract | Scenario 1, Section 3c |
| `formatFilePrompt still works for text (regression)` | Contract | Scenario 1, Section 3c |
| `isVideoFile identifies video mimetypes` | Happy Path | Scenario 1, Section 3b |
| `isAudioFile identifies audio mimetypes` | Happy Path | Scenario 1, Section 3b |

---

## Scenario 2 — Thread download_thread_file media blocking

When AI agent tries to download a video/audio file via `download_thread_file`, it must be blocked (same as images) because Read tool cannot process binary media.

### 1. Entry Point
- Tool: `download_thread_file` MCP tool
- Handler: `SlackMcpServer.handleDownloadFile()` (`slack-mcp-server.ts:697`)
- Auth: Slack bot token (existing)

### 2. Input
- `{ file_url: "https://files.slack.com/.../video.mp4", file_name: "video.mp4" }`

### 3. Layer Flow

#### 3a. handleDownloadFile (`slack-mcp-server.ts:697-785`)
- Current: `isImageFile(undefined, file_name)` check only → blocks images
- **NEW**: Add `isMediaFile(file_name)` check → blocks images + video + audio
- `isMediaFile` function:
  ```
  function isMediaFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext);
  }
  ```
- Transformation: `file_name("video.mp4")` → `ext("mp4")` → `VIDEO_EXTENSIONS.has("mp4")` = true → **blocked**

#### 3b. Blocked response
- Returns JSON: `{ blocked: true, name: "video.mp4", reason: "Media files cannot be read..." }`
- Same pattern as image blocking (line 710-719)

### 4. Side Effects
- None — file is NOT downloaded

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| Video file name | Blocked | Return blocked response with reason |
| Audio file name | Blocked | Return blocked response with reason |
| Image file name | Blocked | Existing behavior unchanged |
| Text/code file name | Allowed | Existing behavior unchanged |

### 6. Output
- Blocked: `{ blocked: true, name: "video.mp4", reason: "Media files (image/video/audio) cannot be downloaded and read..." }`
- AI agent receives clear guidance: reference by name only

### 7. Observability
- Logger: `logger.warn('Blocked media file download', { name })` — extends existing image blocking log

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `isMediaFile returns true for video extensions` | Happy Path | Scenario 2, Section 3a |
| `isMediaFile returns true for audio extensions` | Happy Path | Scenario 2, Section 3a |
| `isMediaFile returns true for image extensions` | Contract | Scenario 2, Section 3a (regression) |
| `isMediaFile returns false for text/code extensions` | Sad Path | Scenario 2, Section 5 |
| `download_thread_file blocks video files` | Happy Path | Scenario 2, Section 3b |
| `download_thread_file blocks audio files` | Happy Path | Scenario 2, Section 3b |
| `download_thread_file still allows text files` | Sad Path | Scenario 2, Section 5 |

---

## Scenario 3 — Thread message listing media file metadata

When `get_thread_messages` returns files, video/audio files must have appropriate metadata (no download URL, media note) — same pattern as images.

### 1. Entry Point
- Tool: `get_thread_messages` MCP tool
- Handler: `SlackMcpServer.formatSingleMessage()` (`slack-mcp-server.ts:657`)

### 2. Input
- Slack message with file: `{ files: [{ id: "F123", name: "video.mp4", mimetype: "video/mp4", size: 12345, url_private_download: "https://..." }] }`

### 3. Layer Flow

#### 3a. formatSingleMessage (`slack-mcp-server.ts:657-693`)
- Current: Only `isImageFile()` check → image gets special treatment
- **NEW**: `isMediaFile()` check → image + video + audio get special treatment
- Transformation:
  ```
  const fileIsMedia = isMediaFile(f.name) || isImageFile(f.mimetype, f.name);
  ```
  - Media file: `url_private_download` excluded, `is_media: true`, media_note added
  - Non-media file: `url_private_download` included (existing behavior)

#### 3b. File metadata output
- Video/audio file in response:
  ```json
  {
    "id": "F123",
    "name": "video.mp4",
    "mimetype": "video/mp4",
    "size": 12345,
    "is_media": true,
    "media_type": "video",
    "media_note": "Media file — do NOT download or Read. Reference by name only."
  }
  ```
- No `url_private_download` → AI cannot attempt download

### 4. Side Effects
- None — read-only formatting

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| Unknown extension | Not media | url_private_download included (existing behavior) |

### 6. Output
- Thread message JSON with media files properly annotated
- AI receives metadata without download URL

### 7. Observability
- No additional logging needed — existing message formatting logs sufficient

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `formatSingleMessage excludes download URL for video files` | Happy Path | Scenario 3, Section 3a |
| `formatSingleMessage excludes download URL for audio files` | Happy Path | Scenario 3, Section 3a |
| `formatSingleMessage adds media_note for video files` | Contract | Scenario 3, Section 3b |
| `formatSingleMessage still includes download URL for text files` | Sad Path | Scenario 3, Section 5 |
| `formatSingleMessage still works for images (regression)` | Contract | Scenario 3, Section 3a |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| `isMediaFile()` 함수를 `isImageFile()` 옆에 추가 | tiny ~5줄 | 기존 패턴 확장 |
| `ProcessedFile` interface에 `isVideo`, `isAudio` 필드 추가 | tiny ~2줄 | 기존 `isImage`, `isText` 패턴 동일 |
| 미디어 파일 차단 메시지를 이미지 차단과 동일 포맷으로 | tiny ~3줄 | 일관성 |
| `formatSingleMessage`에서 `is_media` + `media_type` 필드 추가 | small ~10줄 | `is_image` 패턴 확장 |
| file-handler.ts에 VIDEO/AUDIO extension sets 독립 정의 | small ~10줄 | MCP 서버와 별도 프로세스. 공유 모듈은 over-engineering |

## Implementation Status

| Scenario | Trace | Tests | Verify | Status |
|----------|-------|-------|--------|--------|
| 1. Inbound video/audio prompt formatting | done | GREEN (12/12) | Verified | Complete |
| 2. download_thread_file media blocking | done | GREEN (45/45) | Verified | Complete |
| 3. Thread message listing media metadata | done | GREEN (45/45) | Verified | Complete |

## Trace Deviations

### Deviation 1 — isMediaFile signature expanded (Codex+Gemini P1)
- **Original**: `isMediaFile(filename: string)` — extension-only check
- **Updated**: `isMediaFile(mimetype?: string, filename?: string)` — mimetype + extension check
- **Reason**: Files with video/audio mimetype but no recognized extension bypassed blocking

### Deviation 2 — Media files skip download entirely (Gemini P2)
- **Original**: All files downloaded, then categorized. 50MB limit applied universally.
- **Updated**: Video/audio files return metadata-only ProcessedFile immediately, no download.
- **Reason**: Media prompt only uses name/mimetype/size. Downloading binary was wasteful, and 50MB limit silently dropped large media.

## Verified At
2026-03-28 — All 3 scenarios GREEN + Verified + Review fixes applied

## Files Modified
- `src/file-handler.ts` — ProcessedFile interface + isVideoFile/isAudioFile + formatFilePrompt media branch + media-skip-download
- `src/file-handler.test.ts` — 14 tests (video/audio support + download skip)
- `mcp-servers/slack-mcp/slack-mcp-server.ts` — isMediaFile(mimetype,filename) + handleDownloadFile media blocking + formatSingleMessage media metadata + tool description
- `mcp-servers/slack-mcp/slack-mcp-server.test.ts` — 13 new tests (media blocking + formatting + mimetype detection)
