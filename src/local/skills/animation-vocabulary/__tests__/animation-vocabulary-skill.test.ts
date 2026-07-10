import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const LICENSES_DIR = resolve(SKILL_ROOT, 'LICENSES');

// Spot-check glossary coverage — one representative term per category. If a
// glossary re-sync drops a whole category, one of these disappears with it.
const REPRESENTATIVE_TERMS = [
  'Stagger', // Sequencing & Timing
  'Origin-aware animation', // Movement & Transforms
  'Shared element transition', // Transitions Between States
  'Parallax', // Scroll
  'Rubber-banding', // Feedback & Interaction
  'Cubic-bezier', // Easing
  'Perceptual duration', // Spring Animations
  'Marquee', // Looping & Ambient Motion
  'Skeleton / Shimmer', // Polish & Effects
  'Layout thrashing', // Performance
  'Squash & stretch', // Principles to Know
] as const;

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

describe('local:animation-vocabulary skill — RED contract', () => {
  it('SKILL.md exists', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('frontmatter has name: animation-vocabulary and a reverse-lookup description', () => {
    const fm = parseFrontmatter(readFileSync(SKILL_MD, 'utf8'));
    expect(fm.name).toBe('animation-vocabulary');
    const desc = (fm.description ?? '').toLowerCase();
    expect(desc).toMatch(/glossary|term|vocabulary/);
  });

  it.each(REPRESENTATIVE_TERMS)('glossary defines "%s"', (term) => {
    const md = readFileSync(SKILL_MD, 'utf8');
    expect(md).toContain(`**${term}**`);
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
