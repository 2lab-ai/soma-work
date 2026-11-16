import { beforeEach, describe, expect, it, vi } from 'vitest';
import { interceptToolResults } from '../tool-result-interceptor';

// Contract tests — Scenario 3 (extended): ToolResultInterceptor
// Trace: docs/archive/features/daily-weekly-report/trace.md

// Mock the metrics emitter
vi.mock('../event-emitter', () => {
  const mockEmitter = {
    emitGitHubEvent: vi.fn().mockResolvedValue(undefined),
  };
  return {
    getMetricsEmitter: () => mockEmitter,
    __mockEmitter: mockEmitter,
  };
});

// Access mock for assertions
import { getMetricsEmitter } from '../event-emitter';

const mockEmitter = getMetricsEmitter() as any;

describe('ToolResultInterceptor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('interceptToolResults', () => {
    it('command output is not a code-change metric (.prd/26 §5): git commit and gh pr view --json additions', () => {
      interceptToolResults(
        [
          {
            toolName: 'Bash',
            toolUseId: 'c',
            result: '[main abc1234] feat: add feature\n 3 files changed, 100 insertions(+), 20 deletions(-)',
          },
          { toolName: 'Bash', toolUseId: 'v', result: '{"additions":150,"deletions":30,"number":12}' },
        ],
        'U123',
        'TestUser',
        'session-key',
      );
      expect(mockEmitter.emitGitHubEvent).not.toHaveBeenCalled();
    });

    it('emits pr_created and pr_merged from the write effects (#832), for any tool', () => {
      const pr = (n: number) => ({
        url: `https://github.com/a/b/pull/${n}`,
        type: 'pr' as const,
        provider: 'github' as const,
        label: `PR #${n}`,
      });
      interceptToolResults([], 'U123', 'TestUser', 'session-key', [
        { op: 'create', link: pr(81) },
        { op: 'merge', link: pr(82) },
        // A close and an issue are not PR metrics.
        { op: 'close', link: pr(83) },
        {
          op: 'create',
          link: { url: 'https://github.com/a/b/issues/9', type: 'issue', provider: 'github', label: '#9' },
        },
      ]);
      expect(mockEmitter.emitGitHubEvent.mock.calls.map((c: unknown[]) => [c[0], c[4]])).toEqual([
        // `proven`: the leak report (#835) names a creator only from these.
        ['pr_created', { prUrl: 'https://github.com/a/b/pull/81', prNumber: 81, proven: true }],
        ['pr_merged', { prNumber: 82 }],
      ]);
    });

    it('a PR URL or a merge line in plain output is not a metric without its write effect', () => {
      interceptToolResults(
        [
          { toolName: 'Bash', toolUseId: 'v', result: 'https://github.com/a/b/pull/40' },
          { toolName: 'Bash', toolUseId: 'm', result: '✓ Merged pull request #82 (feat: daily report)' },
        ],
        'U123',
        'TestUser',
        'session-key',
      );
      expect(mockEmitter.emitGitHubEvent).not.toHaveBeenCalled();
    });

    it('skips non-Bash tool results', () => {
      const toolResults = [
        {
          toolName: 'Read',
          toolUseId: 'tu-3',
          result: '[main abc1234] some content',
        },
      ];

      interceptToolResults(toolResults, 'U123', 'TestUser', 'session-key');
      expect(mockEmitter.emitGitHubEvent).not.toHaveBeenCalled();
    });

    it('skips errored tool results', () => {
      const toolResults = [
        {
          toolName: 'Bash',
          toolUseId: 'tu-4',
          result: '[main abc1234] commit msg',
          isError: true,
        },
      ];

      interceptToolResults(toolResults, 'U123', 'TestUser', 'session-key');
      expect(mockEmitter.emitGitHubEvent).not.toHaveBeenCalled();
    });
  });
});
