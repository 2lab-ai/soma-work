# API Error Status Page Capture — Vertical Trace

> STV Trace | Created: 2026-03-26
> Spec: docs/api-error-status/spec.md

## Table of Contents
1. [Scenario 1 — Fetch and display status on API error](#scenario-1)
2. [Scenario 2 — Cache hit on repeated errors](#scenario-2)
3. [Scenario 3 — Graceful degradation when status page unreachable](#scenario-3)
4. [Scenario 4 — All systems operational display](#scenario-4)
5. [Scenario 5 — Integration into stream-executor error flow](#scenario-5)

---

## Scenario 1 — Fetch and display status on API error

### 1. API Entry
- Trigger: Claude SDK throws error with 4xx/5xx pattern (e.g., `API Error: 500`)
- Entry point: `stream-executor.ts` → `handleError()` (line ~713 catch block)
- No HTTP endpoint — internal error handler

### 2. Input
- Error object: `{ message: string, name?: string, stderrContent?: string }`
- Error message patterns that trigger status fetch:
  - Contains `4xx`/`5xx` status codes: `'500'`, `'502'`, `'503'`, `'429'`
  - Contains keywords: `'internal server error'`, `'service unavailable'`, `'overloaded'`, `'rate limit'`, `'too many requests'`, `'temporarily unavailable'`, `'connection reset'`

### 3. Layer Flow

#### 3a. fetchClaudeStatus() — Fetcher
- File: `src/claude-status-fetcher.ts`
- Check cache: `statusCache.get('status')` → if `Date.now() - cached.fetchedAt < CACHE_TTL` → return cached
- Cache miss → `fetch('https://status.claude.com', { signal: AbortSignal.timeout(3000) })`
- Response → `response.text()` → raw HTML string
- Transformation: raw HTML → `ClaudeStatusInfo`

#### 3b. parseStatusPage(html) — Parser
- File: `src/claude-status-fetcher.ts`
- Extract components via regex on HTML class patterns:
  - `.component-inner-container.status-green` → `{ name, status: 'operational' }`
  - `.component-inner-container.status-yellow` or `.status-orange` → `{ name, status: 'degraded' }`
  - `.component-inner-container.status-red` → `{ name, status: 'outage' }`
- Extract component names from `.name` elements within each `.component-container`
- Extract incidents from `.incident-title.impact-*` elements:
  - `incident-title` text → `{ title: string }`
  - `.impact-minor` / `.impact-major` / `.impact-critical` → incident severity
- Derive overall status:
  - Any component `outage` → overall `'outage'`
  - Any component `degraded` → overall `'degraded'`
  - All `operational` → overall `'operational'`
- Transformation arrows:
  - `html.component-container.status-[color]` → `parseStatusColor(color)` → `Component.status`
  - `html.component-container .name` → `Component.name`
  - `html.incident-title` text → `Incident.title`
  - `html.incident-title.impact-[level]` → `Incident.status`

#### 3c. Cache Store
- Store result: `statusCache.set('status', { ...info, fetchedAt: Date.now() })`
- Return `ClaudeStatusInfo`

### 4. Side Effects
- Cache INSERT: `statusCache.set('status', ClaudeStatusInfo)` with `fetchedAt` timestamp
- HTTP GET to `https://status.claude.com` (external, read-only)

### 5. Error Paths
| Condition | Behavior | Result |
|-----------|----------|--------|
| fetch() timeout (>3s) | catch → return null | Error message sent without status |
| fetch() network error | catch → return null | Error message sent without status |
| HTML parse fails (unexpected format) | catch → return null | Error message sent without status |
| response.ok === false | return null | Error message sent without status |

### 6. Output
- Returns: `ClaudeStatusInfo | null`
```typescript
{
  overall: 'outage',
  components: [
    { name: 'claude.ai', status: 'outage' },
    { name: 'Claude API', status: 'outage' },
    { name: 'Claude Code', status: 'degraded' },
    { name: 'Claude for Government', status: 'operational' },
  ],
  incidents: [
    { title: 'Elevated errors on Claude Opus 4.6', status: 'Investigating' },
  ],
  fetchedAt: 1711234567890,
}
```

### 7. Observability
- Logger: `claude-status-fetcher` tag
- Log on fetch failure: `logger.warn('Failed to fetch Claude status', { error })`
- Log on successful fetch: `logger.debug('Claude status fetched', { overall, componentCount, incidentCount })`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `fetchClaudeStatus_parsesComponentStatuses` | Happy Path | S1, Section 3b — component parsing |
| `fetchClaudeStatus_parsesIncidents` | Happy Path | S1, Section 3b — incident parsing |
| `fetchClaudeStatus_derivesOverallStatus` | Contract | S1, Section 3b — overall derivation |
| `fetchClaudeStatus_returnsNullOnTimeout` | Sad Path | S1, Section 5 — timeout |
| `fetchClaudeStatus_returnsNullOnNetworkError` | Sad Path | S1, Section 5 — network error |
| `fetchClaudeStatus_returnsNullOnParseFailure` | Sad Path | S1, Section 5 — parse failure |

---

## Scenario 2 — Cache hit on repeated errors

### 1. API Entry
- Same as Scenario 1: `handleError()` triggers `fetchClaudeStatus()`
- Occurs when multiple errors happen within the cache TTL window (2 min)

### 2. Input
- Same error object as Scenario 1

### 3. Layer Flow

#### 3a. fetchClaudeStatus() — Cache Check
- `statusCache.get('status')` → exists
- `Date.now() - cached.fetchedAt` < `CACHE_TTL` (120_000ms) → **cache hit**
- Return cached `ClaudeStatusInfo` immediately
- **No HTTP request made**

### 4. Side Effects
- None — pure cache read

### 5. Error Paths
- None — cache always returns valid data or undefined

### 6. Output
- Same `ClaudeStatusInfo` as originally cached

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `fetchClaudeStatus_returnsCachedOnSecondCall` | Happy Path | S2, Section 3a — cache hit |
| `fetchClaudeStatus_refetchesAfterTTLExpiry` | Side-Effect | S2, Section 3a — cache expiry |

---

## Scenario 3 — Graceful degradation when status page unreachable

### 1. API Entry
- Same trigger as Scenario 1
- status.claude.com is down or returns non-200

### 3. Layer Flow

#### 3a. fetchClaudeStatus() — Fetch Fails
- `fetch()` throws (DNS failure, connection refused, timeout)
- OR `response.ok === false` (e.g., 503 from status page itself)
- catch block: `logger.warn(...)` → return `null`

### 4. Side Effects
- No cache write (null is not cached)

### 5. Error Paths
- All errors in fetch/parse → caught → return null
- Caller receives null → skips status section in error message

### 6. Output
- `null` — formatErrorForUser renders error without status block

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `fetchClaudeStatus_returnsNullOnFetchError` | Sad Path | S3, Section 3a |
| `fetchClaudeStatus_doesNotCacheNull` | Side-Effect | S3, Section 4 |

---

## Scenario 4 — All systems operational display

### 1. API Entry
- API error occurs but status.claude.com shows all green

### 3. Layer Flow

#### 3a. formatStatusForSlack(status) — Formatter
- File: `src/claude-status-fetcher.ts`
- Input: `ClaudeStatusInfo` where all components are `'operational'` and `incidents.length === 0`
- Transformation:
  - `status.overall === 'operational'` → single-line format
  - Output: `:bar_chart: *Claude Service Status* — :large_green_circle: All Systems Operational`

#### 3b. formatStatusForSlack(status) — Degraded/Outage
- Input: `ClaudeStatusInfo` with mixed statuses
- Transformation per component:
  - `component.status === 'operational'` → `:large_green_circle:`
  - `component.status === 'degraded'` → `:large_yellow_circle:`
  - `component.status === 'outage'` → `:red_circle:`
- Incidents appended as bullet list
- Output: multi-line Slack mrkdwn block (see spec Section 5.4)

### 6. Output
- All operational: `":bar_chart: *Claude Service Status* — :large_green_circle: All Systems Operational"`
- Mixed: Multi-line block with per-component status + incidents

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `formatStatusForSlack_allOperational` | Happy Path | S4, Section 3a — single line |
| `formatStatusForSlack_mixedStatuses` | Happy Path | S4, Section 3b — multi-line |
| `formatStatusForSlack_withIncidents` | Happy Path | S4, Section 3b — incidents |

---

## Scenario 5 — Integration into stream-executor error flow

### 1. API Entry
- `stream-executor.ts` → `execute()` catch block (line ~713)
- Calls `handleError()` which calls `formatErrorForUser()`

### 3. Layer Flow

#### 3a. handleError() — Parallel Status Fetch
- File: `src/slack/pipeline/stream-executor.ts`
- After `isAbort` check (line ~765), before `say()`:
  - `const statusPromise = isApiError(error) ? fetchClaudeStatus() : Promise.resolve(null)`
  - Runs in parallel with session clearing, reaction update, etc.
  - `const statusInfo = await statusPromise` — resolved before `formatErrorForUser`

#### 3b. isApiError(error) — Error Classification
- File: `src/slack/pipeline/stream-executor.ts` (new private method)
- Checks error.message for API error patterns:
  - HTTP status codes: `/\b[45]\d{2}\b/` regex
  - Keywords: `'internal server error'`, `'service unavailable'`, `'overloaded'`, `'rate limit'`, `'too many requests'`, `'temporarily unavailable'`, `'connection reset'`, `'api_error'`, `'api error'`
- Returns `boolean`

#### 3c. formatErrorForUser() — Extended Signature
- Current: `formatErrorForUser(error, sessionCleared)`
- New: `formatErrorForUser(error, sessionCleared, statusInfo?)`
- Transformation:
  - `statusInfo !== null` → append `formatStatusForSlack(statusInfo)` after existing lines
  - `statusInfo === null` → no change to existing output

### 4. Side Effects
- No additional side effects beyond existing handleError behavior

### 5. Error Paths
| Condition | Behavior |
|-----------|----------|
| Non-API error (Slack API error, abort) | `isApiError` returns false → no status fetch |
| Status fetch slow (>3s) | fetch times out → null → no status block |

### 6. Output
- Slack message: existing error text + optional status block appended

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `isApiError_detectsHttpStatusCodes` | Contract | S5, Section 3b |
| `isApiError_detectsApiKeywords` | Contract | S5, Section 3b |
| `isApiError_rejectsSlackErrors` | Sad Path | S5, Section 5 |
| `formatErrorForUser_appendsStatusBlock` | Contract | S5, Section 3c |
| `formatErrorForUser_omitsStatusWhenNull` | Sad Path | S5, Section 3c |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Regex-based HTML parsing (not DOM parser) | tiny | Status page has stable class patterns; regex is dependency-free |
| `isApiError()` as new private method on StreamExecutor | tiny | Single function, one file, follows existing `isRateLimitError()` pattern |
| Status emoji mapping (green/yellow/red) | tiny | Standard Slack convention, easily changed |
| Don't cache null results | tiny | Failed fetches should retry on next error |
| `AbortSignal.timeout(3000)` for fetch | tiny | Native API, no setTimeout cleanup needed |

## Implementation Status
| Scenario | Trace | Tests (RED) | Status |
|----------|-------|-------------|--------|
| 1. Fetch and display status on API error | done | RED | Ready for stv:work |
| 2. Cache hit on repeated errors | done | RED | Ready for stv:work |
| 3. Graceful degradation when unreachable | done | RED | Ready for stv:work |
| 4. All systems operational display | done | RED | Ready for stv:work |
| 5. Integration into stream-executor error flow | done | RED | Ready for stv:work |

## Next Step
→ Proceed with implementation + Trace Verify via `stv:work`
