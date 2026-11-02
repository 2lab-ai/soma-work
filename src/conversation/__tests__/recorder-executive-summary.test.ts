/**
 * SSOT 2026-11-02 T7 — the Executive Summary in the dashboard's chat (지시와 답변).
 *
 * The thread gets the whole summary in Slack; the dashboard's conversation gets it as one answer
 * turn marked `executiveSummary`, its TL;DR as the turn's summary — never sent to the summarizer
 * (it is already a summary) and never the turn the session's title is regenerated from.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../env-paths', async () => {
  const nodeFs = await import('node:fs');
  return { IS_DEV: true, DATA_DIR: nodeFs.mkdtempSync('/tmp/recorder-es-data-') };
});
const summarize = vi.fn();
vi.mock('../summarizer', () => ({ summarizeResponse: (...a: unknown[]) => summarize(...a) }));

import {
  createConversation,
  getConversation,
  recordExecutiveSummaryTurn,
  setOnTurnRecordedCallback,
  setSessionTitleBridge,
} from '../recorder';

function nextTurn(): Promise<any> {
  return new Promise((resolve) => setOnTurnRecordedCallback((_id, turn) => resolve(turn)));
}

describe('T7 — the Executive Summary is an answer turn in the dashboard chat', () => {
  it('records the whole document with its TL;DR as the turn summary, and pushes it', async () => {
    const bridge = { setLastAssistantTurnId: vi.fn(), getSnapshot: vi.fn(), applyTitle: vi.fn() };
    setSessionTitleBridge(bridge as any);
    const cid = createConversation('C1', '1700000000.000900', 'U1', 'Zhuge');
    const seen = nextTurn();
    recordExecutiveSummaryTurn(cid, '**TL;DR**\n- 하나\n- 둘\n\n## SSOT\n버그 수정', ['하나', '둘']);
    const turn = await seen;
    expect(turn).toMatchObject({
      role: 'assistant',
      executiveSummary: true,
      rawContent: '**TL;DR**\n- 하나\n- 둘\n\n## SSOT\n버그 수정',
      summaryTitle: 'Executive Summary',
      summaryBody: '하나\n둘',
      summarized: true,
    });
    const rec = await getConversation(cid);
    expect(rec?.turns[rec.turns.length - 1]?.id).toBe(turn.id);
    // Already a summary: no summarizer call, and the session title is not rebuilt from it.
    await new Promise((r) => setTimeout(r, 20));
    expect(summarize).not.toHaveBeenCalled();
    expect(bridge.setLastAssistantTurnId).not.toHaveBeenCalled();
    setSessionTitleBridge(null);
  });

  it('an unknown conversation records nothing and never throws', async () => {
    const cb = vi.fn();
    setOnTurnRecordedCallback(cb);
    expect(() => recordExecutiveSummaryTurn('nope', '# x', [])).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(cb).not.toHaveBeenCalled();
  });
});
