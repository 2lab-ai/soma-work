import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const LICENSES_DIR = resolve(SKILL_ROOT, 'LICENSES');
// Single source of standards: the canonical reference lives in the
// motion-design skill; review-motion cites it rather than duplicating it.
const SHARED_STANDARDS = resolve(SKILL_ROOT, '..', 'motion-design', 'references', 'motion-standards.md');

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

describe('local:review-motion skill — RED contract', () => {
  it('SKILL.md exists', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('frontmatter has name: review-motion and stays opt-in (disable-model-invocation)', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    const fm = parseFrontmatter(md);
    expect(fm.name).toBe('review-motion');
    const desc = (fm.description ?? '').toLowerCase();
    expect(desc).toMatch(/review/);
    expect(desc).toMatch(/animation|motion/);
    // A specialized reviewer must not auto-fire on every message.
    expect(fm['disable-model-invocation']).toBe('true');
  });

  it('cites the shared motion-standards from motion-design (single source, no duplicate)', () => {
    expect(existsSync(SHARED_STANDARDS)).toBe(true);
    const md = readFileSync(SKILL_MD, 'utf8');
    // The reviewer must point at the canonical standards rather than fork them.
    expect(md).toMatch(/motion-design\/references\/motion-standards\.md/);
  });

  it('encodes the review method: non-negotiable standards + required Before/After table + verdict', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    expect(md).toMatch(/non-negotiable/i);
    // The Before/After table is the mandated output contract for the reviewer.
    expect(md).toMatch(/\|\s*Before\s*\|\s*After\s*\|\s*Why\s*\|/i);
    expect(md).toMatch(/verdict/i);
    expect(md).toMatch(/block|approve/i);
    // It reviews ONLY motion, not general code.
    expect(md).toMatch(/only.*motion|motion.*only|does not (write|review)/i);
  });

  it('LICENSES/ carries an attribution NOTICE for the upstream emilkowalski/skills', () => {
    expect(existsSync(LICENSES_DIR)).toBe(true);
    const files = readdirSync(LICENSES_DIR).map((f) => f.toLowerCase());
    expect(files.some((f) => f.includes('notice'))).toBe(true);
    const notice = readFileSync(resolve(LICENSES_DIR, 'NOTICE.md'), 'utf8');
    expect(notice).toMatch(/emilkowalski\/skills/);
    expect(notice).toMatch(/no license|attribution only|not a license grant/i);
  });
});
