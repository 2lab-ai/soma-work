/**
 * research-skill run 2026-11-13 (diagram probes D1–D5, html probes H1–H5, report v1). Reviewers who had not made the
 * outputs found the same defects across inputs:
 * - every picture's title named its scope, not its finding, and every planned upload comment opened with the
 *   pipeline (sub-skill, template, driver) instead of the conclusion (owner complaint #1, weight ×2);
 * - a comparison with no keyword fell to the ARCHITECTURE tie rule and became a dark infrastructure diagram with
 *   invented arrows; a picture asked for inside a report shipped as a second, unlinked artifact;
 * - html sent every document that contains a table to the KPI dashboard template (owner complaint #2) and opened
 *   the page with KPI tiles instead of the answer, a map and a reading guide.
 * These pin the rules that answer them.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const skill = (name: string) => readFileSync(resolve(__dirname, '..', '..', name, 'SKILL.md'), 'utf-8');
const ref = (name: string, file: string) =>
  readFileSync(resolve(__dirname, '..', '..', name, 'references', file), 'utf-8');
const between = (md: string, from: string, to: string) =>
  md.slice(md.indexOf(from), md.indexOf(to, md.indexOf(from) + 1));

describe('diagram router — the reader decides, the picture shows it', () => {
  const md = skill('diagram');
  it('Step 0 comes before scoring: decision, conclusion title, relation', () => {
    expect(md.indexOf('## Step 0')).toBeGreaterThan(-1);
    expect(md.indexOf('## Step 0')).toBeLessThan(md.indexOf('## Classification'));
    expect(between(md, '## Step 0', '## Classification')).toMatch(/title: it states the finding/);
  });
  it('a request that matches no keyword is not sent to ARCHITECTURE by the tie rule', () => {
    expect(md).toMatch(/a request that scored nothing goes to Step 0's relation/);
  });
  it('COMPARISON is a category with its own layout, and wins over ARCHITECTURE for named options', () => {
    expect(md).toMatch(/\| \*\*COMPARISON\*\* \|/);
    expect(md).toContain('### COMPARISON');
    expect(md).toMatch(/COMPARISON wins over ARCHITECTURE/);
  });
  it('report mode: one rule overrides every upload step, the page is the one artifact (trinity R1)', () => {
    const rm = between(md, '**Report mode', '## Classification');
    expect(rm).toMatch(/overrides every upload step below/);
    expect(rm).toMatch(/hands over the\s+PNG path without uploading/);
    expect(rm).toMatch(/never holds the only copy/);
    expect(between(md, '### GENERAL', '### MIXED')).toMatch(/in report mode, hand the PNG path to the `html` skill/);
    expect(between(md, '### MIXED', '## Unclassifiable')).toMatch(/in report mode both go into the page/);
    const arch = skill('architecture-diagram');
    expect(between(arch, '### 8.', '### 9.')).toMatch(/In report mode skip this step/);
    const html = skill('html');
    expect(between(html, '### 0. Reader', '### 1. Read the catalog')).toMatch(/The page is the only upload/);
  });
  it('report mode: each branch hands over what it makes — Excalidraw a PNG, DRAWING its HTML sheet (trinity R2)', () => {
    const rm = between(md, '**Report mode', '## Classification');
    expect(rm).toMatch(/DRAWING hands over its HTML sheet/);
    expect(rm).toMatch(/srcdoc/);
    const dd = skill('dimensional-drawing');
    expect(between(dd, '## Delivery in soma-work', '\u0000')).toMatch(/In report mode skip steps 4 and 5/);
    expect(between(md, '## Anti-patterns', '## End turn')).toMatch(/separate images[^\n]*report mode/);
  });
  it('the router does not retry; its end line states the conclusion first', () => {
    expect(md).toMatch(/Do NOT retry at the router/);
    expect(between(md, '## End turn', '\u0000')).toMatch(/states the picture's conclusion/);
  });
  it('GENERAL resolves the JSON path before changing into the plugin folder', () => {
    const general = between(md, '### GENERAL', '### MIXED');
    expect(general).toContain('JSON="$(pwd)/diag-<slug>-<ts>.excalidraw"');
    expect(general).not.toMatch(/&& uv run python render_excalidraw\.py "\$\(pwd\)/);
  });
});

describe('architecture-diagram — readable, honest pictures', () => {
  const md = skill('architecture-diagram');
  it('the canvas title is the conclusion; inferred links are dashed and marked', () => {
    expect(between(md, '### 1.', '### 1.5')).toMatch(/canvas title — a finding/);
    expect(between(md, '### 1.', '### 1.5')).toContain('`추정`');
  });
  it('box text is slate-200, not the stroke colour that fails 4.5:1', () => {
    expect(md).toMatch(/Text inside a box: `strokeColor` `#e2e8f0`/);
    expect(md).not.toMatch(/\*\*or\*\* match the parent container's stroke color/);
    expect(ref('architecture-diagram', 'critic-checklist.md')).toMatch(/Every text inside a box is `#e2e8f0`/);
  });
  it('arrow labels are bound and carry a verb; multi-point arrows are not curved', () => {
    expect(md).toMatch(/Arrow labels: bound to their arrow/);
    expect(md).toMatch(/three or more points: `roundness: null`/);
  });
  it('the PNG check cannot pass on a stale image', () => {
    expect(between(md, '### 6.', '### 6.5')).toMatch(/Delete any PNG of the same name before Step 5 renders/);
  });
  it('one palette source per path: the dark table in SKILL.md, color-palette.md is the light one', () => {
    expect(ref('architecture-diagram', 'color-palette.md')).toMatch(/does \*\*not\*\* use it/);
  });
  it('the upload comment opens with the conclusion', () => {
    expect(between(md, '### 8.', '### 9.')).toContain('initial_comment="<the picture\'s conclusion, one line>');
  });
});

describe('html — the page opens with the answer', () => {
  const md = skill('html');
  it('Step 0 sets the reader, the decision, the answer and the asks before the template is chosen', () => {
    const step0 = between(md, '### 0. Reader, decision and first screen', '### 1. Read the catalog');
    expect(step0).toContain('data-first-screen="answer"');
    expect(step0).toContain('data-first-screen="map"');
    expect(step0).toContain('data-first-screen="guide"');
    expect(step0).toMatch(/true on its own/);
  });
  it('only a dataset goes to data-report; a document that contains tables does not', () => {
    expect(between(md, '### 2. Pick a template', '### 3.')).toMatch(/A document that \*\*contains\*\* tables/);
  });
  it('a template slot the content cannot fill is left out, not shown as [—]', () => {
    expect(md).toMatch(/A slot the content cannot fill by its shape is left out, not shown as `\[—\]`/);
  });
  it('Step 5 checks the first screen and a phone width', () => {
    const step5 = between(md, '### 5. Check the page', '### 6.');
    expect(step5).toContain('--first-screen');
    expect(step5).toContain('--width 390');
  });
  it('Step 6 ticks off the asks; Step 8 opens the comment with the answer and names the serving machine', () => {
    expect(between(md, '### 6. Validate the page', '### 7.')).toMatch(/\*\*The asks\.\*\*/);
    const step8 = between(md, '### 8. Upload the HTML to Slack', '### 9.');
    expect(step8).toMatch(/initial_comment="<Step 0 answer, one line>/);
    expect(step8).toMatch(/hostname -s/);
  });
  it('motion only with a job; no pulse on a historical number', () => {
    expect(md).toMatch(/only where a motion has a job/);
    expect(md).toMatch(/never on a historical count/);
  });
});
