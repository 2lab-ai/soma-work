/**
 * Unit tests for PR-issue precondition guard (#696).
 *
 * Trace: docs/pr-issue-precondition/trace.md (v2.1) §S1 — 19 tests covering
 * tool-shape detection, sourceIssueUrl path, escapeEligible path, MCP path,
 * adversarial inputs (codex-flagged), and precedence.
 */

import { describe, expect, it, vi } from 'vitest';
import type { HandoffContext } from '../../types';
import { buildPrIssueHookEntries, handlePrIssuePrecondition, type PrIssueHookLogger } from '../pr-issue-guard';

const SOURCE = 'https://github.com/2lab-ai/soma-work/issues/696';

function makeContext(overrides: Partial<HandoffContext> = {}): HandoffContext {
  return {
    handoffKind: 'plan-to-work',
    sourceIssueUrl: null,
    parentEpicUrl: null,
    escapeEligible: false,
    tier: null,
    issueRequiredByUser: true,
    dependencyGroups: [],
    perTaskDispatchPayloads: [],
    chainId: 'test-chain-id',
    hopBudget: 1,
    ...overrides,
  };
}

describe('pr-issue-guard — tool shape / non-targets', () => {
  it('T1.1 non-PR-create tool passes', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Read',
      toolInput: { file_path: '/tmp/foo' },
      handoffContext: makeContext(),
    });
    expect(result.blocked).toBe(false);
  });

  it('T1.2 Bash but non-PR command passes', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'git status' },
      handoffContext: makeContext({ sourceIssueUrl: null, escapeEligible: false }),
    });
    expect(result.blocked).toBe(false);
  });

  it('T1.3 mcp__github__list_issues passes (only mcp__github__create_pull_request is gated)', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'mcp__github__list_issues',
      toolInput: { owner: 'x', repo: 'y' },
      handoffContext: makeContext({ sourceIssueUrl: null, escapeEligible: false }),
    });
    expect(result.blocked).toBe(false);
  });
});

describe('pr-issue-guard — sourceIssueUrl path (Bash)', () => {
  it('T1.4 sourceIssueUrl + body has Closes #N → pass', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "Closes #696"' },
      handoffContext: makeContext({ sourceIssueUrl: SOURCE }),
    });
    expect(result.blocked).toBe(false);
  });

  it('T1.5 sourceIssueUrl + body in heredoc with Closes #N → pass', () => {
    const cmd = `gh pr create --body "$(cat <<'EOF'\n## Summary\n\nSome text.\n\nCloses #696\nEOF\n)"`;
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: cmd },
      handoffContext: makeContext({ sourceIssueUrl: SOURCE }),
    });
    expect(result.blocked).toBe(false);
  });

  it('T1.6 sourceIssueUrl + no --body flag → block (missing-closes-issue)', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --title x' },
      handoffContext: makeContext({ sourceIssueUrl: SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-closes-issue');
    expect(result.message).toContain('Closes #696');
    expect(result.message).toContain('test-chain-id');
  });

  it('T1.7 sourceIssueUrl + body has no Closes → block (missing-closes-issue)', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "fixes the thing"' },
      handoffContext: makeContext({ sourceIssueUrl: SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-closes-issue');
  });

  it('T1.8 sourceIssueUrl + body has WRONG issue # → block (wrong-issue-number)', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "Closes #999"' },
      handoffContext: makeContext({ sourceIssueUrl: SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('wrong-issue-number');
    expect(result.message).toContain('#696');
  });
});

describe('pr-issue-guard — Bash adversarial (codex-flagged)', () => {
  it('T1.9 marker only in --title → block (--body content is "x")', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --title "Closes #696" --body "x"' },
      handoffContext: makeContext({ sourceIssueUrl: SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-closes-issue');
  });

  it('T1.10 marker in unrelated chained command → block (no --body in gh segment)', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'echo "Closes #696" && gh pr create --title x' },
      handoffContext: makeContext({ sourceIssueUrl: SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-closes-issue');
  });

  it('T1.11 marker in shell var assignment, body uses different var → block', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'BODY="Closes #696"; gh pr create --body "$OTHER"' },
      handoffContext: makeContext({ sourceIssueUrl: SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-closes-issue');
  });

  it('T1.17 --body in echo BEFORE gh segment → block (gh-anchor skips first --body)', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'echo "--body Closes #696" && gh pr create --body "x"' },
      handoffContext: makeContext({ sourceIssueUrl: SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-closes-issue');
  });

  it('T1.20 --body-file with marker in chained tail → block (file content not visible to static check)', () => {
    // Per spec AD-6, --body-file is out of scope (file-backed body). Without explicit
    // exclusion, the chained `echo "Closes #696"` after --body-file body.md would
    // false-pass because the regex would have matched --body-file and returned the
    // rest of the command as "body content". The `(?!-)` negative lookahead in the
    // extractor explicitly excludes --body-file.
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: {
        command: 'gh pr create --body-file body.md && echo "Closes #696"',
      },
      handoffContext: makeContext({ sourceIssueUrl: SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-closes-issue');
  });
});

describe('pr-issue-guard — escapeEligible path (Bash)', () => {
  it('T1.12 escapeEligible + body has Case A escape → pass', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: {
        command: 'gh pr create --body "Case A escape (tier=tiny, no issue by policy)"',
      },
      handoffContext: makeContext({ sourceIssueUrl: null, escapeEligible: true }),
    });
    expect(result.blocked).toBe(false);
  });

  it('T1.13 escapeEligible + body missing marker → block (missing-escape-marker)', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "did stuff"' },
      handoffContext: makeContext({ sourceIssueUrl: null, escapeEligible: true }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-escape-marker');
  });

  it('T1.14 escapeEligible=false + escape marker attempted → block (no-issue-no-escape)', () => {
    // Issue body acceptance #2: escape path NOT activated unless escapeEligible=true,
    // even if the marker text is present.
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "Case A escape (tier=tiny)"' },
      handoffContext: makeContext({ sourceIssueUrl: null, escapeEligible: false }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('no-issue-no-escape');
  });
});

describe('pr-issue-guard — MCP path', () => {
  it('T1.15 MCP create_pull_request with Closes #N in body → pass', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'mcp__github__create_pull_request',
      toolInput: { body: 'Closes #696\n\n## Summary\n...' },
      handoffContext: makeContext({ sourceIssueUrl: SOURCE }),
    });
    expect(result.blocked).toBe(false);
  });

  it('T1.18 MCP wrong issue number → block (wrong-issue-number)', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'mcp__github__create_pull_request',
      toolInput: { body: 'Closes #999' },
      handoffContext: makeContext({ sourceIssueUrl: SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('wrong-issue-number');
  });

  it('T1.19 MCP escapeEligible + missing escape marker → block (missing-escape-marker)', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'mcp__github__create_pull_request',
      toolInput: { body: 'did stuff' },
      handoffContext: makeContext({ sourceIssueUrl: null, escapeEligible: true }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-escape-marker');
  });

  it('T1.21 MCP with non-string body → block (unknown-tool-shape defensive branch)', () => {
    // Defends against malformed MCP input. Static type can't always guarantee body
    // is a string in untyped tool_input from the SDK boundary.
    const result = handlePrIssuePrecondition({
      toolName: 'mcp__github__create_pull_request',
      toolInput: { body: 123 as unknown as string },
      handoffContext: makeContext({ sourceIssueUrl: SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('unknown-tool-shape');
  });
});

describe('pr-issue-guard — defensive branches', () => {
  it('T1.22 sourceIssueUrl with malformed URL (no /issues/<n>) → block (malformed-source-issue-url)', () => {
    // Should not happen if parseHandoff did its job, but defense-in-depth.
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "Closes #696"' },
      handoffContext: makeContext({ sourceIssueUrl: 'https://example.com/not-an-issue' }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('malformed-source-issue-url');
  });
});

describe('pr-issue-guard — precedence', () => {
  it('T1.16 mixed metadata: sourceIssueUrl AND escapeEligible=true — issue path wins', () => {
    // Per spec AD-8: a handoff with both fields set is a producer-side bug; the issue is
    // authoritative. Only Closes #N satisfies the guard, NOT the escape marker.
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "Case A escape"' },
      handoffContext: makeContext({ sourceIssueUrl: SOURCE, escapeEligible: true }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-closes-issue');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests for the SDK hook factory (S2 — wire into claude-handler.ts)
// ─────────────────────────────────────────────────────────────────────────────

function makeLogger(): PrIssueHookLogger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  const info = vi.fn<(msg: string, data?: Record<string, unknown>) => void>();
  const warn = vi.fn<(msg: string, data?: Record<string, unknown>) => void>();
  return { info, warn };
}

describe('buildPrIssueHookEntries — SDK hook factory', () => {
  const LOG_CTX = { channel: 'C123', threadTs: '171.001' };

  it('returns two entries: one for Bash, one for mcp__', () => {
    const entries = buildPrIssueHookEntries({
      getHandoffContext: () => undefined,
      logger: makeLogger(),
      logCtx: LOG_CTX,
    });
    expect(entries).toHaveLength(2);
    expect(entries[0].matcher).toBe('Bash');
    expect(entries[1].matcher).toBe('mcp__');
    expect(entries[0].hooks).toHaveLength(1);
    expect(entries[1].hooks).toHaveLength(1);
  });

  it('T2.1 Bash gh pr create with no-issue handoffContext → permissionDecision=deny + message', async () => {
    const logger = makeLogger();
    const ctx = makeContext({ sourceIssueUrl: null, escapeEligible: false });
    const entries = buildPrIssueHookEntries({
      getHandoffContext: () => ctx,
      logger,
      logCtx: LOG_CTX,
    });
    const bashHook = entries[0].hooks[0];
    const output = await bashHook({
      hook_event_name: 'PreToolUse',
      session_id: 'sdk-x',
      transcript_path: '',
      cwd: '',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title x' },
    } as Parameters<typeof bashHook>[0]);

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    const reason = (
      output as {
        hookSpecificOutput: { permissionDecisionReason: string };
      }
    ).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('no-issue-no-escape');
    expect(reason).toContain('test-chain-id');
    expect(logger.warn).toHaveBeenCalledWith(
      'PR creation blocked by handoff precondition',
      expect.objectContaining({
        channel: 'C123',
        threadTs: '171.001',
        tool: 'Bash',
        reason: 'no-issue-no-escape',
        chainId: 'test-chain-id',
      }),
    );
  });

  it('T2.2 MCP create_pull_request with no-issue handoffContext → permissionDecision=deny', async () => {
    const logger = makeLogger();
    const ctx = makeContext({ sourceIssueUrl: null, escapeEligible: false });
    const entries = buildPrIssueHookEntries({
      getHandoffContext: () => ctx,
      logger,
      logCtx: LOG_CTX,
    });
    const mcpHook = entries[1].hooks[0];
    const output = await mcpHook({
      hook_event_name: 'PreToolUse',
      session_id: 'sdk-x',
      transcript_path: '',
      cwd: '',
      tool_name: 'mcp__github__create_pull_request',
      tool_input: { body: 'just stuff' },
    } as Parameters<typeof mcpHook>[0]);

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('T2.3 bypass-mode precedence: even with bypass enabled, our hook returns deny → SDK precedence makes deny win', async () => {
    // The bypass-mode Bash hook (claude-handler.ts:865-907) returns
    // permissionDecision='allow' for non-dangerous commands. Our hook returns
    // permissionDecision='deny' for handoff-no-issue. Per SDK runtime
    // (cli.js:8208-8240), the precedence is `deny > defer > ask > allow`,
    // so the deny wins regardless of order. We can't directly assert SDK
    // aggregation in a unit test (no SDK runtime here), but we CAN assert
    // that our hook unconditionally returns deny in this scenario — which
    // is the precondition for the SDK rule to take effect.
    const logger = makeLogger();
    const ctx = makeContext({ sourceIssueUrl: null, escapeEligible: false });
    const entries = buildPrIssueHookEntries({
      getHandoffContext: () => ctx,
      logger,
      logCtx: LOG_CTX,
    });
    const bashHook = entries[0].hooks[0];
    const output = await bashHook({
      hook_event_name: 'PreToolUse',
      session_id: 'sdk-x',
      transcript_path: '',
      cwd: '',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title x' },
    } as Parameters<typeof bashHook>[0]);

    expect(
      (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision,
    ).toBe('deny');
    // SDK precedence (deny > allow) is the SDK's responsibility — our contract
    // is to return deny consistently regardless of whether bypass is enabled.
  });

  it('skips enforcement (continue: true) when handoffContext is undefined and emits info log', async () => {
    const logger = makeLogger();
    const entries = buildPrIssueHookEntries({
      getHandoffContext: () => undefined,
      logger,
      logCtx: LOG_CTX,
    });
    const bashHook = entries[0].hooks[0];
    const output = await bashHook({
      hook_event_name: 'PreToolUse',
      session_id: 'sdk-x',
      transcript_path: '',
      cwd: '',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title x' },
    } as Parameters<typeof bashHook>[0]);

    expect(output).toEqual({ continue: true });
    expect(logger.info).toHaveBeenCalledWith(
      'PR-issue guard skipped: no handoff context on PR-create attempt',
      LOG_CTX,
    );
  });

  it('mcp__ matcher filters: non-create_pull_request mcp__ tools pass through', async () => {
    const logger = makeLogger();
    const ctx = makeContext({ sourceIssueUrl: null, escapeEligible: false });
    const entries = buildPrIssueHookEntries({
      getHandoffContext: () => ctx,
      logger,
      logCtx: LOG_CTX,
    });
    const mcpHook = entries[1].hooks[0];
    const output = await mcpHook({
      hook_event_name: 'PreToolUse',
      session_id: 'sdk-x',
      transcript_path: '',
      cwd: '',
      tool_name: 'mcp__github__list_issues',
      tool_input: { owner: 'x', repo: 'y' },
    } as Parameters<typeof mcpHook>[0]);

    expect(output).toEqual({ continue: true });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
