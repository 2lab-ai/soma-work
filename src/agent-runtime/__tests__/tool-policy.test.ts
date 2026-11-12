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
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DATA_DIR, SECRETS_DIR } from '../../env-paths';
import { NATIVE_BYPASS_TOOLS } from '../../hooks/bypass-permission-guard';
import type { HandoffContext } from '../../types';
import { NATIVE_WRITE_TOOLS } from '../policy/native-write-boundary';
import {
  ENV_GATED_TOOLS,
  ENV_PLUGIN_MCP_DENY_MESSAGE,
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
    checkEnvPluginMcpPermission: () => null,
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

    it('ssh ban: Bash ssh → deny for everyone, admins too, pointing at ssh_exec (env-access WU2, #1210)', () => {
      for (const isAdmin of [false, true]) {
        const result = evaluateToolPolicy('Bash', { command: 'ssh prod-host' }, makeCtx({ isAdmin }));
        expect(result.decision).toBe('deny');
        expect(result.reason).toBe('ssh-ban: ssh command');
        expect(result.denyMessage).toContain('ssh_exec');
      }
    });

    it('native write boundary: an admin is held to it too when the session sets it (env-access WU2, #1210)', () => {
      const checkNativeWrite = vi.fn(() => 'Write outside the writable directories');
      const result = evaluateToolPolicy(
        'Write',
        { file_path: '/opt/brew/bin/node', content: 'x' },
        makeCtx({ isAdmin: true, mode: 'bypass', checkNativeWrite }),
      );
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('write-boundary: Write outside the writable directories');
      // Without the check (the sandbox off on an allowing host) an admin's native write is not confined.
      expect(
        evaluateToolPolicy(
          'Write',
          { file_path: '/opt/brew/bin/node', content: 'x' },
          makeCtx({ isAdmin: true, mode: 'bypass' }),
        ).decision,
      ).not.toBe('deny');
    });

    it('devops-secret: the deny message names what was refused (secret store, approval record, credentials)', () => {
      const store = evaluateToolPolicy('Read', { file_path: `${SECRETS_DIR}/x` }, makeCtx({ isAdmin: true }));
      expect(store.reason).toBe('devops-secret: secret store path');
      expect(store.denyMessage).toContain('secret store');
      const record = evaluateToolPolicy(
        'Write',
        { file_path: path.join(DATA_DIR, 'admin-requests.json'), content: '{}' },
        makeCtx({ isAdmin: true }),
      );
      expect(record.reason).toBe('devops-secret: approval record');
      expect(record.denyMessage).toContain('approval');
      const keychain = evaluateToolPolicy(
        'Bash',
        { command: ['security', 'find-generic-password', '-s', 'x'].join(' ') },
        makeCtx({ isAdmin: true }),
      );
      expect(keychain.denyMessage).toContain('GitHub or keychain');
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

  // Environment plugin MCP tools (step 6d): the SDK starts every plugin's MCP servers for every
  // session, so an environment plugin's tools (`mcp__plugin_<plugin>_<server>__<tool>`) run for a
  // non-admin only on an admin's grant of one of that plugin's skills.
  describe('environment plugin MCP gate (step 6d)', () => {
    const TOOL = 'mcp__plugin_envx_browser__probe';
    const denyEnvx = (tool: string) => (tool.startsWith('mcp__plugin_envx_') ? 'envx' : null);

    it.each([
      'auto',
      'bypass',
      'legacy',
    ] as const)('denies an ungranted environment plugin MCP tool for a non-admin (%s)', (mode) => {
      const r = evaluateToolPolicy(
        TOOL,
        { url: 'https://example.test' },
        makeCtx({ mode, checkEnvPluginMcpPermission: denyEnvx }),
      );
      expect(r.decision).toBe('deny');
      expect(r.reason).toBe(`env-plugin-mcp: envx (${TOOL})`);
      expect(r.denyMessage).toBe(ENV_PLUGIN_MCP_DENY_MESSAGE);
    });

    it('tells the model no approval request was sent and what opens the tool', () => {
      expect(ENV_PLUGIN_MCP_DENY_MESSAGE).toMatch(/environment plugin/);
      expect(ENV_PLUGIN_MCP_DENY_MESSAGE).toMatch(/admin approves one of that plugin's skills/);
      expect(ENV_PLUGIN_MCP_DENY_MESSAGE).toMatch(/no approval request is sent/i);
      expect(ENV_PLUGIN_MCP_DENY_MESSAGE).not.toBe(ENV_SKILL_DENY_MESSAGE);
    });

    it('has no opinion once the check finds a grant (null)', () => {
      expect(evaluateToolPolicy(TOOL, {}, makeCtx({ mode: 'bypass' })).decision).toBe('pass');
    });

    it('lets admins call it without consulting the check', () => {
      const spy = vi.fn(denyEnvx);
      const r = evaluateToolPolicy(
        TOOL,
        {},
        makeCtx({ isAdmin: true, mode: 'bypass', checkEnvPluginMcpPermission: spy }),
      );
      expect(r.decision).toBe('pass');
      expect(spy).not.toHaveBeenCalled();
    });

    it('is consulted for `mcp__plugin_` tools only, with the tool name', () => {
      const spy = vi.fn(() => 'envx');
      for (const tool of [
        'mcp__x__y',
        'mcp__github__create_pull_request',
        'mcp__plugins_envx__probe',
        'mcp__pluginenvx_browser__probe',
        'MCP__plugin_envx_browser__probe',
        'xmcp__plugin_envx_browser__probe',
        ' mcp__plugin_envx_browser__probe',
        'Skill',
        'Read',
        'Bash',
      ]) {
        const r = evaluateToolPolicy(tool, {}, makeCtx({ checkEnvPluginMcpPermission: spy }));
        expect(r.reason.startsWith('env-plugin-mcp:')).toBe(false);
      }
      expect(spy).not.toHaveBeenCalled();
      evaluateToolPolicy(TOOL, undefined, makeCtx({ checkEnvPluginMcpPermission: spy }));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenLastCalledWith(TOOL);
    });

    it('an empty deny reason still denies (null is the only "allowed")', () => {
      expect(evaluateToolPolicy(TOOL, {}, makeCtx({ checkEnvPluginMcpPermission: () => '' })).decision).toBe('deny');
    });

    it('a deny tier hit keeps its own reason (the MCP grant guard runs first)', () => {
      const r = evaluateToolPolicy(
        TOOL,
        {},
        makeCtx({ checkMcpToolPermission: () => 'gated server', checkEnvPluginMcpPermission: denyEnvx }),
      );
      expect(r.reason).toBe('mcp-permission: gated server');
    });

    it('leaves incident sessions to the incident tier', () => {
      const r = evaluateToolPolicy(
        TOOL,
        {},
        makeCtx({ checkEnvPluginMcpPermission: denyEnvx, incidentReadOnly: { allowedMcpTools: [TOOL] } }),
      );
      expect(r.decision).toBe('allow');
      expect(r.reason.startsWith('incident-read-only:')).toBe(true);
    });

    it('leaves the environment skill step to skill and file calls', () => {
      const r = evaluateToolPolicy(
        TOOL,
        {},
        makeCtx({ checkEnvSkillPermission: () => 'envx:qa', checkEnvPluginMcpPermission: () => null }),
      );
      expect(r.decision).toBe('pass');
    });
  });
});

/**
 * How the SDK matches a `PreToolUse` matcher to a tool name. Claude Code compares a matcher made
 * only of `[A-Za-z0-9_|]` as a `|`-list of exact tool names (CHANGELOG v2.1.195; the bot's 2.1.284
 * logs "Hook matcher `mcp__` matches no tool (it is compared as an exact string)"); any other
 * matcher is a regular expression tested against the name.
 */
function sdkMatcherHits(matcher: string, toolName: string): boolean {
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    return matcher
      .split('|')
      .map((name) => name.trim())
      .filter(Boolean)
      .includes(toolName);
  }
  return new RegExp(matcher).test(toolName);
}

describe('TOOL_POLICY_MATCHERS under the SDK matcher rule', () => {
  const hooked = (tool: string) => TOOL_POLICY_MATCHERS.some((matcher) => sdkMatcherHits(matcher, tool));

  it('routes every governed tool to the policy hook, MCP tools included', () => {
    for (const tool of ['Bash', 'Skill', ...NATIVE_BYPASS_TOOLS, ...NATIVE_WRITE_TOOLS]) {
      expect({ tool, hooked: hooked(tool) }).toEqual({ tool, hooked: true });
    }
    for (const tool of [
      'mcp__github__create_pull_request',
      'mcp__x__y',
      'mcp__plugin_envx_browser__probe',
      'mcp__plugin_acme-env_browser__probe',
    ]) {
      expect({ tool, hooked: hooked(tool) }).toEqual({ tool, hooked: true });
    }
  });

  it('leaves ungoverned tools and look-alike names out', () => {
    for (const tool of ['ExitPlanMode', 'AskUserQuestion', 'xmcp__y', 'MCP__x__y', 'mcp_x']) {
      expect({ tool, hooked: hooked(tool) }).toEqual({ tool, hooked: false });
    }
  });
});
