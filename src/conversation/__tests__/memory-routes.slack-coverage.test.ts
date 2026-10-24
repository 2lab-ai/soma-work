import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SLACK_MEMORY_COVERAGE } from '../memory-routes';

// SSOT 2026-10-23 T3 (review P2) — every memory write a Slack surface makes
// (`memory …`, the `/z memory` card and modals, the improve buttons) has a
// counterpart in the dashboard 기억 tab. A new Slack memory write without a
// mapping here fails.

const SRC = path.resolve(__dirname, '..', '..');

function memoryWriters(): string[] {
  const l1 = fs.readFileSync(path.join(SRC, 'user-memory-store.ts'), 'utf8');
  const names = new Set<string>();
  for (const m of l1.matchAll(/^export function ((?:add|replace|remove|clear)\w*)\(/gm)) names.add(m[1]);
  const host = fs.readFileSync(path.join(SRC, 'hierarchical-memory.ts'), 'utf8');
  for (const m of host.matchAll(/^export function ((?:add|remove)\w*)\(/gm)) names.add(m[1]);
  for (const n of ['upsertPage', 'removePage', 'appendEpisodic']) names.add(n);
  return [...names];
}

function slackSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') slackSources(p, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('the 기억 tab covers every Slack memory write', () => {
  it('maps every memory writer a Slack surface calls', () => {
    const writers = memoryWriters();
    expect(writers).toEqual(expect.arrayContaining(['addMemory', 'clearAllMemory', 'addUserNote', 'removeUserPage']));
    const called = new Set<string>();
    for (const file of slackSources(path.join(SRC, 'slack'))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const name of writers) if (new RegExp(`\\b${name}\\(`).test(text)) called.add(name);
    }
    expect(called.size).toBeGreaterThan(5);
    const missing = [...called].filter((n) => !(n in SLACK_MEMORY_COVERAGE)).sort();
    expect(missing, 'Slack writes memory through a function the dashboard 기억 tab does not cover').toEqual([]);
  });
});
