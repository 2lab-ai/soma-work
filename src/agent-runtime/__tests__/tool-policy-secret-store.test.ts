/**
 * Hard-deny tier for the secret store and the approval records (.prd/25-env-access-architecture.md §1, §2, WU1).
 *
 * Every model — admins included, in every permission mode — is kept away from the secret store
 * (`SECRETS_DIR`) and may not rewrite an approval or grant record. The OS sandbox is the boundary
 * for Bash; this tier is the boundary for the native file tools and the first tripwire for Bash.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATA_DIR, SECRETS_DIR } from '../../env-paths';
import { approvalRecordPaths, secretStoreDenyRules } from '../policy/devops-secret-guard';
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
    checkEnvPluginMcpPermission: () => null,
    ...overrides,
  };
}

const CONTEXTS = MODES.flatMap((mode) => [
  { label: `${mode} / user`, ctx: makeCtx({ mode }) },
  { label: `${mode} / admin`, ctx: makeCtx({ mode, isAdmin: true, user: 'U000ADMIN' }) },
]);

const secret = (name: string) => path.join(SECRETS_DIR, name);

describe('SECRETS_DIR', () => {
  it('is the `secrets` directory beside the config file', () => {
    expect(path.basename(SECRETS_DIR)).toBe('secrets');
    expect(path.isAbsolute(SECRETS_DIR)).toBe(true);
  });
});

describe('evaluateToolPolicy — secret store hard deny', () => {
  const DENIED_COMMANDS = [
    `cat ${secret('dev2-db-app')}`,
    `ls ${SECRETS_DIR}`,
    `cat "${secret('gh-org-admin')}"`,
    `cat ${SECRETS_DIR}//gh-org-admin`,
    `cat ${SECRETS_DIR}/./gh-org-admin`,
    `tar czf /tmp/x.tgz ${SECRETS_DIR}`,
    `cp -r ${SECRETS_DIR} /tmp/U000ALICE/`,
  ];

  for (const command of DENIED_COMMANDS) {
    it(`denies Bash \`${command}\` in every mode, for users and admins`, () => {
      for (const { label, ctx } of CONTEXTS) {
        const result = evaluateToolPolicy('Bash', { command }, ctx);
        expect(result.decision, label).toBe('deny');
        expect(result.reason, label).toBe('devops-secret: secret store path');
      }
    });
  }

  const DENIED_FILE_CALLS: Array<[string, Record<string, unknown>]> = [
    ['Read', { file_path: secret('dev2-db-app') }],
    ['Read', { file_path: path.join(SECRETS_DIR, 'x', '..', 'gh-org-admin') }],
    ['Read', { file_path: SECRETS_DIR }],
    ['Write', { file_path: secret('new'), content: 'x' }],
    ['Edit', { file_path: secret('dev2-db-app'), old_string: 'a', new_string: 'b' }],
    ['Grep', { pattern: 'token', path: SECRETS_DIR }],
    ['Grep', { pattern: 'token', path: path.dirname(SECRETS_DIR) }],
    ['Glob', { pattern: `${SECRETS_DIR}/**` }],
    ['Glob', { pattern: 'secrets/*', path: path.dirname(SECRETS_DIR) }],
  ];

  for (const [tool, input] of DENIED_FILE_CALLS) {
    it(`denies ${tool} ${JSON.stringify(input)} in every mode, for users and admins`, () => {
      for (const { label, ctx } of CONTEXTS) {
        const result = evaluateToolPolicy(tool, input, ctx);
        expect(result.decision, label).toBe('deny');
        expect(result.reason, label).toBe('devops-secret: secret store path');
      }
    });
  }

  const UNTOUCHED: Array<[string, Record<string, unknown>]> = [
    ['Bash', { command: `ls ${SECRETS_DIR}-other` }],
    ['Bash', { command: 'cat /tmp/U000ALICE/secrets/notes.txt' }],
    ['Read', { file_path: `${SECRETS_DIR}-other/x` }],
    ['Read', { file_path: '/tmp/U000ALICE/secrets/notes.txt' }],
    ['Grep', { pattern: 'secrets', path: '/tmp/U000ALICE' }],
  ];

  for (const [tool, input] of UNTOUCHED) {
    it(`leaves ${tool} ${JSON.stringify(input)} to the other tiers`, () => {
      for (const { label, ctx } of CONTEXTS) {
        expect(evaluateToolPolicy(tool, input, ctx).reason ?? '', label).not.toMatch(/^devops-secret/);
      }
    });
  }
});

describe('evaluateToolPolicy — secret store: spellings the SDK expands (trinity R1)', () => {
  it('denies a leading-space spelling, an NFC-different spelling and a `..` spelling', () => {
    for (const { label, ctx } of CONTEXTS) {
      for (const file_path of [
        ` ${secret('dev2-db-app')}`,
        `${secret('dev2-db-app')} `,
        path.join(SECRETS_DIR, '..', path.basename(SECRETS_DIR), 'x'),
      ]) {
        expect(evaluateToolPolicy('Read', { file_path }, ctx).reason, `${label} ${file_path}`).toBe(
          'devops-secret: secret store path',
        );
      }
    }
  });

  it('denies a `~/` spelling (the SDK expands it to the home directory)', () => {
    const saved = process.env.HOME;
    process.env.HOME = path.dirname(SECRETS_DIR); // os.homedir() reads HOME
    try {
      for (const { label, ctx } of CONTEXTS) {
        expect(
          evaluateToolPolicy('Read', { file_path: `~/${path.basename(SECRETS_DIR)}/dev2-db-app` }, ctx).reason,
          label,
        ).toBe('devops-secret: secret store path');
        expect(evaluateToolPolicy('Grep', { pattern: '.', path: '~' }, ctx).reason, label).toBe(
          'devops-secret: secret store path',
        );
      }
    } finally {
      process.env.HOME = saved;
    }
  });

  it('denies a relative spelling that names the store by its last two names', () => {
    const tail = `${path.basename(path.dirname(SECRETS_DIR))}/${path.basename(SECRETS_DIR)}`;
    for (const file_path of [`../../../${tail}/dev2-db-app`, `${tail}/x`]) {
      expect(evaluateToolPolicy('Read', { file_path }, makeCtx({ isAdmin: true })).reason, file_path).toBe(
        'devops-secret: secret store path',
      );
    }
    expect(evaluateToolPolicy('Grep', { pattern: '.', path: `../../${tail}` }, makeCtx({ isAdmin: true })).reason).toBe(
      'devops-secret: secret store path',
    );
  });

  it('denies a new file through a link to the store, a link inside a missing path, and a dangling link', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-link-'));
    fs.mkdirSync(SECRETS_DIR, { recursive: true });
    try {
      fs.symlinkSync(SECRETS_DIR, path.join(work, 'alias'));
      fs.symlinkSync(path.join(SECRETS_DIR, 'not-yet'), path.join(work, 'dangling'));
      fs.symlinkSync(path.dirname(DATA_DIR), path.join(work, 'cfg'));
      const ctx = makeCtx({ isAdmin: true });
      expect(
        evaluateToolPolicy('Write', { file_path: path.join(work, 'alias', 'new'), content: 'x' }, ctx).reason,
      ).toBe('devops-secret: secret store path');
      expect(evaluateToolPolicy('Write', { file_path: path.join(work, 'dangling'), content: 'x' }, ctx).reason).toBe(
        'devops-secret: secret store path',
      );
      const grants = path.join(work, 'cfg', path.basename(DATA_DIR), 'env-skill-grants.json');
      expect(evaluateToolPolicy('Write', { file_path: grants, content: '{}' }, ctx).reason).toBe(
        'devops-secret: approval record',
      );
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it('denies a Glob whose wildcard segment matches the store, and a brace pattern naming it', () => {
    const cfg = path.dirname(SECRETS_DIR);
    const ctx = makeCtx({ isAdmin: true });
    for (const input of [
      { pattern: `${cfg}/secret*/*` },
      { pattern: 'sec*/**', path: cfg },
      { pattern: `${cfg}/s[e]crets/*` },
      { pattern: `{${SECRETS_DIR},/tmp}/*` },
    ]) {
      expect(evaluateToolPolicy('Glob', input, ctx).reason, JSON.stringify(input)).toBe(
        'devops-secret: secret store path',
      );
    }
    expect(evaluateToolPolicy('Glob', { pattern: 'src/*.ts', path: '/tmp/U000ALICE' }, ctx).reason ?? '').not.toMatch(
      /^devops-secret/,
    );
  });
});

describe('secretStoreDenyRules — CLI deny rules for every session', () => {
  it('covers the store and every approval record, with absolute (`//`) rule paths', () => {
    const rules = secretStoreDenyRules();
    expect(rules).toEqual(
      expect.arrayContaining([
        `Read(/${SECRETS_DIR})`,
        `Read(/${SECRETS_DIR}/**)`,
        `Edit(/${SECRETS_DIR}/**)`,
        `Edit(/${path.join(DATA_DIR, 'env-skill-grants.json')})`,
        `Edit(/${path.join(DATA_DIR, '*', 'skill-grants.json')})`,
      ]),
    );
    for (const rule of rules) expect(rule).toMatch(/^(Read|Edit)\(\/\//);
  });
});

describe('approvalRecordPaths — per-owner grants are write-denied too (trinity R1)', () => {
  it('lists the skill-grants.json of every owner directory, existing or not yet created', () => {
    fs.mkdirSync(path.join(DATA_DIR, 'U000OWNER'), { recursive: true });
    expect(approvalRecordPaths()).toContain(path.join(DATA_DIR, 'U000OWNER', 'skill-grants.json'));
  });
});

describe('evaluateToolPolicy — approval records are not writable by a model', () => {
  const RECORDS = [
    path.join(DATA_DIR, 'env-skill-grants.json'),
    path.join(DATA_DIR, 'mcp-tool-grants.json'),
    path.join(DATA_DIR, 'skill-perm-requests.json'),
    path.join(DATA_DIR, 'admin-requests.json'),
    path.join(DATA_DIR, 'cron-run-requests.json'),
    path.join(DATA_DIR, 'instruction-approvals.json'),
    path.join(DATA_DIR, 'U000OWNER', 'skill-grants.json'),
  ];

  // One check serves Read, Edit and Write (the call the Lean ToolPolicy model fixes), so a model
  // handles an approval record with no file tool — reading one is not needed to use the bot.
  for (const record of RECORDS) {
    it(`denies Read, Write and Edit of ${path.relative(DATA_DIR, record)} for users and admins`, () => {
      for (const { label, ctx } of CONTEXTS) {
        for (const [tool, input] of [
          ['Read', { file_path: record }],
          ['Write', { file_path: record, content: '{}' }],
          ['Edit', { file_path: record, old_string: 'a', new_string: 'b' }],
        ] as const) {
          const result = evaluateToolPolicy(tool, input, ctx);
          expect(result.decision, `${label} ${tool}`).toBe('deny');
          expect(result.reason, `${label} ${tool}`).toBe('devops-secret: approval record');
        }
      }
    });
  }

  it('leaves other files in DATA_DIR and a deeper skill-grants.json alone', () => {
    for (const file of [
      path.join(DATA_DIR, 'sessions.json'),
      path.join(DATA_DIR, 'U000OWNER', 'skills', 'x', 'skill-grants.json'),
    ]) {
      expect(
        evaluateToolPolicy('Write', { file_path: file, content: '{}' }, makeCtx({ isAdmin: true })).reason ?? '',
      ).not.toMatch(/^devops-secret/);
    }
  });

  it('leaves a relative Glob alone (the session resolves it)', () => {
    expect(evaluateToolPolicy('Glob', { pattern: '**/*.ts' }, makeCtx()).reason ?? '').not.toMatch(/^devops-secret/);
  });

  it('leaves Write of a file that only shares a name outside DATA_DIR alone', () => {
    const result = evaluateToolPolicy(
      'Write',
      { file_path: '/tmp/U000ALICE/env-skill-grants.json', content: '{}' },
      makeCtx({ isAdmin: true }),
    );
    expect(result.reason ?? '').not.toMatch(/^devops-secret/);
  });
});
