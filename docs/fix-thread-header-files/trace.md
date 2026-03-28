# Trace: Fix Thread Header Files Invisible on Mid-Thread Initiation

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| S1 | Legacy mode includes root message | tiny | ✅ GREEN |
| S2 | Thread-awareness hint guides array mode + root file check | small | ✅ GREEN |
| S3 | Array mode root message files unchanged (regression guard) | tiny | ✅ GREEN |

---

## S1: Legacy mode includes root message

### Description
`fetchMessagesBefore`가 root message를 skip하지 않고 결과에 포함한다.

### Trace

```
get_thread_messages({ before: 10 })
  → handleGetThreadMessages() [slack-mcp-server.ts:439]
    → isLegacyMode = true (before is defined)
    → handleLegacyMode() [slack-mcp-server.ts:493]
      → fetchMessagesBefore(anchorTs, 10) [slack-mcp-server.ts:604]
        → slack.conversations.replies({ channel, ts: threadTs, limit: 200 })
          → Slack API returns: [root_msg, reply_1, reply_2, ...]
        → for (const m of msgs):
          → m.ts === threadTs → BEFORE: continue (SKIP) → AFTER: collected.push(m) (INCLUDE)
          → root message with files → formatSingleMessage → files metadata included
```

### Contract Test
**File**: `mcp-servers/slack-mcp/slack-mcp-server.test.ts`
**Test**: `legacyMode_includesRootMessage: fetchMessagesBefore includes root message with files`

### Fix Location
- `slack-mcp-server.ts:620` — Remove `if (m.ts === this.context.threadTs) continue;`

---

## S2: Thread-awareness hint guides array mode + root file check

### Description
Thread-awareness hint가 array mode를 기본으로 안내하고, root message(offset 0) 파일 확인을 명시한다.

### Trace

```
StreamExecutor.preparePrompt() [stream-executor.ts:159]
  → isMidThreadMention({ threadTs, mentionTs }) = true
  → getThreadContextHint() [stream-executor.ts:195]
    → BEFORE: "(before/after 개수 지정)" — legacy mode 유도
    → AFTER: Array mode 기본 안내 + "먼저 offset 0(root)의 파일을 확인" 명시
```

### Contract Test
**File**: `src/slack/pipeline/stream-executor.test.ts` (existing)
**Test**: `threadHint_guidesArrayMode: hint mentions array mode and root file check`

### Fix Location
- `stream-executor.ts:195-209` — Rewrite hint text

---

## S3: Array mode root message files unchanged (regression guard)

### Description
Array mode에서 offset 0(root message)의 파일이 정상적으로 포함되는지 기존 동작을 보호한다.

### Trace

```
get_thread_messages({ offset: 0, limit: 1 })
  → handleArrayMode() [slack-mcp-server.ts:460]
    → fetchThreadSlice(0, 1, totalCount)
      → conversations.replies → msgs[0] = root message
      → currentIndex 0 >= offset 0 → collected.push(root)
    → formatSingleMessage(root) → files: [{ id, name, mimetype, is_image, ... }]
```

### Contract Test
**File**: `mcp-servers/slack-mcp/slack-mcp-server.test.ts`
**Test**: `arrayMode_rootMessageIncludesFiles: offset 0 returns root with file metadata`

### Fix Location
- No production code change — regression guard test only
