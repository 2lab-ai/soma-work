# Trace: File Attachments on Session Initiation

## Scenario 1: First mention + file in channel → files processed (THE BUG FIX)

### 1. Entry Point
- **Event**: Slack `message` event, `subtype: 'file_share'`, message contains `<@BOT_ID>`
- **File**: `src/slack/event-router.ts` → `setupMessageHandlers()` → `message` listener

### 2. EventRouter.message handler
```
event-router.ts:132 → subtype === 'file_share' && messageEvent.files
  → this.handleFileUpload(messageEvent, say)
```

### 3. handleFileUpload (MODIFIED)
```
event-router.ts:321 → handleFileUpload(messageEvent, say)
  ├─ isDM? → No (channel message)
  ├─ threadTs? → undefined (first message, no thread)
  ├─ session? → undefined (no session yet)
  ├─ NEW: Check if message contains bot mention
  │   ├─ getBotUserId() → botId
  │   ├─ text.includes(`<@${botId}>`) → true
  │   ├─ Strip mention: text.replace(/<@[^>]+>/g, '').trim()
  │   └─ this.messageHandler(messageEvent, say) → creates session WITH files
  └─ (old path: no_entry emoji — now skipped)
```

### 4. app_mention handler (MODIFIED — dedup guard)
```
event-router.ts:78 → app_mention event fires for same message
  ├─ NEW: Check if event has files (file_share already handling)
  │   ├─ (event as any).subtype === 'file_share' || (event as any).files?.length > 0
  │   └─ return (skip — already handled by file_share path)
  └─ (if no files: existing path unchanged)
```

### 5. handleMessage → inputProcessor.processFiles
```
slack-handler.ts:287 → inputProcessor.processFiles(event, wrappedSay)
  → input-processor.ts:34 → event.files.length > 0 → downloads files
  → Returns processedFiles[]
```

### 6. V1QueryAdapter.startWithContinuation
```
v1-query-adapter.ts:109 → baseParams.processedFiles = processedFiles
  → executeTurn(prompt)
    → StreamExecutor.execute(params)
      → preparePrompt(text, processedFiles, ...)
        → fileHandler.formatFilePrompt(processedFiles, text)
        → Claude receives files in prompt ✅
```

### Parameter Transformation
```
Slack event.files[{id, name, mimetype, url_private, ...}]
  → FileHandler.downloadAndProcessFiles() → ProcessedFile[]
    → fileHandler.formatFilePrompt() → prompt string with file content
      → Claude SDK query({ prompt })
```

---

## Scenario 2: First mention WITHOUT file → unchanged behavior

### Flow
```
app_mention event fires
  ├─ NEW dedup check: no files → passes through
  ├─ text = event.text.replace(/<@[^>]+>/g, '').trim()
  └─ this.messageHandler({...event, text}, say) → existing flow ✅
```

No `message(file_share)` event fires. No change needed.

---

## Scenario 3: File upload in existing thread (no mention) → unchanged behavior

### Flow
```
message event (subtype: file_share, thread_ts present)
  → handleFileUpload
    ├─ threadTs? → defined
    ├─ session = getSession(channel, threadTs) → exists
    └─ this.messageHandler(messageEvent, say) → existing flow ✅
```

---

## Scenario 4: File upload in channel, no mention, no session → no_entry (unchanged)

### Flow
```
message event (subtype: file_share, no mention, no thread)
  → handleFileUpload
    ├─ isDM? → No
    ├─ threadTs? → undefined
    ├─ session? → undefined
    ├─ NEW: bot mention check → false
    └─ addReaction('no_entry') → existing behavior ✅
```

---

## Scenario 5: DM with file (no session) → unchanged

### Flow
```
message event (subtype: file_share, DM channel)
  → handleFileUpload
    ├─ isDM? → Yes
    └─ this.messageHandler(messageEvent, say) → existing flow ✅
```

---

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| 1 | First mention + file → files processed | small | Ready |
| 2 | First mention without file → unchanged | - | No change needed |
| 3 | File in existing thread → unchanged | - | No change needed |
| 4 | File in channel, no mention → no_entry | - | No change needed |
| 5 | DM with file → unchanged | - | No change needed |
