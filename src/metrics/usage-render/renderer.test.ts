import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FontLoadError } from './errors';
import { __setFontPathForTests, renderUsageCard } from './renderer';
import type { UsageCardStats } from './types';

// Trace: docs/usage-card/trace.md, Scenario 6

function makeStats(): UsageCardStats {
  const heatmap = Array.from({ length: 42 }, (_, i) => ({
    date: i >= 12 ? `2026-04-${String((i - 12 + 1) % 31 || 1).padStart(2, '0')}` : '',
    tokens: i >= 12 ? 1000 + i * 20 : 0,
    cellIndex: i,
  }));
  return {
    empty: false,
    targetUserId: 'U_TEST',
    targetUserName: 'Tester',
    windowStart: '2026-03-20',
    windowEnd: '2026-04-18',
    totals: { last24h: 100, last7d: 500, last30d: 12345, costLast30dUsd: 0.42 },
    heatmap,
    hourly: Array.from({ length: 24 }, (_, h) => h * 10),
    rankings: {
      tokensTop: [{ userId: 'U_TEST', userName: 'Tester', totalTokens: 12345, totalCost: 0.42, rank: 1 }],
      costTop: [{ userId: 'U_TEST', userName: 'Tester', totalTokens: 12345, totalCost: 0.42, rank: 1 }],
      targetTokenRow: null,
      targetCostRow: null,
    },
    sessions: {
      tokenTop3: [],
      spanTop3: [],
    },
    favoriteModel: null,
    currentStreakDays: 3,
    totalSessions: 2,
  };
}

describe('renderUsageCard', () => {
  it('missing font → FontLoadError', async () => {
    __setFontPathForTests('/nonexistent/path/to/NotoSansKR.ttf');
    await expect(renderUsageCard(makeStats())).rejects.toBeInstanceOf(FontLoadError);
    __setFontPathForTests(null);
  });

  it('happy path → returns Buffer with PNG magic bytes', async () => {
    // Use real bundled font.
    __setFontPathForTests(path.join(__dirname, 'assets', 'NotoSansKR.ttf'));
    try {
      const png = await renderUsageCard(makeStats());
      expect(Buffer.isBuffer(png)).toBe(true);
      expect(png.length).toBeGreaterThan(1000);
      // PNG magic: 89 50 4E 47
      expect(png[0]).toBe(0x89);
      expect(png[1]).toBe(0x50);
      expect(png[2]).toBe(0x4e);
      expect(png[3]).toBe(0x47);
    } finally {
      __setFontPathForTests(null);
    }
  }, 30_000);
});
