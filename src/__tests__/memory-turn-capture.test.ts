/**
 * Turn-end episodic capture must record real user turns but SKIP host
 * re-injections (goal-continuation, etc.) which otherwise flood the episodic
 * log with boilerplate.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  return { TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-turn-capture-${process.pid}`) };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));

import { captureTurnEpisodic } from '../memory-auto-capture';

const user = 'U_cap';

function todayEpisodic(): string {
  const day = new Date().toISOString().slice(0, 10);
  const fp = path.join(TEST_DATA_DIR, user, 'memory', 'episodic', `${day}.md`);
  return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : '';
}

// captureTurnEpisodic schedules the write on the microtask queue.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('captureTurnEpisodic — skips host re-injections', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });
  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('records a genuine user turn', async () => {
    captureTurnEpisodic(user, '<speaker>Z</speaker>\n메모리 요약해줘', 'Here is the summary.');
    await flush();
    const ep = todayEpisodic();
    expect(ep).toContain('메모리 요약해줘');
    expect(ep).toContain('Here is the summary.');
  });

  it('does NOT record a [goal-continuation] re-injection', async () => {
    captureTurnEpisodic(
      user,
      '[goal-continuation] Continue working toward the active session goal. The objective below is ...',
      'Halting — no action.',
    );
    await flush();
    expect(todayEpisodic()).toBe(''); // nothing written
  });

  it('does NOT record the goal-continuation prose even without the bracket tag', async () => {
    captureTurnEpisodic(
      user,
      'Continue working toward the active session goal.\n<objective>\nprompt\n</objective>',
      'x',
    );
    await flush();
    expect(todayEpisodic()).toBe('');
  });

  it('still records after a skipped re-injection (no state corruption)', async () => {
    captureTurnEpisodic(user, '[goal-continuation] Continue working toward the active session goal.', 'noop');
    await flush();
    captureTurnEpisodic(user, '<speaker>Z</speaker>\n실제 질문', 'real answer');
    await flush();
    const ep = todayEpisodic();
    expect(ep).toContain('실제 질문');
    expect(ep).not.toContain('goal-continuation');
  });
});
