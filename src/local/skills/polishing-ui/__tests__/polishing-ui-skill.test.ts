import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const SKILL_ROOT = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(resolve(SKILL_ROOT, rel), 'utf8');

/** The front matter as a YAML loader reads it: an unquoted `: ` in a value fails here, as it fails the skill loader. */
function frontmatter(md: string): Record<string, string> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  return parse(match[1]) as Record<string, string>;
}

/** The value of `key: <number>` inside the named preset block of audit.mjs's THRESHOLDS. */
function threshold(src: string, preset: 'desktop' | 'mobile', key: string): number {
  const block = src.match(new RegExp(`${preset}: \\{([\\s\\S]*?)\\n  \\}`));
  const hit = block?.[1].match(new RegExp(`${key}: (\\d+)`));
  return hit ? Number(hit[1]) : Number.NaN;
}

describe('local:polishing-ui skill — contract', () => {
  it('frontmatter names the skill and says when to use it', () => {
    const fm = frontmatter(read('SKILL.md'));
    expect(fm.name).toBe('polishing-ui');
    expect(fm.description).toMatch(/^Use when /);
    expect(fm.description).toMatch(/polishing-ui/);
    expect(fm.description).toMatch(/UI 폴리싱/);
    expect(fm.license).toBe('ISC');
  });

  it('carries the detail pass in order', () => {
    const md = read('SKILL.md');
    const steps = [
      /Corner element: equal distance to both edges/,
      /Gap to the next element = the same distance/,
      /Opposite corner control/,
      /Whole component: type and surface/,
      /Hover: nothing disappears/,
      /Hover while open: no hard edge/,
      /Motion: nothing opens or closes in 0 ms/,
      /Accessible name: what it is, nothing else/,
      /Themes\./,
      /Before and after\./,
    ];
    let at = -1;
    for (const step of steps) {
      const i = md.search(step);
      expect(i, String(step)).toBeGreaterThan(at);
      at = i;
    }
    expect(md).toMatch(/never 0\.5 px/);
  });

  it('states the desktop and phone numbers, and the reference cites their sources', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/28 pt/);
    expect(md).toMatch(/44 pt/);
    expect(md).toMatch(/17 pt where macOS body is 13 pt/);
    expect(md).toMatch(/16 px/);
    const ref = read('reference/apple-metrics.md');
    expect(ref).toMatch(/developer\.apple\.com\/design\/human-interface-guidelines/);
    expect(ref).toMatch(/44x44 pt \\\| 28x28 pt/);
    expect(ref).toMatch(/concentric with bar corners/);
    expect(ref).toMatch(/target-size-minimum/);
    expect(ref).toMatch(/## 4\. Not stated by any source/);
  });

  it('the audit thresholds are the reference numbers', () => {
    const src = read('scripts/audit.mjs');
    expect(threshold(src, 'desktop', 'targetPlatform')).toBe(28);
    expect(threshold(src, 'mobile', 'targetPlatform')).toBe(44);
    expect(threshold(src, 'desktop', 'targetMin')).toBe(24);
    expect(threshold(src, 'desktop', 'fontMin')).toBe(10);
    expect(threshold(src, 'mobile', 'fontMin')).toBe(11);
    expect(threshold(src, 'mobile', 'inputMinFont')).toBe(16);
    // The audit only reads the page: no write, click-through or form submission beyond --click.
    expect(src).not.toMatch(/\.fill\(|\.type\(|method: 'POST'/);
  });

  it('credits the method and its source write-up', () => {
    const notice = read('LICENSES/NOTICE.md');
    expect(notice).toMatch(/diegohaz/);
    expect(notice).toMatch(/dosi\.dev/);
  });
});
