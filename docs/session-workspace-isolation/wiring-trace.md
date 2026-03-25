# Session Workspace Isolation — Wiring Trace

> STV Trace | Created: 2026-03-25
> Spec: docs/session-workspace-isolation/wiring-spec.md
> Parent trace: docs/session-workspace-isolation/trace.md (infrastructure)

## Table of Contents
1. [Scenario W1 — Session Base Dir Creation on New Session](#scenario-w1)
2. [Scenario W2 — Session CWD Wiring in Pipeline](#scenario-w2)
3. [Scenario W3 — Existing Session Backward Compatibility](#scenario-w3)
4. [Scenario W4 — Session Cleanup Includes sessionWorkingDir](#scenario-w4)

---

## Scenario W1 — Session Base Dir Creation on New Session

### 1. Entry Point
- Module: `WorkingDirectoryManager`
- Function: `createSessionBaseDir(slackId: string): string | undefined`
- File: `src/working-directory-manager.ts`
- Caller: `SessionInitializer.initialize()` (new session path)

### 2. Input
```typescript
slackId: string  // required — Slack user ID (e.g. "U094E5L4A15")
```

### 3. Layer Flow

#### 3a. WorkingDirectoryManager.createSessionBaseDir()
- Build directory name: `session_${Date.now()}_${this.sessionDirCounter++}`
- Build full path: `normalizeTmpPath(path.join('/tmp', slackId, dirName))`
  - → `"/tmp/U094E5L4A15/session_1742868567000_0"`
- `fs.mkdirSync(fullPath, { recursive: true })`
- Return: `fullPath`

Transformation:
```
slackId = "U094E5L4A15"
  → dirName = `session_${Date.now()}_${counter++}`
  → fullPath = normalizeTmpPath('/tmp/U094E5L4A15/' + dirName)
  → fs.mkdirSync(fullPath, { recursive: true })
  → return fullPath
```

### 4. Side Effects
- FS CREATE: `/tmp/{slackId}/session_{epochMs}_{counter}/`

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| slackId empty | validation | return undefined, log warn |
| mkdir fails | fs error | catch → return undefined, log error |

### 6. Output
- Success: `string` — normalized path
- Failure: `undefined`

### Contract Tests (RED)
| Test Name | Category |
|-----------|----------|
| `createSessionBaseDir_createsUniqueDir` | Happy Path |
| `createSessionBaseDir_emptySlackId_returnsUndefined` | Sad Path |
| `createSessionBaseDir_twoCalls_differentPaths` | Uniqueness |

---

## Scenario W2 — Session CWD Wiring in Pipeline

### 1. Entry Point
- Module: `SessionInitializer`
- Function: `initialize(event, workingDirectory, effectiveText?, forceWorkflow?)`
- File: `src/slack/pipeline/session-initializer.ts`
- Caller: `SlackHandler.handleMessage()` line 307

### 2. Input
- `event.user`: slack user ID
- `workingDirectory`: base validated dir from `validateWorkingDirectory()`
- New session flag: `isNewSession = !existingSession`

### 3. Layer Flow

#### 3a. SessionInitializer.initialize() — new session path (line ~126)
After `createSession()`:
```typescript
if (isNewSession) {
  // [NEW] Create session-unique working directory
  const sessionDir = this.deps.workingDirManager.createSessionBaseDir(user);
  if (sessionDir) {
    session.sessionWorkingDir = sessionDir;
    // Auto-register for cleanup
    this.deps.claudeHandler.addSourceWorkingDir(channel, threadTs, sessionDir);
  }
}
```

#### 3b. SessionInitResult — workingDirectory override
```typescript
// Prefer session-unique dir over fixed user dir
const effectiveWorkingDir = session.sessionWorkingDir || workingDirectory;

return {
  session, sessionKey, isNewSession, userName,
  workingDirectory: effectiveWorkingDir,
  abortController,
};
```

#### 3c. SlackHandler.handleMessage (no change needed)
- Line 353: `streamExecutor.execute({ workingDirectory: sessionResult.workingDirectory })`
- Already uses `sessionResult.workingDirectory` — which now contains the session-unique path

#### 3d. StreamExecutor → ClaudeHandler.streamQuery (no change needed)
- Line 525: `streamQuery(finalPrompt, session, abortController, workingDirectory, slackContext)`
- Line 549: `options.cwd = workingDirectory`

Transformation:
```
event.user = "U094E5L4A15"
  → createSessionBaseDir("U094E5L4A15")
    → session.sessionWorkingDir = "/tmp/U094E5L4A15/session_1742868567000_0"
  → addSourceWorkingDir(channel, threadTs, sessionDir)
  → SessionInitResult.workingDirectory = session.sessionWorkingDir
  → streamQuery cwd = "/tmp/U094E5L4A15/session_1742868567000_0"
```

### 4. Side Effects
- Session object gets `sessionWorkingDir` field set
- `sourceWorkingDirs` gets the session base dir registered
- Claude agent's cwd becomes the session-unique path

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| createSessionBaseDir fails | returns undefined | fallback to original `workingDirectory` (graceful degradation) |
| addSourceWorkingDir fails | returns false | log warn, session still works (dir just won't be auto-cleaned) |

### 6. Output
- `SessionInitResult.workingDirectory` = session-unique path (or fallback to base)

### Contract Tests (RED)
| Test Name | Category |
|-----------|----------|
| `initialize_newSession_createsSessionWorkingDir` | Happy Path |
| `initialize_newSession_registersSourceWorkingDir` | Integration |
| `initialize_existingSession_reusesSessionWorkingDir` | Reuse |
| `initialize_createSessionBaseDirFails_fallsBackToBaseDir` | Graceful Degradation |

---

## Scenario W3 — Existing Session Backward Compatibility

### 1. Entry Point
- Module: `SessionInitializer`
- Function: `initialize()` — existing session path
- Scenario: Session created before wiring deployment (no sessionWorkingDir field)

### 2. Input
- Existing session with `session.sessionWorkingDir === undefined`

### 3. Layer Flow

#### 3a. SessionInitializer.initialize() — existing session path
```typescript
const existingSession = this.deps.claudeHandler.getSession(channel, threadTs);
const isNewSession = !existingSession;
// isNewSession = false → skip createSessionBaseDir

const session = existingSession;
// session.sessionWorkingDir is undefined (pre-wiring session)

const effectiveWorkingDir = session.sessionWorkingDir || workingDirectory;
// effectiveWorkingDir = workingDirectory (from validateWorkingDirectory = /tmp/{userId}/)
```

#### 3b. Result
- CWD = `/tmp/{userId}/` (same as before wiring)
- No behavioral change for existing sessions

### 4. Side Effects
- None

### Contract Tests (RED)
| Test Name | Category |
|-----------|----------|
| `initialize_existingSessionWithoutSessionWorkingDir_usesBaseDir` | Backward Compat |

---

## Scenario W4 — Session Cleanup Includes sessionWorkingDir

### 1. Entry Point
- Module: `SessionRegistry`
- Function: `cleanupSourceWorkingDirs(session)` + `terminateSession(sessionKey)`
- Scenario: Session ends, sessionWorkingDir should be cleaned up

### 2. Input
- `session.sourceWorkingDirs = ["/tmp/U094E5L4A15/session_1742868567000_0"]`
- (registered by Scenario W2, step 3a)

### 3. Layer Flow

Already implemented in PR #77:
- `terminateSession()` → `cleanupSourceWorkingDirs(session)`
- → `session.sourceWorkingDirs.forEach(dir => safeRemoveSourceDir(dir))`
- → `fs.rmSync(dir, { recursive: true, force: true })`

No new code needed — sessionWorkingDir is auto-registered in sourceWorkingDirs (Scenario W2).

### 4. Side Effects
- `/tmp/{userId}/session_{epochMs}_{counter}/` deleted recursively

### Contract Tests (RED)
| Test Name | Category |
|-----------|----------|
| `cleanup_removesSessionBaseDir` | Happy Path |

---

## Implementation Status
| Scenario | Trace | Tests | Verify | Status |
|----------|-------|-------|--------|--------|
| W1. Session Base Dir Creation | done | pending | — | Ready |
| W2. Session CWD Wiring | done | pending | — | Ready |
| W3. Backward Compatibility | done | pending | — | Ready |
| W4. Cleanup | done | pending | — | Ready (reuse PR #77 infra) |

## Auto-Decisions
| Decision | Tier | Rationale |
|----------|------|-----------|
| 새 메서드 `createSessionBaseDir` 추가 (기존 `createSessionWorkingDir` 재활용 아님) | small | `createSessionWorkingDir`은 repoUrl/prName 필요. 세션 base dir은 더 단순한 서명 |
| `session.sessionWorkingDir` 필드 추가 | tiny | 기존 `workingDirectory` 필드와 역할 분리 (base vs session-unique) |
| sourceWorkingDirs에 auto-register | tiny | 기존 cleanup 메커니즘 재활용, 추가 코드 최소화 |
| 모든 세션에 적용 (워크플로우 무관) | small | dispatch 전에 cwd 결정 필요. 선택적 적용은 복잡도만 증가 |
