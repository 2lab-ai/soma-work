# 🎯 EXAMPLE-42 Executive Summary

> **Synthetic example.** Every ticket key, PR number, repository, service, file and person
> below is invented for this document. It ships inside a public package, so it must never be
> replaced with a real report from a private or customer codebase — copy the *shape*, not a
> real incident.

## 0. SSOT
- SSOT
```
@reporter [2026/03/30 11:52 AM] @assistant Research job
Intent:
- Split the jobs that can run in parallel (feed polling, digest scan) out of the main worker.
  A read-only database context would be ideal for most of them
- Thoughts
  - Separate the background job executors
  - Run the scheduled jobs periodically and finalize by calling the notifier service API
  - Only the read-only replica should be reachable from there
@reporter [2026/03/30 12:49 PM] Approved — wrap it up
```
- EXAMPLE-42: https://example.atlassian.net/browse/EXAMPLE-42 - QA
- PR #12: https://github.com/example-org/example-service/pull/12 - Merged
- PR #15: https://github.com/example-org/example-service/pull/15 - Merged

## 1. Problem Background

A failure was suspected in the **order settlement pipeline** where `notifyOrderSettled` messages were **not being delivered over the WebSocket** from the relay server to the notifier service.

**Impact Chain**:
```
ResultFeedPoller.processResults()
  → SettlementEventBuilder.build()
    → relayServer.onReceive('notifyOrderSettled', serialized)
      → RelayServer notifyOrderSettled handler
        → filterEventsForSubscribers (blocked here!)
          → broadcastEvents.length === 0
            → broadcastToSubscribers skipped (no logs!)
              → NotifierService.notifyOrderSettled not received
                → settleOrder() not called
                → DigestPublisher.publishOnSettlement() not called
```

**Business Impact**:
- **Settlements missing**: order settlements were not being processed on time
- **Digest feed not triggering**: notification digests never fired, leaving a gap for the ops team
- **Failure detection impossible**: nothing was logged when the issue occurred (silent filter drop), so operators could not see it

## 2. Root Cause Analysis

### Ticket: 7 Failure Points (by priority)

| # | Failure Point | Location | Diagnosis |
|---|---------------|----------|-----------|
| 1 | Auto-settle disabled | src/feed/result-poller.ts:290 | Config verification needed |
| 2 | feed.enabled=false | src/feed/result-poller.ts:61 | Config verification needed |
| 3 | Notifier WS not connected | src/relay/subscribe-server.ts:38 | Connection status check needed |
| 4 | resultApiUrl not configured | src/feed/result-poller.ts:204 | Config verification needed |
| 5 | Publication gate duplication | src/feed/result-poller.ts:302 | Confirmed working correctly |
| **6** | **Snapshot null filter (SILENT!)** | **src/relay/receive.ts:689** | **🔴 Code defect confirmed** |
| 7 | source.enabled=false | src/feed/result-poller.ts:137 | Config verification needed |

### Code Defects Found: 2

**Defect A — Filter/Update Order Error (Root Cause)**

In 4 notify handlers, `filterEventsForSubscribers` (filter) was called **before** `updateSnapshot` (snapshot update).

```
❌ AS-IS: filter(stale snapshot) → update
✅ TO-BE: update(latest snapshot) → filter
```

The filter's internal `shouldBroadcast` checks for `snapshotEvent.order == null`, but since the snapshot had not been updated yet at the time of the check, newly seen orders were always null, causing broadcasts to be blocked.

Only `notifyOrderUpdate` had the correct order (update-first); the other 4 were wrong.

**Defect B — Silent Filter Drop (#6)**

When `broadcastEvents.length === 0`, the broadcast was skipped without logging anything. A structural defect that made it impossible for operators to detect failures.

## 3. Fix History

### PR #12 — Root Cause Fix (MERGED 2026-03-31 10:09 UTC)

| Item | Details |
|------|---------|
| **Change** | Unified `updateSnapshot`/`filterEventsForSubscribers` call order to update-first across 4 handlers |
| **Files** | `src/relay/receive.ts` (+12 -12, order swap only) |
| **Effect** | `notifyOrderSettled` now broadcasts normally over the WebSocket → notifier receives → settlement and digest feed restored |
| **Review** | Review requested from a maintainer, squash merge |

### PR #15 — Silent Filter Drop Logging (MERGED 2026-04-01 03:49 UTC)

| Item | Details |
|------|---------|
| **Change** | Added `else` branch warn logs to 5 notify handlers + `logFilteredEventsDrop` helper method |
| **Files** | `src/relay/receive.ts` (+71 -10) |
| **Quality** | Automated review, 3 loop iterations: 83→92→**99/100** |
| **Fixes** | Duplicate-event log warn→debug (prevent amplification), orderIds→distinct+sample, field name `sampleOrderIds` |
| **Review** | Maintainer approved, squash merge |

## 4. STV Verify Results

| Spec Item | Status | Verification Method |
|-----------|--------|---------------------|
| notifyOrderSettled WS delivery restored | ✅ | Code order verified, build 0 errors |
| notifyOrderUpdate confirmed correct | ✅ | Originally update-first — no change needed |
| notifyStatusUpdate order fixed | ✅ | update→filter order diff verified |
| notifyPriceUpdate order fixed | ✅ | update→filter order diff verified |
| notifyItemUpdate order fixed | ✅ | update→filter order diff verified |
| Silent filter drop logging | ✅ | 5 handler else branches + helper method verified |
| Settlement/digest trigger restored | ✅ | notifyOrderSettled→broadcastToSubscribers→settlement path verified |

**Verdict: PASS** — 7/7 spec items satisfied, 0 gaps

## 5. Timeline

| Time (UTC) | Event |
|------------|-------|
| 03/31 06:49 | EXAMPLE-42 work started in previous session |
| 03/31 07:14 | Ticket EXAMPLE-42 created (7 failure points analyzed) |
| 03/31 07:39 | PR #15 created (silent filter drop logging) |
| 03/31 08:48 | Reporter: "It says to deliver over the WebSocket" — core requirement clarified |
| 03/31 09:19 | PR #12 created (filter/update order fix — root cause fix) |
| 03/31 10:09 | **PR #12 MERGED** |
| 03/31 10:43 | Staging deployment PR #17 merged |
| 04/01 02:53 | Maintainer approved PR #15 |
| 04/01 03:49 | **PR #15 MERGED** |

## 6. Risks and Follow-up Actions

| Item | Status | Action |
|------|--------|--------|
| **Previously missed settlements** | ⚠️ Unverified | Settlements may have been missed during the pre-deployment period. Operations team needs to run reconciliation |
| **Staging deployment confirmed** | ✅ | The staging deployment (#17) containing PR #12 is already merged. PR #15 to be included in the next deployment |
| **Monitoring** | 🔶 Recommended | Monitor `relay_events_all_filtered` log frequency after deployment → 0 is normal; if persistent, investigate failure points 1~5, 7 |
| **Failure points 1~5, 7** | 🔶 Unverified | Configuration-based failure points (auto-settle, feed config, etc.) require runtime verification. Code defects have been fixed |
| **Ticket EXAMPLE-42** | QA | Post-deployment QA verification of actual settlement behavior needed |

## 7. AS-IS → TO-BE Summary

| Category | AS-IS | TO-BE |
|----------|-------|-------|
| **Handler order** | 4 handlers filter→update (stale snapshot) | ✅ All 5 handlers update→filter (consistent) |
| **WS Broadcast** | notifyOrderSettled blocked | ✅ Normal broadcast |
| **Settlement** | settleOrder not called | ✅ Normal invocation |
| **Digest feed** | publishOnSettlement not called | ✅ Normal invocation |
| **Observability** | Silent drop — no logs | ✅ 5 handler warn + duplicate-event debug |
| **Diagnostics** | Unable to trace failure cause | ✅ Structured logs with eventType, correlationId, sampleOrderIds |

## 8. References

-
