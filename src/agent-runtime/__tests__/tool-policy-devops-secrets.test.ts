/**
 * Hard-deny tier for devops credentials (.prd/16-devops-tools-architecture.md §1, §2 "정책 훅 하드 거부").
 *
 * `gh auth token`, keychain dumps and the devops broker's root-owned paths are denied in every
 * permission mode and for admins too — unlike the dangerous-command rules, which auto mode hands to
 * the classifier and bypass mode allows. The OS user boundary is the real one; this is the first
 * tripwire in front of it.
 */

import { describe, expect, it } from 'vitest';
import type { PermissionMode } from '../policy/permission-mode';
import { evaluateToolPolicy, type ToolPolicyContext } from '../policy/tool-policy';

const MODES: readonly PermissionMode[] = ['auto', 'bypass', 'legacy'];

function makeCtx(overrides: Partial<ToolPolicyContext> = {}): ToolPolicyContext {
  return {
    user: 'U000ALICE',
    isAdmin: false,
    mode: 'auto',
    aborted: false,
    isDangerousRuleDisabled: () => false,
    handoffContext: undefined,
    checkMcpToolPermission: () => null,
    checkEnvSkillPermission: () => null,
    ...overrides,
  };
}

/** Every mode, for a regular user and an admin. */
const CONTEXTS = MODES.flatMap((mode) => [
  { label: `${mode} / user`, ctx: makeCtx({ mode }) },
  { label: `${mode} / admin`, ctx: makeCtx({ mode, isAdmin: true, user: 'U000ADMIN' }) },
]);

const DENIED_COMMANDS = [
  'gh auth token',
  'gh  auth   token --hostname github.com',
  "bash -c 'gh auth token'",
  'gh auth status -t',
  'gh auth status --show-token',
  'gh auth status --hostname github.com --show-token',
  'echo "$(gh auth token)"',
  'TOKEN=`gh auth token` && echo ok',
  '/opt/homebrew/bin/gh auth token',
  'env GH_HOST=github.com gh auth token',
  'security find-generic-password -w -s x',
  'security find-internet-password -s github.com',
  'security dump-keychain',
  'security -q export -k login.keychain -t certs',
  'cat /usr/local/var/soma-devops/secrets/gh/x.token',
  'ls /usr/local/libexec/soma-devops',
  'ls /usr/local/var/soma-devops',
  'cat "/usr/local/var/soma-devops/policy.json"',
  'cat /USR/LOCAL/VAR/SOMA-DEVOPS/policy.json',
  'cat /usr/local/var//soma-devops/policy.json',
  'cat /usr/local/var/./soma-devops/policy.json',
  'cat /usr/local/var/soma\\-devops/policy.json',
  "g'h' auth tok''en",
  'soma-devops-broker ingest gh member',
  'gh auth git-credential get',
  'printf "protocol=https\\nhost=github.com\\n" | gh auth git-credential get',
  'gh auth git-credential store',
  'gh auth git-credential erase',
  'sudo gh auth token',
  'xargs -n1 gh auth token',
  // Accepted cost of matching words anywhere, not only at command position (fail-closed: wrappers
  // like sudo/xargs/eval/find -exec cannot slip through): Bash text searches for the phrase are
  // denied too. The Grep tool, which this tier checks by path only, still finds it.
  'grep -rn "gh auth token" src/',
  'git log --grep "security export"',
];

const UNTOUCHED_COMMANDS = [
  'gh auth status',
  'gh pr list',
  'gh pr list --search "auth token"',
  'gh auth login --with-token',
  'security list-keychains',
  'export FOO=bar',
  'ls /usr/local/var',
  'ls /usr/local/var/soma-devops-other',
];

describe('evaluateToolPolicy — devops-secret hard deny', () => {
  for (const command of DENIED_COMMANDS) {
    it(`denies Bash \`${command}\` in every mode, for users and admins`, () => {
      for (const { label, ctx } of CONTEXTS) {
        const result = evaluateToolPolicy('Bash', { command }, ctx);
        expect(result.decision, label).toBe('deny');
        expect(result.reason, label).toMatch(/^devops-secret: /);
        expect(result.denyMessage, label).toMatch(/every permission mode/);
      }
    });
  }

  for (const command of UNTOUCHED_COMMANDS) {
    it(`leaves Bash \`${command}\` to the other tiers`, () => {
      for (const { label, ctx } of CONTEXTS) {
        const result = evaluateToolPolicy('Bash', { command }, ctx);
        expect(result.decision, label).not.toBe('deny');
        expect(result.reason, label).not.toMatch(/^devops-secret/);
      }
    });
  }

  const DENIED_FILE_CALLS: Array<[string, Record<string, unknown>]> = [
    ['Read', { file_path: '/usr/local/var/soma-devops/policy.json' }],
    ['Read', { file_path: '/usr/local/var/./soma-devops//secrets/gh/x.token' }],
    ['Read', { file_path: '/usr/local/var/x/../soma-devops/state/ledger.jsonl' }],
    ['Read', { file_path: '/Usr/Local/Var/Soma-Devops/policy.json' }],
    ['Edit', { file_path: '/usr/local/libexec/soma-devops/broker/broker.js', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: '/usr/local/libexec/soma-devops/gh', content: '' }],
    ['Grep', { pattern: 'token', path: '/usr/local/var/soma-devops' }],
    ['Glob', { pattern: '/usr/local/var/soma-devops/**' }],
    ['Glob', { pattern: 'soma-devops/secrets/**', path: '/usr/local/var' }],
  ];

  for (const [tool, input] of DENIED_FILE_CALLS) {
    it(`denies ${tool} ${JSON.stringify(input)} in every mode, for users and admins`, () => {
      for (const { label, ctx } of CONTEXTS) {
        const result = evaluateToolPolicy(tool, input, ctx);
        expect(result.decision, label).toBe('deny');
        expect(result.reason, label).toMatch(/^devops-secret: /);
      }
    });
  }

  const UNTOUCHED_FILE_CALLS: Array<[string, Record<string, unknown>]> = [
    ['Grep', { pattern: 'gh auth token', path: '/tmp/U000ALICE' }],
    ['Read', { file_path: '/usr/local/var/soma-devops-other/x' }],
    ['Read', { file_path: '/tmp/U000ALICE/soma-devops/notes.txt' }],
    ['Grep', { pattern: '/usr/local/var/soma-devops', path: '/tmp/U000ALICE' }],
    ['Glob', { pattern: '**/*.ts', path: '/tmp/U000ALICE' }],
  ];

  for (const [tool, input] of UNTOUCHED_FILE_CALLS) {
    it(`leaves ${tool} ${JSON.stringify(input)} to the other tiers`, () => {
      for (const { label, ctx } of CONTEXTS) {
        expect(evaluateToolPolicy(tool, input, ctx).reason, label).not.toMatch(/^devops-secret/);
      }
    });
  }

  it('also denies inside an incident READ-ONLY session', () => {
    const ctx = makeCtx({ isAdmin: true, incidentReadOnly: { allowedMcpTools: [] } });
    expect(evaluateToolPolicy('Bash', { command: 'gh auth token' }, ctx).decision).toBe('deny');
  });

  it('keeps the abort guard first for Bash', () => {
    const result = evaluateToolPolicy('Bash', { command: 'gh auth token' }, makeCtx({ aborted: true }));
    expect(result.reason).toMatch(/^abort-guard/);
  });

  it('carries no bypass hint in the surfaced message', () => {
    const result = evaluateToolPolicy('Bash', { command: 'gh auth token' }, makeCtx({ mode: 'bypass' }));
    expect(result.denyMessage).toBeDefined();
    expect(result.denyMessage).not.toMatch(/instead|try|use |admin|grant|disable/i);
  });
});
