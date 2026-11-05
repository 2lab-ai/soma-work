/**
 * #927 — the restart resume must not repeat an outside action that already took effect.
 *
 * A restart can cut a turn after a push, a `gh pr create`, a comment or a deploy ran but before the model saw its
 * result. The resume prompt (`src/prompt/restart.prompt`, sent by `autoResumeSession` for a restart and for an error
 * auto-retry — `auto-resume.test.ts` pins that the file is what is sent) must make the model check git and GitHub
 * before it repeats one, on every resume path — including the "I remember what I was doing" shortcut.
 * Source: dsh-superagent docs/003-execution.md §Restart ("check its directory, git history and GitHub before repeating
 * any outside action").
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompt', 'restart.prompt'), 'utf-8');

describe('restart.prompt — outside actions are checked before they are repeated (#927)', () => {
  it('names the outside actions and asks whether each already happened', () => {
    expect(PROMPT).toContain('before you repeat any outside action');
    // The whole list, so a dropped action fails here (a bare 'PR' or 'push' would match anywhere).
    expect(PROMPT).toContain(
      'a push, a PR or issue you create, a comment or review reply, a merge, a deploy, a message',
    );
  });

  it('says where to look: the working tree, its history, the remote branch, the branch PRs and the latest comments', () => {
    expect(PROMPT).toContain('git status');
    expect(PROMPT).toContain('git log');
    expect(PROMPT).toContain('remote branch');
    expect(PROMPT).toContain('gh pr list --head');
    expect(PROMPT).toContain('latest comments');
  });

  it('forbids the duplicate outright', () => {
    expect(PROMPT).toContain('Never open a second PR');
  });

  it('states the check before the steps, so every resume path meets it', () => {
    const rule = PROMPT.indexOf('before you repeat any outside action');
    const firstStep = PROMPT.search(/^0\. /m);
    expect(rule).toBeGreaterThanOrEqual(0);
    expect(firstStep).toBeGreaterThan(rule);
  });

  it('the "clearly remember" shortcut still runs the check', () => {
    const shortcut = PROMPT.split('\n').find((line) => line.includes('clearly remember'));
    expect(shortcut).toBeDefined();
    expect(shortcut).toContain('check above');
  });
});
