# Bug Trace: Codex Review Round 2 — Post-Merge Findings

## AS-IS: PR #115 merged but Codex code review 5/10, test review 8/10. 4 actionable findings remain.
## TO-BE: All HIGH/MEDIUM findings addressed or consciously deferred with rationale.

## Phase 1: Heuristic Verification of Codex Findings

### Finding 1 (HIGH): incidents not filtered to active/unresolved
- `claude-status-fetcher.ts:138` → incidentRegex matches ALL `.incident-title` blocks
- status.claude.com shows recent incidents in a timeline — resolved ones remain visible
- `claude-status-fetcher.ts:146` → `afterMatch` grabs first `.updates` div after title
- **Verification**: If page has "Resolved" incidents, they will be collected
- **Impact**: "Active Incidents" section may show resolved incidents → misleading
- **Verdict**: ✅ CONFIRMED — needs filter or page structure analysis

### Finding 2 (MEDIUM): incident status scoping drift
- `claude-status-fetcher.ts:145` → `html.slice(match.index + match[0].length)` — scopes forward from current incident
- `claude-status-fetcher.ts:146` → first `.updates` div after that slice
- **Scenario**: If incident A has no updates div but incident B does, A gets B's status
- **Verdict**: ✅ CONFIRMED — multi-incident edge case vulnerable

### Finding 3 (MEDIUM): isApiLikeError over-triggers on 401/403/404
- `claude-status-fetcher.ts:269` → regex `[45]\d{2}` catches 401, 403, 404
- These are auth/config errors, not service outages
- Fetching status page on auth errors adds latency without value
- **Verdict**: ✅ CONFIRMED — but OUT OF SCOPE for this fix (separate concern)

### Finding 4 (MEDIUM): no negative cache / backoff
- `claude-status-fetcher.ts:76-77` → `statusCache.set('status', info)` only on success
- `claude-status-fetcher.ts:86-89` → catch returns null, no cache write
- **Scenario**: status page down → every API error triggers 3s timeout fetch
- **Verdict**: ✅ CONFIRMED — needs negative TTL

### Finding 5 (HIGH from test review): stream-executor integration test missing
- `stream-executor.ts:1176` → guard condition changed but no test exercises this path
- formatErrorForUser is private method on StreamExecutor class
- **Verdict**: ✅ CONFIRMED — spec requirement unfulfilled

### Finding 6 (MEDIUM from test review): non-OK HTTP response untested
- `claude-status-fetcher.ts:64-67` → `!response.ok` branch returns null
- No test sends a mock response with `ok: false`
- **Verdict**: ✅ CONFIRMED — easy to add

### Finding 7 (MEDIUM from test review): incident status value untested
- Tests check `incidents[0].title` but never `incidents[0].status`
- `claude-status-fetcher.ts:147` → status extraction from updates div
- **Verdict**: ✅ CONFIRMED — easy to add

## Triage: What to fix now vs defer

| # | Finding | Action | Rationale |
|---|---------|--------|-----------|
| 1 | Active incidents filter | DEFER | Requires actual status.claude.com page analysis for resolved marker. Separate issue. |
| 2 | Incident status scoping | FIX | Small regex/logic fix, testable |
| 3 | isApiLikeError scope | DEFER | Different concern, needs design discussion |
| 4 | Negative cache | FIX | Simple backoff, high production impact |
| 5 | Integration test | FIX | Spec requirement, must fulfill |
| 6 | Non-OK response test | FIX | One test, trivial |
| 7 | Incident status test | FIX | One assertion, trivial |

## Fix Scope: 5 items (2, 4, 5, 6, 7)
