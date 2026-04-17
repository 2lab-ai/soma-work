# Governance Audit DB (SQLite Phase A) — Vertical Trace

> STV Trace | Created: 2026-04-17
> Spec: docs/governance-db/spec.md

## Table of Contents
1. [Scenario 1 — DB Initialization + Migration on First Run](#scenario-1--db-initialization--migration-on-first-run)
2. [Scenario 2 — Record Governance Evaluation (INSERT)](#scenario-2--record-governance-evaluation-insert)
3. [Scenario 3 — Create Approval Record (pending)](#scenario-3--create-approval-record-pending)
4. [Scenario 4 — Resolve Approval (Slack button click)](#scenario-4--resolve-approval-slack-button-click)
5. [Scenario 5 — Find Reusable Approval (auto-approve path)](#scenario-5--find-reusable-approval-auto-approve-path)
6. [Scenario 6 — Invalidate Approvals by Fingerprint (policy change)](#scenario-6--invalidate-approvals-by-fingerprint-policy-change)
7. [Scenario 7 — Audit Query — Recent Evaluations](#scenario-7--audit-query--recent-evaluations)
8. [Scenario 8 — DB Unavailable Degradation](#scenario-8--db-unavailable-degradation)

### Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| 1 | DB init + migration | medium | Ready |
| 2 | Record evaluation INSERT | small | Ready |
| 3 | Create approval record | small | Ready |
| 4 | Resolve approval | small | Ready |
| 5 | Find reusable approval | small | Ready |
| 6 | Invalidate by fingerprint | small | Ready |
| 7 | Audit query API | small | Ready |
| 8 | DB unavailable degradation | small | Ready |

---

## Scenario 1 — DB Initialization + Migration on First Run

App startup → `getSomaDb()` 최초 호출 → 파일 부재 시 생성 → `001_governance.sql` 실행 → `schema_version` 테이블에 v1 기록.

### 1. Entry Point
- Function: `getSomaDb(): Database`
- File: `src/db/soma-db.ts`
- Trigger: First call from `governanceEvaluationStore.record()` or `approvalRecordStore.create()` (lazy init).

### 2. Input
- None (uses `DATA_DIR` from `src/env-paths.ts`).
- Precondition: `DATA_DIR` exists and is writable. (`env-paths.ts` ensures this on import.)

### 3. Layer Flow

#### 3a. `getSomaDb()` singleton

```typescript
// src/db/soma-db.ts
import Database from 'better-sqlite3';
import path from 'node:path';
import { DATA_DIR } from '../env-paths';
import { runMigrations } from './migration-runner';
import { Logger } from '../logger';

const logger = new Logger('SomaDb');
let instance: Database.Database | null = null;

export function getSomaDb(): Database.Database {
  if (instance) return instance;
  const dbPath = path.join(DATA_DIR, 'soma.db');
  instance = new Database(dbPath);
  instance.pragma('journal_mode = WAL');
  instance.pragma('synchronous = NORMAL');
  instance.pragma('foreign_keys = ON');
  runMigrations(instance);
  logger.info('soma.db opened', { dbPath, version: getSchemaVersion(instance) });
  process.on('exit', () => closeSomaDb());
  return instance;
}

export function closeSomaDb(): void {
  if (!instance) return;
  try {
    instance.pragma('wal_checkpoint(TRUNCATE)');
    instance.close();
  } catch (err) {
    logger.error('close failed', { err });
  }
  instance = null;
}
```

#### 3b. `runMigrations(db)` — `src/db/migration-runner.ts`

```typescript
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const VERSION_RE = /^(\d+)_.+\.sql$/;

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const current = getSchemaVersion(db);
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => VERSION_RE.test(f))
    .sort((a, b) => parseInt(a) - parseInt(b));
  for (const f of files) {
    const v = parseInt(f.match(VERSION_RE)![1]);
    if (v <= current) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8');
    const applyTx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(v, Date.now());
    });
    applyTx();
  }
}

export function getSchemaVersion(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
  return row.v ?? 0;
}
```

#### 3c. Apply `001_governance.sql`
File contents = spec §5.4. Executed in a single transaction.

### 4. Side Effects
- File created: `{DATA_DIR}/soma.db` (+ `.db-wal`, `.db-shm` after first write)
- File mode: default umask (process should set `0600` — add explicit `fs.chmodSync(dbPath, 0o600)` after create)
- Tables created: `schema_version`, `governance_evaluations`, `approval_records` + 7 indexes

### 5. Error Paths

| Condition | Handling | Impact |
|-----------|----------|--------|
| `DATA_DIR` not writable | `new Database()` throws `SQLITE_CANTOPEN` | Startup fails — MUST log and exit |
| Migration SQL syntax error | tx rollback, throws | Startup fails — deployment blocker, fix SQL |
| Migration already applied (v ≤ current) | skip | Idempotent |
| `better-sqlite3` native build missing | require fails at import | Startup crash — Dockerfile check required |

### 6. Output
- Returns `Database.Database` handle
- Log: `soma.db opened` with version

### 7. Observability
- Log at startup: `SomaDb` info line with DB path + schema version
- No metric yet

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `somaDb_firstRun_createsFileAndAppliesMigrations` | Happy Path | S1, §3a+§3c |
| `somaDb_secondRun_reusesSingleton` | Contract | S1, §3a |
| `runMigrations_alreadyApplied_isNoop` | Contract | S1, §3b |
| `runMigrations_badSql_rollsBackTransaction` | Sad Path | S1, §5 |
| `somaDb_walModeEnabled` | Contract | S1, §3a (`PRAGMA journal_mode`) |
| `somaDb_closesOnExit` | Side-Effect | S1, §3a |

---

## Scenario 2 — Record Governance Evaluation (INSERT)

Issue A의 classifier hook이 verdict 결정 후 `emitGovernanceEvaluation(eval)` 호출 → `governanceEvaluationStore.record()` → prepared INSERT → DB.

### 1. Entry Point
- Function: `GovernanceEvaluationStore.record(eval: GovernanceEvaluation): void`
- File: `src/db/governance-evaluation-store.ts`
- Trigger: Called by `emitter.ts` sink, which is wired to this store at app init.

### 2. Input
- `eval: GovernanceEvaluation` (type defined in Issue A spec §5.4)

### 3. Layer Flow

#### 3a. Store class

```typescript
// src/db/governance-evaluation-store.ts
import type Database from 'better-sqlite3';
import { getSomaDb } from './soma-db';
import type { GovernanceEvaluation, GovernanceClass } from '../tool-governance/types';

export class GovernanceEvaluationStore {
  private db: Database.Database;
  private insertStmt!: Database.Statement;
  private listStmt!: Database.Statement;
  private countByClassStmt!: Database.Statement;

  constructor(db?: Database.Database) {
    this.db = db ?? getSomaDb();
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.insertStmt = this.db.prepare(`
      INSERT INTO governance_evaluations (
        id, workspace_id, user_id, thread_ts, tool_name, tool_args_json,
        verdict_class, reasons_json, policy_fingerprint,
        llm_reverify_result, final_decision, reused_from_approval_id, created_at
      ) VALUES (
        @id, @workspace_id, @user_id, @thread_ts, @tool_name, @tool_args_json,
        @verdict_class, @reasons_json, @policy_fingerprint,
        @llm_reverify_result, @final_decision, @reused_from_approval_id, @created_at
      )
    `);
    this.listStmt = this.db.prepare(`
      SELECT * FROM governance_evaluations
      WHERE (@workspace_id IS NULL OR workspace_id = @workspace_id)
        AND (@user_id IS NULL OR user_id = @user_id)
        AND (@verdict_class IS NULL OR verdict_class = @verdict_class)
        AND created_at >= @since
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.countByClassStmt = this.db.prepare(`
      SELECT verdict_class, COUNT(*) as n
      FROM governance_evaluations
      WHERE workspace_id = ? AND created_at >= ?
      GROUP BY verdict_class
    `);
  }

  record(e: GovernanceEvaluation): void {
    this.insertStmt.run({
      id: e.id,
      workspace_id: e.workspaceId ?? null,
      user_id: e.userId ?? null,
      thread_ts: e.threadTs ?? null,
      tool_name: e.toolName,
      tool_args_json: JSON.stringify(e.toolArgs ?? {}),
      verdict_class: e.classification.class,
      reasons_json: JSON.stringify(e.classification.reasons),
      policy_fingerprint: e.policyFingerprint,
      llm_reverify_result: e.llmReverifyResult ?? null,
      final_decision: e.finalDecision,
      reused_from_approval_id: e.reusedFromApprovalId ?? null,
      created_at: e.createdAt,
    });
  }
  // listRecent, countByClass per spec §5.6
}
export const governanceEvaluationStore = new GovernanceEvaluationStore();
```

### 4. Side Effects
- 1 INSERT row
- WAL append (batched flush by SQLite)

### 5. Error Paths

| Condition | Handling | Impact |
|-----------|----------|--------|
| CHECK constraint fails (bad verdict_class) | throws `SQLITE_CONSTRAINT` | Emitter catches, logs error. Upstream Issue A validates before emit — this is defense in depth. |
| Duplicate id (uuid collision) | `SQLITE_CONSTRAINT_PRIMARYKEY` | Log + skip. Caller must use uuid v7. |
| DB locked (shouldn't happen in WAL mode for writes) | retry 3x with 10ms backoff | If still locked after retries, drop the row + log |
| DB file missing at runtime | `SQLITE_CANTOPEN` | Degrade: Scenario 8 |

### 6. Output
- void — INSERT completed
- Emitter sink wrapper swallows exceptions (see Issue A §3a)

### 7. Observability
- Log (debug): `governanceEvaluationStore.record` only on error
- Metric (future): `governance.eval.insert_total`, `governance.eval.insert_fail_total`

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `record_validEvaluation_insertsRow` | Happy Path | S2, §3a |
| `record_badVerdictClass_throwsConstraint` | Contract | S2, §5 |
| `record_duplicateId_throws` | Contract | S2, §5 |
| `record_nullableFieldsOmitted_insertsWithNull` | Contract | S2, §3a |
| `record_preparedStatementReused_acrossCalls` | Performance | S2, §3a |

---

## Scenario 3 — Create Approval Record (pending)

classifier decide가 `'ask'` 반환 → `permission-mcp-server.ts`가 Slack 버튼 생성 → `approvalRecordStore.create()` 호출 → pending 상태 row INSERT.

### 1. Entry Point
- Function: `ApprovalRecordStore.create(input)`
- File: `src/db/approval-record-store.ts`
- Caller: `mcp-servers/permission/permission-mcp-server.ts` inside `handlePermissionPrompt()`.

### 2. Input

```typescript
{
  approvalId: string;            // generated by permission server (existing pattern: `approval_${ts}_${rand}`)
  workspaceId?: string;
  userId: string;
  toolName: string;
  toolArgsJson: string;
  scopeSummary?: string;
  policyFingerprint: string;     // computed by Issue A classifier, passed via SLACK_CONTEXT env or MCP arg
  expiresAt: number;
}
```

### 3. Layer Flow

#### 3a. permission-mcp-server wiring delta

In `mcp-servers/permission/permission-mcp-server.ts:handlePermissionPrompt()`:
- After `sharedStore.storePendingApproval(approvalId, pendingApproval)`, also:

```typescript
import { approvalRecordStore } from '../../src/db/approval-record-store.js';
import { computePolicyFingerprint } from '../../src/tool-governance/fingerprint.js';

// inside handlePermissionPrompt:
const fingerprint = computePolicyFingerprint(tool_name, input);
try {
  approvalRecordStore.create({
    approvalId,
    workspaceId: slackContext.team_id,
    userId: user,
    toolName: tool_name,
    toolArgsJson: JSON.stringify(input),
    scopeSummary: `tool=${tool_name}`,
    policyFingerprint: fingerprint,
    expiresAt: Date.now() + 10 * 60 * 1000,  // 10min (spec §10 decision)
  });
} catch (err) {
  this.logger.error('approval db record failed', { err, approvalId });
  // continue — shared-store has the truth; DB is audit mirror
}
```

#### 3b. Store prepared stmt

```typescript
this.createStmt = this.db.prepare(`
  INSERT INTO approval_records (
    approval_id, workspace_id, user_id, tool_name, tool_args_json,
    scope_summary, policy_fingerprint, requested_at, expires_at
  ) VALUES (
    @approval_id, @workspace_id, @user_id, @tool_name, @tool_args_json,
    @scope_summary, @policy_fingerprint, @requested_at, @expires_at
  )
`);
```

### 4. Side Effects
- 1 INSERT row in `approval_records`
- Existing `sharedStore.storePendingApproval` JSON write preserved — truth remains dual-written in Phase A

### 5. Error Paths

| Condition | Handling | Impact |
|-----------|----------|--------|
| DB insert fails | logger.error, do not throw | Approval proceeds via shared-store; audit row missing |
| `approvalId` already exists | `SQLITE_CONSTRAINT_PRIMARYKEY` | Log warn — implies ID generator collision, unlikely |

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `approvalStore_create_insertsPending` | Happy Path | S3, §3b |
| `approvalStore_create_duplicateId_throws` | Contract | S3, §5 |
| `permissionServer_createApproval_writesDbAndSharedStore` | Integration | S3, §3a |
| `permissionServer_dbFail_doesNotBlockApproval` | Sad Path | S3, §5 |

---

## Scenario 4 — Resolve Approval (Slack button click)

Slack button payload → handler dispatches to permission flow → `approvalRecordStore.resolve(approvalId, 'approved' | 'denied', userId)`.

### 1. Entry Point
- `ApprovalRecordStore.resolve(approvalId, resolution, resolvedByUser?)`
- Caller: Slack interactivity handler (existing — resolves pending approval in `sharedStore`).

### 3. Layer Flow

#### 3a. UPDATE stmt

```typescript
this.resolveStmt = this.db.prepare(`
  UPDATE approval_records
  SET resolution = @resolution,
      resolved_at = @resolved_at,
      resolved_by_user = @resolved_by_user
  WHERE approval_id = @approval_id
    AND resolution IS NULL
    AND invalidated_at IS NULL
`);
// returns RunResult with .changes indicating 0 or 1 rows affected
```

#### 3b. `resolve()`

```typescript
resolve(approvalId: string, resolution: 'approved'|'denied'|'expired', resolvedByUser?: string): void {
  const result = this.resolveStmt.run({
    approval_id: approvalId,
    resolution,
    resolved_at: Date.now(),
    resolved_by_user: resolvedByUser ?? null,
  });
  if (result.changes === 0) {
    this.logger.warn('resolve no-op — approval missing or already resolved', { approvalId });
  }
}
```

### 4. Side Effects
- 1 UPDATE row (or 0 if already resolved / invalidated)

### 5. Error Paths

| Condition | Handling | Impact |
|-----------|----------|--------|
| approval_id not found | `result.changes === 0` → log warn | No-op, safe |
| Already resolved | same → log warn | Idempotent (second button click) |
| Invalidated (policy changed) | same → log warn | Signal to UI: "this approval is stale" |

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `approvalStore_resolve_approved_updatesRow` | Happy Path | S4, §3b |
| `approvalStore_resolve_alreadyResolved_isNoop` | Contract | S4, §5 |
| `approvalStore_resolve_invalidated_isNoop` | Contract | S4, §5 |
| `approvalStore_resolve_nonExistentId_isNoop` | Contract | S4, §5 |

---

## Scenario 5 — Find Reusable Approval (auto-approve path)

classifier decide 단계에서 `ask` verdict 내기 직전에 `findReusable(fingerprint, userId, now)` 호출 → match 있으면 decision을 `allow`로 upgrade + `reused_from_approval_id` 기록.

### 1. Entry Point
- `ApprovalRecordStore.findReusable(fingerprint, userId, now): ApprovalReuseLookup | null`
- Caller: `src/tool-governance/decide.ts` inside `decide()` before LLM re-verify.

### 2. Input
- `fingerprint: string` — Issue A classifier computed
- `userId: string`
- `now: number` — epoch ms

### 3. Layer Flow

#### 3a. SELECT stmt

```sql
SELECT approval_id, expires_at, resolved_at
FROM approval_records
WHERE policy_fingerprint = ?
  AND user_id = ?
  AND resolution = 'approved'
  AND (expires_at IS NULL OR expires_at > ?)
  AND invalidated_at IS NULL
ORDER BY requested_at DESC
LIMIT 1;
```

#### 3b. Method

```typescript
findReusable(fingerprint: string, userId: string, now: number): ApprovalReuseLookup | null {
  const row = this.findReusableStmt.get(fingerprint, userId, now) as
    { approval_id: string; expires_at: number; resolved_at: number } | undefined;
  if (!row) return null;
  return { approvalId: row.approval_id, expiresAt: row.expires_at, resolvedAt: row.resolved_at };
}
```

### 4. Side Effects
- 1 index seek (idx_approval_policy) — p50 < 1ms

### 5. Error Paths

| Condition | Handling | Impact |
|-----------|----------|--------|
| No match | returns null | decide() proceeds to LLM re-verify |
| All matches expired | returns null | same |
| All matches invalidated | returns null | same (policy change wiped approvals) |

### 7. Observability
- Log: `governance.reuse_hit` count per workspace (future metric)

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `findReusable_matchFound_returnsLookup` | Happy Path | S5, §3a |
| `findReusable_expired_returnsNull` | Contract | S5, §5 |
| `findReusable_invalidated_returnsNull` | Contract | S5, §5 |
| `findReusable_differentUser_returnsNull` | Contract | S5, §5 |
| `findReusable_deniedApproval_returnsNull` | Contract | S5, §3a (resolution='approved' filter) |
| `findReusable_noMatch_returnsNull` | Contract | S5, §5 |

---

## Scenario 6 — Invalidate Approvals by Fingerprint (policy change)

Operator bumps `RULES_VERSION` in Issue A code → all fingerprints change → old approvals stale → **ad-hoc CLI invocation** marks old approvals invalidated. Not automatic; operator-triggered.

### 1. Entry Point
- `ApprovalRecordStore.invalidateByFingerprint(fingerprint, reason, now): number`
- Called by: `scripts/governance-query.ts --invalidate-fingerprint <fp>` CLI OR programmatic on detected fingerprint mismatch.

### 2. Input
- `fingerprint: string` or `'*'` (wildcard for mass invalidation)
- `reason: string` — e.g., `'rules_version_bump_v1_to_v2'`

### 3. Layer Flow

#### 3a. UPDATE stmt

```sql
UPDATE approval_records
SET invalidated_at = ?, invalidation_reason = ?
WHERE (policy_fingerprint = ? OR ? = '*')
  AND invalidated_at IS NULL
  AND (resolution = 'approved' OR resolution IS NULL);
```

#### 3b. Method

```typescript
invalidateByFingerprint(fingerprint: string, reason: string, now: number): number {
  const r = this.invalidateStmt.run(now, reason, fingerprint, fingerprint);
  return r.changes;
}
```

### 4. Side Effects
- N UPDATE rows (can be large on mass invalidation)

### 5. Error Paths

| Condition | Handling | Impact |
|-----------|----------|--------|
| Wildcard `'*'` while prod has tens of thousands of approvals | Single transaction, SQLite handles ~100K rows in 100ms | Lock held briefly; other writers wait. Acceptable for ops task. |
| Called before schema_version=1 | `SQLITE_ERROR` | Operator error — migration must run first |

### 7. Observability
- Log (info): `invalidateByFingerprint summary` with `{fingerprint, reason, changes}` — appears in SIEM

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `invalidate_byFingerprint_marksMatching` | Happy Path | S6, §3a |
| `invalidate_wildcardStar_marksAllActive` | Contract | S6, §3a |
| `invalidate_alreadyInvalidated_skipped` | Contract | S6, §3a |
| `invalidate_deniedApprovals_skipped` | Contract | S6, §3a (resolution='denied' not affected) |

---

## Scenario 7 — Audit Query — Recent Evaluations

Operator runs `node scripts/governance-query.ts recent --workspace WXXX --since 24h` → CLI → `governanceEvaluationStore.listRecent()` → prints table.

### 1. Entry Point
- CLI: `scripts/governance-query.ts`
- Calls: `governanceEvaluationStore.listRecent(filters)`

### 2. Input
- Filters: `{workspaceId?, userId?, verdictClass?, since, limit}`
- Defaults: `since = Date.now() - 24*3600*1000`, `limit = 100`

### 3. Layer Flow

#### 3a. CLI script

```typescript
// scripts/governance-query.ts
import { governanceEvaluationStore } from '../src/db/governance-evaluation-store';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    workspace: { type: 'string' },
    user: { type: 'string' },
    class: { type: 'string' },  // AllowDirect | GuardIfSuspicious | GuardAlways | RejectBypass
    since: { type: 'string', default: '24h' },
    limit: { type: 'string', default: '100' },
  },
});

const sinceMs = Date.now() - parseDuration(values.since!);
const rows = governanceEvaluationStore.listRecent({
  workspaceId: values.workspace,
  userId: values.user,
  verdictClass: values.class as any,
  since: sinceMs,
  limit: parseInt(values.limit!),
});
printTable(rows);  // or JSON output for piping
```

#### 3b. `listRecent()`
Uses prepared `listStmt` from §3a of Scenario 2.

### 4. Side Effects
- 1 indexed SELECT — p95 < 10ms for 24h window, 1 workspace

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `listRecent_allFilters_returnsMatching` | Happy Path | S7, §3b |
| `listRecent_sinceBoundary_excludesOlder` | Contract | S7, §3b |
| `listRecent_limit_respectsMax` | Contract | S7, §3b |
| `listRecent_nullFilters_returnsAll` | Contract | S7, §3b |
| `countByClass_returnsPerClassCounts` | Happy Path | S7 (spec §5.6) |

---

## Scenario 8 — DB Unavailable Degradation

DB file deleted mid-run (ops mistake, or disk failure) → next `record()` call throws `SQLITE_CANTOPEN` → emitter catches → classifier continues returning decisions (audit data lost for this call).

### 1. Entry Point
- Any store method call.

### 3. Layer Flow

#### 3a. Store call path
```
governanceEvaluationStore.record(eval)
  → this.insertStmt.run(...)
  → throws SQLITE_CANTOPEN (disk gone) or SQLITE_LOCKED
```

#### 3b. Emitter catch (Issue A `emitter.ts` sink wrapper)
```
try { sink(e); } catch (err) { logger.error('emit failed', {err}); }
```

#### 3c. Recovery strategy
- Manual: operator restores from backup, restarts bot → `getSomaDb()` reopens fresh file and runs migrations.
- Partial recovery: emitter can have a **disk-backed fallback queue** — `{DATA_DIR}/governance-failed.jsonl`. Phase A: NOT implemented (spec §10 deferred).

### 5. Error Paths

| Condition | Handling | Impact |
|-----------|----------|--------|
| DB file deleted | throws, caught upstream, logged | Audit loss; tool calls unaffected |
| Disk full | `SQLITE_FULL` | Caught, logged; ops alert via log monitoring |
| DB locked > 5s (checkpoint contention) | `SQLITE_BUSY` | Retry 3x with 10ms → 100ms → 500ms backoff; after that log + drop |
| Corrupt DB | `SQLITE_CORRUPT` | Process degrades; operator must restore |

### 7. Observability
- Log (error): `emit failed` with err message
- Metric (future): `governance.db.insert_fail_total` — spike triggers ops alert

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `record_dbMissing_throwsCaughtByEmitter` | Sad Path | S8, §3a/§3b |
| `record_dbLocked_retriesThenDrops` | Sad Path | S8, §5 (requires injected fake Statement) |
| `emitter_sinkThrows_doesNotPropagate` | Sad Path | S8, §3b |

---

## Cross-Scenario Invariants

- **Dual-write during Phase A**: `approval_records` duplicates `sharedStore` JSON approval state. Truth source remains `sharedStore` until Phase B. Discrepancy audit script (scripts/verify-approval-parity.ts) OPTIONAL for launch, recommended for ops smoke test weekly.
- **Fingerprint opacity**: Store never interprets `policy_fingerprint` — only stores and indexes. Semantic owner is Issue A.
- **Idempotency**: `resolve()` and `invalidateByFingerprint()` are idempotent (`WHERE resolution IS NULL` / `WHERE invalidated_at IS NULL` guards).
- **Fail-safe writes**: all store mutations are best-effort. Classifier + Slack approval flow do not depend on store success for correctness — only for auditability.
