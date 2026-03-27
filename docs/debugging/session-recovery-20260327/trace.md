# Session Recovery Failure After Restart

**Date**: 2026-03-27
**Severity**: P0 — 100% session recovery failure after server restart

## Symptom

After server restart, all sessions fail to resume with:
```
No conversation found with session ID: xxx
```

## Root Cause

PR #77 (`05479a8`) introduced per-session workspace isolation:
- Each new session gets a unique working directory: `/tmp/{slackId}/session_{timestamp}_{hash}/`
- This `sessionWorkingDir` is passed as `options.cwd` to Claude SDK's `query()`
- Claude SDK hashes `cwd` to determine storage path: `~/.claude/projects/<cwd-hash>/sessions/`

**The bug**: `sessionWorkingDir` was never added to `saveSessions()` / `loadSessions()` serialization.

After restart:
1. `loadSessions()` restores the session, but `sessionWorkingDir` is `undefined`
2. `effectiveWorkingDir` falls back to base user dir (`/tmp/{slackId}/`)
3. Different `cwd` → different project hash → different `~/.claude/projects/<hash>/`
4. Claude SDK looks for conversation JSONL in the wrong directory → "No conversation found"

## Fix

Three additions to `session-registry.ts`:
1. `SerializedSession` interface: added `sessionWorkingDir?: string`
2. `saveSessions()`: serialize `session.sessionWorkingDir`
3. `loadSessions()`: restore `serialized.sessionWorkingDir`

## Verification

- Unit test: `persists and restores sessionWorkingDir across save/load`
- Full suite: 1489/1490 passed (1 pre-existing failure in `startup-notifier.test.ts`, unrelated)

## Wrong Hypotheses (chronological)

1. **"Clear sessionId on restart"** — Wrong. Session IDs are persistent and resumable. Claude SDK stores conversations on disk.
2. **"PR #100 broke the resume path"** — Wrong. PR #100 (ghost session fix) does not touch save/load/resume at all.
