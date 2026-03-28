# Bug Trace: file-attach-init — File attachments ignored on session initiation

## AS-IS
When a user @mentions the bot with file/image attachments as the **first message** (session initiation), the files are not processed. AI cannot read the attached files. A `no_entry` emoji is added to the message.

## TO-BE
First-mention messages with file attachments should process files and pass them to Claude, just like subsequent messages in an existing session.

## Phase 1: Heuristic Top-3

### Hypothesis 1: `app_mention` event does NOT include `files` field ✅ CONFIRMED
- Slack's `app_mention` event payload does not reliably include `files`.
- Files are only delivered via `message` event with `subtype: 'file_share'`.
- `EventRouter.setupMessageHandlers` line 78-107:
  - `app_mention` handler spreads `{...event, text}` → no `files` in payload
  - `handleMessage` → `inputProcessor.processFiles(event)` → `event.files` is undefined → 0 files processed

### Hypothesis 2: `handleFileUpload` rejects first message (no session) ✅ CONFIRMED
- `EventRouter.handleFileUpload` (event-router.ts:321-354):
  - Line 334: `const session = threadTs ? this.deps.claudeHandler.getSession(channel, threadTs) : undefined;`
  - For first message: `threadTs` is undefined → `session` is `undefined`
  - Falls to line 346-353: adds `no_entry` emoji, does NOT call `handleMessage`

### Hypothesis 3: processedFiles not reaching Claude SDK ❌ Ruled out
- `V1QueryAdapter.startWithContinuation` (v1-query-adapter.ts:103-143): correctly sets `baseParams.processedFiles`
- `StreamExecutor.execute` (stream-executor.ts:264): correctly calls `preparePrompt(text, processedFiles, ...)`
- `StreamExecutor.preparePrompt` (stream-executor.ts:169): correctly formats files into prompt
- **If files reach `handleMessage`, they DO reach Claude.** The problem is upstream.

## Root Cause: Dual-event gap

When a user sends `@bot + file` as first message:
1. `app_mention` fires → `handleMessage({...event, text})` → **no files** (Slack doesn't include `files` in `app_mention`)
2. `message(file_share)` fires → `handleFileUpload` → **no session** → `no_entry` emoji

Neither path processes the files. The files fall into a gap between two event handlers.

## Callstack

```
User sends @mention + file (first message)
  ├─ Slack emits `app_mention` event
  │   └─ EventRouter.app_mention handler (event-router.ts:78)
  │       ├─ text = event.text.replace(/<@[^>]+>/g, '').trim() (line 99)
  │       └─ this.messageHandler({...event, text}) (line 100-106)
  │           └─ event.files = undefined (app_mention doesn't carry files)
  │               └─ inputProcessor.processFiles → files=[] (input-processor.ts:34)
  │                   └─ Files NOT processed ❌
  │
  └─ Slack emits `message` event (subtype: 'file_share')
      └─ EventRouter.message handler (event-router.ts:110)
          └─ subtype === 'file_share' → handleFileUpload (line 132-134)
              └─ handleFileUpload (event-router.ts:321)
                  ├─ isDM? No
                  ├─ threadTs? undefined (first message)
                  ├─ session = undefined (no session yet)
                  └─ addReaction('no_entry') (line 352) ❌
```

## Fix Strategy

**Option A (Recommended)**: Modify `handleFileUpload` to detect bot mentions and pass through to `handleMessage`:
- If `file_share` message contains `<@botId>`, strip mention and call `handleMessage`
- In `app_mention` handler, skip if event has `subtype: 'file_share'` or if files are present (prevent double processing)

**Option B**: In `app_mention` handler, fetch full message via API to get files:
- Extra API call per mention (inefficient)
- Simpler code change

**Chosen: Option A** — no extra API calls, clean separation of concerns.
