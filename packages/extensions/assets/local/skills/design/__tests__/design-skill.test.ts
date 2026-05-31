import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const REFERENCES_DIR = resolve(SKILL_ROOT, 'references');
const LICENSES_DIR = resolve(SKILL_ROOT, 'LICENSES');

// The five distilled references are the entire reason this skill exists:
// design knowledge, no video/audio/pptx machinery from upstream huashu-design.
const REQUIRED_REFERENCES = [
  'design-styles.md',
  'design-context.md',
  'content-guidelines.md',
  'critique-guide.md',
  'workflow.md',
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

describe('local:design skill — RED contract', () => {
  it('SKILL.md exists', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('SKILL.md frontmatter has name: design and an HTML-focused design description', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    const fm = parseFrontmatter(md);
    expect(fm.name).toBe('design');
    const desc = (fm.description ?? '').toLowerCase();
    expect(desc).toMatch(/design/);
    // The skill's reason-to-exist: pick a direction + kill AI slop for HTML output.
    expect(desc).toMatch(/slop|style|direction/);
  });

  it.each(REQUIRED_REFERENCES)('references/%s exists (distilled design knowledge)', (name) => {
    expect(existsSync(resolve(REFERENCES_DIR, name))).toBe(true);
  });

  it('SKILL.md encodes the anti-AI-slop hard rules and a deterministic style selector', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    expect(md).toMatch(/anti-ai-slop|anti-slop/i);
    // Programmatic mode must NOT ask the user — that contract is what the html
    // skill relies on when calling in mid-generation.
    expect(md).toMatch(/programmatic mode/i);
    expect(md).toMatch(/do not ask|never ask|no questions/i);
    // The 20-philosophy library is the no-context fallback.
    expect(md).toMatch(/20[- ]philosophy|style library|Pentagram/i);
  });

  it('LICENSES/ contains MIT attribution for upstream huashu-design', () => {
    expect(existsSync(LICENSES_DIR)).toBe(true);
    const files = readdirSync(LICENSES_DIR);
    const hasUpstream = files.some((f) => f.toLowerCase().includes('huashu-design'));
    expect(hasUpstream, `expected huashu-design attribution under ${LICENSES_DIR}`).toBe(true);
  });
});
