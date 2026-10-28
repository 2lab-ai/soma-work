import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const INDEX_JSON = resolve(SKILL_ROOT, 'references', 'index.json');

interface ReferenceEntry {
  name: string;
  path: string;
  default?: boolean;
  family?: string;
  tokens?: string;
}

function entries(): ReferenceEntry[] {
  return JSON.parse(readFileSync(INDEX_JSON, 'utf8')).references as ReferenceEntry[];
}

describe('local:ui-ux named reference registry', () => {
  it('has exactly one default, and it is still openai (the comparison baseline)', () => {
    const defaults = entries().filter((e) => e.default === true);
    expect(defaults.map((e) => e.name)).toEqual(['openai']);
  });

  it('every entry path resolves from the ui-ux skill root to an existing design.md', () => {
    for (const e of entries()) {
      const abs = resolve(SKILL_ROOT, e.path);
      expect(existsSync(abs), `${e.name} -> ${e.path}`).toBe(true);
      expect(readFileSync(abs, 'utf8')).toMatch(/^# Design Reference — /m);
      if (e.tokens) expect(existsSync(resolve(SKILL_ROOT, e.tokens)), `${e.name} tokens`).toBe(true);
    }
  });

  it('registers toss-blue and toss-black as pointers into the toss-design skill (single source, no copy)', () => {
    const byName = new Map(entries().map((e) => [e.name, e]));
    for (const name of ['toss-blue', 'toss-black']) {
      const e = byName.get(name);
      expect(e, name).toBeDefined();
      expect(e?.path).toBe(`../toss-design/themes/${name}/design.md`);
      expect(e?.tokens).toBe(`../toss-design/themes/${name}/tokens.css`);
      expect(e?.family).toBe('toss-design');
      expect(existsSync(resolve(SKILL_ROOT, 'references', name))).toBe(false);
    }
  });

  it('SKILL.md tells consumers to resolve references through the index path field', () => {
    const md = readFileSync(resolve(SKILL_ROOT, 'SKILL.md'), 'utf8');
    expect(md).toMatch(/toss-blue/);
    expect(md).toMatch(/toss-black/);
    expect(md).toMatch(/`path`/);
  });
});
