/**
 * RED (autoz): mode-aware `evaluateToolPolicy` (SSOT-1/2/3).
 *
 * The policy context gains a `mode: PermissionMode`. Behaviour after the
 * (unchanged) hard-deny tier:
 *   • legacy → `pass` (defer to the SDK per-tool prompt — the old accept/reject).
 *   • bypass → `allow` everything governed (unsafe: even a dangerous Bash, no ask).
 *   • auto   → non-dangerous Bash / native tools `allow`; a dangerous-rule hit
 *              becomes the new `classify` decision (the async hook then consults
 *              the safety classifier). Hard denies still win in every mode.
 */

import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { evaluateToolPolicy, type ToolPolicyContext } from '../policy/tool-policy';

const USER = 'U0AUTOMODE1';
const OTHER = 'U0OTHERUSR2';
const SAFE = `/tmp/${USER}/x.txt`;
const SENSITIVE = `${os.homedir()}/.ssh/id_rsa`;

function ctx(mode: 'auto' | 'bypass' | 'legacy', over: Partial<ToolPolicyContext> = {}): ToolPolicyContext {
  return {
    user: USER,
    isAdmin: false,
    mode,
    aborted: false,
    isDangerousRuleDisabled: () => false,
    handoffContext: undefined,
    checkMcpToolPermission: () => null,
    checkEnvSkillPermission: () => null,
    ...over,
  } as ToolPolicyContext;
}

describe('evaluateToolPolicy — auto mode (default)', () => {
  it('non-dangerous Bash → allow', () => {
    expect(evaluateToolPolicy('Bash', { command: 'ls -la' }, ctx('auto')).decision).toBe('allow');
  });

  it('dangerous Bash → classify (defer to safety classifier), carrying matched rule ids', () => {
    const r = evaluateToolPolicy('Bash', { command: 'rm -rf /tmp/dir' }, ctx('auto'));
    expect(r.decision).toBe('classify');
    expect(r.matchedRuleIds).toContain('rm-recursive');
  });

  it('dangerous Bash with the rule session-disabled → allow (not classify)', () => {
    const r = evaluateToolPolicy(
      'Bash',
      { command: 'rm -rf /tmp/dir' },
      ctx('auto', { isDangerousRuleDisabled: () => true }),
    );
    expect(r.decision).toBe('allow');
  });

  it('native non-Bash tools → allow', () => {
    expect(evaluateToolPolicy('Write', { file_path: SAFE }, ctx('auto')).decision).toBe('allow');
    expect(evaluateToolPolicy('Read', { file_path: SAFE }, ctx('auto')).decision).toBe('allow');
  });

  it('hard deny still wins over auto (cross-user Bash)', () => {
    expect(evaluateToolPolicy('Bash', { command: `cat /tmp/${OTHER}/s` }, ctx('auto')).decision).toBe('deny');
  });
});

// The hosts run on case-insensitive APFS: `RM` is /bin/rm, `SSH` is /usr/bin/ssh,
// and a lowercased /tmp/<id> is that user's directory. Before soma-lib 0.8.0 the
// rule catalog matched case-sensitively, so each of these was `allow`.
describe('evaluateToolPolicy — case-insensitive filesystem', () => {
  it.each([
    ['RM -rf /tmp/dir', 'rm-recursive'],
    ['rm -R /tmp/dir', 'rm-recursive'],
    ['KILL 1', 'kill'],
  ])('auto mode: %s → classify', (command, ruleId) => {
    const r = evaluateToolPolicy('Bash', { command }, ctx('auto'));
    expect(r.decision).toBe('classify');
    expect(r.matchedRuleIds).toContain(ruleId);
  });

  it('non-admin SSH in any case → deny', () => {
    expect(evaluateToolPolicy('Bash', { command: 'SSH prod-host ls' }, ctx('auto')).decision).toBe('deny');
  });

  it('another user /tmp dir written in lowercase → deny', () => {
    const command = `cat /tmp/${OTHER.toLowerCase()}/s`;
    expect(evaluateToolPolicy('Bash', { command }, ctx('auto')).decision).toBe('deny');
  });

  it('own /tmp dir in lowercase stays allowed', () => {
    const command = `cat /tmp/${USER.toLowerCase()}/x.txt`;
    expect(evaluateToolPolicy('Bash', { command }, ctx('auto')).decision).toBe('allow');
  });
});

describe('evaluateToolPolicy — bypass mode (unsafe)', () => {
  it('dangerous Bash → allow (no ask, no classify)', () => {
    expect(evaluateToolPolicy('Bash', { command: 'rm -rf /tmp/dir' }, ctx('bypass')).decision).toBe('allow');
  });

  it('native tools → allow', () => {
    expect(evaluateToolPolicy('Write', { file_path: SAFE }, ctx('bypass')).decision).toBe('allow');
  });

  it('hard deny still wins over bypass (sensitive Read)', () => {
    expect(evaluateToolPolicy('Read', { file_path: SENSITIVE }, ctx('bypass')).decision).toBe('deny');
  });
});

describe('evaluateToolPolicy — legacy mode', () => {
  it('non-dangerous Bash → pass (defer to SDK prompt = old accept/reject)', () => {
    expect(evaluateToolPolicy('Bash', { command: 'ls' }, ctx('legacy')).decision).toBe('pass');
  });

  it('native tool → pass (SDK prompts)', () => {
    expect(evaluateToolPolicy('Write', { file_path: SAFE }, ctx('legacy')).decision).toBe('pass');
  });

  it('hard deny still wins over legacy', () => {
    expect(evaluateToolPolicy('Bash', { command: 'ssh host' }, ctx('legacy')).decision).toBe('deny');
  });
});
