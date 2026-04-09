# Session Archive Store — Vertical Trace

> STV Trace | Created: 2026-04-09
> Spec: docs/session-archive/spec.md

## Table of Contents
1. [Scenario 1 — Archive on Terminate](#scenario-1--archive-on-terminate)
2. [Scenario 2 — Archive on Sleep-Expire](#scenario-2--archive-on-sleep-expire)
3. [Scenario 3 — Dashboard Closed Column from Archive](#scenario-3--dashboard-closed-column-from-archive)
4. [Scenario 4 — CLI List Sessions](#scenario-4--cli-list-sessions)
5. [Scenario 5 — CLI Show Session Detail](#scenario-5--cli-show-session-detail)

---

## Scenario 1 — Archive on Terminate

세션이 명시적으로 종료(terminate)될 때, 삭제 전에 전체 메타데이터를 아카이브에 저장.

### 1. Entry Point
- Function: `SessionRegistry.terminateSession(sessionKey: string)`
- File: `src/session-registry.ts:1114`
- Trigger: 유저 `/end` 명령, 관리자 세션 종료, trashSession 후 terminate 등

### 2. Input
- `sessionKey: string` — channelId-threadTs 형식 (e.g., `C0AKY7W2UGZ-1775634595.799959`)
- Precondition: `this.sessions.has(sessionKey) === true`

### 3. Layer Flow

#### 3a. SessionRegistry.terminateSession() — 변경점

현재 코드 (AS-IS):
```
session.terminated = true
emitSessionClosed()
cleanupSourceWorkingDirs(session)
clearOnIdleCallbacks(sessionKey)
sessions.delete(sessionKey)
saveSessions()
```

변경 후 (TO-BE):
```
session.terminated = true
emitSessionClosed()
→ SessionArchiveStore.archive(session, sessionKey, 'terminated')  ← 추가
cleanupSourceWorkingDirs(session)
clearOnIdleCallbacks(sessionKey)
sessions.delete(sessionKey)
saveSessions()
```

Parameter transformation:
```
ConversationSession → ArchivedSession 변환:
  session.ownerId         → archived.ownerId
  session.ownerName       → archived.ownerName
  session.channelId       → archived.channelId
  session.threadTs        → archived.threadTs
  session.sessionId       → archived.sessionId
  session.conversationId  → archived.conversationId
  session.title           → archived.title
  session.model           → archived.model
  session.workflow        → archived.workflow
  session.lastActivity.toISOString() → archived.lastActivity
  session.links           → archived.links (deep copy)
  session.linkHistory     → archived.linkHistory (deep copy)
  session.instructions    → archived.instructions (deep copy)
  session.mergeStats      → archived.mergeStats (deep copy)
  session.usage           → archived.usage (deep copy)
  session.state           → archived.finalState
  session.activityState   → archived.finalActivityState
  Date.now()              → archived.archivedAt
  'terminated'            → archived.archiveReason
  sessionKey              → archived.sessionKey
```

#### 3b. SessionArchiveStore.archive()

```typescript
archive(session, sessionKey, reason):
  1. Convert ConversationSession → ArchivedSession (transformation above)
  2. JSON.stringify(archivedSession, null, 2)
  3. Atomic write: writeFileSync(tmpPath) → renameSync(tmpPath, finalPath)
     finalPath = {DATA_DIR}/archives/{sessionKey}.json
     tmpPath = finalPath + '.tmp'
```

#### 3c. File System
- Directory: `{DATA_DIR}/archives/` (auto-created if missing)
- File: `{sessionKey}.json` — sessionKey에서 `/`를 `-`로 치환 (path traversal 방지)
- Write mode: 덮어쓰기 (같은 세션이 재아카이브될 수 있음 — 멱등)

### 4. Side Effects
- FILE WRITE: `{DATA_DIR}/archives/{sanitizedKey}.json`
  - Content: ArchivedSession JSON
  - Size: ~2-5KB per session

### 5. Error Paths

| Condition | Handling | Impact |
|-----------|----------|--------|
| session not found in Map | return false (기존 동작) | 아카이브 안 됨 |
| archives/ 디렉토리 생성 실패 | logger.error, 계속 진행 | 아카이브 유실, terminate은 정상 완료 |
| 파일 쓰기 실패 (disk full 등) | logger.error, 계속 진행 | 아카이브 유실, terminate은 정상 완료 |

**핵심 원칙: 아카이브 실패가 terminate을 차단하면 안 된다.** try-catch로 감싸고 에러는 로그만 남긴다.

### 6. Output
- `terminateSession()` 반환값 변경 없음: `boolean`
- 파일 시스템에 아카이브 JSON 생성

### 7. Observability
- Log: `logger.info('Session archived', { sessionKey, reason: 'terminated' })`
- Log (error): `logger.error('Failed to archive session', { sessionKey, error })`

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `terminate_archivesSessionBeforeDelete` | Happy Path | Scenario 1, Section 3a |
| `terminate_archiveContainsAllMetadata` | Contract | Scenario 1, Section 3a transformation |
| `terminate_archiveFailure_doesNotBlockTerminate` | Sad Path | Scenario 1, Section 5 |
| `terminate_archiveFile_atomicWrite` | Side-Effect | Scenario 1, Section 3b |

---

## Scenario 2 — Archive on Sleep-Expire

SLEEPING 상태 세션이 7일 경과하여 만료될 때, 삭제 전에 아카이브 저장.

### 1. Entry Point
- Function: `SessionRegistry.cleanupInactiveSessions()`
- File: `src/session-registry.ts:1153`
- Trigger: 주기적 cron (세션 정리 루프)

### 2. Input
- 내부 순회: `this.sessions.entries()`
- 조건: `session.state === 'SLEEPING' && sleepAge >= MAX_SLEEP_DURATION (7d)`

### 3. Layer Flow

#### 3a. cleanupInactiveSessions() — 변경점

현재 코드 (AS-IS, line 1160-1174):
```
if (session.state === 'SLEEPING') {
  if (sleepAge >= MAX_SLEEP_DURATION) {
    onExpiry(session)
    cleanupSourceWorkingDirs(session)
    clearOnIdleCallbacks(key)
    sessions.delete(key)
    cleaned++
  }
}
```

변경 후 (TO-BE):
```
if (session.state === 'SLEEPING') {
  if (sleepAge >= MAX_SLEEP_DURATION) {
    onExpiry(session)
    → SessionArchiveStore.archive(session, key, 'sleep_expired')  ← 추가
    cleanupSourceWorkingDirs(session)
    clearOnIdleCallbacks(key)
    sessions.delete(key)
    cleaned++
  }
}
```

Parameter transformation: Scenario 1과 동일, reason만 `'sleep_expired'`로 다름.

### 4. Side Effects
- FILE WRITE: `{DATA_DIR}/archives/{sanitizedKey}.json` (Scenario 1과 동일)

### 5. Error Paths
- Scenario 1과 동일. 아카이브 실패 시 expire 처리는 계속 진행.

### 6. Output
- `cleanupInactiveSessions()` 반환값 변경 없음: `Promise<void>`

### 7. Observability
- Log: `logger.info('Session archived', { sessionKey: key, reason: 'sleep_expired' })`

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `sleepExpire_archivesSessionBeforeDelete` | Happy Path | Scenario 2, Section 3a |
| `sleepExpire_archiveReason_isSleepExpired` | Contract | Scenario 2, Section 3a |
| `sleepExpire_archiveFailure_doesNotBlockExpiry` | Sad Path | Scenario 2, Section 5 |

---

## Scenario 3 — Dashboard Closed Column from Archive

대시보드 칸반의 closed 컬럼이 아카이브에서 최근 48시간 내 종료 세션을 읽어 표시.

### 1. Entry Point
- Function: `buildKanbanBoard(userId?: string)`
- File: `src/conversation/dashboard.ts:308`
- Trigger: 대시보드 웹페이지 로드, WebSocket 업데이트

### 2. Input
- `userId?: string` — 특정 유저 필터 (optional)
- 아카이브 소스: `{DATA_DIR}/archives/*.json`

### 3. Layer Flow

#### 3a. buildKanbanBoard() — 변경점

현재 코드 (AS-IS):
```typescript
function buildKanbanBoard(userId?: string): KanbanBoard {
  const sessions = getAllSessions();
  const board = { working: [], waiting: [], idle: [], closed: [] };
  for (const [key, session] of sessions.entries()) {
    // ... terminated/SLEEPING → closed
  }
  return board;
}
```

변경 후 (TO-BE):
```typescript
function buildKanbanBoard(userId?: string): KanbanBoard {
  const sessions = getAllSessions();
  const board = { working: [], waiting: [], idle: [], closed: [] };

  // 1. 활성 세션 분류 (기존 로직)
  for (const [key, session] of sessions.entries()) {
    if (!session.sessionId) continue;
    if (userId && session.ownerId !== userId) continue;
    if (session.trashed === true) continue;
    const kanban = sessionToKanban(key, session);
    // SLEEPING은 여전히 closed로 (활성 Map에 있는 동안)
    if (session.state === 'SLEEPING') {
      board.closed.push(kanban);
    } else {
      switch (kanban.activityState) { ... }
    }
  }

  // 2. 아카이브에서 최근 종료 세션 추가 (신규)
  → const archives = archiveStore.listRecent(DASHBOARD_ARCHIVE_MAX_AGE);
  → for (const archived of archives) {
  →   if (userId && archived.ownerId !== userId) continue;
  →   board.closed.push(archivedToKanban(archived));
  → }

  return board;
}
```

Parameter transformation (ArchivedSession → KanbanSession):
```
archived.sessionKey       → kanban.sessionKey
archived.title            → kanban.title
archived.ownerName        → kanban.ownerName
archived.ownerId          → kanban.ownerId
archived.model            → kanban.model
archived.lastActivity     → kanban.lastActivity
archived.workflow         → kanban.workflow
archived.links            → kanban.links
archived.mergeStats       → kanban.mergeStats
archived.conversationId   → kanban.conversationId
'terminated'              → kanban.activityState (또는 새 상태 'archived')
archived.archiveReason    → kanban.archiveReason (신규 필드, optional)
```

#### 3b. SessionArchiveStore.listRecent()

```typescript
listRecent(maxAgeMs: number): ArchivedSession[]
  1. readdirSync(archivesDir) → 파일 목록
  2. 각 파일: readFileSync → JSON.parse → ArchivedSession
  3. 필터: archivedAt >= Date.now() - maxAgeMs
  4. Sort: archivedAt desc
  5. 반환
```

**성능 최적화**: 파일 stat의 mtime으로 먼저 필터링 후 JSON 파싱 → 대부분의 오래된 파일은 읽지 않음.

### 4. Side Effects
- 없음 (읽기 전용)

### 5. Error Paths

| Condition | Handling | Impact |
|-----------|----------|--------|
| archives/ 디렉토리 없음 | 빈 배열 반환 | closed 컬럼에 아카이브 없음 (기존 동작과 동일) |
| 개별 JSON 파싱 실패 | logger.warn, skip | 해당 세션만 누락 |

### 6. Output
- `KanbanBoard.closed` 배열에 아카이브 세션 포함
- 기존 SLEEPING 세션과 아카이브 세션이 함께 표시

### 7. Observability
- Log (debug): `logger.debug('Loaded N archived sessions for dashboard')`

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `dashboard_closedColumn_includesRecentArchives` | Happy Path | Scenario 3, Section 3a |
| `dashboard_closedColumn_excludesOldArchives` | Sad Path | Scenario 3, Section 3a (48h filter) |
| `dashboard_closedColumn_filtersArchivesByUser` | Contract | Scenario 3, Section 3a (userId filter) |
| `dashboard_closedColumn_archivedToKanban_transformation` | Contract | Scenario 3, Section 3a transformation |
| `dashboard_closedColumn_missingArchiveDir_returnsEmpty` | Sad Path | Scenario 3, Section 5 |

---

## Scenario 4 — CLI List Sessions

CLI로 아카이브된 세션 목록을 필터링/조회.

### 1. Entry Point
- Command: `tsx scripts/soma-cli.ts sessions list [options]`
- File: `scripts/soma-cli.ts` (신규)

### 2. Input
- CLI arguments:
  ```
  --user <userId>     유저 ID 필터
  --model <model>     모델 필터 (e.g., claude-opus-4-6)
  --since <date>      시작 날짜 (YYYY-MM-DD)
  --until <date>      종료 날짜 (YYYY-MM-DD)
  --limit <N>         최대 결과 수 (default: 50)
  --json              JSON 출력
  ```

### 3. Layer Flow

#### 3a. CLI Entry → SessionArchiveStore.list()

```
parseArgs(process.argv)
  → ArchiveFilter { ownerId, model, after, before, limit }

SessionArchiveStore.list(filter):
  1. readdirSync(archivesDir) → 파일 목록
  2. 각 파일: readFileSync → JSON.parse → ArchivedSession
  3. 필터 적용:
     - ownerId → archived.ownerId === filter.ownerId
     - model → archived.model === filter.model
     - after → archived.archivedAt >= filter.after
     - before → archived.archivedAt <= filter.before
  4. Sort: archivedAt desc
  5. Limit: slice(0, filter.limit)
  6. 반환
```

#### 3b. Output Formatting

테이블 출력 (default):
```
SessionKey           Owner     Model           Workflow  Archived At          Reason
C0AK...-1775..      Zhuge     claude-opus-4-6 default   2026-04-09 12:30:00  terminated
C0AK...-1775..      Alice     claude-sonnet   pr-review 2026-04-08 15:45:00  sleep_expired
```

JSON 출력 (--json):
```json
[{ "sessionKey": "...", "ownerId": "...", ... }]
```

### 4. Side Effects
- 없음 (읽기 전용)

### 5. Error Paths

| Condition | Handling |
|-----------|----------|
| archives/ 없음 | "No archived sessions found." 출력 후 exit 0 |
| 잘못된 옵션 | 사용법 출력 후 exit 1 |
| 필터 결과 없음 | "No sessions match the filter." 출력 후 exit 0 |

### 6. Output
- stdout: 테이블 또는 JSON
- exit code: 0 (성공), 1 (오류)

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `cli_listSessions_returnsAllArchives` | Happy Path | Scenario 4, Section 3a |
| `cli_listSessions_filterByUser` | Contract | Scenario 4, Section 3a filter |
| `cli_listSessions_filterByDateRange` | Contract | Scenario 4, Section 3a filter |
| `cli_listSessions_emptyResult_gracefulMessage` | Sad Path | Scenario 4, Section 5 |

---

## Scenario 5 — CLI Show Session Detail

CLI로 특정 아카이브 세션의 상세 정보 + 대화 이력 조회.

### 1. Entry Point
- Command: `tsx scripts/soma-cli.ts sessions show <sessionKey> [--conversation]`
- File: `scripts/soma-cli.ts` (신규)

### 2. Input
- `sessionKey: string` — positional argument
- `--conversation` flag: 대화 이력(ConversationRecord) 포함 여부

### 3. Layer Flow

#### 3a. CLI Entry → SessionArchiveStore.load() + ConversationStorage.load()

```
const sessionKey = args[0]
const showConversation = args.includes('--conversation')

const archived = archiveStore.load(sessionKey)
if (!archived) → "Session not found: {key}" exit 1

// 기본 출력: 세션 메타데이터
printSessionDetail(archived)

// --conversation 옵션 시 대화 이력 추가
if (showConversation && archived.conversationId) {
  const conversation = await conversationStorage.load(archived.conversationId)
  printConversation(conversation)
}
```

#### 3b. Output Formatting

세션 상세:
```
Session: C0AKY7W2UGZ-1775634595.799959
Owner:   Zhuge (U094E5L4A15)
Model:   claude-opus-4-6
Title:   세션 대시보드 정리
Workflow: default
Archived: 2026-04-09 12:30:00 (terminated)

Links:
  Issue: PTN-123 (open)
  PR:    #456 (merged)

Merge Stats:
  Lines: +120 / -45
  PRs:   1 merged

Instructions:
  1. [user] 세션 종료 기준 정리
```

대화 이력 (--conversation):
```
Conversation: 8 turns

[User] Zhuge — 2026-04-08 07:49:39
  지금 세션 대시보드에서 대기랑 종료를 나누는 기준이 뭐야?

[Assistant] — 2026-04-08 07:50:15
  Summary: 세션 상태 분류 기준 설명
  (use --raw to see full content)
```

### 4. Side Effects
- 없음 (읽기 전용)

### 5. Error Paths

| Condition | Handling |
|-----------|----------|
| sessionKey not provided | 사용법 출력 후 exit 1 |
| 아카이브 파일 없음 | "Session not found: {key}" exit 1 |
| conversationId 없음 + --conversation 옵션 | "No conversation linked to this session." |
| conversation 파일 없음 | "Conversation {id} not found on disk." |

### 6. Output
- stdout: 세션 상세 + (옵션) 대화 이력
- exit code: 0 (성공), 1 (오류)

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `cli_showSession_displaysMetadata` | Happy Path | Scenario 5, Section 3a |
| `cli_showSession_withConversation_displaysturns` | Happy Path | Scenario 5, Section 3a --conversation |
| `cli_showSession_notFound_exits1` | Sad Path | Scenario 5, Section 5 |
| `cli_showSession_noConversationId_gracefulMessage` | Sad Path | Scenario 5, Section 5 |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| archive()를 delete 전에 호출 | tiny | 삭제 후에는 데이터가 없으므로 당연 |
| 아카이브 실패가 terminate을 차단하지 않음 | small | 핵심 동작(세션 종료)이 부수 기능(아카이브)에 의존하면 안 됨 |
| listRecent()에서 mtime 사전 필터링 | small | 수천 파일에서 JSON 파싱 최소화 |
| CLI에서 --conversation을 별도 옵션으로 | small | 대화 이력은 크므로 기본은 메타데이터만 |
| SLEEPING 세션은 대시보드에서 기존대로 Map에서 읽음 | small | SLEEPING은 아직 활성(깨울 수 있음), 아카이브와 혼합하면 복잡 |
| `session.terminated` 조건 제거 | small | 대시보드 closed에서 `terminated === true` 체크는 도달 불가 코드였음. 아카이브로 대체 |

## Implementation Status

| Scenario | Trace | Tests (RED) | Status |
|----------|-------|-------------|--------|
| 1. Archive on Terminate | done | RED | Ready for stv:work |
| 2. Archive on Sleep-Expire | done | RED | Ready for stv:work |
| 3. Dashboard Closed from Archive | done | RED | Ready for stv:work |
| 4. CLI List Sessions | done | RED | Ready for stv:work |
| 5. CLI Show Session Detail | done | RED | Ready for stv:work |

## Changelog

_(Initial creation)_

## Next Step

→ Proceed with implementation + Trace Verify via `stv:work docs/session-archive/trace.md`
