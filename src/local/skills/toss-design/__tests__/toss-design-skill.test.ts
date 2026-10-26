import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const THEMES_INDEX = resolve(SKILL_ROOT, 'themes', 'index.json');

const REFERENCE_SECTIONS = [
  '## Vibe (one line)',
  '## Color Palette',
  '## Typography',
  '## Layout & Grid',
  '## Motion & Interaction',
  '## Imagery & Texture',
  '## Tone / Mood',
  '## Signature Techniques to Reproduce',
  '## Do / Don',
  '## Implementation Notes',
];

const REQUIRED_SEMANTIC_TOKENS = [
  '--color-primary',
  '--color-on-primary',
  '--color-primary-text',
  '--color-bg',
  '--color-text',
  '--color-text-sub',
  '--color-border',
  '--color-danger',
  '--font-sans',
];

interface ThemeEntry {
  name: string;
  default?: boolean;
  accent: string;
  tokens: string;
  design: string;
}

function parseFrontmatter(md: string): Record<string, string> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    out[line.slice(0, colon).trim()] = line
      .slice(colon + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function themes(): ThemeEntry[] {
  return JSON.parse(readFileSync(THEMES_INDEX, 'utf8')).themes as ThemeEntry[];
}

/** Body of the first `<selector> { … }` block in a stylesheet. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return '';
  return css.slice(start, css.indexOf('}', start));
}

/**
 * `--name: value;` pairs, with var() resolution (two passes for chains).
 * Reads the default `:root` block; with `strictAa`, the opt-in
 * `:root[data-contrast="aa"]` overrides are layered on top.
 */
function tokens(css: string, strictAa = false): Map<string, string> {
  const map = new Map<string, string>();
  const source = block(css, ':root') + (strictAa ? block(css, ':root[data-contrast="aa"]') : '');
  for (const m of source.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi))
    map.set(m[1], m[2].replace(/\/\*.*$/s, '').trim());
  for (let pass = 0; pass < 2; pass++)
    for (const [k, v] of map) {
      const ref = v.match(/^var\((--[a-z0-9-]+)\)$/i);
      if (ref && map.has(ref[1])) map.set(k, map.get(ref[1]) as string);
    }
  return map;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe('local:toss-design skill — selectable Toss themes', () => {
  it('SKILL.md frontmatter names the skill and advertises both themes', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    const fm = parseFrontmatter(md);
    expect(fm.name).toBe('toss-design');
    expect(fm.description).toMatch(/toss-blue/);
    expect(fm.description).toMatch(/toss-black/);
    expect(md).toMatch(/tossmini-docs\.toss\.im\/tds-mobile/);
    // Programmatic mode for callers such as the html skill: no questions.
    expect(md).toMatch(/programmatic/i);
  });

  it('ships exactly two themes, toss-blue is the single default', () => {
    const list = themes();
    expect(list.map((t) => t.name).sort()).toEqual(['toss-black', 'toss-blue']);
    expect(list.filter((t) => t.default).map((t) => t.name)).toEqual(['toss-blue']);
  });

  it('each theme design.md follows the ui-ux named-reference template', () => {
    for (const t of themes()) {
      const md = readFileSync(resolve(SKILL_ROOT, t.design), 'utf8');
      expect(md).toMatch(new RegExp(`^# Design Reference — ${t.name}$`, 'm'));
      for (const section of REFERENCE_SECTIONS) expect(md, `${t.name}: ${section}`).toContain(section);
    }
  });

  it('toss-black is labelled a local derivative on a light canvas, not dark mode', () => {
    const md = readFileSync(resolve(SKILL_ROOT, 'themes', 'toss-black', 'design.md'), 'utf8');
    expect(md).toMatch(/local derivative|로컬 파생/i);
    expect(md).toMatch(/not (a )?dark mode|다크 모드가 아니/i);
  });

  it('both tokens.css expose the same semantic token names; only the brand accent differs', () => {
    const [blue, black] = ['toss-blue', 'toss-black'].map((n) =>
      tokens(readFileSync(resolve(SKILL_ROOT, 'themes', n, 'tokens.css'), 'utf8')),
    );
    const semantic = (m: Map<string, string>) => [...m.keys()].filter((k) => k.startsWith('--color-')).sort();
    expect(semantic(blue)).toEqual(semantic(black));
    for (const k of REQUIRED_SEMANTIC_TOKENS) {
      expect(blue.has(k), `toss-blue ${k}`).toBe(true);
      expect(black.has(k), `toss-black ${k}`).toBe(true);
    }
    expect(blue.get('--color-primary')?.toLowerCase()).not.toBe(black.get('--color-primary')?.toLowerCase());
    expect(blue.get('--color-bg')?.toLowerCase()).toBe(black.get('--color-bg')?.toLowerCase());
  });

  it('key colour pairs clear WCAG AA in both themes (TDS blue500 CTA is 3:1-class; strict mode lifts it to 4.5)', () => {
    for (const n of ['toss-blue', 'toss-black']) {
      const css = readFileSync(resolve(SKILL_ROOT, 'themes', n, 'tokens.css'), 'utf8');
      for (const strict of [false, true]) {
        const t = tokens(css, strict);
        const hex = (k: string) => {
          const v = t.get(k) ?? '';
          expect(v, `${n} ${k} must be a hex colour`).toMatch(/^#[0-9a-f]{3,8}$/i);
          return v;
        };
        const label = `${n}${strict ? ' [data-contrast=aa]' : ''}`;
        expect(contrast(hex('--color-text'), hex('--color-bg')), `${label} text/bg`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(hex('--color-text-sub'), hex('--color-bg')), `${label} text-sub/bg`).toBeGreaterThanOrEqual(
          4.5,
        );
        expect(
          contrast(hex('--color-primary-text'), hex('--color-bg')),
          `${label} primary-text/bg`,
        ).toBeGreaterThanOrEqual(4.5);
        // Default: TDS's own blue500 fill is a large-text / UI-component pair (≥ 3:1).
        // Strict AA mode must clear normal-text AA on the fill.
        expect(
          contrast(hex('--color-on-primary'), hex('--color-primary')),
          `${label} on-primary/primary`,
        ).toBeGreaterThanOrEqual(strict ? 4.5 : 3);
      }
    }
  });

  it('ships no Toss font files (proprietary) and names an open fallback', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    expect(md).toMatch(/Pretendard/);
    expect(existsSync(resolve(SKILL_ROOT, 'fonts'))).toBe(false);
  });
  it('strict AA mode passes every required pair in the shipped checker, TextField fill and overlays included', () => {
    for (const n of ['toss-blue', 'toss-black']) {
      const r = spawnSync(
        'python3',
        [
          resolve(SKILL_ROOT, 'scripts', 'contrast-check.py'),
          resolve(SKILL_ROOT, 'themes', n, 'tokens.css'),
          '--mode',
          'aa',
          '--strict',
        ],
        { encoding: 'utf8' },
      );
      expect(r.stdout, n).toMatch(/text-placeholder on field \(focus\)/);
      expect(r.status, `${n}\n${r.stdout}`).toBe(0);
    }
  });
});
