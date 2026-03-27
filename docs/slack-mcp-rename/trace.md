# Slack MCP Rename + File Upload Tools — Vertical Trace

> STV Trace | Created: 2026-03-28
> Spec: docs/slack-mcp-rename/spec.md

## Table of Contents
1. [Scenario 1 — Rename slack-thread → slack-mcp](#scenario-1)
2. [Scenario 2 — send_file: Upload file to Slack thread](#scenario-2)
3. [Scenario 3 — send_media: Upload media to Slack thread](#scenario-3)
4. [Scenario 4 — Security validation (path traversal, size, symlink)](#scenario-4)
5. [Scenario 5 — Existing tools work after rename](#scenario-5)

---

## Scenario 1 — Rename slack-thread → slack-mcp

Mechanical rename across all layers. No behavior change.

### 1. API Entry
- MCP server registration key: `'slack-thread'` → `'slack-mcp'`
- Tool prefix: `mcp__slack-thread` → `mcp__slack-mcp`
- No HTTP endpoints involved (MCP over stdio)

### 2. Input
- Environment variable: `SLACK_THREAD_CONTEXT` → `SLACK_MCP_CONTEXT`
- Same JSON shape: `{ channel: string, threadTs: string, mentionTs: string }`

### 3. Layer Flow

#### 3a. mcp-config-builder.ts (Registration)
- `SLACK_THREAD_SERVER_BASENAME` → `SLACK_MCP_SERVER_BASENAME` = `'slack-mcp-server'`
- `slackThreadServerCache` → `slackMcpServerCache`
- `getSlackThreadServerPath()` → `getSlackMcpServerPath()`
  - path: `path.join(MCP_SERVERS_DIR, 'slack-thread')` → `path.join(MCP_SERVERS_DIR, 'slack-mcp')`
- `buildSlackThreadServer()` → `buildSlackMcpServer()`
  - env key: `SLACK_THREAD_CONTEXT` → `SLACK_MCP_CONTEXT`
  - error message: `'Cannot build slack-thread server...'` → `'Cannot build slack-mcp server...'`
- Registration: `internalServers['slack-thread']` → `internalServers['slack-mcp']`
- Allowed tools: `allowedTools.push('mcp__slack-thread')` → `allowedTools.push('mcp__slack-mcp')`
- Comment line 155: update

#### 3b. slack-handler.ts (Auto-Resume)
- `AUTO_RESUME_PROMPT`: `'slack-thread → get_thread_messages...'` → `'slack-mcp → get_thread_messages...'`

#### 3c. slack-mcp-server.ts (Server itself)
- Directory: `mcp-servers/slack-thread/` → `mcp-servers/slack-mcp/`
- File: `slack-thread-mcp-server.ts` → `slack-mcp-server.ts`
- Server identity: `{ name: 'slack-thread', version: '2.0.0' }` → `{ name: 'slack-mcp', version: '3.0.0' }`
- Class: `SlackThreadMcpServer` → `SlackMcpServer`
- Interface: `SlackThreadContext` → `SlackMcpContext`
- Logger: `StderrLogger('SlackThreadMCP')` → `StderrLogger('SlackMCP')`
- Env var read: `process.env.SLACK_THREAD_CONTEXT` → `process.env.SLACK_MCP_CONTEXT`
- Error messages: all `SLACK_THREAD_CONTEXT` → `SLACK_MCP_CONTEXT`
- Temp dir: `'slack-thread-files'` → `'slack-mcp-files'`
- Log messages: `'SlackThread MCP server started'` → `'SlackMCP server started'`

#### 3d. Test files
- `mcp-servers/slack-thread/*.test.ts` → `mcp-servers/slack-mcp/*.test.ts`
- `src/mcp-config-builder.test.ts`: server key, tool prefix, env var assertions
- `src/auto-resume.test.ts`: RESUME_PROMPT constant

#### 3e. Documentation (6 files)
- `docs/mcp-extraction/spec.md` → directory tree refs
- `docs/mcp-extraction/trace.md` → file path refs
- `docs/auto-resume/spec.md` → resume prompt ref
- `docs/auto-resume/trace.md` → resume prompt ref
- `docs/issue64-midthread-fix-v2/spec.md` → file path refs
- `docs/issue64-midthread-fix-v2/trace.md` → file path refs

### 4. Side Effects
- Directory renamed on filesystem
- No DB changes
- No runtime behavior change

### 5. Error Paths
| Condition | Error | Impact |
|-----------|-------|--------|
| Missed reference | Tool call fails at runtime (mcp__slack-thread not found) | Must grep-verify zero remaining references |

### 6. Output
- All tools now prefixed `mcp__slack-mcp__*`
- Identical behavior to before

### 7. Observability
- Logger tag changes from `SlackThreadMCP` to `SlackMCP`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| registers server as slack-mcp key | Contract | Scenario 1, 3a, registration |
| allowed tools includes mcp__slack-mcp | Contract | Scenario 1, 3a, allowed tools |
| passes SLACK_MCP_CONTEXT env var | Contract | Scenario 1, 3a, env var |
| server identifies as slack-mcp | Contract | Scenario 1, 3c, server identity |

---

## Scenario 2 — send_file: Upload file to Slack thread

### 1. API Entry
- MCP Tool: `send_file`
- Transport: stdio (MCP protocol)
- Auth: Inherited SLACK_BOT_TOKEN (requires `files:write` scope)

### 2. Input
```json
{
  "file_path": "string (required) — absolute path to local file",
  "filename": "string (optional) — display name, defaults to path.basename(file_path)",
  "title": "string (optional) — file title in Slack",
  "initial_comment": "string (optional) — message posted with file"
}
```
- Validation rules:
  - file_path: must be absolute, must exist, must be readable, must not be symlink
  - file size: ≤ 1,073,741,824 bytes (1GB)
  - file_path: no `..` segments after path.resolve()

### 3. Layer Flow

#### 3a. Tool Handler (SlackMcpServer.handleSendFile)
- Transformation:
  - args.file_path → resolvedPath = path.resolve(file_path)
  - args.filename → displayName = filename || path.basename(resolvedPath)
  - args.title → title (pass-through, optional)
  - args.initial_comment → initial_comment (pass-through, optional)
- Security checks (see Scenario 4):
  - validateFilePath(resolvedPath) → { size, resolvedPath }

#### 3b. Slack API Call
- Method: `this.slack.filesUploadV2()`
- Parameters:
  - `file`: resolvedPath (string — SDK reads from disk)
  - `filename`: displayName
  - `channel_id`: this.context.channel
  - `thread_ts`: this.context.threadTs
  - `title`: title (if provided)
  - `initial_comment`: initial_comment (if provided)
- Transformation: resolvedPath → filesUploadV2.file, context.channel → channel_id, context.threadTs → thread_ts

#### 3c. Slack API Response
- `result.files[0]` → file metadata (id, name, permalink, etc.)

### 4. Side Effects
- File uploaded to Slack workspace storage
- Message posted in thread with file attachment
- Workspace storage quota consumed

### 5. Error Paths
| Condition | Error | Response |
|-----------|-------|----------|
| file_path missing | `file_path is required` | isError: true |
| File not found | `File not found: {path}` | isError: true |
| File too large (>1GB) | `File too large: {size} bytes (max 1GB)` | isError: true |
| Path traversal detected | `Path traversal not allowed` | isError: true |
| Symlink detected | `Symlinks not allowed for security` | isError: true |
| Not readable | `File not readable: {path}` | isError: true |
| Slack API rate limit | `{ error, retryable: true }` | isError: true |
| Slack API auth error | `{ error, hint: 'Bot token...' }` | isError: true |
| Slack API other error | `{ error, retryable: false }` | isError: true |

### 6. Output
- Success response:
```json
{
  "uploaded": true,
  "file_id": "F0123ABC",
  "filename": "report.pdf",
  "size": 204800,
  "permalink": "https://slack.com/files/...",
  "channel": "C0123",
  "thread_ts": "1700000000.000000"
}
```

### 7. Observability
- Log: `logger.info('File uploaded', { name, size, file_id })`
- Error log: `logger.error('send_file failed', error)`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| send_file uploads file to thread | Happy Path | Scenario 2, Section 3b |
| send_file returns file metadata | Happy Path | Scenario 2, Section 6 |
| send_file uses basename as default filename | Contract | Scenario 2, Section 3a |
| send_file rejects missing file_path | Sad Path | Scenario 2, Section 5 |
| send_file rejects nonexistent file | Sad Path | Scenario 2, Section 5 |
| send_file rejects oversized file | Sad Path | Scenario 2, Section 5 |
| send_file classifies Slack API errors | Side-Effect | Scenario 2, Section 5 |

---

## Scenario 3 — send_media: Upload media to Slack thread

### 1. API Entry
- MCP Tool: `send_media`
- Transport: stdio (MCP protocol)
- Auth: Inherited SLACK_BOT_TOKEN (requires `files:write` scope)

### 2. Input
```json
{
  "file_path": "string (required) — absolute path to media file",
  "filename": "string (optional) — display name",
  "title": "string (optional) — media title",
  "alt_text": "string (optional) — alt text for images",
  "initial_comment": "string (optional) — message with media"
}
```
- Validation rules:
  - Same as send_file (existence, size, path traversal, symlink)
  - PLUS: file extension must be in ALLOWED_MEDIA_EXTENSIONS set

### 3. Layer Flow

#### 3a. Tool Handler (SlackMcpServer.handleSendMedia)
- Transformation:
  - args.file_path → resolvedPath = path.resolve(file_path)
  - resolvedPath → ext = path.extname().toLowerCase().slice(1)
  - ext → validate against ALLOWED_MEDIA_EXTENSIONS
  - args.filename → displayName = filename || path.basename(resolvedPath)
  - args.alt_text → alt_text (pass-through for images, optional)
- Security checks: validateFilePath(resolvedPath) + media type check

#### 3b. Slack API Call
- Method: `this.slack.filesUploadV2()`
- Parameters (same as send_file plus):
  - `alt_text`: alt_text (if provided — for images)
- Transformation: identical to send_file, plus alt_text pass-through

#### 3c. Slack API Response
- Same as send_file

### 4. Side Effects
- Same as send_file
- Images get inline preview in Slack (if < 25k px longest side)
- Video/audio get inline player (mp4, mov, mp3, wav)

### 5. Error Paths
| Condition | Error | Response |
|-----------|-------|----------|
| All send_file errors | Same as Scenario 2 | Same |
| Unsupported media type | `Unsupported media type: .{ext}. Allowed: {list}` | isError: true |

### 6. Output
- Same schema as send_file, plus:
```json
{
  "uploaded": true,
  "file_id": "F0123ABC",
  "filename": "screenshot.png",
  "size": 102400,
  "media_type": "image",
  "permalink": "https://slack.com/files/...",
  "channel": "C0123",
  "thread_ts": "1700000000.000000"
}
```

### 7. Observability
- Log: `logger.info('Media uploaded', { name, size, file_id, media_type })`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| send_media uploads image to thread | Happy Path | Scenario 3, Section 3b |
| send_media uploads audio to thread | Happy Path | Scenario 3, Section 3b |
| send_media uploads video to thread | Happy Path | Scenario 3, Section 3b |
| send_media passes alt_text for images | Contract | Scenario 3, Section 3b |
| send_media rejects unsupported extension | Sad Path | Scenario 3, Section 5 |
| send_media returns media_type in response | Contract | Scenario 3, Section 6 |

---

## Scenario 4 — Security validation (shared by send_file and send_media)

### 1. API Entry
- Internal function: `validateFilePath(filePath: string)`
- Called by: handleSendFile, handleSendMedia

### 2. Input
- `filePath`: raw string from tool args

### 3. Layer Flow

#### 3a. Path Resolution
- `resolvedPath = path.resolve(filePath)` — resolves relative paths and `..`
- Check: if `filePath !== resolvedPath` AND original contains `..` → reject

#### 3b. Symlink Check
- `stat = await fs.lstat(resolvedPath)`
- Check: `stat.isSymbolicLink()` → reject

#### 3c. Existence + Readability
- `await fs.access(resolvedPath, fs.constants.R_OK)` → reject if not readable

#### 3d. Size Check
- `stat = await fs.stat(resolvedPath)`
- Check: `stat.size > MAX_FILE_SIZE (1073741824)` → reject

### 4. Side Effects
- None — pure validation

### 5. Error Paths
| Condition | Error |
|-----------|-------|
| Path contains `..` after resolve | `Path traversal not allowed: {path}` |
| File is symlink | `Symlinks not allowed for security: {path}` |
| File not found / not readable | `File not found or not readable: {path}` |
| File > 1GB | `File too large: {size} bytes. Maximum: 1073741824 bytes (1GB)` |

### 6. Output
- Returns: `{ resolvedPath: string, size: number }` on success

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| validateFilePath accepts valid file | Happy Path | Scenario 4, Section 3 |
| validateFilePath rejects path traversal | Sad Path | Scenario 4, Section 5 |
| validateFilePath rejects symlinks | Sad Path | Scenario 4, Section 5 |
| validateFilePath rejects nonexistent file | Sad Path | Scenario 4, Section 5 |
| validateFilePath rejects oversized file | Sad Path | Scenario 4, Section 5 |

---

## Scenario 5 — Existing tools work after rename

### 1. API Entry
- MCP Tools: `get_thread_messages`, `download_thread_file`
- Same behavior, new prefix: `mcp__slack-mcp__get_thread_messages`, `mcp__slack-mcp__download_thread_file`

### 2. Input
- Unchanged from current implementation

### 3. Layer Flow
- No code changes to tool handlers
- Only the server registration key and env var name change
- Tool names within the MCP server remain `get_thread_messages` and `download_thread_file`

### 4. Side Effects
- None beyond what already exists

### 5. Error Paths
- Unchanged

### 6. Output
- Unchanged

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| get_thread_messages still listed in tools | Contract | Scenario 5, Section 3 |
| download_thread_file still listed in tools | Contract | Scenario 5, Section 3 |
| server env var is SLACK_MCP_CONTEXT | Contract | Scenario 5, Section 1 |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Version bump to 3.0.0 (breaking: env var rename) | small ~5 lines | Semver: env var rename is breaking change |
| validateFilePath as shared private method | small ~10 lines | DRY: both send_file and send_media use identical validation |
| Media type categorization (image/audio/video) in response | tiny ~5 lines | Useful for model to know what was uploaded |
| ALLOWED_MEDIA_EXTENSIONS as const Set | tiny ~3 lines | Follows existing IMAGE_EXTENSIONS pattern |

## Implementation Status
| Scenario | Trace | Tests (RED) | Status |
|----------|-------|-------------|--------|
| 1. Rename slack-thread → slack-mcp | done | RED | Ready for stv:work |
| 2. send_file tool | done | RED | Ready for stv:work |
| 3. send_media tool | done | RED | Ready for stv:work |
| 4. Security validation | done | RED | Ready for stv:work |
| 5. Existing tools after rename | done | RED | Ready for stv:work |

## Next Step
→ Proceed with implementation + Trace Verify via `stv:work`
