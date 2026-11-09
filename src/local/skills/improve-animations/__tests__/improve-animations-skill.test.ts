import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const LICENSES_DIR = resolve(SKILL_ROOT, 'LICENSES');
const SUPPORT_FILES: string[] = ['AUDIT.md', 'PLAN-TEMPLATE.md'];

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

describe('local:improve-animations skill — vendored contract', () => {
  const md = existsSync(SKILL_MD) ? readFileSync(SKILL_MD, 'utf8') : '';

  it('SKILL.md exists with name improve-animations, an EN/KO trigger description, version and license', () => {
    expect(md).not.toBe('');
    const fm = parseFrontmatter(md);
    expect(fm.name).toBe('improve-animations');
    expect(fm.description ?? '').toMatch(/Triggers on /);
    expect(fm.description ?? '').toMatch(/[가-힣]/);
    expect(fm.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fm.license).toBe('MIT');
  });

  it('carries the upstream substance', () => {
    for (const marker of [/[Aa]udit/, /[Pp]lan/]) expect(md).toMatch(marker);
  });

  it('never opens with a greeting-only reply (the upstream Initial Response is removed)', () => {
    expect(md).not.toMatch(/## Initial Response/);
    expect(md).not.toMatch(/respond only with/i);
  });

  it('links its attribution, and its supporting files exist', () => {
    expect(md).toMatch(/\[`LICENSES\/NOTICE\.md`\]\(\.\/LICENSES\/NOTICE\.md\)/);
    for (const f of SUPPORT_FILES) expect(existsSync(resolve(SKILL_ROOT, f)), f).toBe(true);
  });

  it('LICENSES/ carries the upstream MIT license and an attribution NOTICE', () => {
    const files = readdirSync(LICENSES_DIR).map((f) => f.toLowerCase());
    expect(files.some((f) => f.includes('notice'))).toBe(true);
    expect(files.some((f) => f.includes('mit'))).toBe(true);
    const notice = readFileSync(resolve(LICENSES_DIR, 'NOTICE.md'), 'utf8');
    expect(notice).toMatch(/emilkowalski\/skills/);
    expect(notice).toMatch(/MIT/);
    expect(notice).toMatch(/[0-9a-f]{40}/);
    const mit = readFileSync(resolve(LICENSES_DIR, 'emilkowalski-skills-MIT.txt'), 'utf8');
    expect(mit).toMatch(/Permission is hereby granted, free of charge/);
  });
});
