import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RED contract for the using-intentfirst skill and the zworkflow plugin README.
 *
 * SSOT_1: "1. soma-work의 zworkflow에 using-intentfirst 스킬 추가
 *          1.1 soma-work안에 zworkflow 추가하고 플러그인에 대해서 설치 설명하는 문서 추가해줘"
 *
 *  - T1: src/local/skills/using-intentfirst/SKILL.md exists as a plugin skill, so the
 *        zworkflow plugin (directory-discovered by skill-locator) ships it.
 *  - T2: the skill builds on using-ssot — the sibling skill and every using-ssot hook
 *        it names exist.
 *  - T3: the skill's core contract (intent list, intent task tree, diff against the
 *        SSOT task tree, proceed without waiting, no irreversible step on inference)
 *        is present.
 *  - T4 (SSOT 1.1): zworkflow is findable by name inside soma-work — a plugin README
 *        (English + Korean) documents installation, and both root READMEs link to it.
 *  - T5: plugin.json version is bumped past 2.5.0 (src/local/CLAUDE.md: skill
 *        addition = minor).
 */

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const SKILLS_DIR = resolve(SKILL_ROOT, '..');
const SSOT_MD = resolve(SKILLS_DIR, 'using-ssot', 'SKILL.md');
const PLUGIN_ROOT = resolve(SKILLS_DIR, '..');
const PLUGIN_JSON = resolve(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
const PLUGIN_README = resolve(PLUGIN_ROOT, 'README.md');
const PLUGIN_README_KO = resolve(PLUGIN_ROOT, 'README.ko.md');
const REPO_ROOT = resolve(PLUGIN_ROOT, '..', '..');
const ROOT_README = resolve(REPO_ROOT, 'README.md');
const ROOT_README_KO = resolve(REPO_ROOT, 'README.ko.md');

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

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function body(): string {
  return read(SKILL_MD);
}

describe('local:using-intentfirst skill — plugin registration (T1)', () => {
  it('SKILL.md exists under src/local/skills so skill-locator discovers it', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('sits under the manifest of the zworkflow plugin that ships src/local', () => {
    const plugin = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8'));
    expect(plugin.name).toBe('zworkflow');
  });

  it('frontmatter name is using-intentfirst with a load-first description', () => {
    const fm = parseFrontmatter(body());
    expect(fm.name).toBe('using-intentfirst');
    expect(fm.description ?? '').toMatch(/^Load first on every instruction/);
  });
});

describe('local:using-intentfirst skill — builds on using-ssot (T2)', () => {
  it('the sibling using-ssot skill it depends on ships in the same plugin', () => {
    expect(existsSync(SSOT_MD)).toBe(true);
  });

  it('names using-ssot as the layer it sits on', () => {
    expect(body()).toMatch(/using-ssot/);
  });

  it('every using-ssot hook it cites is a real using-ssot heading', () => {
    const cited = new Set([...body().matchAll(/using-ssot`?\s*Hook (\d+)/g)].map((m) => m[1]));
    // The skill cites Hook 1 (intake), Hook 2 (drift) and Hook 4 (completion report).
    expect([...cited].sort()).toEqual(['1', '2', '4']);
    const ssot = read(SSOT_MD);
    for (const n of cited) {
      expect(ssot).toMatch(new RegExp(`^### Hook ${n} — `, 'm'));
    }
  });
});

describe('local:using-intentfirst skill — doc contract (T3)', () => {
  it('defines the intent layer artifacts and the tree it diffs against', () => {
    const md = body();
    expect(md).toMatch(/INTENT-LIST/);
    expect(md).toMatch(/INTENT-TASK-TREE/);
    expect(md).toMatch(/SSOT-TASK-TREE/);
  });

  it('classifies diff entries as dropped and reshaped', () => {
    const md = body();
    expect(md).toMatch(/`dropped`/);
    expect(md).toMatch(/`reshaped`/);
  });

  it('proceeds without waiting for confirmation', () => {
    expect(body()).toMatch(/질문하고 대기 금지|절대 기다리지 않는다/);
  });

  it('states the prohibition on irreversible steps taken on inferred intent', () => {
    expect(body()).toContain('추론을 근거로 되돌릴 수 없는 일을 저지르지 않는다');
    expect(body()).toMatch(/\[irrev\]/);
  });
});

describe('zworkflow plugin README — install guide (T4, SSOT 1.1)', () => {
  const required = [
    'marketplace add 2lab-ai/soma-work',
    'zworkflow@soma-work',
    'zworkflow:using-intentfirst',
    'using-ssot',
    'HOOKS_PROXY_ENABLED',
  ];

  it.each([
    ['src/local/README.md', PLUGIN_README],
    ['src/local/README.ko.md', PLUGIN_README_KO],
  ])('%s exists and covers install, invocation and hooks', (_label, path) => {
    expect(existsSync(path)).toBe(true);
    const md = read(path);
    for (const s of required) expect(md).toContain(s);
  });

  it('root README.md links to the English plugin README', () => {
    expect(read(ROOT_README)).toContain('src/local/README.md');
  });

  it('root README.ko.md links to the Korean plugin README', () => {
    expect(read(ROOT_README_KO)).toContain('src/local/README.ko.md');
  });
});

describe('zworkflow plugin manifest — version bump (T5)', () => {
  it('version is a semver above 2.5.0 (skill addition = minor bump)', () => {
    const { version } = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8'));
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const [major, minor] = String(version).split('.').map(Number);
    expect(major > 2 || (major === 2 && minor >= 6)).toBe(true);
  });
});
