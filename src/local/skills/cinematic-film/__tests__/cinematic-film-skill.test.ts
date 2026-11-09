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

describe('cinematic-film skill — contract', () => {
  it('SKILL.md has frontmatter name cinematic-film and a trigger-bearing description', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
    const fm = parseFrontmatter(read('SKILL.md'));
    expect(fm.name).toBe('cinematic-film');
    expect(fm.description).toMatch(/cinematic/i);
    expect(fm.description).toMatch(/시네마틱/);
    expect(fm.description).toMatch(/depth of field|out-of-focus|아웃오브포커스/i);
  });

  it('states the look as rules: fixed blur levels, moving focus masks, oversampled plane, beat cuts', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/never animate the blur radius/i);
    expect(md).toMatch(/oversampl/i);
    expect(md).toMatch(/rack/i);
    expect(md).toMatch(/beat/i);
    expect(md).toMatch(/-14 LUFS/);
  });

  it('carries the privacy rule: readable text is published text', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/privacy/i);
    expect(md).toMatch(/every readable/i);
  });

  it('requires an independent review loop until SHIP', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/independent review/i);
    expect(md).toMatch(/SHIP/);
    expect(existsSync(resolve(SKILL_ROOT, 'references', 'review-rubric.md'))).toBe(true);
  });

  it('ships the rig, the cut/GIF/mix scripts and the example film it describes', () => {
    for (const f of [
      'templates/remotion/Plate.tsx.template',
      'templates/remotion/Film.example.tsx.template',
      'scripts/cut.py',
      'scripts/make_gif.py',
      'scripts/mix_audio.py',
      'references/review-rubric.md',
    ]) {
      expect(existsSync(resolve(SKILL_ROOT, f)), f).toBe(true);
    }
    const plate = read('templates', 'remotion', 'Plate.tsx.template');
    // self-contained: no import from a project-specific lib path
    expect(plate).not.toMatch(/from '\.\.\/lib\//);
    expect(plate).toMatch(/export const Plate/);
  });

  it('names the Remotion license condition instead of hiding it', () => {
    expect(read('SKILL.md')).toMatch(/Remotion.*licen[cs]e/i);
  });
});
