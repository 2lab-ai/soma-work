/**
 * Tests for the tiered (HA-style) executive summary.
 *
 * Three semantic modes `brief` / `issue` / `epic` chosen by
 * `selectExecutiveSummaryMode(session)` from session state. The host (Path B)
 * injects the mode; the per-mode template is composed with the global
 * `SUMMARY_PROMPT` rules.
 *
 * Top-of-document invariant: SSOT (user request) first, Status (issue/PR
 * links + state) second on every mode that has artifacts. `brief` omits
 * Status when no durable artifact exists — empty Status would train readers
 * to ignore the top.
 *
 * Trace: docs/turn-summary-lifecycle (S3, S5).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type ExecutiveSummaryMode,
  type ForkExecutor,
  SUMMARY_PROMPT,
  SummaryService,
  type SummarySessionInfo,
  selectExecutiveSummaryMode,
} from '../summary-service.js';

describe('Executive Summary — tiered (HA)', () => {
  function makeSession(overrides: Partial<SummarySessionInfo> = {}): SummarySessionInfo {
    return {
      isActive: true,
      model: 'claude-opus-4-6',
      actionPanel: {},
      ...overrides,
    };
  }

  function prLink(num: number, status = 'open') {
    return {
      url: `https://github.com/org/repo/pull/${num}`,
      type: 'pr' as const,
      provider: 'github' as const,
      title: `PR ${num}`,
      label: `#${num}`,
      status,
    };
  }
  function issueLink(num: number, status = 'open') {
    return {
      url: `https://jira.example.com/ISSUE-${num}`,
      type: 'issue' as const,
      provider: 'jira' as const,
      title: `Issue ${num}`,
      label: `ISSUE-${num}`,
      status,
    };
  }

  describe('selectExecutiveSummaryMode()', () => {
    it('returns "brief" when there is no active link and no link history', () => {
      const session = makeSession();
      expect(selectExecutiveSummaryMode(session)).toBe<ExecutiveSummaryMode>('brief');
    });

    it('returns "brief" when linkHistory is empty', () => {
      const session = makeSession({ linkHistory: { issues: [], prs: [], docs: [] } });
      expect(selectExecutiveSummaryMode(session)).toBe<ExecutiveSummaryMode>('brief');
    });

    it('returns "issue" when there is exactly one PR in history', () => {
      const session = makeSession({
        links: { pr: prLink(1) },
        linkHistory: { issues: [], prs: [prLink(1)], docs: [] },
      });
      expect(selectExecutiveSummaryMode(session)).toBe<ExecutiveSummaryMode>('issue');
    });

    it('returns "issue" when there is exactly one issue in history (no PR)', () => {
      const session = makeSession({
        links: { issue: issueLink(42) },
        linkHistory: { issues: [issueLink(42)], prs: [], docs: [] },
      });
      expect(selectExecutiveSummaryMode(session)).toBe<ExecutiveSummaryMode>('issue');
    });

    it('returns "issue" — parent-epic link on a single-PR leaf does NOT upgrade to epic', () => {
      // A sub-issue of an epic in the middle of a leaf z-work turn stays
      // "issue". Without this rule, every chained sub-issue renders as epic.
      const session = makeSession({
        links: { pr: prLink(1), issue: issueLink(1) },
        linkHistory: { issues: [issueLink(1)], prs: [prLink(1)], docs: [] },
        handoffContext: {
          handoffKind: 'plan-to-work',
          sourceIssueUrl: 'https://jira.example.com/ISSUE-1',
          escapeEligible: false,
          tier: 'medium',
          issueRequiredByUser: false,
          parentEpicUrl: 'https://jira.example.com/EPIC-99',
          chainId: 'chain-1',
          hopBudget: 5,
        },
      });
      expect(selectExecutiveSummaryMode(session)).toBe<ExecutiveSummaryMode>('issue');
    });

    it('returns "epic" when linkHistory has ≥2 PRs', () => {
      const session = makeSession({
        links: { pr: prLink(2) },
        linkHistory: { issues: [], prs: [prLink(1, 'merged'), prLink(2)], docs: [] },
      });
      expect(selectExecutiveSummaryMode(session)).toBe<ExecutiveSummaryMode>('epic');
    });

    it('returns "epic" when linkHistory has ≥2 issues', () => {
      const session = makeSession({
        links: { issue: issueLink(2) },
        linkHistory: { issues: [issueLink(1), issueLink(2)], prs: [], docs: [] },
      });
      expect(selectExecutiveSummaryMode(session)).toBe<ExecutiveSummaryMode>('epic');
    });

    it('returns "epic" when workflow is z-epic-update', () => {
      const session = makeSession({
        workflow: 'z-epic-update',
        linkHistory: { issues: [issueLink(1)], prs: [], docs: [] },
      });
      expect(selectExecutiveSummaryMode(session)).toBe<ExecutiveSummaryMode>('epic');
    });

    it('mode-stickiness via linkHistory: a "quiet" turn after an issue stays at "issue"', () => {
      // No new PR this turn, but linkHistory still records the earlier PR ->
      // we don't downgrade to "brief". Natural stickiness from linkHistory
      // monotonic accumulation in session-registry.updateSessionResources.
      const session = makeSession({
        links: {}, // no active pointer right now
        linkHistory: { issues: [], prs: [prLink(1, 'merged')], docs: [] },
      });
      expect(selectExecutiveSummaryMode(session)).toBe<ExecutiveSummaryMode>('issue');
    });

    it('lastSummaryMode floor: epic prior summary is never downgraded to brief on a cleared session', () => {
      // Pathological case the linkHistory-only argument does NOT cover: if a
      // host reset clears linkHistory mid-session, we still must not erase
      // the previously-rendered epic summary with a `brief`. The
      // `lastSummaryMode` floor enforces that.
      const session = makeSession({
        links: {},
        linkHistory: { issues: [], prs: [], docs: [] },
        lastSummaryMode: 'epic',
      });
      expect(selectExecutiveSummaryMode(session)).toBe<ExecutiveSummaryMode>('epic');
    });

    it('lastSummaryMode floor allows upgrade (issue → epic) when new artifacts justify it', () => {
      // Floor must not block legitimate upgrades — only block downgrades.
      const session = makeSession({
        linkHistory: { issues: [], prs: [prLink(1, 'merged'), prLink(2)], docs: [] },
        lastSummaryMode: 'issue',
      });
      expect(selectExecutiveSummaryMode(session)).toBe<ExecutiveSummaryMode>('epic');
    });
  });

  describe('displayOnThread records lastSummaryMode for stickiness', () => {
    it('writes session.lastSummaryMode after a successful display', () => {
      const service = new SummaryService();
      const session = makeSession({
        links: { pr: prLink(1) },
        linkHistory: { issues: [], prs: [prLink(1)], docs: [] },
      });
      service.displayOnThread(session, 'Summary text');
      expect(session.lastSummaryMode).toBe<ExecutiveSummaryMode>('issue');
    });
  });

  describe('SummaryService.buildPrompt() — mode injection', () => {
    it('declares "Active ES mode: brief" when there are no artifacts', () => {
      const service = new SummaryService();
      const prompt = service.buildPrompt(makeSession());
      expect(prompt).toMatch(/Active ES mode:\s*brief/i);
    });

    it('declares "Active ES mode: issue" for single PR sessions', () => {
      const service = new SummaryService();
      const prompt = service.buildPrompt(
        makeSession({
          links: { pr: prLink(7) },
          linkHistory: { issues: [], prs: [prLink(7)], docs: [] },
        }),
      );
      expect(prompt).toMatch(/Active ES mode:\s*issue/i);
    });

    it('declares "Active ES mode: epic" for multi-PR sessions', () => {
      const service = new SummaryService();
      const prompt = service.buildPrompt(
        makeSession({
          links: { pr: prLink(8) },
          linkHistory: { issues: [], prs: [prLink(7, 'merged'), prLink(8)], docs: [] },
        }),
      );
      expect(prompt).toMatch(/Active ES mode:\s*epic/i);
    });

    it('tells the model NOT to reclassify (host-selected)', () => {
      // The transcript-based one-shot summary cannot reliably count artifacts;
      // we deliberately freeze the mode on the host side.
      const service = new SummaryService();
      const prompt = service.buildPrompt(makeSession());
      expect(prompt).toMatch(/do not reclassify|host[- ]selected/i);
    });

    it('always preserves the global SUMMARY_PROMPT rules (backward compat)', () => {
      const service = new SummaryService();
      const prompt = service.buildPrompt(makeSession());
      expect(prompt).toContain(SUMMARY_PROMPT);
    });
  });

  describe('Per-mode template content', () => {
    function builtPrompt(session: SummarySessionInfo): string {
      return new SummaryService().buildPrompt(session);
    }

    it('"brief" mode mentions SSOT and Outcome and DOES NOT demand a Status table when no link', () => {
      const p = builtPrompt(makeSession());
      // SSOT + Outcome are required even at the lowest tier.
      expect(p.toLowerCase()).toContain('ssot');
      expect(p.toLowerCase()).toMatch(/outcome|what was done|what happened/);
      // The "brief, no artifact" template must NOT render an empty Status
      // section — that would train readers to skip the top of the document.
      expect(p.toLowerCase()).toMatch(/omit status|skip status|no.*status section/);
    });

    it('"issue" mode pins Status (Issue/PR/State) immediately AFTER SSOT — top-of-document invariant', () => {
      const p = builtPrompt(
        makeSession({
          links: { pr: prLink(7) },
          linkHistory: { issues: [], prs: [prLink(7)], docs: [] },
        }),
      );
      // Use lowercase index search so we don't depend on exact casing.
      const lower = p.toLowerCase();
      const ssotIdx = lower.indexOf('ssot');
      const statusIdx = lower.indexOf('status');
      expect(ssotIdx).toBeGreaterThan(-1);
      expect(statusIdx).toBeGreaterThan(-1);
      // SSOT appears before Status. (Both must appear above other sections.)
      expect(ssotIdx).toBeLessThan(statusIdx);
    });

    it('"issue" mode template asks for concrete artifacts (files / commands / commits / PR numbers)', () => {
      const p = builtPrompt(
        makeSession({
          links: { pr: prLink(7) },
          linkHistory: { issues: [], prs: [prLink(7)], docs: [] },
        }).toString === undefined
          ? makeSession({
              links: { pr: prLink(7) },
              linkHistory: { issues: [], prs: [prLink(7)], docs: [] },
            })
          : makeSession(),
      );
      const lower = p.toLowerCase();
      expect(lower).toMatch(/file path|file:|files? (edited|changed|touched)/);
      expect(lower).toMatch(/command|commit/);
    });

    it('"epic" mode template includes Risks/Blockers + Workstream Status + Verification', () => {
      const p = builtPrompt(
        makeSession({
          links: { pr: prLink(8) },
          linkHistory: { issues: [], prs: [prLink(7, 'merged'), prLink(8)], docs: [] },
        }),
      );
      const lower = p.toLowerCase();
      // Epic-only sections per design.
      expect(lower).toMatch(/workstream|child (issues?|prs?)/);
      expect(lower).toMatch(/risk|blocker/);
      expect(lower).toMatch(/verif/);
    });

    it('"epic" mode template forbids leaf-implementation detail (HA discipline)', () => {
      // Codex's strongest argument #1: epic-mode "real artifacts" are issues
      // and PR links, NOT file/function-level detail. The template must say
      // so explicitly, otherwise the epic ES regresses into a long issue ES.
      const p = builtPrompt(
        makeSession({
          links: { pr: prLink(8) },
          linkHistory: { issues: [], prs: [prLink(7, 'merged'), prLink(8)], docs: [] },
        }),
      );
      const lower = p.toLowerCase();
      expect(lower).toMatch(/no file paths?|avoid file paths?|do not list file paths?|exclude file paths?/);
    });
  });

  describe('execute() — fork integration with mode', () => {
    it('passes the mode-tagged prompt through to forkExecutor', async () => {
      const mockFork: ForkExecutor = vi.fn().mockResolvedValue('summary');
      const service = new SummaryService(mockFork);
      const session = makeSession({
        links: { pr: prLink(1) },
        linkHistory: { issues: [], prs: [prLink(1)], docs: [] },
      });
      await service.execute(session);
      const calledPrompt = (mockFork as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledPrompt).toMatch(/Active ES mode:\s*issue/i);
    });
  });
});
