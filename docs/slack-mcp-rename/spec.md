# Slack MCP Rename + File Upload Tools — Spec

> STV Spec | Created: 2026-03-28

## 1. Overview

`slack-thread` MCP 서버를 `slack-mcp`로 리네이밍하고, 파일/미디어 업로드 기능을 추가한다.
현재 서버는 스레드 읽기(get_thread_messages)와 파일 다운로드(download_thread_file)만 지원한다.
이번 작업으로 AI가 Slack 스레드에 파일과 미디어를 직접 전송할 수 있게 된다.

## 2. User Stories

- As an AI agent, I want to send files to the Slack thread, so that I can share code outputs, reports, and generated artifacts directly with the user.
- As an AI agent, I want to send images/audio/video to the Slack thread, so that I can share visual results, voice responses, and media content.
- As a developer, I want the MCP server name to reflect its broader scope (not just "thread reading"), so that the naming is accurate and extensible.

## 3. Acceptance Criteria

- [ ] All references to `slack-thread` renamed to `slack-mcp` (folder, files, class names, env vars, tool prefix, config keys)
- [ ] Existing tools (get_thread_messages, download_thread_file) work identically after rename
- [ ] `send_file` tool uploads any file (≤1GB) from local filesystem to current Slack thread
- [ ] `send_media` tool uploads media files (image/audio/video) with appropriate metadata (alt_text, title)
- [ ] Both upload tools validate: file existence, file size ≤1GB, path sanitization (no path traversal)
- [ ] Both upload tools share files to the correct channel + thread_ts from context
- [ ] All existing tests updated and passing after rename
- [ ] New tests for send_file and send_media tools
- [ ] mcp-config-builder.ts registers the server as 'slack-mcp' with tool prefix mcp__slack-mcp

## 4. Scope

### In-Scope
- Full rename: slack-thread → slack-mcp (code, tests, config, docs)
- send_file tool: upload arbitrary files via filesUploadV2
- send_media tool: upload media (images, audio, video) via filesUploadV2 with media-specific params
- Security validation: path traversal prevention, size limits, file existence checks
- Test coverage for new tools

### Out-of-Scope
- Batch upload (multiple files in one call) — future enhancement
- File upload progress reporting
- Slack Connect channel restrictions
- Changing the SLACK_BOT_TOKEN scope (assumes files:write already granted)
- Message-only posting (use existing Slack handler for that)

## 5. Architecture

### 5.1 Layer Structure

```
Claude Code ──MCP──► SlackMcpServer
                         │
                         ├── get_thread_messages()  (existing, unchanged)
                         ├── download_thread_file()  (existing, unchanged)
                         ├── send_file()             (NEW)
                         └── send_media()            (NEW)
                                │
                                ▼
                      @slack/web-api WebClient
                         │
                         └── filesUploadV2()
                               ├── files.getUploadURLExternal
                               ├── HTTP POST to upload_url
                               └── files.completeUploadExternal
```

### 5.2 Tool Definitions

#### send_file
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| file_path | string | yes | Absolute path to file on local filesystem |
| filename | string | no | Display name in Slack (defaults to basename of file_path) |
| title | string | no | File title shown in Slack |
| initial_comment | string | no | Message posted with the file |

#### send_media
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| file_path | string | yes | Absolute path to media file |
| filename | string | no | Display name in Slack |
| title | string | no | Media title |
| alt_text | string | no | Alt text for images (accessibility) |
| initial_comment | string | no | Message posted with the media |

### 5.3 DB Schema
N/A — no database involved.

### 5.4 Integration Points

| Component | File | Change |
|-----------|------|--------|
| MCP Config Builder | src/mcp-config-builder.ts | Server key 'slack-thread' → 'slack-mcp', method names, BASENAME const, env var name, allowed tools prefix |
| Slack Handler | src/slack-handler.ts | AUTO_RESUME_PROMPT: 'slack-thread' → 'slack-mcp' reference |
| MCP Server | mcp-servers/slack-mcp/slack-mcp-server.ts | Renamed file, class, env var, add 2 new tools |
| Tests | src/*.test.ts, mcp-servers/slack-mcp/*.test.ts | All assertions updated |
| Docs | docs/*/spec.md, docs/*/trace.md | 6 doc files updated |

### 5.5 Security Design

1. **File existence**: `fs.access(file_path, fs.constants.R_OK)` before upload
2. **Size validation**: `fs.stat()` → reject if > 1GB (1,073,741,824 bytes)
3. **Path sanitization**: Resolve to absolute path, reject if contains `..` after resolution
4. **No symlink following**: Use `fs.lstat()` to detect symlinks, reject them
5. **Content type validation** (send_media only): Check file extension against allowed media types

### 5.6 Supported Media Types (send_media)

| Category | Extensions |
|----------|-----------|
| Image | jpg, jpeg, png, gif, webp, svg, bmp, ico, tiff, tif, heic, heif, avif |
| Audio | mp3, wav, ogg, flac, m4a, aac, wma |
| Video | mp4, mov, avi, mkv, webm, wmv, m4v, mpg, mpeg, 3gp |

## 6. Non-Functional Requirements

- **Performance**: filesUploadV2 handles chunked upload internally; no additional optimization needed
- **Security**: Path traversal prevention, size limits, no symlink following
- **Reliability**: Slack API errors (rate limit, auth) classified with retryable flag (existing pattern)
- **Scalability**: Single file per call; batch upload deferred to future

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Env var SLACK_THREAD_CONTEXT → SLACK_MCP_CONTEXT | tiny ~5 lines | Direct rename, referenced in 2 files only |
| Class name SlackThreadMcpServer → SlackMcpServer | tiny ~5 lines | Follows rename pattern |
| Logger tag 'SlackThreadMCP' → 'SlackMCP' | tiny ~2 lines | Cosmetic |
| Temp dir 'slack-thread-files' → 'slack-mcp-files' | tiny ~2 lines | Follows rename |
| Security: follow existing download_thread_file validation pattern | small ~20 lines | Proven pattern in same codebase |
| send_file and send_media as separate tools (not merged) | small ~20 lines | User explicitly requested two tools; send_media adds media-specific validation + alt_text param |
| No symlink following for security | small ~10 lines | Prevents path traversal via symlinks to sensitive files |
| Docs update included | small ~15 lines | Consistency; stale references cause confusion |

## 8. Open Questions
None — all requirements are clear.

## 9. Next Step
→ Proceed with Vertical Trace via `stv:trace docs/slack-mcp-rename/spec.md`
