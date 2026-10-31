/**
 * E4 ③ — an epic tree's spend, the cost cap's input (.prd/19 D9 e).
 *
 *   C1 a task's spend is the card's: the task total (or the runtime total
 *      before it had one) plus the running turn's calls at the session model.
 *   C2 a tree's spend: the epic, each live child, and each closed child from
 *      its latest archive — every id in `childTaskIds`.
 *   C3 the archive's newest snapshot of a key is what a closed child spent.
 *   C4 the owner's limit: a positive number of dollars, default 50.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../env-paths', () => ({ DATA_DIR: path.join(os.tmpdir(), `soma-epic-cost-data-${process.pid}`) }));

import { calculateTokenCost } from '../../metrics/model-registry';
import { SessionArchiveStore } from '../../session-archive';
import {
  DEFAULT_EPIC_COST_LIMIT_USD,
  EPIC_COST_LIMIT_MAX_USD,
  UserSettingsStore,
  validateEpicCostLimitUsd,
} from '../../user-settings-store';
import { archivedCostUsd, epicTreeCostUsd, sessionCostUsd } from '../epic-cost';

const MODEL = 'claude-opus-4-5-20251101';
const live = (inputTokens: number, outputTokens = 0) => ({
  k1: { inputTokens, outputTokens, cacheReadTokens: 0, cacheCreateTokens: 0 },
});
const usage = (cost: number) => ({
  costUsd: cost,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
});

describe('epic cost (E4 ③, D9 e)', () => {
  it('C1 — a task’s spend is its card’s: the task total (or the runtime one) plus the running turn at its model', () => {
    expect(sessionCostUsd({})).toBe(0);
    expect(sessionCostUsd({ taskUsage: usage(1.5) } as any)).toBe(1.5);
    // No task total yet: the runtime total.
    expect(sessionCostUsd({ usage: { totalCostUsd: 2 } } as any)).toBe(2);
    // The task total wins over the runtime one.
    expect(sessionCostUsd({ taskUsage: usage(1), usage: { totalCostUsd: 99 } } as any)).toBe(1);
    // The running turn's calls, priced at the session model.
    const running = calculateTokenCost(MODEL, 1000, 500, 0, 0);
    expect(running).toBeGreaterThan(0);
    expect(sessionCostUsd({ taskUsage: usage(1), liveUsage: live(1000, 500), model: MODEL } as any)).toBeCloseTo(
      1 + running,
      10,
    );
  });

  it('C2 — a tree’s spend: the epic, each live child, each closed child from its archive', () => {
    const epic = { taskUsage: usage(1), childTaskIds: ['live', 'closed', 'gone'] } as any;
    const lives: Record<string, any> = { live: { taskUsage: usage(2) } };
    const archived: Record<string, number> = { closed: 4 };
    const total = epicTreeCostUsd(epic, {
      live: (id) => lives[id],
      archived: (id) => archived[id] ?? 0,
    });
    expect(total).toBe(7);
    // A live child is priced live, never from an older archive of the same key.
    archived.live = 100;
    expect(epicTreeCostUsd(epic, { live: (id) => lives[id], archived: (id) => archived[id] ?? 0 })).toBe(7);
    // No children: the epic alone.
    expect(epicTreeCostUsd({ taskUsage: usage(3) } as any, { live: () => undefined, archived: () => 0 })).toBe(3);
  });

  describe('C3 — a closed child’s spend comes from the newest archive of its key', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-epic-cost-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('reads the latest snapshot; none, or a file naming another key, reads as 0', () => {
      const store = new SessionArchiveStore(dir);
      const key = 'task:c1';
      expect(store.latest(key)).toBeNull();
      expect(archivedCostUsd(store.latest(key))).toBe(0);
      const write = (at: number, body: Record<string, unknown>) =>
        fs.writeFileSync(
          path.join(dir, `task-c1_${at}.json`),
          JSON.stringify({ sessionKey: key, archivedAt: at, ...body }),
        );
      write(1000, { taskUsage: usage(1) });
      write(2000, { taskUsage: usage(3) });
      expect(store.latest(key)?.archivedAt).toBe(2000);
      expect(archivedCostUsd(store.latest(key))).toBe(3);
      // Before the task had a total: the runtime one.
      expect(archivedCostUsd({ usage: { totalCostUsd: 5 } } as any)).toBe(5);
      // A newest file that names another session is not this key's.
      fs.writeFileSync(
        path.join(dir, 'task-c1_3000.json'),
        JSON.stringify({ sessionKey: 'task:other', archivedAt: 3000 }),
      );
      expect(store.latest(key)).toBeNull();
      // An unreadable newest file reads as none, not a throw.
      fs.writeFileSync(path.join(dir, 'task-c1_4000.json'), '{not json');
      expect(store.latest(key)).toBeNull();
    });

    it('a real archive of a closed task carries its spend', () => {
      const store = new SessionArchiveStore(dir);
      store.archive(
        {
          ownerId: 'U1',
          channelId: '',
          slackless: true,
          taskId: 'c2',
          taskUsage: usage(2.5),
          lastActivity: new Date(),
        } as any,
        'task:c2',
        'terminated',
      );
      expect(archivedCostUsd(store.latest('task:c2'))).toBe(2.5);
    });
  });

  it('C4 — the owner’s limit: a positive number of dollars, default 50, capped; a bad stored value reads as the default', () => {
    expect(DEFAULT_EPIC_COST_LIMIT_USD).toBe(50);
    expect(validateEpicCostLimitUsd(12.5)).toBe(12.5);
    expect(validateEpicCostLimitUsd(EPIC_COST_LIMIT_MAX_USD * 2)).toBe(EPIC_COST_LIMIT_MAX_USD);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '10', null]) {
      expect(() => validateEpicCostLimitUsd(bad), String(bad)).toThrow(/positive number/);
    }
    const store = new UserSettingsStore(fs.mkdtempSync(path.join(os.tmpdir(), 'uss-epic-')));
    expect(store.getUserEpicCostLimitUsd('U1')).toBe(50);
    store.setUserEpicCostLimitUsd('U1', 20);
    expect(store.getUserEpicCostLimitUsd('U1')).toBe(20);
    expect(() => store.setUserEpicCostLimitUsd('U1', -5)).toThrow();
    expect(store.getUserEpicCostLimitUsd('U1')).toBe(20);
    // A hand-edited file with a bad value: the default, not a refusal-everything 0.
    (store as any).settings.U1.epicCostLimitUsd = 0;
    expect(store.getUserEpicCostLimitUsd('U1')).toBe(50);
  });
});
