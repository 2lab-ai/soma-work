# API Error Status Coverage Fix — Vertical Trace

> STV Trace | Created: 2026-03-27
> Spec: docs/api-error-status-coverage-fix/spec.md
> Debug: docs/debugging/api-error-status-coverage-202603271530/trace.md

## Table of Contents
1. [S1 — Fix unknown status overall derivation (Bug 4)](#s1)
2. [S2 — Fix operational+incidents guard (Bug 5)](#s2)
3. [S3 — Inflight coalescing test](#s3)
4. [S4 — Regex robustness tests](#s4)
5. [S5 — Test isolation cleanup](#s5)

---

## S1 — Fix unknown status overall derivation {#s1}

### 1. Entry Point
- File: `src/claude-status-fetcher.ts:157-163`
- Function: `parseStatusPage()` → overall derivation block

### 2. Input
- `components` array where some have `status: 'unknown'` (unrecognized CSS class)

### 3. Layer Flow

#### 3a. parseStatusColor (unchanged)
- `status-red` → `'outage'`
- `status-yellow`/`status-orange` → `'degraded'`
- `status-green` → `'operational'`
- anything else → `'unknown'`

#### 3b. Overall derivation (FIX)
```
Before:
  if some(outage) → 'outage'
  else if some(degraded) → 'degraded'
  else → 'operational'  // BUG: unknown falls through

After:
  if some(outage) → 'outage'
  else if some(degraded) → 'degraded'
  else if some(unknown) → 'unknown'
  else → 'operational'
```

### 4. Side Effects
- None — pure function

### 5. Error Paths
- None

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `overall_unknown_when_all_components_unknown` | Bug Fix | S1, 3b |
| `overall_unknown_when_mix_of_operational_and_unknown` | Bug Fix | S1, 3b |

---

## S2 — Fix operational+incidents guard {#s2}

### 1. Entry Point
- File: `src/slack/pipeline/stream-executor.ts:1165`
- Function: `formatErrorForUser()` → status block append guard

### 2. Input
- `statusInfo` with `overall: 'operational'` and `incidents.length > 0`

### 3. Layer Flow

#### 3a. Guard condition (FIX)
```
Before:
  if (statusInfo && statusInfo.overall !== 'operational')

After:
  if (statusInfo && (statusInfo.overall !== 'operational' || statusInfo.incidents.length > 0))
```

#### 3b. formatStatusForSlack (unchanged)
- Already handles operational+incidents correctly (shows full component list + incidents)

### 4. Side Effects
- Slack message now includes status block when incidents exist even if all green

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `formatErrorForUser_shows_status_when_operational_with_incidents` | Bug Fix | S2, 3a |
| `formatErrorForUser_hides_status_when_fully_operational_no_incidents` | Regression | S2, 3a |

---

## S3 — Inflight coalescing test {#s3}

### 1. Entry Point
- File: `src/claude-status-fetcher.ts:99-102`
- Function: `fetchClaudeStatus()` → inflight promise reuse

### 2. Input
- 2 concurrent calls to `fetchClaudeStatus()` when cache is empty

### 3. Layer Flow
```
Call A: cache miss → inflight=null → inflight = doFetch().finally(...)
Call B: cache miss → inflight !== null → return inflight (same promise)
Both resolve with same result, fetch called once
```

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `concurrent_calls_share_single_fetch` | Coverage | S3, 3 |
| `failed_inflight_allows_retry` | Coverage | S3, 3 |

---

## S4 — Regex robustness tests {#s4}

### 1. Entry Point
- File: `src/claude-status-fetcher.ts:119,136`
- Functions: `parseStatusPage()` regex patterns

### 2. Test Fixtures

#### 4a. Extra CSS class before status class
```html
<div class="component-container border-color status-red">
```
- Current regex: `class="component-container\s+(status-\w+)"` — fails (matches `border-color`)
- Fix: `class="component-container[^"]*?(status-\w+)"` — greedy skip to status class

#### 4b. Nested span in name
```html
<div class="name"><span>Claude API</span></div>
```
- Current regex captures `<span>Claude API</span>` — dirty parse
- Fix: strip HTML tags from captured name

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `parser_handles_extra_css_classes` | Robustness | S4, 4a |
| `parser_strips_html_from_component_names` | Robustness | S4, 4b |

---

## S5 — Test isolation cleanup {#s5}

### 1. Entry Point
- File: `src/claude-status-fetcher.test.ts` — all describe blocks

### 2. Fix
- Every `afterEach` block adds: `vi.unstubAllGlobals(); vi.useRealTimers();`
- Remove redundant `vi.restoreAllMocks()` from both `beforeEach` and `afterEach`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `all_existing_tests_pass_after_isolation_fix` | Regression | S5 |

---

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| 1 | Fix unknown status overall derivation | tiny ~5줄 | 🔲 Ready |
| 2 | Fix operational+incidents guard | tiny ~3줄 | 🔲 Ready |
| 3 | Inflight coalescing test | small ~30줄 | 🔲 Ready |
| 4 | Regex robustness + tests | small ~40줄 | 🔲 Ready |
| 5 | Test isolation cleanup | tiny ~10줄 | 🔲 Ready |

## Next Step
→ Proceed with implementation via `stv:do-work`
