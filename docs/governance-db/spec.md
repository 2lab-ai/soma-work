# Governance Audit DB (SQLite Phase A) — Spec

> STV Spec | Created: 2026-04-17
> Related: docs/tool-governance/spec.md (produces the data this DB stores)
> Reference: mkurman/tamux @ `06cb904b33f6e881f5b3bd3e7a147984a8d9ff4f` — `crates/amux-daemon/src/history/schema_sql.rs:314-351`

## 1. Overview

### Proposal
- **Why**: soma-work의 모든 persistence는 JSON 파일 기반 — `src/session-archive.ts`, `src/conversation/storage.ts`, `src/mcp-tool-grant-store.ts`, `src/user-memory-store.ts`, `src/user-settings-store.ts` 전부. Query 불가, 동시성 취약, 감사 대응 불가. Issue A (tool-governance)가 verdict를 쏟아내기 시작하면 **저장할 곳이 없다**. 승인 재사용도 불가 — 매번 같은 툴에 같은 인자로 호출해도 Slack 버튼이 다시 뜬다.
- **What Changes**: `better-sqlite3` 의존성 도입. `${DATA_DIR}/soma.db` 단일 SQLite 파일. **Phase A에선 두 테이블만** — `governance_evaluations`, `approval_records`. 기존 JSON 스토어는 **건드리지 않는다** (마이그레이션은 Phase B 이연).
- **Capabilities**: (1) verdict 감사 질의 — workspace/user/policy/시간 기준. (2) policy fingerprint 기반 승인 재사용 ("같은 지문 + 미만료 승인 있으면 auto-approve"). (3) 정책 변경 시 지문 일치 승인 일괄 무효화.
- **Impact**: 새 디렉토리 `src/db/`. `package.json`에 `better-sqlite3` dependency 추가. Issue A의 `emitGovernanceEvaluation` hook이 본 DB에 기록하도록 구독. `mcp-servers/permission/permission-mcp-server.ts` 승인 생성/해소 시점에 `approval_records` 기록. BREAKING 없음.

tamux는 goal-runner/WELES/debate/consolidation이 전부 SQLite 한 DB에 산다 (354줄 스키마). 우리는 **그 중 38줄만** 이식 — 감사와 재사용 2개 축만. 나머지는 Phase B/C에서 필요할 때.

## 2. User Stories

- As a **운영자**, I want "지난 24시간 RejectBypass / ask 카운트"를 SQL로 질의할 수 있길 원한다, so that 정책 튜닝 근거 데이터를 확보한다.
- As a **멀티테넌트 고객**, I want 우리 workspace의 tool governance 이력을 내보낼 수 있길 원한다, so that 내부 감사 요건을 맞춘다.
- As a **Slack 유저**, I want 같은 위험 툴 호출에 대해 짧은 기간 내 재승인 프롬프트가 뜨지 않길 원한다, so that 30초 전에 승인한 걸 또 누르지 않는다.
- As a **보안 담당자**, I want classifier 규칙이 바뀌면 기존 승인이 자동 invalidate 되길 원한다, so that 오래된 지문의 승인이 자동 재사용되지 않는다.

## 3. Acceptance Criteria

- [ ] `better-sqlite3` 의존성 추가 (`package.json`). Native build는 `npm install` 시 자동 컴파일 — Docker 이미지 빌드 체크.
- [ ] `src/db/soma-db.ts` — singleton DB 핸들. 경로 `${DATA_DIR}/soma.db`. `WAL` 모드 활성화.
- [ ] `src/db/migrations/` 디렉토리 + `migration-runner.ts` — 버전 번호 기반 순차 실행. `schema_version` 메타 테이블로 현재 버전 추적.
- [ ] `src/db/migrations/001_governance.sql` — 두 테이블 + 인덱스 생성.
- [ ] `src/db/governance-evaluation-store.ts` — `record(eval: GovernanceEvaluation): void`, `listRecent(filters): GovernanceEvaluation[]`, `countByClass(since): Record<GovernanceClass, number>`. 모두 prepared statement.
- [ ] `src/db/approval-record-store.ts` — `requestApproval(…): approvalId`, `resolveApproval(id, resolution)`, `findReusable(fingerprint, userId, now): ApprovalRecord | null`, `invalidateByFingerprint(fingerprint, reason)`.
- [ ] Issue A의 `emitGovernanceEvaluation` 훅이 `GovernanceEvaluationStore.record()`를 호출 — **async fire-and-forget**. 실패 시 logger.error만, 툴 호출 path는 블록 안 됨.
- [ ] `mcp-servers/permission/permission-mcp-server.ts` — 승인 생성 시 `approval_records` INSERT, 유저가 Slack 버튼 누르면 `resolveApproval` UPDATE.
- [ ] **Approval reuse** 경로 — classifier가 `ask` verdict 내면 먼저 `findReusable(fingerprint, userId, now)` 질의. 매치 있으면 `allow`로 upgrade + `governance_evaluations.reused_from_approval` 컬럼에 링크.
- [ ] Policy fingerprint는 Issue A의 `computePolicyFingerprint`가 정의 — 본 이슈는 저장만. 임시로 stub fingerprint(`"stub-v0"`)로 개발 가능, A 머지 시 실제 지문 전환.
- [ ] 테스트 — in-memory SQLite (`new Database(':memory:')`)로 unit + integration. 각 store 최소 5 케이스.
- [ ] Backward compatibility — DB 파일 없으면 자동 생성. 기존 JSON 스토어는 건드리지 않음. 실패 시 기능 degrade (Slack 감사 불가), 툴 호출 자체는 계속 동작.
- [ ] Data retention — 초기엔 무제한. PII (메시지 내용) 저장 금지 — `tool_args_json`에 민감 필드 mask 옵션 지원.

## 4. Scope

### In-Scope
- `better-sqlite3` 의존성 + Docker 빌드 검증
- `src/db/soma-db.ts` singleton (~80줄)
- `src/db/migration-runner.ts` + `001_governance.sql` (~100줄 + SQL)
- `src/db/governance-evaluation-store.ts` (~150줄)
- `src/db/approval-record-store.ts` (~180줄)
- `src/db/types.ts` — row → TS 객체 매퍼 (~60줄)
- Issue A hook 구독 — classifier emitter → store.record
- permission-mcp-server.ts 승인 생성/해소 시점 wiring (~40줄 delta)
- Approval reuse path (`findReusable` 조회) — classifier decide 단계에서 호출
- 초기 CLI script `scripts/governance-query.ts` — 기본 통계 5개 질의 (samples for users)

### Out-of-Scope (Phase B/C, 별도 이슈)
- `agent_threads`, `agent_messages`, `agent_tasks`, `execution_traces`, `goal_runs` 등 tamux의 나머지 테이블
- `conversation/storage.ts`, `session-archive.ts`의 SQLite 마이그레이션
- FTS5 전체 텍스트 인덱스
- 웹 UI 대시보드 (쿼리 결과 시각화)
- 자동 retention / 자동 vacuum (수작업 cron 가능)
- Encryption at rest (SQLCipher) — 고객사 요구 생기면 Phase C
- Multi-tenant row-level security — workspace_id 인덱스만 도입, enforcement는 app 레이어

## 5. Architecture

### 5.1 Layer Structure

```
Tool Governance (Issue A)                      Permission MCP Server
   │                                              │
   │ emit GovernanceEvaluation                    │ create/resolve approval
   ↓                                              ↓
[GovernanceEvaluationStore]                   [ApprovalRecordStore]
   │                                              │
   ├──→ INSERT governance_evaluations             ├──→ INSERT approval_records
   │                                              ├──→ UPDATE approval_records (resolve)
   └──→ SELECT by fingerprint/workspace          └──→ UPDATE approval_records (invalidate)
           ↑                                            ↑
           └────────── better-sqlite3 prepared stmts ──┘
                           │
                    soma-db.ts (singleton Database)
                           │
                      ${DATA_DIR}/soma.db  (WAL mode)
                           │
                      migrations/001_governance.sql
```

### 5.2 Data Flow — Approval Reuse

```
Tool call arrives → classifier → verdict = GuardAlways
   ↓
decide() pre-check:
   ApprovalRecordStore.findReusable(
     fingerprint=verdict.policyFingerprint,
     userId=slackContext.user,
     now=Date.now()
   ) → ApprovalRecord | null
   ↓
if reusable found (not expired, not invalidated, resolution='approved'):
   ↓
   decision = 'allow'
   GovernanceEvaluation.reusedFromApprovalId = reusable.approvalId
   → INSERT into governance_evaluations (auditable: reuse traceable)
   → PreToolUse hook returns 'allow'
else:
   decision = 'ask'
   permission-mcp-server creates approval → INSERT approval_records (pending)
   Slack button pressed → UPDATE approval_records.resolution
```

### 5.3 File Structure

```
src/db/
├── soma-db.ts                      # Database singleton, opens {DATA_DIR}/soma.db, WAL on
├── migration-runner.ts             # scans migrations/ dir, applies by version
├── migrations/
│   └── 001_governance.sql          # CREATE TABLE governance_evaluations, approval_records
├── types.ts                        # DB row types + mappers
├── governance-evaluation-store.ts  # class + singleton
├── approval-record-store.ts        # class + singleton
└── *.test.ts

scripts/
└── governance-query.ts             # CLI for operators (audit queries)

package.json
   └── [edit] dependencies: better-sqlite3
```

### 5.4 Schema (001_governance.sql)

```sql
-- schema_version meta (runner creates on first run)
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE governance_evaluations (
  id TEXT PRIMARY KEY,                    -- uuid v7 (monotonic)
  workspace_id TEXT,                      -- Slack workspace
  user_id TEXT,                           -- Slack user
  thread_ts TEXT,
  tool_name TEXT NOT NULL,
  tool_args_json TEXT NOT NULL,           -- sensitive-field-masked per emitter option
  verdict_class TEXT NOT NULL             -- 'AllowDirect'|'GuardIfSuspicious'|'GuardAlways'|'RejectBypass'
    CHECK (verdict_class IN ('AllowDirect','GuardIfSuspicious','GuardAlways','RejectBypass')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  policy_fingerprint TEXT NOT NULL,
  llm_reverify_result TEXT,               -- 'safe'|'unsafe'|'timeout'|'error'|NULL
  final_decision TEXT NOT NULL            -- 'allow'|'deny'|'ask'
    CHECK (final_decision IN ('allow','deny','ask')),
  reused_from_approval_id TEXT,           -- FK approval_records.approval_id (nullable)
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_gov_eval_policy ON governance_evaluations(policy_fingerprint, created_at DESC);
CREATE INDEX idx_gov_eval_workspace ON governance_evaluations(workspace_id, created_at DESC);
CREATE INDEX idx_gov_eval_user_ts ON governance_evaluations(user_id, created_at DESC);
CREATE INDEX idx_gov_eval_verdict ON governance_evaluations(verdict_class, created_at DESC);

CREATE TABLE approval_records (
  approval_id TEXT PRIMARY KEY,           -- id used by Slack button action
  workspace_id TEXT,
  user_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_args_json TEXT NOT NULL,
  scope_summary TEXT,
  policy_fingerprint TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  resolved_at INTEGER,
  expires_at INTEGER,                     -- default requested_at + 15min (tamux uses 900s)
  resolution TEXT                         -- 'approved'|'denied'|'expired'|NULL
    CHECK (resolution IN ('approved','denied','expired') OR resolution IS NULL),
  resolved_by_user TEXT,                  -- Slack user who clicked button
  invalidated_at INTEGER,
  invalidation_reason TEXT
);
CREATE INDEX idx_approval_policy ON approval_records(policy_fingerprint, requested_at DESC);
CREATE INDEX idx_approval_user ON approval_records(user_id, requested_at DESC);
CREATE INDEX idx_approval_workspace ON approval_records(workspace_id, requested_at DESC);
CREATE INDEX idx_approval_pending ON approval_records(resolution, requested_at) WHERE resolution IS NULL;

INSERT INTO schema_version (version, applied_at) VALUES (1, strftime('%s','now') * 1000);
```

### 5.5 Type Definitions

```typescript
// src/db/types.ts
export interface GovernanceEvaluationRow {
  id: string;
  workspace_id: string | null;
  user_id: string | null;
  thread_ts: string | null;
  tool_name: string;
  tool_args_json: string;
  verdict_class: GovernanceClass;
  reasons_json: string;
  policy_fingerprint: string;
  llm_reverify_result: string | null;
  final_decision: 'allow' | 'deny' | 'ask';
  reused_from_approval_id: string | null;
  created_at: number;
}

export interface ApprovalRecordRow {
  approval_id: string;
  workspace_id: string | null;
  user_id: string;
  tool_name: string;
  tool_args_json: string;
  scope_summary: string | null;
  policy_fingerprint: string;
  requested_at: number;
  resolved_at: number | null;
  expires_at: number | null;
  resolution: 'approved' | 'denied' | 'expired' | null;
  resolved_by_user: string | null;
  invalidated_at: number | null;
  invalidation_reason: string | null;
}

export interface ApprovalReuseLookup {
  approvalId: string;
  expiresAt: number;
  resolvedAt: number;
}
```

### 5.6 Store API

```typescript
// src/db/governance-evaluation-store.ts
export class GovernanceEvaluationStore {
  constructor(db?: Database);                // optional for tests (:memory:)
  record(eval: GovernanceEvaluation): void;   // prepared INSERT, ~1ms
  listRecent(filters: {
    workspaceId?: string;
    userId?: string;
    verdictClass?: GovernanceClass;
    since?: number;
    limit?: number;
  }): GovernanceEvaluation[];
  countByClass(workspaceId: string, since: number): Record<GovernanceClass, number>;
  countByUser(since: number, limit: number): Array<{ userId: string; count: number }>;
}
export const governanceEvaluationStore: GovernanceEvaluationStore;

// src/db/approval-record-store.ts
export class ApprovalRecordStore {
  constructor(db?: Database);
  create(input: {
    approvalId: string;
    workspaceId?: string;
    userId: string;
    toolName: string;
    toolArgsJson: string;
    scopeSummary?: string;
    policyFingerprint: string;
    expiresAt: number;
  }): void;
  resolve(approvalId: string, resolution: 'approved'|'denied'|'expired', resolvedByUser?: string): void;
  findReusable(fingerprint: string, userId: string, now: number): ApprovalReuseLookup | null;
  invalidateByFingerprint(fingerprint: string, reason: string, now: number): number;  // returns count
  findById(approvalId: string): ApprovalRecord | null;
}
export const approvalRecordStore: ApprovalRecordStore;
```

## 6. Performance / Non-Functional

- SQLite `PRAGMA journal_mode=WAL` + `PRAGMA synchronous=NORMAL` — 충분히 안전 + 빠른 concurrent reads.
- `record()` p95 < 5ms (단일 INSERT, prepared).
- `findReusable()` p95 < 2ms — `(policy_fingerprint, requested_at DESC)` 인덱스 hit.
- DB 파일 크기 예상 — eval 1건 ~500B. 100 verdict/min → 월 2GB. **Phase B retention 필요 명시.**
- `fs.fsync` 비용은 WAL checkpoint에서만 — tool call path는 버퍼 flush 안 기다림.

## 7. Security Model

- DB 파일 권한 `0600` — 소마 프로세스 유저만 read/write.
- Sensitive field mask — emitter(Issue A)가 `tool_args_json`에서 `authorized_keys`, password 등 filter 후 저장. mask rules는 `src/tool-governance/sensitive-mask.ts` (Issue A).
- No PII in `tool_args_json` by default — Slack message content는 first 200자 요약 + hash. Full message 저장은 explicit opt-in.
- Workspace isolation — all queries must filter `workspace_id` at application layer. No shared cross-workspace views.

## 8. Migration / Rollback

- First run — `soma.db` 없으면 자동 생성 + `001_governance.sql` 실행. `schema_version` 기록.
- Rollback — DB 파일 삭제 시 기능 degrade (auto-approve 재사용 불가, 감사 로그 없음). 툴 호출 자체는 계속 동작.
- Backup — 파일 단일. `cp soma.db soma.db.bak` 로 운영. WAL 활성 시 `.db-wal` 파일도 함께.

## 9. Dependencies

- **Blocked by**: Issue A (tool-governance) — `policyFingerprint` 알고리즘 합의 필요. 본 이슈는 stub 지문으로 먼저 시작 가능, A 머지 시 전환.
- **Blocks**: Phase B (conversation/session JSON→SQL migration) — 본 이슈의 migration-runner 패턴을 재사용.
- **Related**: 기존 `src/mcp-tool-grant-store.ts` — grant store는 유지. Grant와 approval은 서로 다른 개념 — grant는 "MCP server access level, 시간 제한", approval은 "특정 툴 호출에 대한 일회성 승인".

## 10. Open Questions

1. **`better-sqlite3` native build in prod Docker** — Alpine base + Node-gyp 필요? Dockerfile 검증 필수. **자율 판단: 미리 Dockerfile에 `apk add python3 make g++` 추가 + build stage에서 설치. 실패 시 `sqlite3` (async) 폴백은 만들지 않음 — 복잡도 증가.**
2. **Approval reuse window default** — tamux 900s (15분). soma-work은? **자율 판단: 기본 600s (10분). 툴별 재정의 가능하게 `rules.ts`에 `reuseWindowSec?` 필드 추가 — Issue A의 책임.**
3. **WAL file cleanup on shutdown** — daemon 없으므로 프로세스 crash 시 WAL 파일 잔재 가능. better-sqlite3는 checkpoint on close 지원. graceful shutdown hook 필수.
4. **Multi-tenant partitioning** — workspace 수 만 단위 되면 단일 파일 bottleneck? **현재 규모에선 단일 파일로 충분. Phase C에서 shard-by-workspace 고려.**

## 11. Rollout Plan

- Phase A (this issue):
  1. `better-sqlite3` 의존성 + Docker 빌드 검증 (CI)
  2. Migration runner + `001_governance.sql`
  3. 두 Store 구현 + 테스트
  4. Issue A의 shadow-mode emitter를 실제 DB write로 전환
  5. permission-mcp-server.ts wiring
  6. Approval reuse 경로 활성화
- Phase B (별도 이슈): `conversation/storage.ts`, `session-archive.ts` → SQL 마이그레이션. `002_conversations.sql`, `003_sessions.sql`. FTS5 도입.
- Phase C (별도 이슈): `execution_traces`, `context_archive`, `goal_runs` — autonomous mode 도입 시.
