import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RED contract for the explore-unknowns skill (SSOT T4/T6).
 *
 * SSOT_2: "explore-unknown 스킬을 local에 추가해주고 /
 *          spec이랑 autoz 스킬을 사용할시에 먼저 탐구하도록 개선해줘"
 *
 *  - T4: src/local/skills/explore-unknowns/ exists as a complete skill
 *        (SKILL.md + the five quadrant-walk stage references + after-the-walk
 *        + upstream attribution), adapted from dzhng/skills (MIT).
 *  - T4: the skill must carry an explicit autonomous mode so no-question
 *        pipelines (autoz) can run it without violating their contract.
 *  - T6: autoz SKILL.md wires an Explore phase before RED.
 *
 * (T5 — stv:spec explore-first — lives in 2lab-ai/oh-my-claude and is
 *  covered by that repo's PR, not this test.)
 */

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const REFERENCES_DIR = resolve(SKILL_ROOT, 'references');
const AUTOZ_SKILL_MD = resolve(SKILL_ROOT, '..', 'autoz', 'SKILL.md');

const REQUIRED_REFERENCES = [
  'stage-1-known-knowns.md',
  'stage-2-known-unknowns.md',
  'stage-3-unknown-knowns.md',
  'stage-4-unknown-unknowns.md',
  'stage-5-hand-over-the-map.md',
  'after-the-walk.md',
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

describe('local:explore-unknowns skill — contract (T4)', () => {
  it('SKILL.md exists', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('frontmatter has name: explore-unknowns and a quadrant/unknowns-focused description', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    const fm = parseFrontmatter(md);
    expect(fm.name).toBe('explore-unknowns');
    const desc = (fm.description ?? '').toLowerCase();
    expect(desc).toMatch(/unknown/);
    expect(desc).toMatch(/quadrant|map/);
  });

  it('walks the four quadrants via progressive-disclosure stage references', () => {
    for (const ref of REQUIRED_REFERENCES) {
      expect(existsSync(resolve(REFERENCES_DIR, ref)), `missing references/${ref}`).toBe(true);
    }
    const md = readFileSync(SKILL_MD, 'utf8');
    for (const ref of REQUIRED_REFERENCES) {
      expect(md, `SKILL.md must point at references/${ref}`).toContain(`references/${ref}`);
    }
  });

  it('carries an explicit autonomous mode for no-question pipelines (autoz)', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    // The section must exist and must forbid user questions in that mode.
    expect(md).toMatch(/## Autonomous [Mm]ode/);
    const autonomous = md.slice(md.search(/## Autonomous [Mm]ode/));
    expect(autonomous.toLowerCase()).toMatch(/no user question|never ask|without ask/);
    // The map is still the deliverable in autonomous mode.
    expect(autonomous.toLowerCase()).toMatch(/map/);
  });

  it('attributes the upstream source (dzhng/skills, MIT)', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    expect(md).toMatch(/dzhng\/skills/);
    expect(md).toMatch(/MIT/);
  });
});

describe('autoz wires an Explore phase before RED (T6)', () => {
  it('autoz SKILL.md references local:explore-unknowns', () => {
    const md = readFileSync(AUTOZ_SKILL_MD, 'utf8');
    expect(md).toMatch(/explore-unknowns/);
  });

  it('Pipeline Order runs Explore before the RED step', () => {
    const md = readFileSync(AUTOZ_SKILL_MD, 'utf8');
    const pipeline = md.slice(md.indexOf('## Pipeline Order'));
    const exploreIdx = pipeline.search(/[Ee]xplore/);
    const redIdx = pipeline.search(/\*\*RED\b/);
    expect(exploreIdx, 'Pipeline Order must contain an Explore step').toBeGreaterThan(-1);
    expect(redIdx, 'Pipeline Order must contain the RED step').toBeGreaterThan(-1);
    expect(exploreIdx, 'Explore must come before RED').toBeLessThan(redIdx);
  });

  it('autoz explore runs in autonomous mode (no interactive quadrant walk)', () => {
    const md = readFileSync(AUTOZ_SKILL_MD, 'utf8');
    expect(md.toLowerCase()).toMatch(/autonomous mode/);
    // The interactive walk must be explicitly forbidden inside autoz — no user questions.
    expect(md.toLowerCase()).toMatch(
      /never enter the interactive quadrant walk|interactive quadrant walk is forbidden/,
    );
    expect(md.toLowerCase()).toMatch(/no user questions|never to the user/);
  });

  it('the unknowns map always carries all four quadrants (trivial trees compress, never drop)', () => {
    const md = readFileSync(AUTOZ_SKILL_MD, 'utf8');
    expect(md.toLowerCase()).toMatch(/always carries all four quadrants/);
    expect(md.toLowerCase()).toMatch(/quadrants never disappear/);
  });
});
