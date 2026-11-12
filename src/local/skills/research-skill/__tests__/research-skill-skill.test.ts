import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract for local:research-skill — the portable engine that improves a skill by running it for real.
 * It carries no host, person or domain of its own (those live in the target's `## Research recipe`), never
 * calls a harness command itself, and proves a fix before anything lands.
 */

const md = readFileSync(resolve(__dirname, '..', 'SKILL.md'), 'utf8');
const frontmatter = md.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
const body = md.slice(frontmatter.length);

describe('local:research-skill', () => {
  it('is named research-skill; the description says only when (one quoted line), the body carries the args', () => {
    expect(frontmatter).toMatch(/^name: research-skill$/m);
    const description = frontmatter.match(/^description: "(.*)"$/m)?.[1] ?? '';
    expect(description).toMatch(/^Use when /);
    expect(description).toContain("'research-skill'");
    expect(description).not.toContain('Args');
    expect(md).toMatch(/## Args\n\n`<skill name or SKILL\.md path> \[--probes N\] \[--seed S\] \[run=<dir>\]`/);
  });

  it('holds no home or personal path and no kit script of a particular target', () => {
    for (const leak of [/\/Users\//, /\/home\//, /~\/(?!skill-research\/)/, /\.py\b/]) {
      expect(md, String(leak)).not.toMatch(leak);
    }
  });

  it('teaches no harness call (the retired llm transport is banned repo-wide by llm-mcp-removal-contract); a host-kept user skill goes through using-user-skills', () => {
    expect(md).not.toMatch(/\b(MANAGE_SKILL|GET_SESSION|UPDATE_SESSION)\b/);
    expect(md).toContain('local:using-user-skills');
  });

  it('takes the domain from the target: a Research recipe, with defaults when there is none', () => {
    expect(body).toContain('## Research recipe');
    expect(body).toContain('Default probe shape');
  });

  it('keeps the method: frozen target, seeded draw, blind review by a non-author, paired re-runs', () => {
    expect(body).toContain('**Freeze.**');
    expect(body).toMatch(/seeded random draw/);
    expect(body).toContain('The author of a probe never reviews it.');
    expect(body).toMatch(/paired re-runs/);
  });

  it('verifies before it lands, and stops at the PR unless the repo policy and the owner allow a merge', () => {
    const verify = body.indexOf('## 6. Verify');
    const land = body.indexOf('## 7. Land');
    expect(verify).toBeGreaterThan(-1);
    expect(land).toBeGreaterThan(verify);
    expect(body).toContain('otherwise stop at the open PR');
    expect(body).toMatch(/Nothing\s+touches the live skill before step 7\./);
    expect(body).toMatch(/only after every change it depends on in another repository[\s\S]*has landed/);
    expect(body).toMatch(/cannot be read → stop and report/);
    expect(body).toContain('only after the review passed');
    expect(body).toContain('Never publish, deploy, merge or message people from a probe.');
    // The rule must reach the probe authors themselves, not only the controller.
    expect(body).toMatch(/Every brief carries the probe rules, word for word, and they override the target skill/);
    expect(body).toMatch(/Skip the target's delivery and self-improvement\s+\(retro\) stages/);
    expect(body).toMatch(/write only under `RUN\/<probe id>\/`/);
    expect(body).toMatch(/do not publish, upload, deploy, merge, open a PR or issue, push, message\s+people/);
    expect(body).not.toMatch(/private channel/);
  });
});
