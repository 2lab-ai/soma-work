import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = resolve(SKILL_ROOT, '..');
const md = () => readFileSync(resolve(SKILL_ROOT, 'SKILL.md'), 'utf8');

/** Text of the section that starts with `heading` and runs to the next `### ` heading. */
function section(text: string, heading: RegExp): string {
  const start = text.search(heading);
  if (start === -1) return '';
  const rest = text.slice(start + 4);
  const next = rest.search(/^### /m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('local:html — deterministic design driver (`design=` input)', () => {
  it('Inputs table has a `design` row naming default, impeccable and the toss themes', () => {
    const row = md()
      .split('\n')
      .find((l) => /^\| \*\*Design\*\*/.test(l));
    expect(row, 'expected an Inputs row starting with | **Design**').toBeDefined();
    for (const v of ['default', 'impeccable', 'toss-blue', 'toss-black']) expect(row).toContain(`\`${v}\``);
  });

  it('Step 3.4 resolves the driver in a fixed order and fails on unknown values', () => {
    const s34 = section(md(), /^### 3\.4\./m);
    expect(s34).toMatch(/explicit `design=`/i);
    const order = ['explicit `design=`', 'user-named reference', 'brand context', 'registry default'].map((k) =>
      s34.toLowerCase().indexOf(k.toLowerCase()),
    );
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(s34).toMatch(/unknown[^.]*(stop|fail)/i);
    expect(s34).toMatch(/never (silently )?fall back/i);
  });

  it('reference files are resolved through the index `path` field, not a hard-coded directory', () => {
    const text = md();
    expect(text).not.toMatch(/references\/\$REF\/design\.md/);
    expect(section(text, /^### 3\.4\./m)).toMatch(/\['path'\]|`path` field/);
  });

  it('impeccable driver: reads the vendored skill adapter, runs neither the ui-ux engine nor the design layer', () => {
    const s34 = section(md(), /^### 3\.4\./m);
    expect(s34).toMatch(/skills\/impeccable\/SKILL\.md/);
    expect(s34).toMatch(/soma-work local additions/);
    const s35 = section(md(), /^### 3\.5\./m);
    expect(s35).toMatch(/impeccable[^.]*(skip|off|does not run)/i);
    expect(existsSync(resolve(SKILLS_DIR, 'impeccable', 'SKILL.md'))).toBe(true);
  });

  it('toss drivers: load the theme tokens and the toss-design component recipes', () => {
    const s34 = section(md(), /^### 3\.4\./m);
    expect(s34).toMatch(/tokens\.css|`tokens` field/);
    expect(s34).toMatch(/skills\/toss-design\/SKILL\.md/);
    expect(existsSync(resolve(SKILLS_DIR, 'toss-design', 'SKILL.md'))).toBe(true);
  });

  it('removes the unreachable design style-selector fallback (dead branch)', () => {
    expect(md()).not.toMatch(/Only fall back to the `design`\s+skill's own style selector/);
  });

  it('the audit comment records driver and reference', () => {
    expect(md()).toMatch(/<!-- ui-ux: driver=/);
  });

  it('the selected system owns font, spacing, radius and material; shared floor is accessibility, reduced motion, content', () => {
    const text = md();
    expect(text).toMatch(/selected (design )?system owns/i);
    expect(text).toMatch(/accessibility[^.]*reduced[- ]motion[^.]*content/i);
  });
});
