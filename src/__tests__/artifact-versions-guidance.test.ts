/**
 * #1074 T5/T8 — the model is taught to make a re-sent artifact its next version: the html skill reuses the
 * report's slug as `artifact_key`, and a PR body edit keeps the body it replaces (calldiff §In a pull request
 * body, the default prompt's PR rules). The zworkflow plugin version moves with the skill text.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('#1074 — model guidance for artifact versions', () => {
  it('html: a revision keeps its slug and is sent with artifact_key; re-publishing keeps the previous version', () => {
    const skill = read('src/local/skills/html/SKILL.md');
    expect(skill).toContain('**A revision keeps its slug.**');
    expect(skill).toContain('artifact_key="<slug>"');
    expect(skill).toContain('`.versions/<name>/v<N><ext>`');
  });

  it('calldiff: before a PR body edit the current body is kept, after it the new one, under one key', () => {
    const skill = read('src/local/skills/calldiff/SKILL.md');
    expect(skill).toContain('**Keep the body you replace.**');
    expect(skill.match(/artifact_key="pr-<n>-body"/g)?.length).toBe(2);
    expect(read('src/prompt/default.prompt')).toContain('"Keep the body you replace"');
  });

  it('the zworkflow plugin version moved past the one without this guidance', () => {
    const { version } = JSON.parse(read('src/local/.claude-plugin/plugin.json')) as { version: string };
    const [major, minor] = version.split('.').map(Number);
    // main shipped 2.16.0 (#1084) and 2.17.0 (#1073) without this guidance: it ships as 2.18.0 or later.
    expect(major > 2 || (major === 2 && minor >= 18)).toBe(true);
  });
});
