import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const REFERENCE_DIR = resolve(SKILL_ROOT, 'reference');
const LICENSES_DIR = resolve(SKILL_ROOT, 'LICENSES');

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

/** The html driver-mode adapter: everything between the local-additions heading and the next `## ` heading. */
function adapterSection(md: string): string {
  const start = md.search(/^## soma-work local additions/m);
  if (start === -1) return '';
  const rest = md.slice(start + 3);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('local:impeccable skill — vendored docs-only contract', () => {
  it('SKILL.md frontmatter names the skill and keeps the upstream Apache-2.0 license', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
    const fm = parseFrontmatter(readFileSync(SKILL_MD, 'utf8'));
    expect(fm.name).toBe('impeccable');
    expect(fm.license).toMatch(/Apache/);
    expect((fm.description ?? '').toLowerCase()).toMatch(/design|critique|audit|polish/);
  });

  it('keeps the upstream command surface (modes + command table)', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    for (const mode of ['Persuade', 'Operate', 'Read', 'Experience']) expect(md).toContain(`**${mode}:**`);
    for (const cmd of ['shape', 'critique', 'audit', 'polish', 'typeset', 'layout', 'colorize', 'quieter', 'bolder']) {
      expect(md).toMatch(new RegExp(`\\| \`${cmd}`));
    }
  });

  it('every reference/*.md linked from SKILL.md ships', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    const links = [...md.matchAll(/\]\((reference\/[a-z0-9.-]+\.md)(?:#[^)]*)?\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(20);
    for (const rel of new Set(links)) expect(existsSync(resolve(SKILL_ROOT, rel)), rel).toBe(true);
    for (const f of ['craft-floor.md', 'mode-read.md', 'mode-persuade.md', 'mode-operate.md', 'critique.md']) {
      expect(existsSync(resolve(REFERENCE_DIR, f)), f).toBe(true);
    }
    expect(readdirSync(resolve(REFERENCE_DIR, 'degraded')).length).toBeGreaterThanOrEqual(4);
  });

  it('ships no executable runtime: no binary-downloading launcher, no live-browser bundle, no agents', () => {
    expect(existsSync(resolve(SKILL_ROOT, 'scripts'))).toBe(false);
    expect(existsSync(resolve(SKILL_ROOT, 'agents'))).toBe(false);
  });

  it('declares a no-question html driver-mode adapter with a positive read list', () => {
    const adapter = adapterSection(readFileSync(SKILL_MD, 'utf8'));
    expect(adapter.length).toBeGreaterThan(0);
    // Positive enumeration: the adapter names exactly what to read.
    expect(adapter).toMatch(/craft-floor\.md/);
    expect(adapter).toMatch(/mode-read\.md/);
    expect(adapter).toMatch(/mode-persuade\.md/);
    // And what never runs on the html critical path.
    expect(adapter).toMatch(/new-work\.md/);
    expect(adapter).toMatch(/routing\.md/);
    expect(adapter).toMatch(/concept-seed/);
    expect(adapter).toMatch(/launcher/i);
    expect(adapter).toMatch(/never ask|no questions|do not ask/i);
    // Honest labelling of what is unsupported in soma-work.
    for (const cmd of ['live', 'generate', 'hooks', 'pin', 'doctor']) expect(adapter).toMatch(new RegExp(`\`${cmd}\``));
    expect(adapter).toMatch(/document-based|문서 기반/i);
  });

  it('LICENSES carries the Apache-2.0 text and a NOTICE with upstream commit + ehmo MIT attribution', () => {
    const files = readdirSync(LICENSES_DIR).map((f) => f.toLowerCase());
    expect(files.some((f) => f.includes('apache'))).toBe(true);
    const notice = readFileSync(resolve(LICENSES_DIR, 'NOTICE.md'), 'utf8');
    expect(notice).toMatch(/pbakaus\/impeccable/);
    expect(notice).toMatch(/3671d50f/);
    expect(notice).toMatch(/ehmo\/platform-design-skills/);
    expect(notice).toMatch(/Local changes/i);
  });
});
