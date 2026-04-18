# /usage card — proof artifact

## usage-card-proof.png

End-to-end reproduction of the `/usage card` pipeline using deployed dist + real production JSONL.

**Reproduction**:
- Runtime: mac-mini-dev (darwin-arm64)
- Dist: `/opt/soma-work/dev/dist/metrics/usage-render/` (from PR #561, commit 86f07b1c)
- Data source: `/opt/soma-work/dev/data/metrics-events-*.jsonl`
- Pipeline: `MetricsEventStore.readRange()` → `ReportAggregator.aggregateUsageCard(U094E5L4A15, 30d KST)` → `renderUsageCard(stats)` → 1600×2200 RGBA PNG

**Stats snapshot (2026-04-18, 30d window ending today)**:
- last24h: 493,469,019 tokens
- last7d: 1,171,174,959 tokens
- last30d: 1,531,663,292 tokens ($1,497.25)
- heatmapCells: 42, hourlyBins: 24
- sessions: top 3 by tokens, top 3 by span
- favoriteModel: claude-opus-4-6 (965M tokens)
- currentStreakDays: 11

**Live verification** (Slack thread 2026-04-18):
- 02:17:58Z — user invoked `/usage card`
- 02:18:06Z — bot responded with Block Kit image + alt_text

See `docs/usage-card/spec.md` and `docs/usage-card/trace.md` for the authoritative specification.
