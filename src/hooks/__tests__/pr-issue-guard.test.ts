/**
 * Unit tests for PR-issue precondition guard (#696).
 *
 * Trace: docs/archive/features/pr-issue-precondition/trace.md (v2.1) §S1 — 19 tests covering
 * tool-shape detection, sourceIssueUrl path, escapeEligible path, MCP path,
 * adversarial inputs (codex-flagged), and precedence.
 */

import { describe, expect, it } from 'vitest';
import type { HandoffContext } from '../../types';
import { handlePrIssuePrecondition } from '../pr-issue-guard';

const SOURCE = 'https://github.com/2lab-ai/soma-work/issues/696';

function makeContext(overrides: Partial<HandoffContext> = {}): HandoffContext {
  return {
    handoffKind: 'plan-to-work',
    sourceIssueUrl: null,
    parentEpicUrl: null,
    escapeEligible: false,
    tier: null,
    issueRequiredByUser: true,
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
// Jira source URL coverage (#885)
//
// Mirrors the GitHub matrix for Atlassian Cloud `/browse/<KEY>-<NUM>` sources.
// Recognized URL form (codex-agreed):
//   /^https:\/\/[A-Za-z0-9][A-Za-z0-9-]*\.atlassian\.net\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:[/?#]|$)/
//
// Body satisfies the guard when EITHER:
//   - case-insensitive `Closes <KEY>` (parallel to `Closes #N`), OR
//   - the matching Jira URL appears verbatim in the body.
// Bare key alone (`PROJ-4217`) does NOT satisfy — false-pass risk from
// accidental mentions in commentary.
//
// New reason codes (preserve existing): `missing-jira-key`, `wrong-jira-key`.
// Cross-provider closure markers (`Closes #696` against a Jira source, or vice
// versa) never satisfy — guard validates against the *source* provider.
// ─────────────────────────────────────────────────────────────────────────────

const JIRA_SOURCE = 'https://yourcompany.atlassian.net/browse/PROJ-4217';

describe('pr-issue-guard — Jira source path (Bash)', () => {
  it('T1.23 Jira source + body has `Closes PROJ-4217` → pass', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "Closes PROJ-4217"' },
      handoffContext: makeContext({ sourceIssueUrl: JIRA_SOURCE }),
    });
    expect(result.blocked).toBe(false);
  });

  it('T1.24 Jira source + body has lowercase `closes PROJ-4217` → pass (case-insensitive)', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "closes proj-4217 fixes the thing"' },
      handoffContext: makeContext({ sourceIssueUrl: JIRA_SOURCE }),
    });
    expect(result.blocked).toBe(false);
  });

  it('T1.25 Jira source + full matching Jira URL in body → pass', () => {
    const cmd = `gh pr create --body "See ${JIRA_SOURCE} for context"`;
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: cmd },
      handoffContext: makeContext({ sourceIssueUrl: JIRA_SOURCE }),
    });
    expect(result.blocked).toBe(false);
  });

  it('T1.26 Jira source + body heredoc with `Closes PROJ-4217` → pass', () => {
    const cmd = `gh pr create --body "$(cat <<'EOF'\n## Summary\n\nSome text.\n\nCloses PROJ-4217\nEOF\n)"`;
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: cmd },
      handoffContext: makeContext({ sourceIssueUrl: JIRA_SOURCE }),
    });
    expect(result.blocked).toBe(false);
  });

  it('T1.27 Jira source + no --body flag → block (missing-jira-key)', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --title x' },
      handoffContext: makeContext({ sourceIssueUrl: JIRA_SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-jira-key');
    expect(result.message).toContain('PROJ-4217');
    expect(result.message).toContain('test-chain-id');
  });

  it('T1.28 Jira source + body has no marker → block (missing-jira-key)', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "fixes the thing"' },
      handoffContext: makeContext({ sourceIssueUrl: JIRA_SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-jira-key');
  });

  it('T1.29 Jira source + bare key PROJ-4217 (no Closes) → block (missing-jira-key)', () => {
    // Bare key in body must NOT satisfy — accidental mentions in commentary
    // could false-pass. Requires explicit `Closes <KEY>` or the full URL.
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "Related ticket: PROJ-4217"' },
      handoffContext: makeContext({ sourceIssueUrl: JIRA_SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-jira-key');
  });

  it('T1.30 Jira source + body has `Closes PROJ-9999` (wrong key) → block (wrong-jira-key)', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "Closes PROJ-9999"' },
      handoffContext: makeContext({ sourceIssueUrl: JIRA_SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('wrong-jira-key');
    expect(result.message).toContain('PROJ-4217');
  });

  it('T1.31 Jira source + body has different project key `Closes ABC-4217` → block (wrong-jira-key)', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "Closes ABC-4217"' },
      handoffContext: makeContext({ sourceIssueUrl: JIRA_SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('wrong-jira-key');
  });

  it('T1.32 Jira source + GitHub-style `Closes #696` (cross-provider) → block (missing-jira-key)', () => {
    // GitHub closure marker MUST NOT satisfy a Jira source. The guard validates
    // against the SOURCE provider, not any issue-like reference.
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "Closes #696"' },
      handoffContext: makeContext({ sourceIssueUrl: JIRA_SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-jira-key');
  });

  it('T1.33 GitHub source + Jira-style `Closes PROJ-4217` (cross-provider) → block (missing-closes-issue)', () => {
    // The reverse: Jira closure marker must not satisfy a GitHub source.
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "Closes PROJ-4217"' },
      handoffContext: makeContext({ sourceIssueUrl: SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-closes-issue');
  });
});

describe('pr-issue-guard — Jira Bash adversarial', () => {
  it('T1.34 Jira marker only in --title → block (--body content is "x")', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: {
        command: 'gh pr create --title "Closes PROJ-4217" --body "x"',
      },
      handoffContext: makeContext({ sourceIssueUrl: JIRA_SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-jira-key');
  });

  it('T1.35 Jira marker in unrelated chained command → block', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: {
        command: 'echo "Closes PROJ-4217" && gh pr create --title x',
      },
      handoffContext: makeContext({ sourceIssueUrl: JIRA_SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-jira-key');
  });

  it('T1.36 Jira --body-file with marker in chained tail → block', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: {
        command: 'gh pr create --body-file body.md && echo "Closes PROJ-4217"',
      },
      handoffContext: makeContext({ sourceIssueUrl: JIRA_SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-jira-key');
  });
});

describe('pr-issue-guard — Jira MCP path', () => {
  it('T1.37 MCP create_pull_request with `Closes PROJ-4217` → pass', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'mcp__github__create_pull_request',
      toolInput: { body: 'Closes PROJ-4217\n\n## Summary\n...' },
      handoffContext: makeContext({ sourceIssueUrl: JIRA_SOURCE }),
    });
    expect(result.blocked).toBe(false);
  });

  it('T1.38 MCP create_pull_request with full Jira URL in body → pass', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'mcp__github__create_pull_request',
      toolInput: { body: `Tracking: ${JIRA_SOURCE}` },
      handoffContext: makeContext({ sourceIssueUrl: JIRA_SOURCE }),
    });
    expect(result.blocked).toBe(false);
  });

  it('T1.39 MCP wrong Jira key → block (wrong-jira-key)', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'mcp__github__create_pull_request',
      toolInput: { body: 'Closes PROJ-9999' },
      handoffContext: makeContext({ sourceIssueUrl: JIRA_SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('wrong-jira-key');
  });

  it('T1.40 MCP missing Jira marker → block (missing-jira-key)', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'mcp__github__create_pull_request',
      toolInput: { body: 'did stuff' },
      handoffContext: makeContext({ sourceIssueUrl: JIRA_SOURCE }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('missing-jira-key');
  });
});

describe('pr-issue-guard — Jira malformed source URLs', () => {
  it('T1.41 lowercase project key → malformed-source-issue-url', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "Closes proj-4217"' },
      handoffContext: makeContext({
        sourceIssueUrl: 'https://yourcompany.atlassian.net/browse/proj-4217',
      }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('malformed-source-issue-url');
  });

  it('T1.42 self-hosted /jira/browse path → malformed-source-issue-url', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "Closes PROJ-4217"' },
      handoffContext: makeContext({
        sourceIssueUrl: 'https://jira.example.com/jira/browse/PROJ-4217',
      }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('malformed-source-issue-url');
  });

  it('T1.43 board view with selectedIssue param → malformed-source-issue-url', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "Closes PROJ-4217"' },
      handoffContext: makeContext({
        sourceIssueUrl: 'https://yourcompany.atlassian.net/jira/software/projects/PTN/boards/1?selectedIssue=PROJ-4217',
      }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('malformed-source-issue-url');
  });

  it('T1.44 project key starts with digit → malformed-source-issue-url', () => {
    const result = handlePrIssuePrecondition({
      toolName: 'Bash',
      toolInput: { command: 'gh pr create --body "Closes 4PROJ-4217"' },
      handoffContext: makeContext({
        sourceIssueUrl: 'https://yourcompany.atlassian.net/browse/4PROJ-4217',
      }),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('malformed-source-issue-url');
  });
});
