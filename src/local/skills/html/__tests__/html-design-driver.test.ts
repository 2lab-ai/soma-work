import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = resolve(SKILL_ROOT, '..');
const UIUX_ROOT = resolve(SKILLS_DIR, 'ui-ux');
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

  it('brand context is its own driver: the resolver is not run, so the registry default cannot override the brand', () => {
    const s34 = section(md(), /^### 3\.4\./m);
    expect(s34).toMatch(/#### Brand-context driver/);
    expect(s34).toMatch(/Rule 3 → the \*\*brand-context driver\*\*[^.]*\. Do not run the resolver/);
    expect(s34).toMatch(/design-context\.md/);
    expect(s34).toMatch(/driver=brand/);
  });

  it('Step 6 checks the fonts actually used, not only the ones loaded', () => {
    const text = md();
    expect(text).toMatch(/`fonts used:/);
    expect(text).toMatch(/reads `unknown`/);
    const renderer = readFileSync(resolve(SKILL_ROOT, 'renderer', 'render.mjs'), 'utf8');
    expect(renderer).toMatch(/CSS\.getPlatformFontsForNode/);
    expect(renderer).toMatch(/fonts used:/);
  });
});

describe('local:html — the Step 3.4 resolver snippet, executed', () => {
  const snippet = () => {
    const m = md().match(/<<'RESOLVE'\n([\s\S]*?)\nRESOLVE/);
    expect(m, 'Step 3.4 must carry the RESOLVE heredoc').not.toBeNull();
    return (m as RegExpMatchArray)[1];
  };
  const run = (design: string) =>
    spawnSync('python3', ['-', UIUX_ROOT, design], { input: snippet(), encoding: 'utf8' });

  it('default resolves to the registry default (openai) through its index path', () => {
    const r = run('default');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('driver=reference');
    expect(r.stdout).toContain('reference=openai');
    const designMd = r.stdout.match(/^design_md=(.+)$/m)?.[1] ?? '';
    expect(existsSync(designMd)).toBe(true);
  });

  it('toss themes resolve into the toss-design skill with tokens', () => {
    for (const name of ['toss-blue', 'toss-black']) {
      const r = run(name);
      expect(r.status, name).toBe(0);
      const designMd = r.stdout.match(/^design_md=(.+)$/m)?.[1] ?? '';
      const tokens = r.stdout.match(/^tokens_css=(.+)$/m)?.[1] ?? '';
      expect(designMd).toBe(resolve(SKILLS_DIR, 'toss-design', 'themes', name, 'design.md'));
      expect(existsSync(tokens), `${name} tokens`).toBe(true);
      expect(r.stdout).toContain('family=toss-design');
    }
  });

  it('impeccable selects the methodology driver; an unknown value exits non-zero with the valid list', () => {
    expect(run('impeccable').stdout.trim()).toBe('driver=impeccable');
    const bad = run('no-such-design');
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/unknown design=no-such-design; valid: default, impeccable, openai/);
  });
});
