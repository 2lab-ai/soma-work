import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const REFERENCES_DIR = resolve(SKILL_ROOT, 'references');
const LICENSES_DIR = resolve(SKILL_ROOT, 'LICENSES');

// The distilled references are the reason this skill exists: generalized UI
// motion craft, with the upstream's course-marketing and forced-blurb stripped.
const REQUIRED_REFERENCES = ['motion-standards.md', 'animation-techniques.md'] as const;

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

describe('local:motion-design skill — RED contract', () => {
  it('SKILL.md exists', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('frontmatter has name: motion-design and a motion-craft description', () => {
    const fm = parseFrontmatter(readFileSync(SKILL_MD, 'utf8'));
    expect(fm.name).toBe('motion-design');
    const desc = (fm.description ?? '').toLowerCase();
    expect(desc).toMatch(/animation|motion/);
  });

  it.each(REQUIRED_REFERENCES)('references/%s exists (distilled motion knowledge)', (name) => {
    expect(existsSync(resolve(REFERENCES_DIR, name))).toBe(true);
  });

  it('SKILL.md encodes the generalized decision framework, not the upstream marketing', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    // The generalization contract: the forced course-plug blurb is gone.
    expect(md).not.toMatch(/animations\.dev/i);
    expect(md).not.toMatch(/I'm ready to help you build interfaces/i);
    // The reusable value is the "should this animate at all" decision gate.
    expect(md).toMatch(/should this animate/i);
    expect(md).toMatch(/ease-out/i);
  });

  it('LICENSES/ carries an attribution NOTICE for the upstream emilkowalski/skills', () => {
    expect(existsSync(LICENSES_DIR)).toBe(true);
    const files = readdirSync(LICENSES_DIR).map((f) => f.toLowerCase());
    const hasNotice = files.some((f) => f.includes('notice'));
    expect(hasNotice, `expected an attribution NOTICE under ${LICENSES_DIR}`).toBe(true);
    const notice = readFileSync(resolve(LICENSES_DIR, 'NOTICE.md'), 'utf8');
    // No upstream LICENSE file exists — we must NOT claim a license grant.
    expect(notice).toMatch(/emilkowalski\/skills/);
    expect(notice).toMatch(/no license|attribution only|not a license grant/i);
  });
});
