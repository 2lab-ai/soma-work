# Bug Fix: File Attachments Ignored on Session Initiation

## Problem Statement

When a user @mentions the bot with file/image attachments as the **first message** (session initiation), the attached files are never processed. The AI receives only the text, not the files.

**Impact**: Users must send files in a separate follow-up message after the session is created, degrading the initial interaction experience.

## Root Cause

Slack emits two separate events for a message containing both @mention and files:
1. `app_mention` — carries text but **NOT** `files`
2. `message` (subtype: `file_share`) — carries `files` but is rejected by `handleFileUpload` when no session exists

Neither event path processes the files on session initiation.

## Architecture Decision

**Chosen approach**: Modify `handleFileUpload` to detect bot mentions and pass through to `handleMessage`. Suppress `app_mention` handler when `file_share` already handles the message.

**Rationale**: No extra Slack API calls. Clean separation — `file_share` event is the authoritative source of files.

**Alternative rejected**: Fetching full message in `app_mention` handler — adds latency to every mention.

## Scope

| Area | Files | Change |
|------|-------|--------|
| EventRouter | `src/slack/event-router.ts` | `handleFileUpload` + `app_mention` handler |

**Size**: small (~20 lines)

## Success Criteria

1. First @mention + file attachment → files processed and visible to AI
2. Existing flows unchanged: DM files, thread file uploads, mention-only messages
3. No duplicate processing (file_share + app_mention don't both call handleMessage)
4. `no_entry` emoji NOT added when files + mention are sent as first message
