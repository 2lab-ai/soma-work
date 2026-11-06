import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #950 — the owner's go-ahead re-arms the one automatic error resume (#948).
 *
 * Every owner action that lets a goal act again (the cap question's Continue
 * from the DM or the dashboard, `goal resume`, a goal edit, Delete-advance)
 * reaches the loop through ONE hook: `setGoalLoopResumeHandler` in `index.ts`.
 * The re-arm lives there, so no caller can forget it.
 */
const source = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

describe('goal resume hook wiring (#950)', () => {
  it('re-arms the error resume in the one hook every owner go-ahead runs through', () => {
    const start = source.indexOf('setGoalLoopResumeHandler((sessionKey: string) => {');
    expect(start, 'the resume hook is registered in index.ts').toBeGreaterThan(-1);
    // The hook body ends where the next wiring statement starts.
    const body = source.slice(start, source.indexOf('slackHandler.setGoalLoopActingProbe', start));
    expect(body).toContain('slackHandler.rearmGoalErrorResume(sessionKey)');
    expect(body.indexOf('rearmGoalErrorResume')).toBeLessThan(body.indexOf('goalLoopController.onTurnSettled'));
  });
});
