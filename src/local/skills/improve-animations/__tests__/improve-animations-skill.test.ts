import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const LICENSES_DIR = resolve(SKILL_ROOT, 'LICENSES');
const SUPPORT_FILES = ['AUDIT.md', 'PLAN-TEMPLATE.md'];
/** Upstream skill names that are not installed under that name in soma-work. */
const UPSTREAM_ONLY = [
  'animate',
  'emil-design-eng',
  'review-animations',
  'animate-expo',
  'prototype',
  'pick-ui-library',
];

/** Splits SKILL.md into its YAML frontmatter (parsed — malformed YAML throws) and the body below it. */
function split(md: string): { fm: Record<string, unknown>; body: string } {
  const match = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { fm: {}, body: '' };
  return { fm: (parse(match[1]) ?? {}) as Record<string, unknown>, body: match[2] };
}

describe('local:improve-animations skill — vendored contract', () => {
  const md = existsSync(SKILL_MD) ? readFileSync(SKILL_MD, 'utf8') : '';
  const { fm, body } = split(md);
  const attribution = body.split('\n').find((l) => l.startsWith('Vendored from ')) ?? '';

  it('frontmatter is valid YAML: name, an EN/KO trigger description within 1024 chars, allowed-tools, version, license', () => {
    expect(md).not.toBe('');
    expect(fm.name).toBe('improve-animations');
    expect(typeof fm.description).toBe('string');
    const description = fm.description as string;
    expect(description).toMatch(/Triggers on /);
    expect(description).toMatch(/[가-힣]/);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(fm['allowed-tools']).toBe('Read, Grep, Glob, Write, Bash');
    expect(fm.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fm.license).toBe('MIT');
  });

  it('the body carries the upstream instructions (checked apart from the description)', () => {
    for (const marker of [
      /\*\*Never modify source code\.\*\*/,
      /^### Phase 1 — Recon \(always first\)$/m,
      /^### Phase 4 — Write plans$/m,
      /\[PLAN-TEMPLATE\.md\]\(PLAN-TEMPLATE\.md\)/,
    ])
      expect(body).toMatch(marker);
  });

  it('keeps the scope paragraph and drops the greeting-only reply of the upstream Initial Response', () => {
    expect(body).toMatch(/It does ONE thing: survey animation and motion code/);
    expect(body).not.toMatch(/## Initial Response/);
    expect(body).not.toMatch(/respond only with/i);
  });

  it('maps every upstream-only skill name the body mentions to a local one (or says it is not vendored)', () => {
    const rest = body.replace(attribution, '');
    for (const n of UPSTREAM_ONLY) if (rest.includes(`\`${n}\``)) expect(attribution, n).toContain(`\`${n}\``);
    expect(fm.description as string).not.toMatch(
      /\b(review-animations|emil-design-eng|animate-expo|pick-ui-library)\b/,
    );
  });

  it("writes plans to the repository's own plan directory (soma-work: docs/current/plans/animations/)", () => {
    expect(body).toMatch(/\*\*Plan location \(local\)\.\*\* Where the repository names its own place for plans/);
    expect(body).toMatch(/`docs\/current\/plans\/animations\/`/);
  });

  it('the execute variant reviews against review-motion', () => {
    expect(body).toMatch(/^\| `execute <plan>`.*`review-motion`/m);
  });

  it('its supporting files exist and are linked from the body', () => {
    for (const f of SUPPORT_FILES) {
      expect(existsSync(resolve(SKILL_ROOT, f)), f).toBe(true);
      expect(body).toContain(`(${f})`);
    }
  });

  it('links its attribution; LICENSES/ carries the upstream MIT license and a NOTICE pinned to a commit', () => {
    expect(attribution).toMatch(/\[`LICENSES\/NOTICE\.md`\]\(\.\/LICENSES\/NOTICE\.md\)/);
    const notice = readFileSync(resolve(LICENSES_DIR, 'NOTICE.md'), 'utf8');
    expect(notice).toMatch(/emilkowalski\/skills/);
    expect(notice).toMatch(/MIT/);
    expect(notice).toMatch(/[0-9a-f]{40}/);
    expect(notice).toMatch(/^## Local changes$/m);
    const mit = readFileSync(resolve(LICENSES_DIR, 'emilkowalski-skills-MIT.txt'), 'utf8');
    expect(mit).toMatch(/Permission is hereby granted, free of charge/);
  });
});
