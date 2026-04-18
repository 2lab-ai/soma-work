/* eslint-disable no-console */
/**
 * Generates `src/metrics/__fixtures__/usage-card.jsonl` — 30 days of synthetic
 * `token_usage` events for multiple users, anchored at a fixed endDate so the
 * fixture is deterministic across runs.
 *
 * Anchor: endDate = 2026-04-17 (KST). Window = 2026-03-19 .. 2026-04-17 (30 days).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const TZ_OFFSET_HOURS = 9; // Asia/Seoul, fixed for fixture determinism
const END_KST_DATE = '2026-04-17';
const DAYS = 30;

interface Event {
  id: string;
  timestamp: number;
  eventType: 'token_usage';
  userId: string;
  userName: string;
  sessionKey: string;
  metadata: {
    sessionKey: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUsd: number;
    pricingVersion: string;
  };
}

function kstDateAtHour(kstDate: string, hour: number, minute: number): number {
  // Returns UTC ms for KST date at the given hour/minute.
  const [y, m, d] = kstDate.split('-').map(Number);
  // KST → UTC: subtract 9h
  return Date.UTC(y, m - 1, d, hour - TZ_OFFSET_HOURS, minute, 0);
}

function addDaysStr(kstDate: string, delta: number): string {
  const [y, m, d] = kstDate.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() + delta);
  return utc.toISOString().slice(0, 10);
}

const users = [
  { userId: 'U_TEST_TARGET', userName: 'Target User' },
  { userId: 'U_ALICE', userName: 'Alice' },
  { userId: 'U_BOB', userName: 'Bob' },
  { userId: 'U_CAROL', userName: 'Carol' },
];

const events: Event[] = [];
let seq = 0;

// Seeded pseudo-random (deterministic).
function prand(i: number): number {
  const x = Math.sin(i) * 10000;
  return x - Math.floor(x);
}

for (let dayOffset = 0; dayOffset < DAYS; dayOffset++) {
  const kstDate = addDaysStr(END_KST_DATE, -(DAYS - 1 - dayOffset));

  for (const u of users) {
    // Target user: activity on 28/30 days, 3-5 events per day, multiple sessions.
    // Others: sparser, fewer events.
    const isTarget = u.userId === 'U_TEST_TARGET';
    const activeProb = isTarget ? 0.93 : 0.4;
    if (prand(seq + dayOffset * 7) > activeProb) continue;

    const eventsToday = isTarget
      ? 3 + Math.floor(prand(seq + dayOffset) * 3)
      : 1 + Math.floor(prand(seq + dayOffset) * 2);

    for (let k = 0; k < eventsToday; k++) {
      const hour = Math.floor(prand(seq++) * 24);
      const minute = Math.floor(prand(seq++) * 60);
      const ts = kstDateAtHour(kstDate, hour, minute);
      // 2 sessions per user; events within the same session span a window.
      const sessionIdx = k % 2;
      const sessionKey = `C${u.userId}-${kstDate}-${sessionIdx}`;
      const inputTokens = 1000 + Math.floor(prand(seq++) * 500);
      const outputTokens = 200 + Math.floor(prand(seq++) * 300);
      const cacheRead = 500 + Math.floor(prand(seq++) * 200);
      const cacheCreate = Math.floor(prand(seq++) * 100);
      const costUsd = Math.round((inputTokens * 0.000003 + outputTokens * 0.000015) * 10000) / 10000;
      events.push({
        id: `evt-${seq++}`,
        timestamp: ts,
        eventType: 'token_usage',
        userId: u.userId,
        userName: u.userName,
        sessionKey,
        metadata: {
          sessionKey,
          model: isTarget && k % 3 === 0 ? 'claude-opus-4-7' : 'claude-sonnet-4-6',
          inputTokens,
          outputTokens,
          cacheReadInputTokens: cacheRead,
          cacheCreationInputTokens: cacheCreate,
          costUsd,
          pricingVersion: '2026-04-16',
        },
      });
    }
  }
}

events.sort((a, b) => a.timestamp - b.timestamp);

const outPath = path.join(__dirname, '..', 'src', 'metrics', '__fixtures__', 'usage-card.jsonl');
const jsonl = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
fs.writeFileSync(outPath, jsonl);
console.log(`Wrote ${events.length} events to ${outPath}`);
