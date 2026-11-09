import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const read = (...p: string[]) => readFileSync(resolve(SKILL_ROOT, ...p), 'utf8');

function parseFrontmatter(md: string): Record<string, string> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key) out[key] = line.slice(colon + 1).trim();
  }
  return out;
}

describe('make-product-demo skill — contract', () => {
  it('SKILL.md has frontmatter name make-product-demo and Korean + English triggers', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
    const fm = parseFrontmatter(read('SKILL.md'));
    expect(fm.name).toBe('make-product-demo');
    expect(fm.description).toMatch(/demo/i);
    expect(fm.description).toMatch(/데모/);
  });

  it('builds on cinematic-film instead of copying it (one owner for the look)', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/cinematic-film/);
    expect(existsSync(resolve(SKILL_ROOT, '..', 'cinematic-film', 'SKILL.md'))).toBe(true);
    expect(existsSync(resolve(SKILL_ROOT, 'templates'))).toBe(false);
  });

  it('starts from the audience and records the real product, never a mockup', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/audience/i);
    expect(md).toMatch(/real product/i);
    expect(md).toMatch(/mockup/i);
  });

  it('covers one film per display language and a README per language', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/per language|each language/i);
    expect(md).toMatch(/README/);
    expect(md).toMatch(/restore/i);
  });

  it('records spoken input through a TTS voice fed to the real dictation, and ships the fake microphone', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/TTS/);
    expect(md).toMatch(/fake microphone|fake mic/i);
    expect(existsSync(resolve(SKILL_ROOT, 'scripts', 'fakemic.cjs'))).toBe(true);
  });

  it("drives the user's own logged-in apps only through a path they enabled, never by relaunching them", () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/remote debugging/i);
    expect(md).toMatch(/never (kill|relaunch|restart)/i);
  });

  it('keeps a pitfalls reference from real runs', () => {
    expect(existsSync(resolve(SKILL_ROOT, 'references', 'pitfalls.md'))).toBe(true);
  });
});
