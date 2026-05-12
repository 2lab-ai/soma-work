/**
 * Unit tests for bypass-permission-guard.
 *
 * Pins the contract of `buildBypassPermissionHookEntry`:
 *   1. The audited tool set (`NATIVE_BYPASS_TOOLS_FOR_TEST`) is exactly the set
 *      encoded in the matcher string.
 *   2. The matcher uses pipe-alternation so the SDK matches each token as a
 *      literal tool name (cli.js: `FeY` — split on `|`, literal-compare).
 *   3. The hook callback returns `permissionDecision: 'allow'`.
 *
 * What this test does NOT pin (because they belong to the SDK, not us):
 *   - That `'allow'` from a PreToolUse hook short-circuits the prompt tool.
 *   - The deny > allow precedence across multiple matchers.
 * Those are SDK invariants the caller relies on; pinning them would require
 * an integration test against `query()`.
 */

import type { HookInput, HookJSONOutput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import {
  BYPASS_ALLOW_MATCHER_FOR_TEST,
  buildBypassPermissionHookEntry,
  NATIVE_BYPASS_TOOLS_FOR_TEST,
} from '../bypass-permission-guard';

function extractDecision(o: HookJSONOutput | undefined): string | undefined {
  if (!o || !('hookSpecificOutput' in o)) return undefined;
  const sync = o as SyncHookJSONOutput;
  const so = sync.hookSpecificOutput;
  if (!so || so.hookEventName !== 'PreToolUse') return undefined;
  return (so as { permissionDecision?: string }).permissionDecision;
}

describe('buildBypassPermissionHookEntry — matcher contract', () => {
  it('matcher is pipe-alternation of the audited tool set', () => {
    const entry = buildBypassPermissionHookEntry();
    expect(entry.matcher).toBe(BYPASS_ALLOW_MATCHER_FOR_TEST);
    expect(entry.matcher?.split('|').sort()).toEqual([...NATIVE_BYPASS_TOOLS_FOR_TEST].sort());
  });

  it('matcher does NOT cover Bash (bypass-Bash-gate owns dangerous-rule escalation)', () => {
    const entry = buildBypassPermissionHookEntry();
    expect(entry.matcher?.split('|')).not.toContain('Bash');
  });

  it('matcher does NOT cover auto-allowlisted control tools (Skill / EnterPlanMode / ExitPlanMode)', () => {
    const entry = buildBypassPermissionHookEntry();
    const tokens = entry.matcher?.split('|') ?? [];
    for (const tool of ['Skill', 'EnterPlanMode', 'ExitPlanMode']) {
      expect(tokens).not.toContain(tool);
    }
  });

  it('matcher does NOT cover disallowed tools (AskUserQuestion / Cron*)', () => {
    const entry = buildBypassPermissionHookEntry();
    const tokens = entry.matcher?.split('|') ?? [];
    for (const tool of ['AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList']) {
      expect(tokens).not.toContain(tool);
    }
  });

  it('matcher covers every native non-Bash tool that can otherwise hit permissionPromptToolName', () => {
    // Sentinel set: native tool names SDK 0.2.111 is known to emit that are
    // NOT in allowedTools and NOT in disallowedTools. If a future SDK adds
    // another emit-able tool name, this test gives reviewers a single place
    // to verify the audit.
    const sentinel = [
      'Write',
      'Edit',
      'NotebookEdit',
      'TodoWrite',
      'Read',
      'Glob',
      'Grep',
      'Task',
      'WebFetch',
      'WebSearch',
      'KillShell',
    ];
    const tokens = buildBypassPermissionHookEntry().matcher?.split('|') ?? [];
    for (const tool of sentinel) {
      expect(tokens).toContain(tool);
    }
  });
});

describe('buildBypassPermissionHookEntry — hook decision', () => {
  it('single hook callback returns permissionDecision="allow"', async () => {
    const entry = buildBypassPermissionHookEntry();
    expect(entry.hooks).toHaveLength(1);
    const hook = entry.hooks[0];
    expect(hook).toBeDefined();
    // SDK hook input shape is structurally checked at runtime — a partial mock
    // is enough to drive the constant-return implementation.
    const result = await hook!({
      tool_name: 'Write',
      tool_input: { file_path: '/private/tmp/U_SELF/a.txt' },
    } as unknown as HookInput);
    expect(extractDecision(result)).toBe('allow');
  });
});
