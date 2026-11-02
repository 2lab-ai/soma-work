/**
 * #772 — a reply that echoed `<display-lang>` at its end is kept, and shown on
 * the dashboard, without it — including a reply recorded before the fix.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../env-paths', async () => {
  const nodeFs = await import('node:fs');
  return { IS_DEV: true, DATA_DIR: nodeFs.mkdtempSync('/tmp/recorder-display-lang-') };
});

import {
  createConversation,
  getConversation,
  getTurnRawContent,
  recordAssistantTurn,
  setOnTurnRecordedCallback,
} from '../recorder';

function nextTurn(): Promise<any> {
  return new Promise((resolve) => setOnTurnRecordedCallback((_id, turn) => resolve(turn)));
}

describe('#772 — no echoed <display-lang> in the chat', () => {
  it('records a reply without the tag it ended with', async () => {
    const cid = createConversation('C1', '1700000000.000900', 'U1', 'Zhuge');
    const seen = nextTurn();
    recordAssistantTurn(cid, '바꿨습니다.\n\n<display-lang>ko</display-lang>');
    const turn = await seen;
    expect(turn.rawContent).toBe('바꿨습니다.');
    expect(await getTurnRawContent(cid, turn.id)).toBe('바꿨습니다.');
  });

  it('a reply recorded before the fix reads without it too', async () => {
    const cid = createConversation('C1', '1700000000.000910', 'U1', 'Zhuge');
    const seen = nextTurn();
    recordAssistantTurn(cid, '예전 답변');
    const turn = await seen;
    // As an older build stored it: the echo is in the record.
    const record = await getConversation(cid);
    const stored = record?.turns.find((t: any) => t.id === turn.id);
    if (stored) stored.rawContent = '예전 답변\n<display-lang>ko</display-lang>';
    expect(await getTurnRawContent(cid, turn.id)).toBe('예전 답변');
  });
});
