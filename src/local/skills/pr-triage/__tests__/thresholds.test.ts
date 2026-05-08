/**
 * Snapshot test: SKILL.md "Tier policy" table must agree with the THRESHOLDS
 * const inside classify-prs.ts. A reviewer who edits one without the other
 * silently changes triage behavior; this test makes that drift a CI failure.
 *
 * The test parses the markdown table by line shape, then re-derives the same
 * (stale, rotten) tuples that THRESHOLDS encodes. If you change a threshold,
 * change BOTH the const and the markdown table in the same commit.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_MD = path.join(__dirname, '..', 'SKILL.md');
const SCRIPT_TS = path.join(__dirname, '..', 'scripts', 'classify-prs.ts');

interface TierRow {
  tier: string;
  stale: number;
  rotten: number;
}

/** Parse the "Tier policy" markdown table from SKILL.md. */
function parseSkillMdTable(): TierRow[] {
  const md = fs.readFileSync(SKILL_MD, 'utf8');
  // Find the "Tier policy" section (header may carry a parenthetical suffix).
  const sectionMatch = md.match(/^##\s+Tier policy\b.*$/m);
  if (!sectionMatch) throw new Error('SKILL.md is missing the "Tier policy" section');
  const sectionIdx = md.indexOf(sectionMatch[0]);

  const after = md.slice(sectionIdx + sectionMatch[0].length);
  const lines = after.split('\n');
  const rows: TierRow[] = [];
  for (const line of lines) {
    // Stop at the next ## heading.
    if (line.startsWith('## ')) break;
    // Skip non-table lines, separator rows, and the table header row.
    if (!line.startsWith('|') || line.includes('---') || /Category\s*\|.*Detection/i.test(line)) {
      continue;
    }
    // Cells: | **draft** | isDraft=true | 7d | 14d |
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 4) continue;
    const tier = cells[0]
      .replace(/\*/g, '')
      .replace(/\s*\(.*$/, '')
      .trim();
    const staleMatch = cells[2].match(/(\d+)d/);
    const rottenMatch = cells[3].match(/(\d+)d/);
    if (!staleMatch || !rottenMatch) continue;
    rows.push({
      tier,
      stale: Number(staleMatch[1]),
      rotten: Number(rottenMatch[1]),
    });
  }
  return rows;
}

/** Parse the THRESHOLDS literal from classify-prs.ts via regex (no eval). */
function parseScriptThresholds(): TierRow[] {
  const ts = fs.readFileSync(SCRIPT_TS, 'utf8');
  const block = ts.match(/const THRESHOLDS = \{([\s\S]*?)\} as const;/);
  if (!block) throw new Error('classify-prs.ts is missing the THRESHOLDS const');
  const rows: TierRow[] = [];
  // Each entry: `draft: { stale: 7, rotten: 14 },` — keys may be quoted.
  const entryRe = /['"]?([\w-]+)['"]?\s*:\s*\{\s*stale:\s*(\d+)\s*,\s*rotten:\s*(\d+)\s*\}/g;
  for (let m = entryRe.exec(block[1]); m !== null; m = entryRe.exec(block[1])) {
    rows.push({ tier: m[1], stale: Number(m[2]), rotten: Number(m[3]) });
  }
  return rows;
}

/** Map SKILL.md table tier names → THRESHOLDS keys. */
const TIER_NAME_MAP: Record<string, string> = {
  draft: 'draft',
  ready: 'ready',
  approved: 'approved',
  'failing-CI': 'failing-CI',
};

describe('pr-triage threshold drift guard', () => {
  it('SKILL.md "Tier policy" table matches THRESHOLDS in classify-prs.ts', () => {
    const md = parseSkillMdTable();
    const ts = parseScriptThresholds();

    expect(md.length).toBeGreaterThan(0);
    expect(ts.length).toBe(md.length);

    const tsByKey = new Map(ts.map((r) => [r.tier, r]));
    for (const row of md) {
      const key = TIER_NAME_MAP[row.tier];
      expect(key, `unknown tier name in SKILL.md table: ${row.tier}`).toBeDefined();
      const tsRow = tsByKey.get(key);
      expect(tsRow, `THRESHOLDS missing key: ${key}`).toBeDefined();
      expect(tsRow?.stale, `tier ${row.tier} stale mismatch`).toBe(row.stale);
      expect(tsRow?.rotten, `tier ${row.tier} rotten mismatch`).toBe(row.rotten);
    }
  });

  it('THRESHOLDS covers exactly the 4 tiers expected by pickTier', () => {
    const ts = parseScriptThresholds();
    const tiers = new Set(ts.map((r) => r.tier));
    expect(tiers).toEqual(new Set(['draft', 'ready', 'approved', 'failing-CI']));
  });

  it('every (stale, rotten) pair is monotonically ordered with stale < rotten', () => {
    const ts = parseScriptThresholds();
    for (const row of ts) {
      expect(row.stale, `tier ${row.tier}`).toBeLessThan(row.rotten);
    }
  });
});
