/**
 * Unit tests for bypass-permission-guard.
 *
 * Covers the regression where bypass=ON users still saw Slack "Permission
 * Request" UI for innocuous Write/Edit/MultiEdit/NotebookEdit calls because
 * the SDK fell through to `permissionPromptToolName`. The guard explicitly
 * emits `permissionDecision: 'allow'` for every native non-Bash tool so the
 * SDK's permission pipeline short-circuits before invoking the prompt MCP.
 */

import type { HookInput, HookJSONOutput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import {
  type BypassPermissionHookEntry,
  buildBypassPermissionHookEntries,
  NATIVE_BYPASS_TOOL_NAMES,
} from '../bypass-permission-guard';

function callHook(
  entry: BypassPermissionHookEntry,
  toolName: string,
  toolInput: Record<string, unknown> = {},
): Promise<HookJSONOutput> {
  const fn = entry.hooks[0];
  if (!fn) throw new Error('hook missing');
  return fn({ tool_name: toolName, tool_input: toolInput } as unknown as HookInput);
}

/**
 * Mirror the SDK's per-matcher merge precedence so the test pins behavior
 * independently of the upstream code path:
 *   deny > defer > ask > allow > undefined
 *
 * Confirmed against `@anthropic-ai/claude-agent-sdk@0.2.111` cli.js:8219:10094.
 */
function extractDecision(o: HookJSONOutput | undefined): string | undefined {
  if (!o || !('hookSpecificOutput' in o)) return undefined;
  const sync = o as SyncHookJSONOutput;
  const so = sync.hookSpecificOutput;
  if (!so || so.hookEventName !== 'PreToolUse') return undefined;
  return (so as { permissionDecision?: string }).permissionDecision;
}

function mergeDecisions(outputs: Array<HookJSONOutput | undefined>): string | undefined {
  let best: string | undefined;
  for (const o of outputs) {
    const decision = extractDecision(o);
    if (decision === 'deny') return 'deny';
    if (decision === 'defer' && best !== 'deny') best = 'defer';
    else if (decision === 'ask' && best !== 'deny' && best !== 'defer') best = 'ask';
    else if (decision === 'allow' && best === undefined) best = 'allow';
  }
  return best;
}

describe('bypass-permission-guard — registration', () => {
  it('returns empty array when userBypass=false (bypass-off uses SDK default flow)', () => {
    expect(buildBypassPermissionHookEntries({ userBypass: false })).toEqual([]);
  });

  it('registers one entry per native non-Bash tool when userBypass=true', () => {
    const entries = buildBypassPermissionHookEntries({ userBypass: true });
    expect(entries.map((e) => e.matcher).sort()).toEqual([...NATIVE_BYPASS_TOOL_NAMES].sort());
  });

  it('does NOT register Bash (covered by bypass-Bash-gate in claude-handler.ts)', () => {
    const entries = buildBypassPermissionHookEntries({ userBypass: true });
    expect(entries.find((e) => e.matcher === 'Bash')).toBeUndefined();
  });

  it('does NOT register auto-allowlisted control tools (Skill / EnterPlanMode / ExitPlanMode)', () => {
    const entries = buildBypassPermissionHookEntries({ userBypass: true });
    for (const tool of ['Skill', 'EnterPlanMode', 'ExitPlanMode']) {
      expect(entries.find((e) => e.matcher === tool)).toBeUndefined();
    }
  });
});

describe('bypass-permission-guard — hook decision per tool', () => {
  for (const tool of NATIVE_BYPASS_TOOL_NAMES) {
    it(`${tool} hook returns permissionDecision='allow' under bypass=ON`, async () => {
      const entries = buildBypassPermissionHookEntries({ userBypass: true });
      const entry = entries.find((e) => e.matcher === tool);
      expect(entry).toBeDefined();
      const result = await callHook(entry!, tool, { file_path: '/private/tmp/U_SELF/foo' });
      expect(extractDecision(result)).toBe('allow');
    });
  }
});

describe('bypass-permission-guard — SDK merge precedence (deny > defer > ask > allow)', () => {
  it('sensitive-path deny still wins over bypass allow on Read', async () => {
    const entries = buildBypassPermissionHookEntries({ userBypass: true });
    const readEntry = entries.find((e) => e.matcher === 'Read');
    const allow = await callHook(readEntry!, 'Read');
    const deny: HookJSONOutput = {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    };
    expect(mergeDecisions([allow, deny])).toBe('deny');
    expect(mergeDecisions([deny, allow])).toBe('deny');
  });

  it('passthrough hook + bypass allow → allow (Write under /private/tmp/<self>/...)', async () => {
    const entries = buildBypassPermissionHookEntries({ userBypass: true });
    const writeEntry = entries.find((e) => e.matcher === 'Write');
    const allow = await callHook(writeEntry!, 'Write', {
      file_path: '/private/tmp/U_SELF/work/foo.txt',
    });
    const passthrough: HookJSONOutput = { continue: true };
    expect(mergeDecisions([passthrough, allow])).toBe('allow');
    expect(mergeDecisions([allow, passthrough])).toBe('allow');
  });

  it('ask hook + bypass allow → ask (defer/ask precedence preserved)', async () => {
    const entries = buildBypassPermissionHookEntries({ userBypass: true });
    const editEntry = entries.find((e) => e.matcher === 'Edit');
    const allow = await callHook(editEntry!, 'Edit');
    const ask: HookJSONOutput = {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
    };
    expect(mergeDecisions([allow, ask])).toBe('ask');
  });
});
