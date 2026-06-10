import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const RENDERERS_MD = resolve(SKILL_ROOT, 'references', 'renderers.md');

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

describe('local:structurize skill — RED contract', () => {
  it('SKILL.md exists', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('frontmatter has name: structurize and trigger keywords in description', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    const fm = parseFrontmatter(md);
    expect(fm.name).toBe('structurize');
    const desc = fm.description ?? '';
    // The skill's reason-to-exist: lossless structuring, not summarization.
    expect(desc).toMatch(/구조화/);
    expect(desc).toMatch(/무손실/);
  });

  it('references/renderers.md exists at the path SKILL.md points to', () => {
    expect(existsSync(RENDERERS_MD)).toBe(true);
    const md = readFileSync(SKILL_MD, 'utf8');
    expect(md).toMatch(/references\/renderers\.md/);
  });

  it('SKILL.md encodes the engine-before-renderer rule and lossless constraint', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    // Renderer choice must follow structure — the reverse direction is forbidden.
    expect(md).toMatch(/렌더러를 먼저 정하고 구조를 거기 맞추는 역방향은 금지/);
    // Lossless: details get an address, they are never dropped.
    expect(md).toMatch(/무손실/);
  });

  it('SKILL.md contains the 7-stage engine (0–6) and a failure-mode checklist', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    for (const heading of [
      /### 0\. 진단/,
      /### 1\. 분해/,
      /### 2\. 핵-위성 판정/,
      /### 3\. 관계 부여/,
      /### 4\. 계층 조립/,
      /### 5\. 암묵 구조 승격/,
      /### 6\. 무손실 검증/,
    ]) {
      expect(md).toMatch(heading);
    }
    expect(md).toMatch(/## 실패 모드 체크리스트/);
  });

  it('renderers.md covers all four non-default renderers', () => {
    const md = readFileSync(RENDERERS_MD, 'utf8');
    expect(md).toMatch(/<details/); // HTML fold tree template
    expect(md).toMatch(/flowchart TD/); // Mermaid flowchart
    expect(md).toMatch(/graph LR/); // Mermaid relation graph
    expect(md).toMatch(/갈리는 조건/); // comparison table contract
    expect(md).toMatch(/계층 제목 문서/); // heading-document rewrite
  });
});
