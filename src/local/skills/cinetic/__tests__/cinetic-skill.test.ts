import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
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

describe('cinetic skill — a pinned loader for the upstream skill', () => {
  it('SKILL.md has frontmatter name cinetic, EN/KO triggers and a license line', () => {
    const fm = parseFrontmatter(read('SKILL.md'));
    expect(fm.name).toBe('cinetic');
    expect(fm.description).toMatch(/cinetic/);
    expect(fm.description).toMatch(/시네틱/);
    expect(fm.description).toMatch(/cinematic-film/);
    expect(fm.license).toMatch(/MIT/);
  });

  it('pins one upstream commit, the same in the installer and the notice', () => {
    const sh = read('scripts', 'install.sh');
    const pin = sh.match(/CINETIC_PIN:-([0-9a-f]{40})/)?.[1];
    expect(pin, 'install.sh pins a full commit').toBeDefined();
    expect(sh).toMatch(/github\.com\/Leonxlnx\/cinetic/);
    expect(read('LICENSES', 'NOTICE.md')).toContain(pin as string);
    expect(statSync(resolve(SKILL_ROOT, 'scripts', 'install.sh')).mode & 0o111).not.toBe(0);
  });

  it('carries the upstream MIT license and routes recordings to cinematic-film', () => {
    expect(existsSync(resolve(SKILL_ROOT, 'LICENSES', 'cinetic-MIT.txt'))).toBe(true);
    expect(read('LICENSES', 'cinetic-MIT.txt')).toMatch(/MIT License/);
    const md = read('SKILL.md');
    expect(md).toMatch(/cinematic-film/);
    expect(md).toMatch(/Remotion.*licen[cs]e/i);
  });

  it('loads through CLAUDE_PLUGIN_ROOT, never a runtime-root-relative runner command', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/export CLAUDE_PLUGIN_ROOT=/);
    expect(md).not.toMatch(/\b(?:npx\s+)?[A-Za-z0-9_.@/-]+\s+local\/[^\s"'`)]+/);
  });
});
