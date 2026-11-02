import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamExecutor, setStreamExecutorProviders } from '../pipeline/stream-executor';
import { composeExecutiveSummaryMarkdown, SummaryService } from '../summary-service';

/**
 * SSOT 2026-11-02 T7 — the Executive Summary reaches the dashboard too.
 *
 * "슬랙에서는 작업 완료후 5분이내에 $es를 호출하고 그 내역을 스레드 헤드에 tl;dr 표기하고 채팅에
 * 전체 내역을 표시하는데 이거 대시보드에도 표기해줘 tl;dr은 태스크 카드에 표기해줘."
 *
 * The session carries the TL;DR the thread head shows (`executiveSummary`) until the next input
 * clears it, and the host is handed the whole summary (`recordExecutiveSummary`) to put in the
 * dashboard's chat and to push the card.
 */

const ES = [
  '<tldr>',
  'PR #771 merged: the viewer fills the screen.',
  'CI is green on main.',
  'Next: deploy to dev.',
  '</tldr>',
  '',
  '## SSOT',
  '버그 수정과 개선',
  '## Status',
  '- PR: https://github.com/2lab-ai/soma-work/pull/771 — Merged',
].join('\n');

const session = () =>
  ({
    sessionId: 'sess-1',
    channelId: 'C1',
    threadTs: '1700.0',
    conversationId: 'conv-1',
    isActive: true,
    actionPanel: { channelId: 'C1', messageTs: '1700.0' },
  }) as any;

afterEach(() => {
  setStreamExecutorProviders({ recordExecutiveSummary: () => {} });
  vi.restoreAllMocks();
});

describe('T7 — the session holds the TL;DR the thread head shows', () => {
  it('displayOnThread keeps the TL;DR lines and when they came', () => {
    const s = session();
    const before = Date.now();
    new SummaryService(vi.fn()).displayOnThread(s, ES);
    expect(s.executiveSummary.tldr).toEqual([
      'PR #771 merged: the viewer fills the screen.',
      'CI is green on main.',
      'Next: deploy to dev.',
    ]);
    expect(s.executiveSummary.at).toBeGreaterThanOrEqual(before);
  });

  it('a task with no Slack thread (a dashboard task) still gets the TL;DR for its card (review: fable P3)', () => {
    const s = { ...session(), actionPanel: undefined };
    new SummaryService(vi.fn()).displayOnThread(s, ES);
    expect(s.executiveSummary.tldr).toHaveLength(3);
  });

  it('no TL;DR envelope: nothing for the card (the chat still gets the document)', () => {
    const s = session();
    new SummaryService(vi.fn()).displayOnThread(s, ES.slice(ES.indexOf('## SSOT')));
    expect(s.executiveSummary).toBeUndefined();
  });

  it('the next input clears it — with or without a thread head to clear', () => {
    const svc = new SummaryService(vi.fn());
    const s = session();
    svc.displayOnThread(s, ES);
    svc.clearDisplay(s);
    expect(s.executiveSummary).toBeUndefined();
    const bare = { ...session(), actionPanel: undefined, executiveSummary: { tldr: ['x'], at: 1 } };
    svc.clearDisplay(bare);
    expect(bare.executiveSummary).toBeUndefined();
  });
});

describe('T7 — the dashboard chat gets the whole summary', () => {
  it('composeExecutiveSummaryMarkdown: the TL;DR as a list, then the document; no envelope', () => {
    const md = composeExecutiveSummaryMarkdown(ES);
    expect(md).toBe(
      [
        '**TL;DR**',
        '- PR #771 merged: the viewer fills the screen.',
        '- CI is green on main.',
        '- Next: deploy to dev.',
        '',
        '## SSOT',
        '버그 수정과 개선',
        '## Status',
        '- PR: https://github.com/2lab-ai/soma-work/pull/771 — Merged',
      ].join('\n'),
    );
    expect(composeExecutiveSummaryMarkdown('## SSOT\nx')).toBe('## SSOT\nx');
  });

  it('the summary timer hands the host the session, its conversation and the raw summary', async () => {
    const seen: unknown[] = [];
    setStreamExecutorProviders({
      recordExecutiveSummary: (sessionKey, conversationId, text) => seen.push({ sessionKey, conversationId, text }),
    });
    const s = session();
    const executor = new StreamExecutor({
      summaryService: new SummaryService(vi.fn().mockResolvedValue(ES)),
      threadPanel: { updatePanel: vi.fn() },
    } as any);
    await (executor as any).onSummaryTimerFire(s, 'C1:1700.0');
    expect(seen).toEqual([{ sessionKey: 'C1:1700.0', conversationId: 'conv-1', text: ES }]);
    // The session already holds the TL;DR when the host is told (it pushes the card).
    expect(s.executiveSummary.tldr).toHaveLength(3);
  });

  it('a failed thread update never keeps the summary from the dashboard (review: fable P3)', async () => {
    const seen = vi.fn();
    setStreamExecutorProviders({ recordExecutiveSummary: seen });
    const executor = new StreamExecutor({
      summaryService: new SummaryService(vi.fn().mockResolvedValue(ES)),
      threadPanel: { updatePanel: vi.fn().mockRejectedValue(new Error('slack down')) },
    } as any);
    await (executor as any).onSummaryTimerFire(session(), 'C1:1700.0');
    expect(seen).toHaveBeenCalledWith('C1:1700.0', 'conv-1', ES);
  });

  it('no summary (the fork failed): nothing is handed over', async () => {
    const seen = vi.fn();
    setStreamExecutorProviders({ recordExecutiveSummary: seen });
    const executor = new StreamExecutor({
      summaryService: new SummaryService(vi.fn().mockResolvedValue(null)),
      threadPanel: { updatePanel: vi.fn() },
    } as any);
    await (executor as any).onSummaryTimerFire(session(), 'C1:1700.0');
    expect(seen).not.toHaveBeenCalled();
  });
});
