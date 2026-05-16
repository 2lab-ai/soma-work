import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const RENDERER = resolve(SKILL_ROOT, 'renderer', 'render.mjs');
const INDEX_JSON = resolve(SKILL_ROOT, 'templates', 'index.json');
const TEMPLATES_DIR = resolve(SKILL_ROOT, 'templates', 'skills');
const LICENSES_DIR = resolve(SKILL_ROOT, 'LICENSES');

// The 8 curated v1 templates — frozen to keep the auto-pick rubric stable.
// Adding more templates is fine, but these 8 must stay so the classifier
// in SKILL.md keeps working without a rewrite.
const REQUIRED_TEMPLATES = [
  'data-report',
  'meeting-notes',
  'resume-modern',
  'deck-simple',
  'eng-runbook',
  'saas-landing',
  'social-x-post-card',
  'doc-kami-parchment',
] as const;

interface TemplateIndexEntry {
  name: string;
  description?: string;
  surface?: string;
  viewport?: {
    width: number;
    height: number;
    fullPage?: boolean;
    selector?: string;
  };
}

function parseFrontmatter(md: string): Record<string, string> {
  // Minimal YAML frontmatter parser (string values + simple keys).
  // The real SKILL.md format only uses flat string fields, so a full YAML
  // parser is overkill and adds a runtime dep we don't otherwise need.
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

describe('local:html skill — RED contract', () => {
  it('SKILL.md exists', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('SKILL.md frontmatter has name: html and description covering HTML+PNG+Slack', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    const fm = parseFrontmatter(md);
    expect(fm.name).toBe('html');
    expect(fm.description).toBeDefined();
    const desc = (fm.description ?? '').toLowerCase();
    expect(desc).toMatch(/html/);
    expect(desc).toMatch(/png/);
    // Slack upload is the whole point — must be advertised in the trigger description.
    expect(desc).toMatch(/slack|thread|upload|file/);
  });

  it('SKILL.md encodes the global anti-AI-slop design discipline', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    // These four constraints come straight from html-anything's hard rules.
    // They are what stops the model from freestyling ugly defaults.
    expect(md).toMatch(/CJK|Noto Sans SC|source-han/i);
    expect(md).toMatch(/8\s*px|baseline grid/i);
    expect(md).toMatch(/contrast.*4\.5|4\.5.*contrast/i);
    expect(md).toMatch(/no lorem|real data|must use.*data/i);
  });

  it('renderer/render.mjs exists and uses Playwright Chromium', () => {
    expect(existsSync(RENDERER)).toBe(true);
    const src = readFileSync(RENDERER, 'utf8');
    expect(src).toMatch(/playwright/);
    expect(src).toMatch(/chromium/);
  });

  it('templates/index.json exists', () => {
    expect(existsSync(INDEX_JSON)).toBe(true);
  });

  it('templates/index.json has exactly the 8 curated v1 templates', () => {
    const raw = readFileSync(INDEX_JSON, 'utf8');
    const parsed = JSON.parse(raw) as { templates: TemplateIndexEntry[] };
    expect(Array.isArray(parsed.templates)).toBe(true);
    const names = parsed.templates.map((t) => t.name).sort();
    expect(names).toEqual([...REQUIRED_TEMPLATES].sort());
  });

  it.each(REQUIRED_TEMPLATES)('templates/skills/%s/SKILL.md exists', (name) => {
    expect(existsSync(resolve(TEMPLATES_DIR, name, 'SKILL.md'))).toBe(true);
  });

  it('every index entry points to an existing template SKILL.md', () => {
    const parsed = JSON.parse(readFileSync(INDEX_JSON, 'utf8')) as {
      templates: TemplateIndexEntry[];
    };
    for (const entry of parsed.templates) {
      const path = resolve(TEMPLATES_DIR, entry.name, 'SKILL.md');
      expect(existsSync(path), `missing template: ${entry.name} at ${path}`).toBe(true);
    }
  });

  it('templates with non-default geometry declare viewport overrides', () => {
    const parsed = JSON.parse(readFileSync(INDEX_JSON, 'utf8')) as {
      templates: TemplateIndexEntry[];
    };
    const byName = new Map(parsed.templates.map((t) => [t.name, t]));
    // These three are not document-shaped and need explicit canvas sizing.
    // Default 1200×1600 fullPage would produce wrong aspect for decks and cards.
    expect(byName.get('deck-simple')?.viewport).toBeDefined();
    expect(byName.get('social-x-post-card')?.viewport).toBeDefined();
    expect(byName.get('data-report')?.viewport).toBeDefined();
  });

  it('LICENSES/ contains Apache-2.0 attribution for html-anything', () => {
    expect(existsSync(LICENSES_DIR)).toBe(true);
    const files = readdirSync(LICENSES_DIR);
    const hasUpstream = files.some((f) => f.toLowerCase().includes('html-anything'));
    expect(hasUpstream, `expected html-anything attribution under ${LICENSES_DIR}`).toBe(true);
  });
});
