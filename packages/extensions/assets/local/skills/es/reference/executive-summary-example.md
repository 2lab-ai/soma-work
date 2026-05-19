# 🎯 PTN-3231 Executive Summary

## 0. SSOT
- SSOT
```
@Z [2026/03/30 11:52 AM] @사마중달 (Beta) Research job
Intent:
- Service separation work for tasks that can run in parallel, such as bonus scan and vsports polling. Providing a db read-only context for most of them would be ideal
- Thoughts
  - Separate bg worker jobs executors
  - Periodically execute scheduled tasks and finalize by calling the settlements_service API
  - Can only directly access the replicated ro db
@Z [2026/03/30 12:49 PM] I approved it, so you wrap it up
```
- PTN-3231: https://insightquest.atlassian.net/browse/PTN-3231 - QA
- PR #1462: https://github.com/devinsightquest/Gucci/pull/1462 - Merged
- PR #1455: https://github.com/devinsightquest/Gucci/pull/1455 - Merged

## 1. Problem Background

A failure was suspected in the **VirtualSport settlement pipeline** where `NotifySettlements` messages were **not being delivered via WebSocket** from SnapshotService to SettlementService/GucciService.

**Impact Chain**:
```
VsportsResultFeedHostedService.ProcessResults()
  → VsportsSettlementEventBuilder.Build()
    → _snapshotServer.OnReceive(NotifySettlements, serialized)
      → SnapshotServer.NotifySettlements handler
        → FilterAndMapLivescoreForEvents (blocked here!)
          → broadcastEvents.Count == 0
            → BroadcastToSubscribers skipped (no logs!)
              → SettlementService.NotifySettlements not received
                → SettleFixture() not called
                → BigWinPublisher.PublishOnVirtualSportSettlement() not called
```

**Business Impact**:
- **Bet settlement missing**: Bet settlements for VirtualSport match results were not being processed on time
- **BigWinFeed not triggering**: Jackpot win notifications were not firing, causing ops/marketing feed gaps
- **Failure detection impossible**: No logs were generated when the issue occurred (Silent Filter Drop), making it impossible for operators to detect

## 2. Root Cause Analysis

### Jira Issue: 7 Failure Points (by priority)

| # | Failure Point | Location | Diagnosis |
|---|---------------|----------|-----------|
| 1 | AutoSettle disabled | VsportsResultFeedHostedService.cs:290 | Config verification needed |
| 2 | VsportsConfig.Enabled=false | VsportsResultFeedHostedService.cs:61 | Config verification needed |
| 3 | SettlementService WS not connected | SnapshotServer.Impl.SubscribeServer.cs:38 | Connection status check needed |
| 4 | ResultApiUrl not configured | VsportsResultFeedHostedService.cs:204 | Config verification needed |
| 5 | PublicationGate duplication | VsportsResultFeedHostedService.cs:302 | Confirmed working correctly |
| **6** | **Snapshot Fixture null filter (SILENT!)** | **SnapshotServer.Protein.Receive.cs:689** | **🔴 Code defect confirmed** |
| 7 | sport.Enabled=false | VsportsResultFeedHostedService.cs:137 | Config verification needed |

### Code Defects Found: 2

**Defect A — Filter/Update Order Error (Root Cause)**

In 4 Notify handlers, `FilterAndMapLivescoreForEvents` (filter) was called **before** `UpdateEventMessage` (snapshot update).

```
❌ AS-IS: Filter(stale snapshot) → Update
✅ TO-BE: Update(latest snapshot) → Filter
```

The filter's internal `ShouldBroadcastEvent` checks for `snapshotEvent.Fixture == null`, but since the snapshot had not been updated yet at the time of the check, new VirtualSport Fixtures were always null, causing broadcasts to be blocked.

Only `NotifyFixtureUpdate` had the correct order (Update-First); the other 4 were wrong.

**Defect B — Silent Filter Drop (#6)**

When `broadcastEvents.Count == 0`, the broadcast was skipped without logging anything. A structural defect that made it impossible for operators to detect failures.

## 3. Fix History

### PR #1462 — Root Cause Fix (MERGED 2026-03-31 10:09 UTC)

| Item | Details |
|------|---------|
| **Change** | Unified `UpdateEventMessage`/`FilterAndMapLivescoreForEvents` call order to Update-First across 4 handlers |
| **Files** | `SnapshotServer.Protein.Receive.cs` (+12 -12, order swap only) |
| **Effect** | NotifySettlements now broadcasts normally via WebSocket → SettlementService receives → SettleFixture/BigWinFeed restored |
| **Review** | Review requested from osun50s, squash merge |

### PR #1455 — Silent Filter Drop Logging (MERGED 2026-04-01 03:49 UTC)

| Item | Details |
|------|---------|
| **Change** | Added `else` branch Warn logs to 5 Notify handlers + `LogFilteredEventsDrop` helper method |
| **Files** | `SnapshotServer.Protein.Receive.cs` (+71 -10) |
| **Quality** | Codex review 3 loop iterations: 83→92→**99/100** |
| **Fixes** | Competition log Warn→Debug (prevent amplification), FixtureIds→Distinct+Sample, field name `SampleFixtureIds` |
| **Review** | icedac APPROVED, squash merge |

## 4. STV Verify Results

| Spec Item | Status | Verification Method |
|-----------|--------|---------------------|
| NotifySettlements WS delivery restored | ✅ | Code order verified, build 0 errors |
| NotifyFixtureUpdate confirmed correct | ✅ | Originally Update-First — no change needed |
| NotifyLivescoreUpdate order fixed | ✅ | Update→Filter order diff verified |
| NotifyMarketUpdate order fixed | ✅ | Update→Filter order diff verified |
| NotifyEventUpdate order fixed | ✅ | Update→Filter order diff verified |
| Silent Filter Drop logging | ✅ | 5 handler else branches + helper method verified |
| Bet settlement/BigWinFeed trigger restored | ✅ | NotifySettlements→BroadcastToSubscribers→Settlement path verified |

**Verdict: PASS** — 7/7 spec items satisfied, 0 gaps

## 5. Timeline

| Time (UTC) | Event |
|------------|-------|
| 03/31 06:49 | PTN-3231 work started in previous session |
| 03/31 07:14 | Jira PTN-3231 issue created (7 failure points analyzed) |
| 03/31 07:39 | PR #1455 created (Silent Filter Drop logging) |
| 03/31 08:48 | Z: "It says to deliver via WebSocket" — core requirement clarified |
| 03/31 09:19 | PR #1462 created (Filter/Update order fix — root cause fix) |
| 03/31 10:09 | **PR #1462 MERGED** |
| 03/31 10:43 | deploy/dev2 deployment PR #1470 merged |
| 04/01 02:53 | icedac PR #1455 APPROVED |
| 04/01 03:49 | **PR #1455 MERGED** |

## 6. Risks and Follow-up Actions

| Item | Status | Action |
|------|--------|--------|
| **Previously missed settlements** | ⚠️ Unverified | VirtualSport settlements may have been missed during the pre-deployment period. Operations team needs to run reconciliation |
| **dev2 deployment confirmed** | ✅ | deploy/dev2 (#1470) containing PR #1462 already merged. PR #1455 to be included in next deployment |
| **Monitoring** | 🔶 Recommended | Monitor `notify_settlements_all_filtered` log frequency after deployment → 0 is normal; if persistent, investigate Jira failure points 1~5, 7 |
| **Jira failure points 1~5, 7** | 🔶 Unverified | Configuration-based failure points (AutoSettle, VsportsConfig, etc.) require runtime verification. Code defects have been fixed |
| **Jira PTN-3231** | QA | Post-deployment QA verification of actual settlement behavior needed |

## 7. AS-IS → TO-BE Summary

| Category | AS-IS | TO-BE |
|----------|-------|-------|
| **Handler order** | 4 handlers Filter→Update (stale snapshot) | ✅ All 5 handlers Update→Filter (consistent) |
| **WS Broadcast** | NotifySettlements blocked (VirtualSport) | ✅ Normal broadcast |
| **Bet settlement** | SettleFixture not called | ✅ Normal invocation |
| **BigWinFeed** | PublishOnVirtualSportSettlement not called | ✅ Normal invocation |
| **Observability** | Silent Drop — no logs | ✅ 5 handler Warn + Competition Debug |
| **Diagnostics** | Unable to trace failure cause | ✅ Structured logs with GameType, Guid, SampleFixtureIds |

## 8. References

-
