import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  interceptToolResults,
  parseGhPrCreateResult,
  parseGhPrMergeResult,
  parseGitCommitResult,
} from './tool-result-interceptor';

// Contract tests — Scenario 3 (extended): ToolResultInterceptor
// Trace: docs/daily-weekly-report/trace.md

// Mock the metrics emitter
vi.mock('./event-emitter', () => {
  const mockEmitter = {
    emitGitHubEvent: vi.fn().mockResolvedValue(undefined),
  };
  return {
    getMetricsEmitter: () => mockEmitter,
    __mockEmitter: mockEmitter,
  };
});

// Access mock for assertions
import { getMetricsEmitter } from './event-emitter';

const mockEmitter = getMetricsEmitter() as any;

describe('ToolResultInterceptor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseGitCommitResult', () => {
    it('parses standard git commit output', () => {
      const output = `[main abc1234f] feat: add daily report
 3 files changed, 50 insertions(+), 10 deletions(-)`;
      const result = parseGitCommitResult(output);
      expect(result).toEqual({ sha: 'abc1234f', linesAdded: 50, linesDeleted: 10 });
    });

    it('parses commit with branch name containing slashes', () => {
      const output = `[feat/daily-report b6848d3] fix: update scheduler
 1 file changed, 5 insertions(+)`;
      const result = parseGitCommitResult(output);
      expect(result).toEqual({ sha: 'b6848d3', linesAdded: 5, linesDeleted: 0 });
    });

    it('returns null for non-commit output', () => {
      expect(parseGitCommitResult('On branch main')).toBeNull();
      expect(parseGitCommitResult('nothing to commit')).toBeNull();
    });

    it('handles singular insertion/deletion', () => {
      const output = `[main abc1234] fix typo
 1 file changed, 1 insertion(+), 1 deletion(-)`;
      const result = parseGitCommitResult(output);
      expect(result).toEqual({ sha: 'abc1234', linesAdded: 1, linesDeleted: 1 });
    });
  });

  describe('parseGhPrCreateResult', () => {
    it('parses gh pr create URL output', () => {
      const output = 'https://github.com/2lab-ai/soma-work/pull/82';
      const result = parseGhPrCreateResult(output);
      expect(result).toEqual({ prUrl: 'https://github.com/2lab-ai/soma-work/pull/82', prNumber: 82 });
    });

    it('extracts URL from surrounding text', () => {
      const output = `Creating pull request...
https://github.com/org/repo/pull/123
Done!`;
      const result = parseGhPrCreateResult(output);
      expect(result).toEqual({ prUrl: 'https://github.com/org/repo/pull/123', prNumber: 123 });
    });

    it('returns null for non-PR output', () => {
      expect(parseGhPrCreateResult('error: failed')).toBeNull();
    });
  });

  describe('parseGhPrMergeResult', () => {
    it('parses "Merged pull request #N"', () => {
      const output = '✓ Merged pull request #123 (fix: update scheduler)';
      const result = parseGhPrMergeResult(output);
      expect(result).toEqual({ prNumber: 123 });
    });

    it('parses merged with # number', () => {
      const output = 'Pull request #456 has been merged successfully.';
      const result = parseGhPrMergeResult(output);
      expect(result).toEqual({ prNumber: 456 });
    });

    it('returns null for non-merge output', () => {
      expect(parseGhPrMergeResult('Created PR #123')).toBeNull();
      expect(parseGhPrMergeResult('nothing happened')).toBeNull();
    });
  });

  describe('interceptToolResults', () => {
    it('emits commit_created and code_lines_added on git commit', () => {
      const toolResults = [
        {
          toolName: 'Bash',
          toolUseId: 'tu-1',
          result: `[main abc1234] feat: add feature
 3 files changed, 100 insertions(+), 20 deletions(-)`,
        },
      ];

      interceptToolResults(toolResults, 'U123', 'TestUser', 'session-key');

      expect(mockEmitter.emitGitHubEvent).toHaveBeenCalledTimes(2);
      // First call: commit_created
      expect(mockEmitter.emitGitHubEvent.mock.calls[0][0]).toBe('commit_created');
      expect(mockEmitter.emitGitHubEvent.mock.calls[0][4]).toEqual(
        expect.objectContaining({ commitSha: 'abc1234', linesAdded: 100, linesDeleted: 20 }),
      );
      // Second call: code_lines_added
      expect(mockEmitter.emitGitHubEvent.mock.calls[1][0]).toBe('code_lines_added');
    });

    it('emits pr_merged on gh pr merge output', () => {
      const toolResults = [
        {
          toolName: 'Bash',
          toolUseId: 'tu-2',
          result: '✓ Merged pull request #82 (feat: daily report)',
        },
      ];

      interceptToolResults(toolResults, 'U123', 'TestUser', 'session-key');

      expect(mockEmitter.emitGitHubEvent).toHaveBeenCalledWith(
        'pr_merged',
        'U123',
        'TestUser',
        'session-key',
        expect.objectContaining({ prNumber: 82 }),
      );
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

    it('does not emit code_lines_added when linesAdded is 0', () => {
      const toolResults = [
        {
          toolName: 'Bash',
          toolUseId: 'tu-5',
          result: `[main abc1234] empty commit
 0 files changed`,
        },
      ];

      interceptToolResults(toolResults, 'U123', 'TestUser', 'session-key');
      // Only commit_created, no code_lines_added
      expect(mockEmitter.emitGitHubEvent).toHaveBeenCalledTimes(1);
      expect(mockEmitter.emitGitHubEvent.mock.calls[0][0]).toBe('commit_created');
    });
  });
});
