import { describe, expect, it, vi } from 'vitest';

/**
 * Contract tests for Issue #64, Scenarios 4-5:
 * postSourceThreadSummary — shared utility for posting summaries to original thread
 * Trace: docs/mid-thread-initial-response/trace.md
 *
 * These tests are RED — the module does not exist yet.
 */

// Trace: S4, Sec 3b — postSourceThreadSummary 함수 존재 확인
describe('postSourceThreadSummary', () => {
  it('should be importable from source-thread-summary module', async () => {
    // RED: module does not exist yet
    const mod = await import('./source-thread-summary');
    expect(mod.postSourceThreadSummary).toBeDefined();
    expect(typeof mod.postSourceThreadSummary).toBe('function');
  });
});

describe('Scenario 4: PR merge posts summary to source thread', () => {
  // Trace: S4, Sec 3a — sourceThread 있는 세션 머지
  it('prMerge_postsSourceThreadSummary: posts summary when sourceThread exists', async () => {
    const mockSlackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: 'summary-msg-ts' }),
      getPermalink: vi.fn().mockResolvedValue('https://slack.com/archives/C_NEW/p123'),
    };

    const session = {
      title: 'Fix login redirect',
      workflow: 'pr-review',
      channelId: 'C_NEW',
      threadTs: 'new-thread-ts',
      threadRootTs: 'new-root-ts',
      sourceThread: {
        channel: 'C_ORIGINAL',
        threadTs: '1711234567.000100',
      },
      links: {
        issue: { url: 'https://github.com/org/repo/issues/64', label: '#64' },
        pr: { url: 'https://github.com/org/repo/pull/65', label: 'PR #65', status: 'merged' },
      },
    };

    const { postSourceThreadSummary } = await import('./source-thread-summary');
    await postSourceThreadSummary(mockSlackApi as any, session as any, 'merged');

    // Should post to the ORIGINAL thread
    expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
      'C_ORIGINAL',
      expect.stringContaining('Fix login redirect'),
      expect.objectContaining({ threadTs: '1711234567.000100' }),
    );
  });

  // Trace: S4, Sec 5 — sourceThread 없으면 스킵
  it('prMerge_noSourceThread_skips: does nothing when sourceThread is undefined', async () => {
    const mockSlackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
      getPermalink: vi.fn().mockResolvedValue(null),
    };

    const session = {
      title: 'Some work',
      channelId: 'C_NEW',
      threadTs: 'thread-ts',
      // sourceThread: undefined — no mid-thread origin
      links: {},
    };

    const { postSourceThreadSummary } = await import('./source-thread-summary');
    await postSourceThreadSummary(mockSlackApi as any, session as any, 'merged');

    // Should NOT post anything
    expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
  });

  // Trace: S4, Sec 3b — 링크 포함 확인
  it('postSourceThreadSummary_includesLinks: summary includes issue and PR links', async () => {
    const mockSlackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
      getPermalink: vi.fn().mockResolvedValue('https://slack.com/archives/C_NEW/p123'),
    };

    const session = {
      title: 'Fix login redirect',
      workflow: 'pr-review',
      channelId: 'C_NEW',
      threadTs: 'thread-ts',
      threadRootTs: 'root-ts',
      sourceThread: {
        channel: 'C_ORIGINAL',
        threadTs: '1711234567.000100',
      },
      links: {
        issue: { url: 'https://github.com/org/repo/issues/64', label: '#64' },
        pr: { url: 'https://github.com/org/repo/pull/65', label: 'PR #65' },
      },
    };

    const { postSourceThreadSummary } = await import('./source-thread-summary');
    await postSourceThreadSummary(mockSlackApi as any, session as any, 'merged');

    // Block Kit: URLs are in blocks, not in fallback text
    const callArgs = mockSlackApi.postMessage.mock.calls[0];
    const opts = callArgs?.[2];
    const blocksJson = JSON.stringify(opts?.blocks ?? []);
    expect(blocksJson).toContain('github.com/org/repo/issues/64');
    expect(blocksJson).toContain('github.com/org/repo/pull/65');
  });

  // Trace: S4, Sec 5 — postMessage 실패 시 throw 안 함
  it('postSourceThreadSummary_postFailure_noThrow: does not throw on postMessage failure', async () => {
    const mockSlackApi = {
      postMessage: vi.fn().mockRejectedValue(new Error('Slack API error')),
      getPermalink: vi.fn().mockResolvedValue('https://slack.com/archives/C_NEW/p123'),
    };

    const session = {
      title: 'Fix',
      channelId: 'C_NEW',
      threadTs: 'ts',
      sourceThread: { channel: 'C_ORIGINAL', threadTs: '123.456' },
      links: {},
    };

    const { postSourceThreadSummary } = await import('./source-thread-summary');

    // Should not throw
    await expect(postSourceThreadSummary(mockSlackApi as any, session as any, 'merged')).resolves.not.toThrow();
  });
});

describe('Scenario 5: session close posts summary to source thread', () => {
  // Trace: S5, Sec 3a — sourceThread 있는 세션 종료
  it('sessionClose_postsSourceThreadSummary: posts summary with closed trigger', async () => {
    const mockSlackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
      getPermalink: vi.fn().mockResolvedValue('https://slack.com/archives/C_NEW/p123'),
    };

    const session = {
      title: 'Code review task',
      workflow: 'default',
      channelId: 'C_NEW',
      threadTs: 'thread-ts',
      threadRootTs: 'root-ts',
      sourceThread: {
        channel: 'C_ORIGINAL',
        threadTs: '1711234567.000100',
      },
      links: {},
    };

    const { postSourceThreadSummary } = await import('./source-thread-summary');
    await postSourceThreadSummary(mockSlackApi as any, session as any, 'closed');

    expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
      'C_ORIGINAL',
      expect.any(String),
      expect.objectContaining({ threadTs: '1711234567.000100' }),
    );
  });

  // Trace: S5, Sec 5 — sourceThread 없으면 스킵
  it('sessionClose_noSourceThread_skips: does nothing when no sourceThread', async () => {
    const mockSlackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
      getPermalink: vi.fn().mockResolvedValue(null),
    };

    const session = {
      title: 'Task',
      channelId: 'C_NEW',
      threadTs: 'ts',
      links: {},
    };

    const { postSourceThreadSummary } = await import('./source-thread-summary');
    await postSourceThreadSummary(mockSlackApi as any, session as any, 'closed');

    expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
  });
});
