import { describe, expect, it } from 'vitest';
import type { FollowupItem } from '../followup-queue';
import {
  buildFollowupQueueBlocks,
  FOLLOWUP_PAGE_NEXT_ACTION_ID,
  FOLLOWUP_PAGE_PREV_ACTION_ID,
  FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE,
  FOLLOWUP_QUEUE_TITLE,
  FOLLOWUP_RESUME_ACTION_ID,
  FOLLOWUP_RETRY_ACTION_ID,
  FOLLOWUP_SEND_NOW_ACTION_ID,
  FOLLOWUP_SEND_NOW_LABEL,
  parseFollowupItemActionValue,
  parseFollowupPageActionValue,
} from '../followup-queue-blocks';
import type { MessageEvent } from '../pipeline/types';

const SESSION = 'C1:1700.000000';

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

describe('buildFollowupQueueBlocks — surface labels', () => {
  it('titles the surface `Queue` and never merges the separate Goals queue (SSOT §2/§3.6)', () => {
    const { blocks, text } = buildFollowupQueueBlocks({ sessionKey: SESSION, items: [item()] });

    expect(FOLLOWUP_QUEUE_TITLE).toBe('Queue');
    expect(sectionTexts(blocks)[0]).toBe('Queue');
    expect(JSON.stringify(blocks)).not.toContain('Goals');
    expect(text).toContain('Queue');
  });

  it('offers the canonical `Send now` label on a queued item (SSOT §2)', () => {
    const { blocks } = buildFollowupQueueBlocks({ sessionKey: SESSION, items: [item()] });

    const buttons = collectButtons(blocks);
    expect(FOLLOWUP_SEND_NOW_LABEL).toBe('Send now');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].action_id).toBe(FOLLOWUP_SEND_NOW_ACTION_ID);
    expect((buttons[0].text as Record<string, unknown>).text).toBe('Send now');
    expect((buttons[0].text as Record<string, unknown>).type).toBe('plain_text');
  });

  it('shows the raw message as the item preview', () => {
    const { blocks } = buildFollowupQueueBlocks({ sessionKey: SESSION, items: [item()] });

    expect(sectionTexts(blocks).join('\n')).toContain('진행중인거 알려줘?');
  });
});

describe('buildFollowupQueueBlocks — purity and Slack limits', () => {
  it('never mutates the caller snapshot (A14/A30 — raw input preserved)', () => {
    const input = { sessionKey: SESSION, items: [item({ seq: 1 }), item({ seq: 2, state: 'paused' })] };
    const before = structuredClone(input);

    buildFollowupQueueBlocks(input);

    expect(input).toEqual(before);
  });

  it('truncates long unicode previews without splitting surrogate pairs or exceeding limits', () => {
    const long = `${'🙂'.repeat(400)}끝`;
    const { blocks } = buildFollowupQueueBlocks({
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
    const { blocks } = buildFollowupQueueBlocks({
      sessionKey: SESSION,
      items: [item({ message: event({ text: '   ', files }) })],
    });

    expect(sectionTexts(blocks).join('\n')).toContain('trace-capture.png');
  });

  it('emits only plain_text objects so an untrusted message cannot inject mrkdwn mentions', () => {
    const hostile = '<!channel> <@U0DEADBEEF> *bold* <https://evil.example|click>';
    const { blocks, text } = buildFollowupQueueBlocks({
      sessionKey: SESSION,
      items: [item({ message: event({ text: hostile }) })],
    });

    for (const textObject of collectTextObjects(blocks)) expect(textObject.type).toBe('plain_text');
    expect(text).not.toContain('<!channel>');
    expect(text).not.toContain('<@U0DEADBEEF>');
  });

  it('never emits the unsupported `disabled` button field (invalid_blocks guard)', () => {
    const items: FollowupItem[] = (
      ['queued', 'reserved', 'claimed', 'dispatched', 'resolved', 'failed', 'uncertain', 'paused', 'cancelled'] as const
    ).map((state, index) => item({ seq: index + 1, state }));

    const { blocks } = buildFollowupQueueBlocks({ sessionKey: SESSION, items });

    for (const button of collectButtons(blocks)) expect(button).not.toHaveProperty('disabled');
    expect(JSON.stringify(blocks)).not.toContain('"disabled"');
  });
});

describe('buildFollowupQueueBlocks — state semantics (SSOT §3.4/§3.5)', () => {
  it('renders a denied-but-queued item distinctly from a paused item (A29)', () => {
    const { blocks } = buildFollowupQueueBlocks({
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
    const { blocks } = buildFollowupQueueBlocks({
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
    const { blocks } = buildFollowupQueueBlocks({
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
    const { blocks } = buildFollowupQueueBlocks({
      sessionKey: SESSION,
      items: [item({ seq: 1, state: 'cancelled', stateReason: '세션 삭제', message: event({ text: '취소된 후속' }) })],
    });

    expect(sectionTexts(blocks).join('\n')).toContain('취소된 후속');
    expect(contextTexts(blocks).some((line) => line.startsWith('cancelled') && line.includes('세션 삭제'))).toBe(true);
    expect(collectButtons(blocks)).toHaveLength(0);
  });
});

describe('buildFollowupQueueBlocks — action values carry no identity', () => {
  it('encodes only queue coordinates — never author, cwd, token or raw message', () => {
    const target = item({ seq: 3, epoch: 11, message: event({ text: 'secret-payload-text', user: 'U-AUTHOR' }) });

    const { blocks } = buildFollowupQueueBlocks({ sessionKey: SESSION, items: [target], turnEpoch: 4 });

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

    const withTurn = buildFollowupQueueBlocks({ sessionKey: SESSION, items: [target], turnEpoch: 9 });
    const withoutTurn = buildFollowupQueueBlocks({ sessionKey: SESSION, items: [target] });

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
    const { blocks } = buildFollowupQueueBlocks({
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

describe('buildFollowupQueueBlocks — pagination exposes every item', () => {
  const many = Array.from({ length: 100 }, (_, index) =>
    item({ seq: index + 1, message: event({ ts: `1700.${index}`, text: `msg-${index + 1}` }) }),
  );

  it('reaches all 100 items across pages, within the 50-block message cap', () => {
    const seen = new Set<string>();
    const pageCount = Math.ceil(many.length / FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE);

    for (let page = 1; page <= pageCount; page++) {
      const { blocks } = buildFollowupQueueBlocks({ sessionKey: SESSION, items: many }, { page });
      expect(blocks.length).toBeLessThanOrEqual(50);
      for (const text of sectionTexts(blocks)) {
        const match = text.match(/msg-\d+/);
        if (match) seen.add(match[0]);
      }
    }

    expect(seen.size).toBe(100);
  });

  it('states the full count and the page position so nothing is silently omitted', () => {
    const { blocks, text } = buildFollowupQueueBlocks({ sessionKey: SESSION, items: many }, { page: 2 });

    const summary = contextTexts(blocks)[0];
    expect(summary).toContain('100');
    expect(summary).toContain('2/10');
    expect(text).toContain('100');
  });

  it('emits prev/next navigation carrying sessionKey + target page', () => {
    const { blocks } = buildFollowupQueueBlocks({ sessionKey: SESSION, items: many }, { page: 2 });

    const nav = collectButtons(blocks).filter(
      (button) =>
        button.action_id === FOLLOWUP_PAGE_PREV_ACTION_ID || button.action_id === FOLLOWUP_PAGE_NEXT_ACTION_ID,
    );
    expect(nav).toHaveLength(2);
    expect(parseFollowupPageActionValue(nav[0].value as string)).toEqual({ sessionKey: SESSION, page: 1 });
    expect(parseFollowupPageActionValue(nav[1].value as string)).toEqual({ sessionKey: SESSION, page: 3 });
  });

  it('omits the out-of-range navigation button rather than disabling it', () => {
    const first = buildFollowupQueueBlocks({ sessionKey: SESSION, items: many }, { page: 1 });
    const last = buildFollowupQueueBlocks({ sessionKey: SESSION, items: many }, { page: 10 });

    const ids = (blocks: unknown[]) => collectButtons(blocks).map((button) => button.action_id);
    expect(ids(first.blocks)).not.toContain(FOLLOWUP_PAGE_PREV_ACTION_ID);
    expect(ids(first.blocks)).toContain(FOLLOWUP_PAGE_NEXT_ACTION_ID);
    expect(ids(last.blocks)).toContain(FOLLOWUP_PAGE_PREV_ACTION_ID);
    expect(ids(last.blocks)).not.toContain(FOLLOWUP_PAGE_NEXT_ACTION_ID);
  });

  it('clamps an invalid page instead of rendering an empty queue', () => {
    for (const page of [0, -5, 999, Number.NaN, 2.7]) {
      const { blocks } = buildFollowupQueueBlocks({ sessionKey: SESSION, items: many }, { page });
      expect(sectionTexts(blocks).some((text) => /msg-\d+/.test(text))).toBe(true);
    }

    const low = buildFollowupQueueBlocks({ sessionKey: SESSION, items: many }, { page: -5 });
    const high = buildFollowupQueueBlocks({ sessionKey: SESSION, items: many }, { page: 999 });
    expect(sectionTexts(low.blocks).join('\n')).toContain('msg-1');
    expect(sectionTexts(high.blocks).join('\n')).toContain('msg-100');
  });

  it('clamps pageSize so a page can never exceed the Slack block budget', () => {
    const { blocks } = buildFollowupQueueBlocks({ sessionKey: SESSION, items: many }, { page: 1, pageSize: 500 });

    expect(blocks.length).toBeLessThanOrEqual(50);
  });

  it('renders an empty queue as an explicit zero, not a missing surface', () => {
    const { blocks, text } = buildFollowupQueueBlocks({ sessionKey: SESSION, items: [] });

    expect(sectionTexts(blocks)[0]).toBe('Queue');
    expect(contextTexts(blocks)[0]).toContain('0');
    expect(text).toContain('0');
  });
});
