/**
 * Unit tests for bypass-permission-guard.
 *
 * Pins the audited `NATIVE_BYPASS_TOOLS` set that the tool policy allows in
 * bypass/auto mode and joins into its PreToolUse matcher:
 *   1. Bash is not in it (the tool policy owns dangerous-rule escalation).
 *   2. Tools that are already allow-listed or disallowed are not in it.
 *   3. Every native non-Bash tool that could otherwise hit
 *      `permissionPromptToolName` is in it.
 */

import { describe, expect, it } from 'vitest';
import { NATIVE_BYPASS_TOOLS } from '../bypass-permission-guard';

describe('NATIVE_BYPASS_TOOLS — audited tool set', () => {
  it('does NOT cover Bash (the tool policy owns dangerous-rule escalation)', () => {
    expect(NATIVE_BYPASS_TOOLS).not.toContain('Bash');
  });

  it('does NOT cover auto-allowlisted control tools (Skill / EnterPlanMode / ExitPlanMode)', () => {
    for (const tool of ['Skill', 'EnterPlanMode', 'ExitPlanMode']) {
      expect(NATIVE_BYPASS_TOOLS).not.toContain(tool);
    }
  });

  it('does NOT cover disallowed tools (AskUserQuestion / Cron*)', () => {
    for (const tool of ['AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList']) {
      expect(NATIVE_BYPASS_TOOLS).not.toContain(tool);
    }
  });

  it('covers every native non-Bash tool that can otherwise hit permissionPromptToolName', () => {
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
      'Agent',
      'WebFetch',
      'WebSearch',
      'KillShell',
    ];
    for (const tool of sentinel) {
      expect(NATIVE_BYPASS_TOOLS).toContain(tool);
    }
  });
});
