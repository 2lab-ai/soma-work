/**
 * Shared fixtures for the carousel/usage-card test suites.
 *
 * Hoisted from `buildCarouselOption.test.ts`, `carousel-renderer.test.ts`, and
 * `usage-handler.routing.test.ts` so the tabs-Record literal type is defined
 * once. Kept narrow on purpose — only the fields each consumer asserts on.
 */

import type { CarouselStats, CarouselTabStats, EmptyTabStats, ModelsTabStats, PeriodTabId, TabId } from '../types';

export type CarouselTabsOverrides = Partial<{
  '24h': CarouselTabStats | EmptyTabStats;
  '7d': CarouselTabStats | EmptyTabStats;
  '30d': CarouselTabStats | EmptyTabStats;
  all: CarouselTabStats | EmptyTabStats;
  models: ModelsTabStats | EmptyTabStats;
}>;

export function makePeriodTabStats(tabId: PeriodTabId, overrides: Partial<CarouselTabStats> = {}): CarouselTabStats {
  return {
    empty: false,
    tabId,
    targetUserId: 'U_TEST',
    targetUserName: 'Tester',
    windowStart: '2026-03-20',
    windowEnd: '2026-04-18',
    totals: { tokens: 12345, costUsd: 0.42, sessions: 3 },
    favoriteModel: { model: 'claude-opus', tokens: 10000 },
    hourly: Array.from({ length: 24 }, (_, h) => h * 10),
    heatmap: [{ date: '2026-04-10', tokens: 500, cellIndex: 0 }],
    rankings: {
      tokensTop: [{ userId: 'U_TEST', userName: 'Tester', totalTokens: 12345, rank: 1 }],
      targetTokenRow: null,
    },
    activeDays: 5,
    longestStreakDays: 3,
    currentStreakDays: 2,
    topSessions: [],
    longestSession: null,
    mostActiveDay: null,
    ...overrides,
  };
}

export function makeEmptyTabStats(tabId: TabId): EmptyTabStats {
  return { empty: true, tabId, windowStart: '2026-03-20', windowEnd: '2026-04-18' };
}

export function makeModelsTabStats(overrides: Partial<ModelsTabStats> = {}): ModelsTabStats {
  return {
    empty: false,
    tabId: 'models',
    targetUserId: 'U_TEST',
    targetUserName: 'Tester',
    windowStart: '2026-03-20',
    windowEnd: '2026-04-18',
    totalTokens: 1000,
    rows: [
      {
        model: 'claude-opus-4-7',
        inputTokens: 400,
        outputTokens: 500,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 50,
      },
    ],
    dayKeys: Array.from({ length: 30 }, (_, i) => `2026-03-${String(20 + (i % 11)).padStart(2, '0')}`),
    dailyByModel: { 'claude-opus-4-7': new Array(30).fill(0).map((_, i) => (i === 0 ? 1000 : 0)) },
    ...overrides,
  };
}

export function makeCarouselStats(overrides: CarouselTabsOverrides = {}): CarouselStats {
  return {
    targetUserId: 'U_TEST',
    targetUserName: 'Tester',
    now: '2026-04-18T12:00:00+09:00',
    tabs: {
      '24h': overrides['24h'] ?? makePeriodTabStats('24h'),
      '7d': overrides['7d'] ?? makePeriodTabStats('7d'),
      '30d': overrides['30d'] ?? makePeriodTabStats('30d'),
      all: overrides.all ?? makePeriodTabStats('all'),
      models: overrides.models ?? makeModelsTabStats(),
    },
  };
}
