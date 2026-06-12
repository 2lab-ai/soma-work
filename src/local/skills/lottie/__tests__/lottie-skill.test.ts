import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const VALIDATOR = resolve(SKILL_ROOT, 'validator', 'validate.mjs');
const NOTICE = resolve(SKILL_ROOT, 'LICENSES', 'NOTICE.md');

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

describe('local:lottie skill — RED contract', () => {
  it('SKILL.md exists with name: lottie and an authoring+embedding description', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
    const fm = parseFrontmatter(readFileSync(SKILL_MD, 'utf8'));
    expect(fm.name).toBe('lottie');
    const desc = (fm.description ?? '').toLowerCase();
    expect(desc).toMatch(/lottie/);
    expect(desc).toMatch(/author|create|generate/);
    expect(desc).toMatch(/html|embed/);
  });

  it('SKILL.md encodes the strict-renderer authoring mechanics from upstream', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    // The #1 gotcha: ungrouped shapes render blank. If this guidance is lost,
    // the skill regresses into producing invisible animations.
    expect(md).toMatch(/"ty":\s*"gr"/);
    expect(md).toMatch(/"tr"/);
    // Required top-level Bodymovin fields.
    for (const field of ['"v"', '"fr"', '"ip"', '"op"', '"w"', '"h"', '"layers"']) {
      expect(md).toContain(field);
    }
    // Colors are 0–1 RGBA — the other classic silent failure.
    expect(md).toMatch(/0–1 RGBA|0-1 RGBA|normalized 0–1/i);
    // Keyframe scalar values must be arrays.
    expect(md).toMatch(/always an array|s.*always.*array/i);
  });

  it('SKILL.md pins the lottie-web runtime and mandates inline animationData for embeds', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    expect(md).toMatch(/lottie-web@5\.13\.0/);
    expect(md).toMatch(/animationData/);
    expect(md).toMatch(/prefers-reduced-motion/);
  });

  it('SKILL.md documents the upstream player as deep mode (degit path preserved)', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    expect(md).toMatch(/degit diffusionstudio\/lottie/);
    expect(md).toMatch(/\?frame=\d+&paused=1/);
  });

  it('validator/validate.mjs exists, uses Playwright, and detects the blank-render gotcha', () => {
    expect(existsSync(VALIDATOR)).toBe(true);
    const src = readFileSync(VALIDATOR, 'utf8');
    expect(src).toMatch(/playwright/);
    expect(src).toMatch(/lottie-web@5\.13\.0/);
    expect(src).toMatch(/svgNodes/);
    expect(src).toMatch(/animationData/);
  });

  it('LICENSES/NOTICE.md carries MIT attribution for diffusionstudio/lottie', () => {
    expect(existsSync(NOTICE)).toBe(true);
    const notice = readFileSync(NOTICE, 'utf8');
    expect(notice).toMatch(/diffusionstudio\/lottie/);
    expect(notice).toMatch(/MIT/);
    expect(notice).toMatch(/Diffusion Studio/);
  });
});
