import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const LICENSES_DIR = resolve(SKILL_ROOT, 'LICENSES');

function parseFrontmatter(md: string): Record<string, string> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
    if (key) out[key] = value;
  }
  return out;
}

describe('local:apple-design skill — RED contract', () => {
  it('SKILL.md exists', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('frontmatter has name: apple-design and a fluid-interface description', () => {
    const fm = parseFrontmatter(readFileSync(SKILL_MD, 'utf8'));
    expect(fm.name).toBe('apple-design');
    const desc = (fm.description ?? '').toLowerCase();
    expect(desc).toMatch(/apple/);
    expect(desc).toMatch(/motion|fluid|spring|gesture/);
  });

  it('SKILL.md carries the core fluid-interface pillars', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    // Interruptibility is called out upstream as "the single most important principle".
    expect(md).toMatch(/interruptib/i);
    // Velocity handoff + momentum projection are the two web-translated Apple techniques.
    expect(md).toMatch(/velocity/i);
    expect(md).toMatch(/momentum/i);
    // Rubber-banding, materials, typography, and reduced-motion round out the surface.
    expect(md).toMatch(/rubber-?band/i);
    expect(md).toMatch(/backdrop-filter/i);
    expect(md).toMatch(/letter-spacing|tracking/i);
    expect(md).toMatch(/prefers-reduced-motion/i);
  });

  it('LICENSES/ carries the upstream MIT license and an attribution NOTICE', () => {
    expect(existsSync(LICENSES_DIR)).toBe(true);
    const files = readdirSync(LICENSES_DIR).map((f) => f.toLowerCase());
    expect(files.some((f) => f.includes('notice'))).toBe(true);
    expect(files.some((f) => f.includes('mit'))).toBe(true);
    const notice = readFileSync(resolve(LICENSES_DIR, 'NOTICE.md'), 'utf8');
    expect(notice).toMatch(/emilkowalski\/skills/);
    expect(notice).toMatch(/MIT/);
  });
});
