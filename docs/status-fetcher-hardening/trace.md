# Status Fetcher Hardening — Vertical Trace

> STV Trace | Created: 2026-03-28
> Spec: docs/status-fetcher-hardening/spec.md

## Table of Contents
1. [S1 — Negative cache / backoff](#s1)
2. [S2 — Incident status scoping](#s2)
3. [S3 — stream-executor integration test](#s3)
4. [S4 — non-OK HTTP response test](#s4)
5. [S5 — Incident status value test](#s5)

---

## S1 — Negative cache / backoff {#s1}

### 1. Entry Point
- File: `src/claude-status-fetcher.ts:92-103`
- Function: `fetchClaudeStatus()` → cache check → doFetch()

### 2. Input
- status page unreachable (fetch throws or returns non-OK)

### 3. Layer Flow

#### 3a. Current behavior
```
fetchClaudeStatus() → cache miss → doFetch() → catch → return null
Next call → cache miss again → doFetch() again → 3s timeout
```

#### 3b. Fix: add negative cache timestamp
```
doFetch() catch → lastFailedAt = Date.now() → return null
fetchClaudeStatus() → cache miss → check lastFailedAt → if within 30s → return null (skip fetch)
```

### 4. Side Effects
- Reduces outbound requests during status page outage
- 30s window where status info is unavailable even if page recovers

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `negative_cache_skips_fetch_within_backoff` | Bug Fix | S1, 3b |
| `negative_cache_allows_retry_after_backoff` | Bug Fix | S1, 3b |

---

## S2 — Incident status scoping {#s2}

### 1. Entry Point
- File: `src/claude-status-fetcher.ts:144-147`
- Function: `parseStatusPage()` → incident status extraction

### 2. Input
- HTML with 2+ incidents, first has no updates div

### 3. Layer Flow

#### 3a. Current behavior
```
afterMatch = html.slice(from current incident to END)
updatesMatch = first .updates div found anywhere in remainder
→ Can match WRONG incident's updates
```

#### 3b. Fix: scope to next incident boundary
```
afterMatch = html.slice(from current incident to END)
nextBoundary = afterMatch.indexOf('incident-container')
scopedHtml = nextBoundary > 0 ? afterMatch.slice(0, nextBoundary) : afterMatch
updatesMatch = first .updates div within scopedHtml only
```

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `incident_status_scoped_to_correct_incident` | Bug Fix | S2, 3b |
| `incident_without_updates_gets_unknown_status` | Bug Fix | S2, 3b |

---

## S3 — stream-executor integration test {#s3}

### 1. Entry Point
- File: `src/slack/pipeline/stream-executor.ts:1176`
- Function: `formatErrorForUser()` → statusInfo guard

### 2. Test Strategy
- Cannot call private `formatErrorForUser()` directly
- Test through exported or mockable integration point
- Alternative: extract guard logic into testable function

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `formatErrorForUser_includes_status_on_degraded` | Coverage | S3 |
| `formatErrorForUser_includes_status_on_operational_with_incidents` | Coverage | S3 |
| `formatErrorForUser_excludes_status_on_fully_operational` | Coverage | S3 |

---

## S4 — non-OK HTTP response test {#s4}

### 1. Entry Point
- File: `src/claude-status-fetcher.ts:64-67`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `fetchClaudeStatus_returnsNullOnNonOkResponse` | Coverage | S4 |

---

## S5 — Incident status value test {#s5}

### 1. Entry Point
- File: `src/claude-status-fetcher.ts:146-147`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `incident_status_extracted_from_updates_div` | Coverage | S5 |

---

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| 1 | Negative cache / backoff | small ~15줄 | 🔲 Ready |
| 2 | Incident status scoping | small ~5줄 | 🔲 Ready |
| 3 | stream-executor integration test | medium ~40줄 | 🔲 Ready |
| 4 | non-OK HTTP response test | tiny ~10줄 | 🔲 Ready |
| 5 | Incident status value test | tiny ~10줄 | 🔲 Ready |
