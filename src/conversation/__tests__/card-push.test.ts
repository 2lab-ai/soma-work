/**
 * A board card's live push as what changed (dashboard perf 2026-11-24): a socket gets nothing when its copy is
 * current, only the changed fields otherwise, and the whole card first and every CARD_KEYFRAME_MS of changes.
 */
import { describe, expect, it } from 'vitest';
import { CARD_KEYFRAME_MS, cardFields, cardPushMessage, type SentCards } from '../card-push';

const card = (over: Record<string, unknown> = {}) => ({
  key: 'i::C1:1.1',
  title: 'T',
  earlierTasks: [{ id: 'T1', content: 'long history '.repeat(500) }],
  tokenUsage: { totalCostUsd: 1 },
  ...over,
});

describe('cardFields', () => {
  it('rebuilt whole, the fields are JSON.stringify of the card — undefined and functions left out', () => {
    const c = { a: 1, b: undefined, c: () => 1, d: { e: [1, null] }, f: new Date(0) };
    const fields = cardFields(c);
    expect([...fields.keys()]).toEqual(['a', 'd', 'f']);
    const rebuilt = `{${[...fields].map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',')}}`;
    expect(rebuilt).toBe(JSON.stringify(c));
  });
});

describe('cardPushMessage', () => {
  it("the first push to a socket is the whole card, byte for byte the old message's", () => {
    const sent: SentCards = new Map();
    const c = card();
    const msg = cardPushMessage(sent, c.key, cardFields(c), 1000);
    expect(msg).toBe(JSON.stringify({ type: 'sessionUpdated', session: c }));
  });

  it('a card the socket already holds as it is sends nothing', () => {
    const sent: SentCards = new Map();
    cardPushMessage(sent, 'k', cardFields(card()), 1000);
    expect(cardPushMessage(sent, 'k', cardFields(card()), 2000)).toBeUndefined();
  });

  it('a changed card sends only what changed: set for new values, unset for fields that left', () => {
    const sent: SentCards = new Map();
    cardPushMessage(sent, 'k', cardFields(card({ goal: { text: 'g' } })), 1000);
    const msg = cardPushMessage(sent, 'k', cardFields(card({ tokenUsage: { totalCostUsd: 2 } })), 2000);
    expect(JSON.parse(msg ?? '')).toEqual({
      type: 'sessionPatch',
      key: 'k',
      set: { tokenUsage: { totalCostUsd: 2 } },
      unset: ['goal'],
    });
    // The big unchanged field stays home: the patch is a small fraction of the card.
    expect((msg ?? '').length).toBeLessThan(JSON.stringify(card()).length / 10);
  });

  it('each patch is against the copy the last message made, not the first', () => {
    const sent: SentCards = new Map();
    cardPushMessage(sent, 'k', cardFields(card()), 1000);
    cardPushMessage(sent, 'k', cardFields(card({ title: 'T2' })), 2000);
    expect(cardPushMessage(sent, 'k', cardFields(card({ title: 'T2' })), 3000)).toBeUndefined();
    const back = JSON.parse(cardPushMessage(sent, 'k', cardFields(card()), 4000) ?? '');
    expect(back).toEqual({ type: 'sessionPatch', key: 'k', set: { title: 'T' } });
  });

  it('a change CARD_KEYFRAME_MS after the last whole copy sends the whole card again', () => {
    const sent: SentCards = new Map();
    cardPushMessage(sent, 'k', cardFields(card()), 0);
    expect(JSON.parse(cardPushMessage(sent, 'k', cardFields(card({ title: 'a' })), 1000) ?? '').type).toBe(
      'sessionPatch',
    );
    // No change at the keyframe time: still nothing.
    expect(cardPushMessage(sent, 'k', cardFields(card({ title: 'a' })), CARD_KEYFRAME_MS)).toBeUndefined();
    const whole = JSON.parse(cardPushMessage(sent, 'k', cardFields(card({ title: 'b' })), CARD_KEYFRAME_MS) ?? '');
    expect(whole).toEqual({ type: 'sessionUpdated', session: card({ title: 'b' }) });
    // …and the keyframe clock restarts there.
    expect(
      JSON.parse(cardPushMessage(sent, 'k', cardFields(card({ title: 'c' })), CARD_KEYFRAME_MS + 1000) ?? '').type,
    ).toBe('sessionPatch');
  });

  it('cards are kept apart by key', () => {
    const sent: SentCards = new Map();
    cardPushMessage(sent, 'a', cardFields(card()), 0);
    expect(JSON.parse(cardPushMessage(sent, 'b', cardFields(card()), 1) ?? '').type).toBe('sessionUpdated');
  });
});
