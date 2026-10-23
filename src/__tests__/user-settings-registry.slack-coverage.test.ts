import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SLACK_SETTER_COVERAGE } from '../user-settings-registry';

// SSOT 2026-10-23 T2 — "every personal setting a Slack command changes is
// changeable on the dashboard" as a contract. Every `UserSettingsStore`
// mutator called from a Slack surface (`src/slack/**`) must be mapped in
// `SLACK_SETTER_COVERAGE` to a registry key or to an explicit exclusion
// reason. A new Slack settings command without a dashboard row fails here.

const SRC = path.resolve(__dirname, '..');

function storeMutators(): string[] {
  const source = fs.readFileSync(path.join(SRC, 'user-settings-store.ts'), 'utf8');
  const names = new Set<string>();
  const re = /^ {2}((?:set|patch|toggle|add|remove|clear|accept|create|update|ensure|consume|change)[A-Za-z]*)\(/gm;
  for (let m = re.exec(source); m; m = re.exec(source)) names.add(m[1]);
  return [...names];
}

function slackSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      slackSources(p, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('settings registry covers every Slack settings write', () => {
  const mutators = storeMutators();

  it('finds the store mutators (sanity)', () => {
    expect(mutators).toEqual(expect.arrayContaining(['setUserDefaultModel', 'patchNotification', 'setUserRating']));
  });

  it('maps every mutator a Slack surface calls', () => {
    const called = new Set<string>();
    for (const file of slackSources(path.join(SRC, 'slack'))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const name of mutators) {
        if (new RegExp(`\\.${name}\\(`).test(text)) called.add(name);
      }
    }
    expect(called.size).toBeGreaterThan(10);
    const missing = [...called].filter((name) => !(name in SLACK_SETTER_COVERAGE)).sort();
    expect(missing, 'Slack calls a settings mutator the dashboard registry does not cover').toEqual([]);
  });

  it('names a reason for every exclusion', () => {
    for (const [name, entry] of Object.entries(SLACK_SETTER_COVERAGE)) {
      if (typeof entry === 'object') expect(entry.excluded.length, name).toBeGreaterThan(10);
    }
  });
});
