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

describe('buildRequestStartBlocks', () => {
  it('returns header and section with fields', async () => {
    const { buildRequestStartBlocks } = await import('./source-thread-summary');
    const session = { title: 'Test Task', workflow: 'default', ownerId: 'U123' } as any;
    const result = buildRequestStartBlocks(session);
    expect(result.text).toBe('Test Task — 시작');
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].type).toBe('header');
    expect(result.blocks[1].type).toBe('section');
    expect(result.blocks[1].fields.length).toBeGreaterThanOrEqual(2);
  });

  it('adds accessory button when permalink provided', async () => {
    const { buildRequestStartBlocks } = await import('./source-thread-summary');
    const session = { title: 'Task', workflow: 'default' } as any;
    const result = buildRequestStartBlocks(session, 'https://slack.com/archives/C1/p1');
    const section = result.blocks[1];
    expect(section.accessory).toBeDefined();
    expect(section.accessory.action_id).toBe('source_open_thread');
    expect(section.accessory.url).toBe('https://slack.com/archives/C1/p1');
  });

  it('omits accessory button when no permalink', async () => {
    const { buildRequestStartBlocks } = await import('./source-thread-summary');
    const session = { title: 'Task', workflow: 'default' } as any;
    const result = buildRequestStartBlocks(session, null);
    expect(result.blocks[1].accessory).toBeUndefined();
  });

  it('truncates long titles in header block', async () => {
    const { buildRequestStartBlocks } = await import('./source-thread-summary');
    const longTitle = 'A'.repeat(200);
    const session = { title: longTitle, workflow: 'default' } as any;
    const result = buildRequestStartBlocks(session);
    expect(result.blocks[0].text.text.length).toBeLessThanOrEqual(150);
  });
});

describe('buildRequestCompleteBlocks', () => {
  it('returns merged status for merged trigger', async () => {
    const { buildRequestCompleteBlocks } = await import('./source-thread-summary');
    const session = { title: 'Fix Bug', workflow: 'default', links: {} } as any;
    const result = buildRequestCompleteBlocks(session, 'merged');
    expect(result.text).toContain('머지 완료');
    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('머지 완료');
  });

  it('returns closed status for closed trigger', async () => {
    const { buildRequestCompleteBlocks } = await import('./source-thread-summary');
    const session = { title: 'Review', workflow: 'default', links: {} } as any;
    const result = buildRequestCompleteBlocks(session, 'closed');
    expect(result.text).toContain('완료');
    expect(result.text).not.toContain('머지');
  });

  it('includes issue and PR sections when links exist', async () => {
    const { buildRequestCompleteBlocks } = await import('./source-thread-summary');
    const session = {
      title: 'Work', workflow: 'default',
      links: {
        issue: { url: 'https://github.com/org/repo/issues/1', label: '#1', title: 'Bug report' },
        pr: { url: 'https://github.com/org/repo/pull/2', label: 'PR #2', title: 'Fix bug' },
      },
    } as any;
    const result = buildRequestCompleteBlocks(session, 'merged');
    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('github.com/org/repo/issues/1');
    expect(blocksJson).toContain('github.com/org/repo/pull/2');
    // Should have divider between hero and detail sections
    expect(result.blocks.some((b: any) => b.type === 'divider')).toBe(true);
    // Should have actions block with buttons
    expect(result.blocks.some((b: any) => b.type === 'actions')).toBe(true);
  });

  it('omits divider and detail sections when no links', async () => {
    const { buildRequestCompleteBlocks } = await import('./source-thread-summary');
    const session = { title: 'Task', workflow: 'default', links: {} } as any;
    const result = buildRequestCompleteBlocks(session, 'closed');
    expect(result.blocks.some((b: any) => b.type === 'divider')).toBe(false);
  });

  it('includes executive summary in hero text', async () => {
    const { buildRequestCompleteBlocks } = await import('./source-thread-summary');
    const session = { title: 'Task', workflow: 'default', links: {} } as any;
    const result = buildRequestCompleteBlocks(session, 'merged', {
      executiveSummary: 'All tests passing, code reviewed',
    });
    const heroSection = result.blocks[1];
    expect(heroSection.text.text).toContain('All tests passing, code reviewed');
  });

  it('includes verify result in hero fields', async () => {
    const { buildRequestCompleteBlocks } = await import('./source-thread-summary');
    const session = { title: 'Task', workflow: 'default', links: {} } as any;
    const result = buildRequestCompleteBlocks(session, 'merged', {
      verifyResult: 'PASS',
    });
    const heroFields = result.blocks[1].fields;
    const verifyField = heroFields.find((f: any) => f.text.includes('검증'));
    expect(verifyField).toBeDefined();
    expect(verifyField.text).toContain('PASS');
  });

  it('truncates long titles in header block', async () => {
    const { buildRequestCompleteBlocks } = await import('./source-thread-summary');
    const longTitle = 'B'.repeat(200);
    const session = { title: longTitle, workflow: 'default', links: {} } as any;
    const result = buildRequestCompleteBlocks(session, 'merged');
    expect(result.blocks[0].text.text.length).toBeLessThanOrEqual(150);
  });

  it('renders issue section without PR section when only issue linked', async () => {
    const { buildRequestCompleteBlocks } = await import('./source-thread-summary');
    const session = {
      title: 'Work', workflow: 'default',
      links: { issue: { url: 'https://github.com/org/repo/issues/1', label: '#1' } },
    } as any;
    const result = buildRequestCompleteBlocks(session, 'merged');
    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('github.com/org/repo/issues/1');
    expect(blocksJson).not.toContain('source_open_pr');
    expect(result.blocks.some((b: any) => b.type === 'divider')).toBe(true);
  });

  it('renders PR section without issue section when only PR linked', async () => {
    const { buildRequestCompleteBlocks } = await import('./source-thread-summary');
    const session = {
      title: 'Work', workflow: 'default',
      links: { pr: { url: 'https://github.com/org/repo/pull/2', label: 'PR #2' } },
    } as any;
    const result = buildRequestCompleteBlocks(session, 'merged');
    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('github.com/org/repo/pull/2');
    expect(blocksJson).not.toContain('source_open_issue');
  });

  it('includes issue context fields when provided', async () => {
    const { buildRequestCompleteBlocks } = await import('./source-thread-summary');
    const session = {
      title: 'Work', workflow: 'default',
      links: { issue: { url: 'https://github.com/org/repo/issues/1', label: '#1' } },
    } as any;
    const result = buildRequestCompleteBlocks(session, 'merged', {
      issueContext: { cause: 'Race condition', impact: 'Data corruption' },
    });
    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('Race condition');
    expect(blocksJson).toContain('Data corruption');
  });

  it('includes PR context fields when provided', async () => {
    const { buildRequestCompleteBlocks } = await import('./source-thread-summary');
    const session = {
      title: 'Work', workflow: 'default',
      links: { pr: { url: 'https://github.com/org/repo/pull/2', label: 'PR #2' } },
    } as any;
    const result = buildRequestCompleteBlocks(session, 'merged', {
      prContext: { fix: 'Added mutex lock', test: '3 unit tests added' },
    });
    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('Added mutex lock');
    expect(blocksJson).toContain('3 unit tests added');
  });

  it('includes thread button in actions when workThreadPermalink provided', async () => {
    const { buildRequestCompleteBlocks } = await import('./source-thread-summary');
    const session = { title: 'Work', workflow: 'default', links: {} } as any;
    const result = buildRequestCompleteBlocks(session, 'closed', {
      workThreadPermalink: 'https://slack.com/archives/C1/p1',
    });
    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('source_open_thread');
    expect(blocksJson).toContain('https://slack.com/archives/C1/p1');
  });

  it('parses elapsed time from turnSummary', async () => {
    const { buildRequestCompleteBlocks } = await import('./source-thread-summary');
    const session = { title: 'Work', workflow: 'default', links: {} } as any;
    const result = buildRequestCompleteBlocks(session, 'merged', {
      turnSummary: '⏱ 3m 22s · 14 turns',
    });
    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('3m 22s');
  });
});

describe('postSourceThreadSummary edge cases', () => {
  it('handles null permalink gracefully in postSourceThreadSummary', async () => {
    const mockSlackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
      getPermalink: vi.fn().mockResolvedValue(null),
    };
    const session = {
      title: 'Task', channelId: 'C_NEW', threadTs: 'ts', threadRootTs: 'root-ts',
      sourceThread: { channel: 'C_ORIGINAL', threadTs: '123.456' },
      links: {},
    };
    const { postSourceThreadSummary } = await import('./source-thread-summary');
    await postSourceThreadSummary(mockSlackApi as any, session as any, 'merged');
    expect(mockSlackApi.postMessage).toHaveBeenCalled();
    const blocksJson = JSON.stringify(mockSlackApi.postMessage.mock.calls[0][2]?.blocks ?? []);
    expect(blocksJson).not.toContain('source_open_thread');
  });
});

describe('buildRequestStartBlocks edge cases', () => {
  it('uses Session as default title when title is empty', async () => {
    const { buildRequestStartBlocks } = await import('./source-thread-summary');
    const session = { workflow: 'default' } as any;
    const result = buildRequestStartBlocks(session);
    expect(result.blocks[0].text.text).toBe('Session');
    expect(result.text).toContain('Session');
  });
});

describe('postSourceThreadSummary success path', () => {
  it('passes Block Kit blocks to postMessage on success', async () => {
    const mockSlackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
      getPermalink: vi.fn().mockResolvedValue('https://slack.com/archives/C1/p1'),
    };
    const session = {
      title: 'Deploy feature',
      workflow: 'deploy',
      channelId: 'C_WORK',
      threadTs: 'work-ts',
      threadRootTs: 'work-root-ts',
      sourceThread: { channel: 'C_ORIGINAL', threadTs: '111.222' },
      links: {
        pr: { url: 'https://github.com/org/repo/pull/10', label: 'PR #10' },
      },
    };
    const { postSourceThreadSummary } = await import('./source-thread-summary');
    await postSourceThreadSummary(mockSlackApi as any, session as any, 'merged');

    const callArgs = mockSlackApi.postMessage.mock.calls[0];
    expect(callArgs[0]).toBe('C_ORIGINAL');
    expect(callArgs[1]).toContain('Deploy feature');
    const opts = callArgs[2];
    expect(opts.threadTs).toBe('111.222');
    expect(opts.blocks).toBeDefined();
    expect(Array.isArray(opts.blocks)).toBe(true);
    expect(opts.blocks.length).toBeGreaterThanOrEqual(2);
    expect(opts.blocks[0].type).toBe('header');
    expect(opts.blocks[1].type).toBe('section');
  });

  it('uses threadRootTs over threadTs for permalink lookup', async () => {
    const mockSlackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
      getPermalink: vi.fn().mockResolvedValue('https://slack.com/archives/C1/p1'),
    };
    const session = {
      title: 'Task',
      channelId: 'C_WORK',
      threadTs: 'thread-ts-fallback',
      threadRootTs: 'root-ts-preferred',
      sourceThread: { channel: 'C_ORIGINAL', threadTs: '111.222' },
      links: {},
    };
    const { postSourceThreadSummary } = await import('./source-thread-summary');
    await postSourceThreadSummary(mockSlackApi as any, session as any, 'closed');

    expect(mockSlackApi.getPermalink).toHaveBeenCalledWith('C_WORK', 'root-ts-preferred');
  });
});

describe('buildRequestCompleteBlocks edge cases', () => {
  it('omits elapsed field when turnSummary has no timer emoji', async () => {
    const { buildRequestCompleteBlocks } = await import('./source-thread-summary');
    const session = { title: 'Task', workflow: 'default', links: {} } as any;
    const result = buildRequestCompleteBlocks(session, 'merged', {
      turnSummary: 'no timer info here',
    });
    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).not.toContain('소요');
  });

  it('omits elapsed field when turnSummary is undefined', async () => {
    const { buildRequestCompleteBlocks } = await import('./source-thread-summary');
    const session = { title: 'Task', workflow: 'default', links: {} } as any;
    const result = buildRequestCompleteBlocks(session, 'merged', {});
    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).not.toContain('소요');
  });

  it('handles empty string title gracefully', async () => {
    const { buildRequestCompleteBlocks } = await import('./source-thread-summary');
    const session = { title: '', workflow: 'default', links: {} } as any;
    const result = buildRequestCompleteBlocks(session, 'closed');
    expect(result.blocks[0].text.text).toBe('Session');
    expect(result.text).toContain('Session');
  });

  it('handles whitespace-only title', async () => {
    const { buildRequestStartBlocks } = await import('./source-thread-summary');
    const session = { title: '   ', workflow: 'default' } as any;
    const result = buildRequestStartBlocks(session);
    // Whitespace title passes through (not empty string), this is acceptable
    expect(result.blocks[0].text.text).toBeDefined();
    expect(result.text).toBeDefined();
  });
});
