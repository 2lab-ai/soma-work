import { describe, expect, it } from 'vitest';
import type { FollowupItem, FollowupItemState } from '../followup-queue';
import {
  buildFollowupQueueBlocks,
  FOLLOWUP_CANCEL_LABEL,
  FOLLOWUP_ITEM_ACTION_IDS,
  FOLLOWUP_ITEM_MENU_ACTION_ID,
  FOLLOWUP_PAGE_NEXT_ACTION_ID,
  FOLLOWUP_PAGE_PREV_ACTION_ID,
  FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE,
  FOLLOWUP_QUEUE_TITLE,
  FOLLOWUP_RESUME_ACTION_ID,
  FOLLOWUP_RETRY_ACTION_ID,
  FOLLOWUP_SEND_NOW_ACTION_ID,
  FOLLOWUP_SEND_NOW_LABEL,
  FOLLOWUP_STATE_DISPLAY_ORDER,
  FOLLOWUP_STEERED_COUNT_LABEL,
  FOLLOWUP_STEERED_LABEL,
  type FollowupQueueBlocksOptions,
  type FollowupQueueView,
  followupStateCountLabel,
  parseFollowupItemActionValue,
  parseFollowupMenuValue,
  parseFollowupPageActionValue,
} from '../followup-queue-blocks';
import type { MessageEvent } from '../pipeline/types';

const SESSION = 'C1:1700.000000';

/**
 * Every `FollowupItemState` (`followup-queue.ts:29-39`), spelled out here so the
 * display order is compared against an INDEPENDENT list rather than against
 * itself. The header counts are a `.filter()` over the display order, so a state
 * missing from that order is uncounted with no error anywhere.
 */
const ALL_FOLLOWUP_STATES = [
  'queued',
  'steered',
  'reserved',
  'claimed',
  'dispatched',
  'resolved',
  'failed',
  'uncertain',
  'paused',
  'cancelled',
] as const satisfies readonly FollowupItemState[];

/**
 * The pre-compact layout (one section + one context line per item). It is no
 * longer the default — the live panel was too tall (2026-09-17 user report) —
 * but it stays reachable, so its contract keeps being pinned here.
 */
function buildLegacyQueueBlocks(view: FollowupQueueView, options: FollowupQueueBlocksOptions = {}) {
  return buildFollowupQueueBlocks(view, { ...options, compact: false });
}

function event(over: Partial<MessageEvent> = {}): MessageEvent {
  return { user: 'U1', channel: 'C1', ts: '1700.000100', text: '진행중인거 알려줘?', ...over };
}

function item(over: Partial<FollowupItem> = {}): FollowupItem {
  const seq = over.seq ?? 1;
  return {
    id: `${SESSION}#${seq}`,
    sessionKey: SESSION,
    seq,
    epoch: 7,
    state: 'queued',
    eventKey: `C1:1700.0001${seq}`,
    message: event({ ts: `1700.0001${seq}` }),
    context: { workingDirectory: '/Users/secret/work' },
    enqueuedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

/** Every text object in the payload, wherever it is nested. */
function collectTextObjects(node: unknown, out: Array<{ type: string; text: string }> = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectTextObjects(child, out);
    return out;
  }
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (typeof record.type === 'string' && typeof record.text === 'string') {
      out.push({ type: record.type, text: record.text });
    }
    for (const value of Object.values(record)) collectTextObjects(value, out);
  }
  return out;
}

function collectButtons(blocks: unknown[]): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (record.type === 'button') found.push(record);
      for (const value of Object.values(record)) walk(value);
    }
  };
  walk(blocks);
  return found;
}

function sectionTexts(blocks: unknown[]): string[] {
  return (blocks as Array<Record<string, unknown>>)
    .filter((block) => block.type === 'section')
    .map((block) => ((block.text as Record<string, unknown>).text as string) ?? '');
}

function contextTexts(blocks: unknown[]): string[] {
  return (blocks as Array<Record<string, unknown>>)
    .filter((block) => block.type === 'context')
    .flatMap((block) => (block.elements as Array<Record<string, unknown>>).map((el) => el.text as string));
}

describe('buildFollowupQueueBlocks legacy layout (compact:false) — surface labels', () => {
  it('titles the surface `Queue` and never merges the separate Goals queue (SSOT §2/§3.6)', () => {
    const { blocks, text } = buildLegacyQueueBlocks({ sessionKey: SESSION, items: [item()] });

    expect(FOLLOWUP_QUEUE_TITLE).toBe('Queue');
    expect(sectionTexts(blocks)[0]).toBe('Queue');
    expect(JSON.stringify(blocks)).not.toContain('Goals');
    expect(text).toContain('Queue');
  });

  it('offers the canonical `Send now` label on a queued item (SSOT §2)', () => {
    const { blocks } = buildLegacyQueueBlocks({ sessionKey: SESSION, items: [item()] });

    const buttons = collectButtons(blocks);
    expect(FOLLOWUP_SEND_NOW_LABEL).toBe('Send now');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].action_id).toBe(FOLLOWUP_SEND_NOW_ACTION_ID);
    expect((buttons[0].text as Record<string, unknown>).text).toBe('Send now');
    expect((buttons[0].text as Record<string, unknown>).type).toBe('plain_text');
  });

  it('shows the raw message as the item preview', () => {
    const { blocks } = buildLegacyQueueBlocks({ sessionKey: SESSION, items: [item()] });

    expect(sectionTexts(blocks).join('\n')).toContain('진행중인거 알려줘?');
  });
});

describe('buildFollowupQueueBlocks legacy layout (compact:false) — purity and Slack limits', () => {
  it('never mutates the caller snapshot (A14/A30 — raw input preserved)', () => {
    const input = { sessionKey: SESSION, items: [item({ seq: 1 }), item({ seq: 2, state: 'paused' })] };
    const before = structuredClone(input);

    buildLegacyQueueBlocks(input);

    expect(input).toEqual(before);
  });

  it('truncates long unicode previews without splitting surrogate pairs or exceeding limits', () => {
    const long = `${'🙂'.repeat(400)}끝`;
    const { blocks } = buildLegacyQueueBlocks({
      sessionKey: SESSION,
      items: [item({ message: event({ text: long }) })],
    });

    const preview = sectionTexts(blocks)[1];
    expect(preview).toContain('…');
    expect(preview.length).toBeLessThanOrEqual(3000);
    // A split surrogate pair renders as U+FFFD; code-point-safe truncation has none.
    expect(preview).not.toContain('�');
    expect([...preview].every((ch) => ch === '…' || ch === '🙂' || /[\s\d.#]/.test(ch))).toBe(true);
    for (const button of collectButtons(blocks)) {
      expect(((button.text as Record<string, unknown>).text as string).length).toBeLessThanOrEqual(75);
      expect((button.value as string).length).toBeLessThanOrEqual(2000);
    }
  });

  it('falls back to attachment names when the message carries files only', () => {
    const files = [
      {
        id: 'F1',
        name: 'trace-capture.png',
        mimetype: 'image/png',
        filetype: 'png',
        url_private: 'https://files.slack.com/p',
        url_private_download: 'https://files.slack.com/d',
        size: 10,
      },
    ];
    const { blocks } = buildLegacyQueueBlocks({
      sessionKey: SESSION,
      items: [item({ message: event({ text: '   ', files }) })],
    });

    expect(sectionTexts(blocks).join('\n')).toContain('trace-capture.png');
  });

  it('emits only plain_text objects so an untrusted message cannot inject mrkdwn mentions', () => {
    const hostile = '<!channel> <@U0DEADBEEF> *bold* <https://evil.example|click>';
    const { blocks, text } = buildLegacyQueueBlocks({
      sessionKey: SESSION,
      items: [item({ message: event({ text: hostile }) })],
    });

    for (const textObject of collectTextObjects(blocks)) expect(textObject.type).toBe('plain_text');
    expect(text).not.toContain('<!channel>');
    expect(text).not.toContain('<@U0DEADBEEF>');
  });

  it('never emits the unsupported `disabled` button field (invalid_blocks guard)', () => {
    const items: FollowupItem[] = ALL_FOLLOWUP_STATES.map((state, index) => item({ seq: index + 1, state }));

    const { blocks } = buildLegacyQueueBlocks({ sessionKey: SESSION, items });

    for (const button of collectButtons(blocks)) expect(button).not.toHaveProperty('disabled');
    expect(JSON.stringify(blocks)).not.toContain('"disabled"');
  });
});

describe('buildFollowupQueueBlocks legacy layout (compact:false) — state semantics (SSOT §3.4/§3.5)', () => {
  it('renders a denied-but-queued item distinctly from a paused item (A29)', () => {
    const { blocks } = buildLegacyQueueBlocks({
      sessionKey: SESSION,
      items: [
        item({ seq: 1, state: 'queued', stateReason: 'interrupt 권한 거부' }),
        item({ seq: 2, state: 'paused', stateReason: '재시작 복원' }),
      ],
    });

    const states = contextTexts(blocks);
    expect(states.some((line) => line.startsWith('queued') && line.includes('interrupt 권한 거부'))).toBe(true);
    expect(states.some((line) => line.startsWith('paused') && line.includes('재시작 복원'))).toBe(true);

    const buttons = collectButtons(blocks);
    expect(buttons.map((button) => button.action_id)).toEqual([FOLLOWUP_SEND_NOW_ACTION_ID, FOLLOWUP_RESUME_ACTION_ID]);
    const resume = buttons[1];
    expect((resume.text as Record<string, unknown>).text).not.toBe(FOLLOWUP_SEND_NOW_LABEL);
    expect((resume.text as Record<string, unknown>).text).toContain('Resume');
  });

  it('requires an explicit Resume under a session freeze and withholds Send now', () => {
    const { blocks } = buildLegacyQueueBlocks({
      sessionKey: SESSION,
      items: [item({ seq: 1, state: 'queued' }), item({ seq: 2, state: 'paused' })],
      freeze: { reason: 'stop requested', at: 1_700_000_000_000 },
    });

    expect(contextTexts(blocks).some((line) => line.includes('stop requested'))).toBe(true);
    const buttons = collectButtons(blocks);
    expect(buttons.every((button) => button.action_id !== FOLLOWUP_SEND_NOW_ACTION_ID)).toBe(true);
    expect(buttons.some((button) => button.action_id === FOLLOWUP_RESUME_ACTION_ID)).toBe(true);
  });

  it('gives failed and uncertain items an explicit Retry control, confirm-gated for uncertain (R6)', () => {
    const { blocks } = buildLegacyQueueBlocks({
      sessionKey: SESSION,
      items: [
        item({ seq: 1, state: 'failed', stateReason: 'dispatch error' }),
        item({ seq: 2, state: 'uncertain', stateReason: '재시작 중 중단' }),
      ],
    });

    const buttons = collectButtons(blocks);
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.action_id === FOLLOWUP_RETRY_ACTION_ID)).toBe(true);
    expect(buttons.every((button) => ((button.text as Record<string, unknown>).text as string) === 'Retry')).toBe(true);

    // `failed` is a confirmed outcome — no dialog. `uncertain` may have already run: never re-run without a click-through.
    expect(buttons[0].confirm).toBeUndefined();
    const confirm = buttons[1].confirm as Record<string, Record<string, unknown>>;
    expect(confirm).toBeDefined();
    expect(confirm.title.type).toBe('plain_text');
    expect((confirm.title.text as string).length).toBeLessThanOrEqual(100);
    expect((confirm.text.text as string).length).toBeLessThanOrEqual(300);
    expect((confirm.confirm.text as string).length).toBeLessThanOrEqual(30);
    expect((confirm.deny.text as string).length).toBeLessThanOrEqual(30);
  });

  it('keeps cancelled items visible as history with no action', () => {
    const { blocks } = buildLegacyQueueBlocks({
      sessionKey: SESSION,
      items: [item({ seq: 1, state: 'cancelled', stateReason: '세션 삭제', message: event({ text: '취소된 후속' }) })],
    });

    expect(sectionTexts(blocks).join('\n')).toContain('취소된 후속');
    expect(contextTexts(blocks).some((line) => line.startsWith('cancelled') && line.includes('세션 삭제'))).toBe(true);
    expect(collectButtons(blocks)).toHaveLength(0);
  });
});

describe('buildFollowupQueueBlocks legacy layout (compact:false) — action values carry no identity', () => {
  it('encodes only queue coordinates — never author, cwd, token or raw message', () => {
    const target = item({ seq: 3, epoch: 11, message: event({ text: 'secret-payload-text', user: 'U-AUTHOR' }) });

    const { blocks } = buildLegacyQueueBlocks({ sessionKey: SESSION, items: [target], turnEpoch: 4 });

    const value = collectButtons(blocks)[0].value as string;
    const parsed = JSON.parse(value);
    expect(Object.keys(parsed).sort()).toEqual(['epoch', 'itemId', 'sessionKey', 'turnEpoch']);
    expect(parsed).toEqual({ sessionKey: SESSION, itemId: target.id, epoch: 11, turnEpoch: 4 });
    expect(value).not.toContain('secret-payload-text');
    expect(value).not.toContain('U-AUTHOR');
    expect(value).not.toContain('/Users/secret/work');
    expect(parseFollowupItemActionValue(value)).toEqual({
      sessionKey: SESSION,
      itemId: target.id,
      epoch: 11,
      turnEpoch: 4,
    });
  });

  it('carries the session turnEpoch beside the item epoch on Send now, defaulting to 0 (A12/A28)', () => {
    const target = item({ seq: 1, epoch: 11 });

    const withTurn = buildLegacyQueueBlocks({ sessionKey: SESSION, items: [target], turnEpoch: 9 });
    const withoutTurn = buildLegacyQueueBlocks({ sessionKey: SESSION, items: [target] });

    const sendNow = collectButtons(withTurn.blocks)[0];
    expect(sendNow.action_id).toBe(FOLLOWUP_SEND_NOW_ACTION_ID);
    expect(parseFollowupItemActionValue(sendNow.value as string)).toEqual({
      sessionKey: SESSION,
      itemId: target.id,
      epoch: 11,
      turnEpoch: 9,
    });
    // The item epoch is a separate CAS token and is NOT overwritten by the turn counter.
    expect(parseFollowupItemActionValue(sendNow.value as string)?.epoch).toBe(11);
    expect(parseFollowupItemActionValue(collectButtons(withoutTurn.blocks)[0].value as string)?.turnEpoch).toBe(0);
  });

  it('leaves Resume and Retry on the item-epoch-only payload (no turn-generation gate)', () => {
    const { blocks } = buildLegacyQueueBlocks({
      sessionKey: SESSION,
      items: [item({ seq: 1, state: 'paused' }), item({ seq: 2, state: 'failed' })],
      turnEpoch: 9,
    });

    for (const button of collectButtons(blocks)) {
      expect([FOLLOWUP_RESUME_ACTION_ID, FOLLOWUP_RETRY_ACTION_ID]).toContain(button.action_id);
      expect(Object.keys(JSON.parse(button.value as string)).sort()).toEqual(['epoch', 'itemId', 'sessionKey']);
      expect(parseFollowupItemActionValue(button.value as string)?.turnEpoch).toBeUndefined();
    }
  });

  it('rejects malformed action values instead of guessing', () => {
    expect(parseFollowupItemActionValue(undefined)).toBeNull();
    expect(parseFollowupItemActionValue('not json')).toBeNull();
    expect(parseFollowupItemActionValue('{"sessionKey":"C1"}')).toBeNull();
    expect(parseFollowupItemActionValue('{"sessionKey":"C1","itemId":"C1#1","epoch":1,"turnEpoch":"x"}')).toBeNull();
    expect(parseFollowupItemActionValue('{"sessionKey":"C1","itemId":"C1#1","epoch":1,"user":"U1"}')).toBeNull();
    expect(parseFollowupPageActionValue('{"sessionKey":"C1"}')).toBeNull();
    expect(parseFollowupPageActionValue('{"sessionKey":"C1","page":0}')).toBeNull();
  });
});

describe('buildFollowupQueueBlocks legacy layout (compact:false) — pagination exposes every item', () => {
  const many = Array.from({ length: 100 }, (_, index) =>
    item({ seq: index + 1, message: event({ ts: `1700.${index}`, text: `msg-${index + 1}` }) }),
  );

  it('reaches all 100 items across pages, within the 50-block message cap', () => {
    const seen = new Set<string>();
    const pageCount = Math.ceil(many.length / FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE);

    for (let page = 1; page <= pageCount; page++) {
      const { blocks } = buildLegacyQueueBlocks({ sessionKey: SESSION, items: many }, { page });
      expect(blocks.length).toBeLessThanOrEqual(50);
      for (const text of sectionTexts(blocks)) {
        const match = text.match(/msg-\d+/);
        if (match) seen.add(match[0]);
      }
    }

    expect(seen.size).toBe(100);
  });

  it('states the full count and the page position so nothing is silently omitted', () => {
    const { blocks, text } = buildLegacyQueueBlocks({ sessionKey: SESSION, items: many }, { page: 2 });

    const summary = contextTexts(blocks)[0];
    expect(summary).toContain('100');
    expect(summary).toContain('2/10');
    expect(text).toContain('100');
  });

  it('emits prev/next navigation carrying sessionKey + target page', () => {
    const { blocks } = buildLegacyQueueBlocks({ sessionKey: SESSION, items: many }, { page: 2 });

    const nav = collectButtons(blocks).filter(
      (button) =>
        button.action_id === FOLLOWUP_PAGE_PREV_ACTION_ID || button.action_id === FOLLOWUP_PAGE_NEXT_ACTION_ID,
    );
    expect(nav).toHaveLength(2);
    expect(parseFollowupPageActionValue(nav[0].value as string)).toEqual({ sessionKey: SESSION, page: 1 });
    expect(parseFollowupPageActionValue(nav[1].value as string)).toEqual({ sessionKey: SESSION, page: 3 });
  });

  it('omits the out-of-range navigation button rather than disabling it', () => {
    const first = buildLegacyQueueBlocks({ sessionKey: SESSION, items: many }, { page: 1 });
    const last = buildLegacyQueueBlocks({ sessionKey: SESSION, items: many }, { page: 10 });

    const ids = (blocks: unknown[]) => collectButtons(blocks).map((button) => button.action_id);
    expect(ids(first.blocks)).not.toContain(FOLLOWUP_PAGE_PREV_ACTION_ID);
    expect(ids(first.blocks)).toContain(FOLLOWUP_PAGE_NEXT_ACTION_ID);
    expect(ids(last.blocks)).toContain(FOLLOWUP_PAGE_PREV_ACTION_ID);
    expect(ids(last.blocks)).not.toContain(FOLLOWUP_PAGE_NEXT_ACTION_ID);
  });

  it('clamps an invalid page instead of rendering an empty queue', () => {
    for (const page of [0, -5, 999, Number.NaN, 2.7]) {
      const { blocks } = buildLegacyQueueBlocks({ sessionKey: SESSION, items: many }, { page });
      expect(sectionTexts(blocks).some((text) => /msg-\d+/.test(text))).toBe(true);
    }

    const low = buildLegacyQueueBlocks({ sessionKey: SESSION, items: many }, { page: -5 });
    const high = buildLegacyQueueBlocks({ sessionKey: SESSION, items: many }, { page: 999 });
    expect(sectionTexts(low.blocks).join('\n')).toContain('msg-1');
    expect(sectionTexts(high.blocks).join('\n')).toContain('msg-100');
  });

  it('clamps pageSize so a page can never exceed the Slack block budget', () => {
    const { blocks } = buildLegacyQueueBlocks({ sessionKey: SESSION, items: many }, { page: 1, pageSize: 500 });

    expect(blocks.length).toBeLessThanOrEqual(50);
  });

  it('renders an empty queue as an explicit zero, not a missing surface', () => {
    const { blocks, text } = buildLegacyQueueBlocks({ sessionKey: SESSION, items: [] });

    expect(sectionTexts(blocks)[0]).toBe('Queue');
    expect(contextTexts(blocks)[0]).toContain('0');
    expect(text).toContain('0');
  });
});

/**
 * The header breakdown renders `FOLLOWUP_STATE_DISPLAY_ORDER.filter(...)`, so a
 * state that is not in the order is dropped from the counts silently — the item
 * is still listed, but the summary under-reports the queue. The compile-time
 * side of this is the exhaustiveness assertion next to the constant; this is the
 * runtime side, comparing against an independently written list of the states.
 */
describe('FOLLOWUP_STATE_DISPLAY_ORDER — no state can fall out of the counts', () => {
  it('is set-equal to the full state list, each state exactly once', () => {
    expect([...FOLLOWUP_STATE_DISPLAY_ORDER].sort()).toEqual([...ALL_FOLLOWUP_STATES].sort());
    expect(new Set(FOLLOWUP_STATE_DISPLAY_ORDER).size).toBe(FOLLOWUP_STATE_DISPLAY_ORDER.length);
  });

  it('counts one item of every state in the legacy breakdown', () => {
    const items: FollowupItem[] = ALL_FOLLOWUP_STATES.map((state, index) => item({ seq: index + 1, state }));

    const { blocks } = buildLegacyQueueBlocks({ sessionKey: SESSION, items });

    const summary = contextTexts(blocks)[0];
    for (const state of ALL_FOLLOWUP_STATES) {
      expect(summary).toContain(`${followupStateCountLabel(state)} 1`);
    }
  });
});

/** Every overflow menu in the payload, in block order. */
function collectMenus(blocks: unknown[]): Array<Record<string, unknown>> {
  return (blocks as Array<Record<string, unknown>>)
    .map((block) => block.accessory as Record<string, unknown> | undefined)
    .filter((accessory): accessory is Record<string, unknown> => accessory?.type === 'overflow');
}

function menuOptions(menu: Record<string, unknown>): Array<Record<string, unknown>> {
  return menu.options as Array<Record<string, unknown>>;
}

function menuLabels(menu: Record<string, unknown>): string[] {
  return menuOptions(menu).map((option) => (option.text as Record<string, unknown>).text as string);
}

function menuOps(menu: Record<string, unknown>): Array<string | undefined> {
  return menuOptions(menu).map((option) => parseFollowupMenuValue(option.value as string)?.op);
}

function blockTypes(blocks: unknown[]): string[] {
  return (blocks as Array<Record<string, unknown>>).map((block) => block.type as string);
}

describe('buildFollowupQueueBlocks — compact layout is the default (2026-09-17 panel height)', () => {
  it('spends exactly one block per item, so a full page of 10 fits in 13 blocks', () => {
    const items = Array.from({ length: FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE }, (_, index) =>
      item({ seq: index + 1, message: event({ ts: `1700.${index}`, text: `msg-${index + 1}` }) }),
    );

    const { blocks } = buildFollowupQueueBlocks({ sessionKey: SESSION, items });

    expect(blocks.length).toBeLessThanOrEqual(13);
    expect(blockTypes(blocks)).toEqual(['context', ...Array(10).fill('section')]);
    expect(collectMenus(blocks)).toHaveLength(10);
  });

  it('carries the title, the total and the page position on one context line', () => {
    const few = buildFollowupQueueBlocks({ sessionKey: SESSION, items: [item({ seq: 1 }), item({ seq: 2 })] });
    const many = Array.from({ length: 100 }, (_, index) => item({ seq: index + 1 }));
    const paged = buildFollowupQueueBlocks({ sessionKey: SESSION, items: many }, { page: 2 });

    expect(contextTexts(few.blocks)[0]).toBe(`${FOLLOWUP_QUEUE_TITLE} · 2 item(s)`); // no `page 1/1` noise
    expect(contextTexts(paged.blocks)[0]).toBe(`${FOLLOWUP_QUEUE_TITLE} · 100 item(s) · page 2/10`);
    // The dropped decorations: per-state counts and the `showing a–b` range.
    expect(contextTexts(paged.blocks)[0]).not.toContain('showing');
    expect(contextTexts(paged.blocks)[0]).not.toContain('queued 100');
  });

  it('renders an empty queue as an explicit zero, not a missing surface', () => {
    const { blocks, text } = buildFollowupQueueBlocks({ sessionKey: SESSION, items: [] });

    expect(blockTypes(blocks)).toEqual(['context']);
    expect(contextTexts(blocks)[0]).toBe(`${FOLLOWUP_QUEUE_TITLE} · 0 item(s)`);
    expect(text).toContain('0');
  });

  it('keeps the state (and its reason) on the item line, so denied-but-queued stays distinct from paused (A29)', () => {
    const { blocks } = buildFollowupQueueBlocks({
      sessionKey: SESSION,
      items: [
        item({ seq: 1, state: 'queued', stateReason: 'interrupt 권한 거부' }),
        item({ seq: 2, state: 'paused', stateReason: '재시작 복원' }),
      ],
    });

    const lines = sectionTexts(blocks);
    expect(lines[0]).toContain('_queued · interrupt 권한 거부_');
    expect(lines[1]).toContain('_paused · 재시작 복원_');
    expect(lines[0].startsWith('1. ')).toBe(true);
    expect(contextTexts(blocks)).toHaveLength(1); // the title line only — no per-item context
  });

  it('never mutates the caller snapshot (A14/A30 — raw input preserved)', () => {
    const input = { sessionKey: SESSION, items: [item({ seq: 1 }), item({ seq: 2, state: 'paused' as const })] };
    const before = structuredClone(input);

    buildFollowupQueueBlocks(input);

    expect(input).toEqual(before);
  });
});

describe('buildFollowupQueueBlocks — compact overflow menu', () => {
  const MENUS: ReadonlyArray<[FollowupItemState, string[]]> = [
    ['queued', ['send_now', 'cancel']],
    ['steered', ['send_now', 'cancel']],
    ['paused', ['resume', 'send_now', 'cancel']],
    ['failed', ['retry', 'cancel']],
    ['uncertain', ['retry', 'cancel']],
    ['reserved', ['cancel']],
    ['claimed', ['cancel']],
    ['dispatched', ['cancel']],
  ];

  it.each(MENUS)('offers %s the operations %j behind one menu', (state, ops) => {
    const { blocks } = buildFollowupQueueBlocks({ sessionKey: SESSION, items: [item({ state })] });

    const menus = collectMenus(blocks);
    expect(menus).toHaveLength(1);
    expect(menus[0].action_id).toBe(FOLLOWUP_ITEM_MENU_ACTION_ID);
    expect(menuOps(menus[0])).toEqual(ops);
    // Cancel is offered even in flight: the host refuses it, and the refusal is
    // an explicit answer rather than a missing control.
    expect(menuLabels(menus[0])[menuLabels(menus[0]).length - 1]).toBe(FOLLOWUP_CANCEL_LABEL);
    expect(collectButtons(blocks)).toHaveLength(0); // item controls live in the menu, not in buttons
  });

  it.each(['resolved', 'cancelled'] as const)('gives a terminal %s item no menu at all', (state) => {
    const { blocks } = buildFollowupQueueBlocks({ sessionKey: SESSION, items: [item({ state })] });

    expect(collectMenus(blocks)).toHaveLength(0);
    expect(sectionTexts(blocks)[0]).toContain(`_${state}_`); // still visible as history
  });

  it('lists the compact menu among the item-scoped action ids a host registers in one pass', () => {
    // The compact layout is the DEFAULT, so a host that registers only
    // `FOLLOWUP_ITEM_ACTION_IDS` would wire up zero live item controls.
    expect(FOLLOWUP_ITEM_ACTION_IDS).toContain(FOLLOWUP_ITEM_MENU_ACTION_ID);
    expect(new Set(FOLLOWUP_ITEM_ACTION_IDS).size).toBe(FOLLOWUP_ITEM_ACTION_IDS.length);
  });

  it('uses the canonical labels', () => {
    const { blocks } = buildFollowupQueueBlocks({ sessionKey: SESSION, items: [item({ state: 'paused' })] });

    expect(FOLLOWUP_ITEM_MENU_ACTION_ID).toBe('followup_item_menu_v1');
    expect(FOLLOWUP_CANCEL_LABEL).toBe('Cancel');
    expect(menuLabels(collectMenus(blocks)[0])).toEqual(['Resume', FOLLOWUP_SEND_NOW_LABEL, FOLLOWUP_CANCEL_LABEL]);
  });

  it('withholds Send now under a session freeze while keeping Resume and Cancel', () => {
    const { blocks } = buildFollowupQueueBlocks({
      sessionKey: SESSION,
      items: [item({ seq: 1, state: 'queued' }), item({ seq: 2, state: 'paused' })],
      freeze: { reason: 'stop requested', at: 1_700_000_000_000 },
    });

    expect(contextTexts(blocks).some((line) => line.includes('stop requested'))).toBe(true);
    for (const menu of collectMenus(blocks)) {
      expect(menuOps(menu)).toEqual(['resume', 'cancel']);
    }
  });

  it('encodes the op beside the queue coordinates and nothing else (A30)', () => {
    const target = item({ seq: 3, epoch: 11, message: event({ text: 'secret-payload-text', user: 'U-AUTHOR' }) });

    const { blocks } = buildFollowupQueueBlocks({ sessionKey: SESSION, items: [target], turnEpoch: 4 });

    const [sendNow, cancel] = menuOptions(collectMenus(blocks)[0]);
    // Short keys, and the item's `seq` instead of its id: the option budget is
    // 150 chars and the id repeats the session key verbatim.
    expect(Object.keys(JSON.parse(sendNow.value as string)).sort()).toEqual(['e', 'n', 'op', 's', 't']);
    expect(parseFollowupMenuValue(sendNow.value as string)).toEqual({
      op: 'send_now',
      sessionKey: SESSION,
      itemId: target.id,
      epoch: 11,
      turnEpoch: 4,
    });
    // Cancel acts on an item the caller already sees; it is not gated on the turn generation.
    expect(parseFollowupMenuValue(cancel.value as string)).toEqual({
      op: 'cancel',
      sessionKey: SESSION,
      itemId: target.id,
      epoch: 11,
    });
    for (const option of menuOptions(collectMenus(blocks)[0])) {
      const value = option.value as string;
      expect(value).not.toContain('secret-payload-text');
      expect(value).not.toContain('U-AUTHOR');
      expect(value).not.toContain('/Users/secret/work');
    }
  });

  it('rejects malformed or unknown-op menu values instead of guessing', () => {
    expect(parseFollowupMenuValue(undefined)).toBeUndefined();
    expect(parseFollowupMenuValue('not json')).toBeUndefined();
    expect(parseFollowupMenuValue('{"s":"C1","n":1,"e":1}')).toBeUndefined(); // no op
    expect(parseFollowupMenuValue('{"op":"delete","s":"C1","n":1,"e":1}')).toBeUndefined();
    expect(parseFollowupMenuValue('{"op":"cancel","s":"C1","n":1}')).toBeUndefined(); // no epoch
    expect(parseFollowupMenuValue('{"op":"cancel","s":"C1","e":1}')).toBeUndefined(); // no seq
    expect(parseFollowupMenuValue('{"op":"cancel","s":"C1","n":1,"e":1,"u":"U1"}')).toBeUndefined();
    expect(parseFollowupMenuValue('{"op":"cancel","s":"C1","n":1,"e":"x"}')).toBeUndefined();
    expect(parseFollowupMenuValue('{"op":"cancel","s":"C1","n":"1","e":1}')).toBeUndefined();
    expect(parseFollowupMenuValue('{"op":"cancel","s":"","n":1,"e":1}')).toBeUndefined();
    expect(parseFollowupMenuValue('{"op":"cancel","s":"C1","n":1,"e":1,"t":null}')).toBeUndefined();
    // The pre-2026-09-17 long-key encoding is not accepted either: a stale
    // button is refused, never re-read under the new key names.
    expect(parseFollowupMenuValue('{"op":"cancel","sessionKey":"C1","itemId":"C1#1","epoch":1}')).toBeUndefined();
  });

  it('reconstructs the item id from the session key and the seq', () => {
    const { blocks } = buildFollowupQueueBlocks({ sessionKey: SESSION, items: [item({ seq: 42, epoch: 3 })] });

    const [, cancel] = menuOptions(collectMenus(blocks)[0]);
    expect(JSON.parse(cancel.value as string).n).toBe(42);
    expect(parseFollowupMenuValue(cancel.value as string)?.itemId).toBe(`${SESSION}#42`);
  });

  // A menu-level confirm is the only kind Slack offers, and it fires for EVERY
  // option — including Cancel, which is the one operation an uncertain item can
  // always take safely. The R6 caution therefore moves into the item line and
  // the menu stays confirm-free; the confirm-gated Retry survives in the legacy
  // layout, where it is attached to the Retry BUTTON and nothing else.
  it('carries the R6 caution on the uncertain item line instead of confirm-gating its whole menu', () => {
    const { blocks } = buildFollowupQueueBlocks({
      sessionKey: SESSION,
      items: [item({ seq: 1, state: 'uncertain' }), item({ seq: 2, state: 'failed' })],
    });

    const [uncertain, failed] = collectMenus(blocks);
    expect(uncertain.confirm).toBeUndefined();
    expect(failed.confirm).toBeUndefined();
    expect(JSON.stringify(blocks)).not.toContain('"confirm"');

    const [uncertainLine, failedLine] = sectionTexts(blocks);
    expect(uncertainLine).toContain('_uncertain — 재실행 전 확인_');
    expect(failedLine).toContain('_failed_');
    expect(failedLine).not.toContain('재실행 전 확인');
  });

  it('keeps the state reason next to the caution on an uncertain item', () => {
    const { blocks } = buildFollowupQueueBlocks({
      sessionKey: SESSION,
      items: [item({ seq: 1, state: 'uncertain', stateReason: '재시작 중 중단' })],
    });

    expect(sectionTexts(blocks)[0]).toContain('_uncertain — 재실행 전 확인 · 재시작 중 중단_');
  });

  it('keeps a REAL session key far inside the 150-char option budget', () => {
    // The shapes the queue actually mints: `work:<channel>:<threadTs>`
    // (`src/session-identity.ts:45`) and `<sessionKey>#<seq>`
    // (`followup-queue.ts:315`). Spelled out in full, the pair alone was ~140 of
    // the 150 available — one longer channel id away from a dropped control.
    const sessionKey = 'work:C08ABCDEFGH:1726500000.123456';
    const target = item({
      sessionKey,
      seq: 9999,
      id: `${sessionKey}#9999`,
      epoch: 99,
    });

    const { blocks } = buildFollowupQueueBlocks({ sessionKey, items: [target], turnEpoch: 9999 });

    const [sendNow] = menuOptions(collectMenus(blocks)[0]);
    expect((sendNow.value as string).length).toBeLessThanOrEqual(110);
    expect(parseFollowupMenuValue(sendNow.value as string)).toEqual({
      op: 'send_now',
      sessionKey,
      itemId: `${sessionKey}#9999`,
      epoch: 99,
      turnEpoch: 9999,
    });
  });

  it('says so on the item line when an option is dropped for exceeding the option cap', () => {
    // A key no real session has, to force the defensive drop deterministically.
    const sessionKey = `work:${'X'.repeat(300)}`;
    const target = item({ sessionKey, seq: 1, id: `${sessionKey}#1` });

    const { blocks } = buildFollowupQueueBlocks({ sessionKey, items: [target] });

    expect(collectMenus(blocks)).toHaveLength(0);
    expect((blocks[1] as Record<string, unknown>).accessory).toBeUndefined();
    expect(sectionTexts(blocks)[0]).toContain('action unavailable');
  });

  it('stays inside the Slack option limits (text ≤75, value ≤150, ≤5 options)', () => {
    const items: FollowupItem[] = ALL_FOLLOWUP_STATES.map((state, index) => item({ seq: index + 1, state }));

    const { blocks } = buildFollowupQueueBlocks({ sessionKey: SESSION, items });

    for (const menu of collectMenus(blocks)) {
      const options = menuOptions(menu);
      expect(options.length).toBeGreaterThanOrEqual(1);
      expect(options.length).toBeLessThanOrEqual(5);
      for (const option of options) {
        expect(((option.text as Record<string, unknown>).text as string).length).toBeLessThanOrEqual(75);
        expect((option.value as string).length).toBeLessThanOrEqual(150);
        expect((option.text as Record<string, unknown>).type).toBe('plain_text');
      }
    }
    expect(JSON.stringify(blocks)).not.toContain('"disabled"');
  });
});

/**
 * `steered` = the message was pushed into the RUNNING turn's SDK input channel
 * and the model reads it at its next tool-call boundary (06 §3.1/§3.2). It is a
 * live queue row, not history: it keeps controls until the SDK's consumption
 * receipt turns it into `resolved · consumed`, which is when it leaves.
 */
describe('buildFollowupQueueBlocks — a steered item (06 §3.5)', () => {
  it('says 전달됨 instead of the internal state word, in both layouts', () => {
    // The queue stamps `steered` as BOTH the state and its reason
    // (`followup-queue.ts:587`), which is the shape the panel has to survive.
    const steered = item({ seq: 1, state: 'steered', stateReason: 'steered', steerUuid: 'uuid-1' });

    const compact = buildFollowupQueueBlocks({ sessionKey: SESSION, items: [steered] });
    const legacy = buildLegacyQueueBlocks({ sessionKey: SESSION, items: [steered] });

    expect(FOLLOWUP_STEERED_LABEL).toBe('전달됨 · 모델이 다음 툴 호출에서 읽음');
    expect(sectionTexts(compact.blocks)[0]).toBe(`1. 진행중인거 알려줘? · _${FOLLOWUP_STEERED_LABEL}_`);
    // Repeating the enum name after the label says nothing the label has not said.
    expect(sectionTexts(compact.blocks)[0]).not.toContain('steered');
    expect(contextTexts(legacy.blocks).some((line) => line.startsWith(FOLLOWUP_STEERED_LABEL))).toBe(true);
    expect(contextTexts(legacy.blocks).some((line) => line.includes('· steered'))).toBe(false);
  });

  it('offers Send now and Cancel, and gates only Send now on the turn generation (06 §3.3/§3.4)', () => {
    const { blocks } = buildFollowupQueueBlocks({
      sessionKey: SESSION,
      items: [item({ state: 'steered' })],
      turnEpoch: 5,
    });

    const [menu] = collectMenus(blocks);
    expect(menuOps(menu)).toEqual(['send_now', 'cancel']);
    expect(menuLabels(menu)).toEqual([FOLLOWUP_SEND_NOW_LABEL, FOLLOWUP_CANCEL_LABEL]);
    // `Send now` on a steered item still targets the LIVE turn (the dispatcher
    // unsteers it, then interrupts), so it keeps the turn-generation gate;
    // `Cancel` goes to the SDK by uuid and is not gated on it.
    const [sendNow, cancel] = menuOptions(menu);
    expect(parseFollowupMenuValue(sendNow.value as string)?.turnEpoch).toBe(5);
    expect(parseFollowupMenuValue(cancel.value as string)?.turnEpoch).toBeUndefined();
  });

  it('keeps Send now reachable in the legacy layout too', () => {
    const { blocks } = buildLegacyQueueBlocks({
      sessionKey: SESSION,
      items: [item({ state: 'steered' })],
      turnEpoch: 5,
    });

    const buttons = collectButtons(blocks);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].action_id).toBe(FOLLOWUP_SEND_NOW_ACTION_ID);
    expect(parseFollowupItemActionValue(buttons[0].value as string)?.turnEpoch).toBe(5);
    expect(contextTexts(blocks).some((line) => line.includes('action unavailable'))).toBe(false);
  });

  it('offers only Cancel under a freeze — a frozen session has no turn to steer into', () => {
    // A freeze rewrites `steered → paused` (`followup-queue.ts:202/221`), so this
    // row should not exist; the default branch still has to be safe if it does.
    const { blocks } = buildFollowupQueueBlocks({
      sessionKey: SESSION,
      items: [item({ state: 'steered' })],
      freeze: { reason: 'stop requested', at: 1_700_000_000_000 },
    });

    expect(menuOps(collectMenus(blocks)[0])).toEqual(['cancel']);
  });

  it('keeps the steered Send now option inside the option budget with a REAL session key', () => {
    const sessionKey = 'work:C08ABCDEFGH:1726500000.123456';
    const target = item({ sessionKey, seq: 9999, id: `${sessionKey}#9999`, epoch: 99, state: 'steered' });

    const { blocks } = buildFollowupQueueBlocks({ sessionKey, items: [target], turnEpoch: 9999 });

    const [sendNow] = menuOptions(collectMenus(blocks)[0]);
    expect((sendNow.value as string).length).toBeLessThanOrEqual(110);
    expect(parseFollowupMenuValue(sendNow.value as string)?.op).toBe('send_now');
    expect(sectionTexts(blocks)[0]).not.toContain('action unavailable');
  });

  it('leaves a consumed item as history with no control once the model has read it', () => {
    const { blocks } = buildFollowupQueueBlocks({
      sessionKey: SESSION,
      items: [item({ seq: 1, state: 'steered' }), item({ seq: 2, state: 'resolved', stateReason: 'consumed' })],
    });

    // Only the steered row is still actionable; the consumed one is history.
    expect(collectMenus(blocks)).toHaveLength(1);
    const [steeredLine, consumedLine] = sectionTexts(blocks);
    expect(steeredLine).toContain(FOLLOWUP_STEERED_LABEL);
    expect(consumedLine).toContain('_resolved · consumed_');
    expect(consumedLine).not.toContain(FOLLOWUP_STEERED_LABEL);
  });

  it('counts steered as 전달, right after queued, in the legacy breakdown', () => {
    const { blocks } = buildLegacyQueueBlocks({
      sessionKey: SESSION,
      items: [item({ seq: 1, state: 'queued' }), item({ seq: 2, state: 'steered' }), item({ seq: 3, state: 'paused' })],
    });

    const summary = contextTexts(blocks)[0];
    expect(FOLLOWUP_STEERED_COUNT_LABEL).toBe('전달');
    expect(summary).toContain(`queued 1 · ${FOLLOWUP_STEERED_COUNT_LABEL} 1 · paused 1`);
    expect(summary).not.toContain('steered 1');
  });
});

describe('buildFollowupQueueBlocks — compact text safety and paging', () => {
  it('escapes an untrusted message so mrkdwn cannot inject mentions or links', () => {
    const hostile = '<!channel> <@U0DEADBEEF> <https://evil.example|click>';
    const { blocks, text } = buildFollowupQueueBlocks({
      sessionKey: SESSION,
      items: [item({ message: event({ text: hostile }) })],
    });

    const line = blocks[1] as Record<string, Record<string, unknown>>;
    expect(line.text.type).toBe('mrkdwn');
    expect(line.text.text).toContain('&lt;!channel&gt;');
    expect(JSON.stringify(blocks)).not.toContain('<!channel>');
    expect(JSON.stringify(blocks)).not.toContain('<@U0DEADBEEF>');
    expect(JSON.stringify(blocks)).not.toContain('<https://evil.example|click>');
    expect(text).not.toContain('<!channel>');
  });

  it('renders a preview containing _queued_ without italics markers, with the real state last', () => {
    // The compact row italicises the REAL state, so an italic run inside the
    // message reads as one more state label sitting BEFORE it.
    const { blocks } = buildFollowupQueueBlocks({
      sessionKey: SESSION,
      items: [item({ state: 'failed', message: event({ text: '이거 봐줘 _queued_' }) })],
    });

    const line = sectionTexts(blocks)[0];
    expect(line).not.toContain('_queued_');
    expect(line.match(/_/g)).toHaveLength(2); // the real label's pair, and nothing else
    expect(line.endsWith('_failed_')).toBe(true);
    expect(line).toContain('queued'); // the word stays readable — only its markers change
  });

  it('neutralises a spoofed 전달됨 state label in the message text', () => {
    const spoof = `작업 · _${FOLLOWUP_STEERED_LABEL}_`;
    const { blocks } = buildFollowupQueueBlocks({
      sessionKey: SESSION,
      items: [item({ state: 'queued', message: event({ text: spoof }) })],
    });

    const line = sectionTexts(blocks)[0];
    expect(line).not.toContain(`_${FOLLOWUP_STEERED_LABEL}_`);
    expect(line.match(/_/g)).toHaveLength(2);
    expect(line.endsWith('_queued_')).toBe(true);
  });

  it('neutralises * and ~ in the preview too, so no emphasis run starts in user text', () => {
    const { blocks } = buildFollowupQueueBlocks({
      sessionKey: SESSION,
      items: [item({ message: event({ text: '*bold* ~strike~' }) })],
    });

    const line = sectionTexts(blocks)[0];
    expect(line).not.toContain('*');
    expect(line).not.toContain('~');
    expect(line).toContain('bold');
    expect(line).toContain('strike');
  });

  it('truncates a long unicode preview to one short line without splitting surrogate pairs', () => {
    const long = `${'🙂'.repeat(400)}끝`;
    const { blocks } = buildFollowupQueueBlocks({
      sessionKey: SESSION,
      items: [item({ message: event({ text: long }) })],
    });

    const line = sectionTexts(blocks)[0];
    expect(line).toContain('…');
    expect([...line].length).toBeLessThanOrEqual(120);
    expect(line).not.toContain('�');
    expect(line).not.toContain('끝'); // the tail is cut, not wrapped onto a second line
  });

  it('falls back to attachment names when the message carries files only', () => {
    const files = [
      {
        id: 'F1',
        name: 'trace-capture.png',
        mimetype: 'image/png',
        filetype: 'png',
        url_private: 'https://files.slack.com/p',
        url_private_download: 'https://files.slack.com/d',
        size: 10,
      },
    ];
    const { blocks } = buildFollowupQueueBlocks({
      sessionKey: SESSION,
      items: [item({ message: event({ text: '   ', files }) })],
    });

    expect(sectionTexts(blocks)[0]).toContain('trace-capture.png');
  });

  it('keeps the attachment count visible when the message has both text and files', () => {
    // Compact dropped the per-item context line that used to carry `N file(s)`,
    // so a text+files item looked text-only. The badge restores that signal.
    const file = (id: string, name: string) => ({
      id,
      name,
      mimetype: 'image/png',
      filetype: 'png',
      url_private: 'https://files.slack.com/p',
      url_private_download: 'https://files.slack.com/d',
      size: 10,
    });
    const { blocks } = buildFollowupQueueBlocks({
      sessionKey: SESSION,
      items: [
        item({ seq: 1, message: event({ text: '이 로그 봐줘', files: [file('F1', 'a.png'), file('F2', 'b.png')] }) }),
        item({ seq: 2, message: event({ text: '파일 없음' }) }),
      ],
    });

    const [withFiles, withoutFiles] = sectionTexts(blocks);
    expect(withFiles).toContain('이 로그 봐줘 (📎2)');
    expect(withoutFiles).not.toContain('📎');
  });

  it('adds one pagination actions block only when a second page exists, and reaches every item', () => {
    const many = Array.from({ length: 100 }, (_, index) =>
      item({ seq: index + 1, message: event({ ts: `1700.${index}`, text: `msg-${index + 1}` }) }),
    );
    const single = buildFollowupQueueBlocks({ sessionKey: SESSION, items: many.slice(0, 3) });

    expect(blockTypes(single.blocks)).not.toContain('actions');

    const seen = new Set<string>();
    for (let page = 1; page <= 10; page++) {
      const { blocks } = buildFollowupQueueBlocks({ sessionKey: SESSION, items: many }, { page });
      expect(blocks.length).toBeLessThanOrEqual(13);
      expect(blockTypes(blocks).filter((type) => type === 'actions')).toHaveLength(1);
      for (const line of sectionTexts(blocks)) {
        const match = line.match(/msg-\d+/);
        if (match) seen.add(match[0]);
      }
    }
    expect(seen.size).toBe(100);

    const nav = collectButtons(buildFollowupQueueBlocks({ sessionKey: SESSION, items: many }, { page: 2 }).blocks);
    expect(nav.map((button) => button.action_id)).toEqual([FOLLOWUP_PAGE_PREV_ACTION_ID, FOLLOWUP_PAGE_NEXT_ACTION_ID]);
    expect(parseFollowupPageActionValue(nav[0].value as string)).toEqual({ sessionKey: SESSION, page: 1 });
  });
});
