/**
 * Unified ToolPolicy precedence tests (epic #1023 P5).
 *
 * `evaluateToolPolicy` collapses the prior per-matcher PreToolUse hooks into one
 * decision with `deny > classify/allow > pass` precedence. These tests pin every
 * guard AND the cross-guard precedence (a deny must always beat a bypass allow /
 * a dangerous-Bash classify), which is what the old SDK multi-hook `deny>allow` merge
 * guaranteed. The guard primitives themselves have their own unit tests; here we
 * verify the *composition*.
 */

import * as os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { HandoffContext } from '../../types';
import {
  ENV_GATED_TOOLS,
  ENV_SKILL_DENY_MESSAGE,
  evaluateToolPolicy,
  TOOL_POLICY_MATCHERS,
  type ToolPolicyContext,
} from '../policy/tool-policy';

const USER = 'U0PARITY01';
const OTHER_USER = 'U0OTHERUSR9';

function makeCtx(overrides: Partial<ToolPolicyContext> = {}): ToolPolicyContext {
  return {
    user: USER,
    isAdmin: false,
    mode: 'legacy',
    aborted: false,
    isDangerousRuleDisabled: () => false,
    handoffContext: undefined,
    checkMcpToolPermission: () => null,
    checkEnvSkillPermission: () => null,
    ...overrides,
  };
}

// A handoff context that requires a linked source issue → `gh pr create`
// without a `Closes #N` marker is blocked.
const BLOCKING_HANDOFF: HandoffContext = {
  handoffKind: 'plan-to-work',
  sourceIssueUrl: 'https://github.com/2lab-ai/soma-work/issues/696',
  escapeEligible: false,
  tier: null,
  issueRequiredByUser: false,
  parentEpicUrl: null,
  chainId: 'chain-1',
  hopBudget: 3,
};

const SENSITIVE_READ = `${os.homedir()}/.ssh/id_rsa`;
const SAFE_READ = `/tmp/${USER}/notes.txt`;

describe('evaluateToolPolicy — guards (epic #1023 P5)', () => {
  describe('deny tier', () => {
    it('abort guard: Bash after abort → deny; non-Bash unaffected', () => {
      expect(evaluateToolPolicy('Bash', { command: 'ls' }, makeCtx({ aborted: true })).decision).toBe('deny');
      // Read after abort is NOT denied by the abort guard (Bash-only).
      expect(evaluateToolPolicy('Read', { file_path: SAFE_READ }, makeCtx({ aborted: true })).decision).not.toBe(
        'deny',
      );
    });

    it('ssh ban: non-admin Bash ssh → deny; admin → not deny', () => {
      expect(evaluateToolPolicy('Bash', { command: 'ssh prod-host' }, makeCtx()).decision).toBe('deny');
      expect(evaluateToolPolicy('Bash', { command: 'ssh prod-host' }, makeCtx({ isAdmin: true })).decision).not.toBe(
        'deny',
      );
    });

    it('sensitive-path: non-admin Read of ~/.ssh key → deny; admin → not deny', () => {
      expect(evaluateToolPolicy('Read', { file_path: SENSITIVE_READ }, makeCtx()).decision).toBe('deny');
      expect(evaluateToolPolicy('Read', { file_path: SENSITIVE_READ }, makeCtx({ isAdmin: true })).decision).not.toBe(
        'deny',
      );
    });

    it('cross-user: Bash touching another user /tmp dir → deny (even admin, always-on)', () => {
      const cmd = { command: `cat /tmp/${OTHER_USER}/secret` };
      expect(evaluateToolPolicy('Bash', cmd, makeCtx()).decision).toBe('deny');
      expect(evaluateToolPolicy('Bash', cmd, makeCtx({ isAdmin: true })).decision).toBe('deny');
    });

    it('mcp-permission: non-admin gated mcp tool without grant → deny; with grant → pass', () => {
      const denyCtx = makeCtx({ checkMcpToolPermission: () => 'no active grant' });
      const r = evaluateToolPolicy('mcp__server-tools__db_query', {}, denyCtx);
      expect(r.decision).toBe('deny');
      expect(r.reason).toContain('mcp-permission');
      expect(evaluateToolPolicy('mcp__server-tools__db_query', {}, makeCtx()).decision).toBe('pass');
    });

    it('mcp-permission: any non-null deny reason denies, the empty string included (null is the only allow)', () => {
      // `checkMcpToolPermission` returns "a deny reason ..., else null": an empty
      // reason is still a denial, so the guard must not treat it as allowed.
      const r = evaluateToolPolicy('mcp__server-tools__db_query', {}, makeCtx({ checkMcpToolPermission: () => '' }));
      expect(r.decision).toBe('deny');
      expect(r.reason).toBe('mcp-permission: ');
    });

    it('pr-issue: handoff session, gh pr create without Closes #N → deny with surfaced message', () => {
      const r = evaluateToolPolicy(
        'Bash',
        { command: 'gh pr create --title x --body "no marker"' },
        makeCtx({ handoffContext: BLOCKING_HANDOFF }),
      );
      expect(r.decision).toBe('deny');
      expect(r.reason).toContain('pr-issue');
      expect(typeof r.denyMessage).toBe('string'); // surfaced via permissionDecisionReason
    });

    it('pr-issue: handoff session, gh pr create WITH Closes #696 → not denied by pr-issue', () => {
      const r = evaluateToolPolicy(
        'Bash',
        { command: 'gh pr create --body "Closes #696"' },
        makeCtx({ handoffContext: BLOCKING_HANDOFF }),
      );
      expect(r.decision).not.toBe('deny');
    });
  });

  describe('allow / pass tier', () => {
    it('bypass-bash: non-dangerous AND dangerous both → allow (unsafe allow-all)', () => {
      expect(evaluateToolPolicy('Bash', { command: 'ls -la' }, makeCtx({ mode: 'bypass' })).decision).toBe('allow');
      // Unsafe bypass no longer asks on a dangerous rule — it just runs.
      const dangerous = evaluateToolPolicy('Bash', { command: 'rm -rf /tmp/dir' }, makeCtx({ mode: 'bypass' }));
      expect(dangerous.decision).toBe('allow');
    });

    it('native-bypass: Write/Read with bypass → allow', () => {
      expect(evaluateToolPolicy('Write', { file_path: SAFE_READ }, makeCtx({ mode: 'bypass' })).decision).toBe('allow');
      expect(evaluateToolPolicy('Read', { file_path: SAFE_READ }, makeCtx({ mode: 'bypass' })).decision).toBe('allow');
    });

    it('pass: no bypass, non-dangerous Bash → pass (defer to SDK)', () => {
      expect(evaluateToolPolicy('Bash', { command: 'ls' }, makeCtx()).decision).toBe('pass');
    });

    it('pass: bypass off → native tool gets no opinion', () => {
      expect(evaluateToolPolicy('Write', { file_path: SAFE_READ }, makeCtx()).decision).toBe('pass');
    });
  });

  describe('precedence: deny > allow', () => {
    it('sensitive deny beats native-bypass allow (Read sensitive + bypass)', () => {
      expect(evaluateToolPolicy('Read', { file_path: SENSITIVE_READ }, makeCtx({ mode: 'bypass' })).decision).toBe(
        'deny',
      );
    });

    it('cross-user deny beats bypass-bash allow', () => {
      expect(
        evaluateToolPolicy('Bash', { command: `cat /tmp/${OTHER_USER}/x` }, makeCtx({ mode: 'bypass' })).decision,
      ).toBe('deny');
    });

    it('ssh deny beats bypass-bash allow', () => {
      expect(evaluateToolPolicy('Bash', { command: 'ssh host' }, makeCtx({ mode: 'bypass' })).decision).toBe('deny');
    });

    it('pr-issue deny beats bypass-bash allow (non-dangerous gh pr create)', () => {
      expect(
        evaluateToolPolicy(
          'Bash',
          { command: 'gh pr create --body "no marker"' },
          makeCtx({ mode: 'bypass', handoffContext: BLOCKING_HANDOFF }),
        ).decision,
      ).toBe('deny');
    });

    it('abort deny beats bypass-bash allow', () => {
      expect(evaluateToolPolicy('Bash', { command: 'ls' }, makeCtx({ mode: 'bypass', aborted: true })).decision).toBe(
        'deny',
      );
    });
  });

  describe('checkMcpToolPermission wiring', () => {
    it('is only consulted for mcp__ tools and skipped for admins', () => {
      const spy = vi.fn(() => 'denied');
      evaluateToolPolicy('Bash', { command: 'ls' }, makeCtx({ checkMcpToolPermission: spy }));
      expect(spy).not.toHaveBeenCalled(); // not an mcp tool
      evaluateToolPolicy('mcp__x__y', {}, makeCtx({ isAdmin: true, checkMcpToolPermission: spy }));
      expect(spy).not.toHaveBeenCalled(); // admin skips mcp guard
      evaluateToolPolicy('mcp__x__y', {}, makeCtx({ checkMcpToolPermission: spy }));
      expect(spy).toHaveBeenCalledWith('mcp__x__y');
    });
  });

  // Environment skills (step 6b): a skill of a deploy-time environment plugin runs only on an
  // admin's grant, whether the model calls it or reads its files. `checkEnvSkillPermission` gets the
  // tool name and input of every ENV_GATED_TOOLS call.
  describe('environment skill gate (step 6b)', () => {
    const denyEnv = (_tool: string, input: Record<string, unknown>) =>
      input.skill === 'acme-env:post-deploy' || String(input.file_path ?? '').includes('/plugins/acme-env/')
        ? 'acme-env:post-deploy'
        : null;

    it.each([
      'auto',
      'bypass',
      'legacy',
    ] as const)('denies an ungranted environment skill for a non-admin (%s)', (mode) => {
      const r = evaluateToolPolicy(
        'Skill',
        { skill: 'acme-env:post-deploy', args: '--preflight' },
        makeCtx({ mode, checkEnvSkillPermission: denyEnv }),
      );
      expect(r.decision).toBe('deny');
      expect(r.reason).toBe('env-skill: acme-env:post-deploy');
      expect(r.denyMessage).toBe(ENV_SKILL_DENY_MESSAGE);
    });

    it.each([
      'auto',
      'bypass',
    ] as const)('denies reading an environment skill file by hand, over the mode allow (%s)', (mode) => {
      const r = evaluateToolPolicy(
        'Read',
        { file_path: '/opt/soma-work/dev/plugins/acme-env/skills/post-deploy/SKILL.md' },
        makeCtx({ mode, checkEnvSkillPermission: denyEnv }),
      );
      expect(r.decision).toBe('deny');
      expect(r.reason).toBe('env-skill: acme-env:post-deploy');
    });

    it('lets admins run and read environment skills without asking', () => {
      const spy = vi.fn(denyEnv);
      const ctx = makeCtx({ isAdmin: true, mode: 'bypass', checkEnvSkillPermission: spy });
      expect(evaluateToolPolicy('Skill', { skill: 'acme-env:post-deploy' }, ctx).decision).toBe('pass');
      expect(evaluateToolPolicy('Read', { file_path: '/opt/soma-work/dev/plugins/acme-env/x' }, ctx).decision).toBe(
        'allow',
      );
      expect(spy).not.toHaveBeenCalled();
    });

    it('has no opinion on a granted or non-environment skill', () => {
      expect(
        evaluateToolPolicy('Skill', { skill: 'zworkflow:deploy-qa' }, makeCtx({ checkEnvSkillPermission: denyEnv }))
          .decision,
      ).toBe('pass');
    });

    it('is consulted for ENV_GATED_TOOLS only, with the tool name and input', () => {
      const spy = vi.fn(() => null);
      evaluateToolPolicy('TodoWrite', { todos: [] }, makeCtx({ checkEnvSkillPermission: spy }));
      evaluateToolPolicy('mcp__x__y', { skill: 'acme-env:post-deploy' }, makeCtx({ checkEnvSkillPermission: spy }));
      evaluateToolPolicy('ExitPlanMode', {}, makeCtx({ checkEnvSkillPermission: spy }));
      expect(spy).not.toHaveBeenCalled();
      for (const tool of ENV_GATED_TOOLS) {
        evaluateToolPolicy(tool, { skill: 42 }, makeCtx({ checkEnvSkillPermission: spy }));
        expect(spy).toHaveBeenLastCalledWith(tool, { skill: 42 });
      }
      evaluateToolPolicy('Skill', undefined, makeCtx({ checkEnvSkillPermission: spy }));
      expect(spy).toHaveBeenLastCalledWith('Skill', {});
      expect([...ENV_GATED_TOOLS]).toEqual(['Skill', 'Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'NotebookEdit']);
    });

    it('an empty deny reason still denies (null is the only "allowed")', () => {
      expect(evaluateToolPolicy('Skill', { skill: 'x' }, makeCtx({ checkEnvSkillPermission: () => '' })).decision).toBe(
        'deny',
      );
    });

    it('a deny tier hit keeps its own reason (the sensitive-path guard runs first)', () => {
      const r = evaluateToolPolicy(
        'Read',
        { file_path: `${os.homedir()}/.ssh/id_rsa` },
        makeCtx({ mode: 'bypass', checkEnvSkillPermission: () => 'acme-env' }),
      );
      expect(r.reason.startsWith('sensitive-path:')).toBe(true);
    });

    it('leaves incident sessions to the incident tier', () => {
      const r = evaluateToolPolicy(
        'Skill',
        { skill: 'acme-env:post-deploy' },
        makeCtx({
          checkEnvSkillPermission: (_t, input) =>
            input.skill === 'acme-env:post-deploy' ? 'acme-env:post-deploy' : null,
          incidentReadOnly: { allowedMcpTools: [] },
        }),
      );
      expect(r.decision).toBe('deny');
      expect(r.reason.startsWith('incident-read-only:')).toBe(true);
    });

    it('routes the Skill tool through the policy hook', () => {
      expect(TOOL_POLICY_MATCHERS).toContain('Skill');
    });
  });
});
