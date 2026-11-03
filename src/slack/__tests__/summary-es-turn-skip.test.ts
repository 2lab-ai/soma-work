import { describe, expect, it, vi } from 'vitest';
import { esWroteCardThisTurn, SummaryService, steerAfterEs } from '../summary-service';

/**
 * #846 item 8 — a turn whose model-run es (`local:auto-es`) already wrote the card does not fork a host summary.
 *
 * The card ignores that fork (`displayOnThread` keeps an es-written card), yet it cost a fork and put a second,
 * different TL;DR on the Slack thread head. The marker is `executiveSummary.source === 'es'`; the next input clears
 * it (`clearDisplay`), so the next turn's summary runs as usual.
 */

describe('esWroteCardThisTurn', () => {
  it('is true only for a TL;DR the model-run es wrote', () => {
    expect(esWroteCardThisTurn({ executiveSummary: { tldr: ['a'], at: 1, source: 'es' } })).toBe(true);
    expect(esWroteCardThisTurn({ executiveSummary: { tldr: ['a'], at: 1 } })).toBe(false);
    expect(esWroteCardThisTurn({ executiveSummary: undefined })).toBe(false);
    expect(esWroteCardThisTurn({})).toBe(false);
  });
});

describe('displayEsTldrOnThread — the thread head shows the es TL;DR', () => {
  const service = () => new SummaryService(vi.fn() as never, undefined as never);

  it('puts the es TL;DR on the thread surface, no fork', () => {
    const session: any = { actionPanel: {}, executiveSummary: { tldr: ['a', '⚠️ **b**', 'c'], at: 1, source: 'es' } };
    service().displayEsTldrOnThread(session);
    const text = JSON.stringify(session.actionPanel.summaryBlocks);
    expect(text).toContain('a');
    expect(text).toContain('⚠️');
    expect(text).toContain('c');
  });

  it('the head keeps identifiers: only the contract bold becomes Slack bold', () => {
    const blocks = service().buildTldrBlocks(['fix the __init__ import and obj.__dict__', '⚠️ **PR #3 open**']);
    const text = JSON.stringify(blocks);
    expect(text).toContain('__init__');
    expect(text).toContain('obj.__dict__');
    expect(text).toContain('⚠️ *PR #3 open*');
  });

  it('leaves the surface alone without a TL;DR or a panel', () => {
    const noTldr: any = { actionPanel: {}, executiveSummary: undefined };
    service().displayEsTldrOnThread(noTldr);
    expect(noTldr.actionPanel.summaryBlocks).toBeUndefined();
    expect(() => service().displayEsTldrOnThread({ executiveSummary: { tldr: ['a'], at: 1 } } as any)).not.toThrow();
  });
});

// The turn-end behaviour itself (no timer in an es turn, the head shows the es TL;DR, an earlier marker never blocks
// a summary) runs through the real StreamExecutor.execute in src/slack/pipeline/__tests__/stream-executor.test.ts.

describe('steerAfterEs (#881 B1)', () => {
  const es = { executiveSummary: { tldr: ['a'], at: 9, source: 'es', issuedAt: 1_000 } };
  it('no consumed steer: nothing to re-judge', () => {
    expect(steerAfterEs(es, [])).toBe(false);
  });
  it('a steer pushed before the es write was already in the verdict', () => {
    expect(steerAfterEs(es, [400, 999])).toBe(false);
  });
  it('a steer pushed at or after the es write re-opens it', () => {
    expect(steerAfterEs(es, [400, 1_000])).toBe(true);
  });
  it('unknown push time, or an es without an issue time: re-judge (as before)', () => {
    expect(steerAfterEs(es, [undefined])).toBe(true);
    expect(steerAfterEs({ executiveSummary: { tldr: ['a'], at: 9, source: 'es' } }, [1])).toBe(true);
  });
});
