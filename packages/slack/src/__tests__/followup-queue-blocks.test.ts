import { describe, expect, it } from 'vitest';
import type { FollowupItem, FollowupItemState } from '../followup-queue';
import {
  buildFollowupItemMessage,
  FOLLOWUP_CANCEL_ACTION_ID,
  FOLLOWUP_CANCEL_LABEL,
  FOLLOWUP_PENDING_STATES,
  FOLLOWUP_QUEUE_TITLE,
  FOLLOWUP_RESTART_FREEZE_NOTICE,
  FOLLOWUP_RESTART_FREEZE_REASON,
  FOLLOWUP_RESUME_ACTION_ID,
  FOLLOWUP_RETRY_ACTION_ID,
  FOLLOWUP_SEND_NOW_ACTION_ID,
  FOLLOWUP_SEND_NOW_LABEL,
  FOLLOWUP_STEERED_LABEL,
  followupFreezeBannerText,
  parseFollowupItemActionValue,
  parseFollowupMenuValue,
  parseFollowupPageActionValue,
} from '../followup-queue-blocks';
import type { MessageEvent } from '../pipeline/types';

const SESSION = 'C1:1700.000000';

/** Every `FollowupItemState` (`followup-queue.ts:29-39`), spelled out independently of the module. */
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

/**
 * Control payloads. The item buttons are minted by {@link buildFollowupItemMessage};
 * the menu and pagination payloads are no longer minted by anything, but the
 * host still parses them for panel messages posted before A39, so the parsers
 * are pinned against hand-written wire strings.
 */
describe('follow-up control payloads carry queue coordinates only (A30)', () => {
  it('encodes only queue coordinates on every button — never author, cwd, token or raw message', () => {
    const target = item({ seq: 3, epoch: 11, message: event({ text: 'secret-payload-text', user: 'U-AUTHOR' }) });

    const { blocks } = buildFollowupItemMessage(target, 4);

    const [sendNow, cancel] = collectButtons(blocks);
    expect(Object.keys(JSON.parse(sendNow.value as string)).sort()).toEqual([
      'epoch',
      'itemId',
      'sessionKey',
      'turnEpoch',
    ]);
    expect(Object.keys(JSON.parse(cancel.value as string)).sort()).toEqual(['epoch', 'itemId', 'sessionKey']);
    for (const button of [sendNow, cancel]) {
      const value = button.value as string;
      expect(value).not.toContain('secret-payload-text');
      expect(value).not.toContain('U-AUTHOR');
      expect(value).not.toContain('/Users/secret/work');
    }
  });

  it('leaves Resume and Retry on the item-epoch-only payload (no turn-generation gate)', () => {
    for (const state of ['paused', 'failed', 'uncertain'] as const) {
      const { blocks } = buildFollowupItemMessage(item({ seq: 1, state }), 9);
      const [primary] = collectButtons(blocks);
      expect([FOLLOWUP_RESUME_ACTION_ID, FOLLOWUP_RETRY_ACTION_ID]).toContain(primary.action_id);
      expect(Object.keys(JSON.parse(primary.value as string)).sort()).toEqual(['epoch', 'itemId', 'sessionKey']);
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
    expect(parseFollowupPageActionValue('{"sessionKey":"C1","page":3}')).toEqual({ sessionKey: 'C1', page: 3 });
  });

  it('reads the short-key menu wire form and rebuilds the item id from the session key and the seq', () => {
    // `{op,s,n,e,t?}`: short keys and the item's `seq` instead of its id — an
    // option `value` is capped at 150 chars and the id repeats the session key.
    expect(parseFollowupMenuValue(JSON.stringify({ op: 'send_now', s: SESSION, n: 42, e: 3, t: 4 }))).toEqual({
      op: 'send_now',
      sessionKey: SESSION,
      itemId: `${SESSION}#42`,
      epoch: 3,
      turnEpoch: 4,
    });
    expect(parseFollowupMenuValue(JSON.stringify({ op: 'cancel', s: SESSION, n: 42, e: 3 }))).toEqual({
      op: 'cancel',
      sessionKey: SESSION,
      itemId: `${SESSION}#42`,
      epoch: 3,
    });
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
});

describe('buildFollowupItemMessage — text safety and the item line', () => {
  it('escapes an untrusted link so mrkdwn cannot mint it', () => {
    const { blocks, text } = buildFollowupItemMessage(
      item({ message: event({ text: '<https://evil.example|click>' }) }),
      0,
    );

    expect(JSON.stringify(blocks)).not.toContain('<https://evil.example|click>');
    expect(text).not.toContain('<https://evil.example|click>');
    expect(sectionTexts(blocks)[0]).toContain('&lt;https://evil.example|click&gt;');
  });

  it('renders a preview containing _queued_ without italics markers, with the real state last', () => {
    // The row italicises the REAL state, so an italic run inside the message
    // reads as one more state label sitting BEFORE it.
    const { blocks } = buildFollowupItemMessage(
      item({ state: 'failed', message: event({ text: '이거 봐줘 _queued_' }) }),
      0,
    );

    const line = sectionTexts(blocks)[0];
    expect(line).not.toContain('_queued_');
    expect(line.match(/_/g)).toHaveLength(2); // the real label's pair, and nothing else
    expect(line.endsWith('_failed_')).toBe(true);
    expect(line).toContain('queued'); // the word stays readable — only its markers change
  });

  it('neutralises a spoofed 전달됨 state label in the message text', () => {
    const spoof = `작업 · _${FOLLOWUP_STEERED_LABEL}_`;
    const { blocks } = buildFollowupItemMessage(item({ state: 'queued', message: event({ text: spoof }) }), 0);

    const line = sectionTexts(blocks)[0];
    expect(line).not.toContain(`_${FOLLOWUP_STEERED_LABEL}_`);
    expect(line.match(/_/g)).toHaveLength(2);
    expect(line.endsWith('_queued_')).toBe(true);
  });

  it('neutralises * and ~ in the preview too, so no emphasis run starts in user text', () => {
    const { blocks } = buildFollowupItemMessage(item({ message: event({ text: '*bold* ~strike~' }) }), 0);

    const line = sectionTexts(blocks)[0];
    expect(line).not.toContain('*');
    expect(line).not.toContain('~');
    expect(line).toContain('bold');
    expect(line).toContain('strike');
  });

  it('truncates a long unicode preview to one short line without splitting surrogate pairs', () => {
    const long = `${'🙂'.repeat(400)}끝`;
    const { blocks } = buildFollowupItemMessage(item({ message: event({ text: long }) }), 0);

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
    const { blocks } = buildFollowupItemMessage(item({ message: event({ text: '   ', files }) }), 0);

    expect(sectionTexts(blocks)[0]).toContain('trace-capture.png');
  });

  it('adds no attachment badge to a text-only item', () => {
    const { blocks } = buildFollowupItemMessage(item({ message: event({ text: '파일 없음' }) }), 0);

    expect(sectionTexts(blocks)[0]).not.toContain('📎');
  });

  it('keeps the state (and its reason) on the item line, so denied-but-queued stays distinct from paused (A29)', () => {
    const queued = buildFollowupItemMessage(item({ seq: 1, state: 'queued', stateReason: 'interrupt 권한 거부' }), 0);
    const paused = buildFollowupItemMessage(item({ seq: 2, state: 'paused', stateReason: '재시작 복원' }), 0);

    expect(sectionTexts(queued.blocks)[0]).toContain('_queued · interrupt 권한 거부_');
    expect(sectionTexts(paused.blocks)[0]).toContain('_paused · 재시작 복원_');
  });

  it('shows a consumed item as `resolved · consumed`, never as the steered label', () => {
    const { blocks } = buildFollowupItemMessage(item({ seq: 2, state: 'resolved', stateReason: 'consumed' }), 0);

    expect(sectionTexts(blocks)[0]).toContain('_resolved · consumed_');
    expect(sectionTexts(blocks)[0]).not.toContain(FOLLOWUP_STEERED_LABEL);
  });

  it('never mutates the caller item (A14/A30 — raw input preserved)', () => {
    const input = item({ seq: 2, state: 'paused' });
    const before = structuredClone(input);

    buildFollowupItemMessage(input, 3, { freeze: { reason: FOLLOWUP_RESTART_FREEZE_REASON, at: 1 } });

    expect(input).toEqual(before);
  });

  it('never emits the unsupported `disabled` button field, in any state (invalid_blocks guard)', () => {
    for (const state of ALL_FOLLOWUP_STATES) {
      const { blocks } = buildFollowupItemMessage(item({ seq: 1, state }), 0);
      for (const button of collectButtons(blocks)) expect(button).not.toHaveProperty('disabled');
      expect(JSON.stringify(blocks)).not.toContain('"disabled"');
    }
  });

  it('keeps the uncertain Retry confirm dialog inside the Slack text limits (R6)', () => {
    const { blocks } = buildFollowupItemMessage(item({ seq: 1, state: 'uncertain' }), 0);

    const confirm = collectButtons(blocks)[0].confirm as Record<string, Record<string, unknown>>;
    expect(confirm.title.type).toBe('plain_text');
    expect((confirm.title.text as string).length).toBeLessThanOrEqual(100);
    expect((confirm.text.text as string).length).toBeLessThanOrEqual(300);
    expect((confirm.confirm.text as string).length).toBeLessThanOrEqual(30);
    expect((confirm.deny.text as string).length).toBeLessThanOrEqual(30);
  });
});

/**
 * A restart freeze holds back ONLY the items the session already held
 * (`followup-queue.ts:221` — `paused`/`uncertain`); a message sent after it runs
 * normally. The panel used to print the raw reason (`frozen · process restart ·
 * explicit Resume required`), which reads as "the queue is stopped", so a user
 * looking at a live thread could not tell that their next message was fine.
 */
describe('followupFreezeBannerText — a restart freeze is scoped to the parked items', () => {
  const restart = { reason: FOLLOWUP_RESTART_FREEZE_REASON, at: 1_700_000_000_000 };

  it('says what a restart freeze actually holds back, on the parked row', () => {
    const { blocks } = buildFollowupItemMessage(item({ seq: 1, state: 'paused', stateReason: '재시작 복원' }), 0, {
      freeze: restart,
    });
    const banner = contextTexts(blocks).find((line) => line.includes('재시작'));

    expect(banner).toBe(FOLLOWUP_RESTART_FREEZE_NOTICE);
    // The control is named per STATE, because that is what decides it: Resume
    // releases a `paused` row, Retry is the only door out of `uncertain`.
    expect(banner).toContain('Resume(보류)');
    expect(banner).toContain('Retry(불확실)');
    expect(banner).not.toContain('⋯');
  });

  it('never claims the queue is stopped for messages sent after the restart', () => {
    const parked = buildFollowupItemMessage(item({ seq: 1, state: 'paused' }), 0, { freeze: restart });
    const later = buildFollowupItemMessage(item({ seq: 2, state: 'queued' }), 0, { freeze: restart });
    const said = [parked, later].map((message) => `${contextTexts(message.blocks).join('\n')}\n${message.text}`);

    for (const lines of said) {
      expect(lines).not.toContain('큐가 멈춰');
      expect(lines).not.toContain('자동으로 실행되지 않습니다');
      // The raw reason is an internal token, not a sentence the user can act on.
      expect(lines).not.toContain(FOLLOWUP_RESTART_FREEZE_REASON);
    }
  });

  it('passes a non-restart freeze reason through unchanged', () => {
    const { blocks } = buildFollowupItemMessage(item({ seq: 1, state: 'paused' }), 0, {
      freeze: { reason: 'stop requested', at: 1_700_000_000_000 },
    });

    const lines = contextTexts(blocks);
    expect(lines.some((line) => line.includes('stop requested'))).toBe(true);
    expect(lines.every((line) => !line.includes(FOLLOWUP_RESTART_FREEZE_NOTICE))).toBe(true);
  });

  it('maps the reason the restart path actually writes, and only that one', () => {
    // `followup-queue.ts:763` stores the caller's string verbatim and
    // `slack-handler.ts:623` passes this exact one.
    expect(FOLLOWUP_RESTART_FREEZE_REASON).toBe('process restart');
    expect(FOLLOWUP_RESTART_FREEZE_NOTICE).toBe(
      '재시작 전에 남아 있던 항목입니다 — 자동으로 다시 실행하지 않습니다. 필요하면 해당 항목의 Resume(보류)/Retry(불확실)로 실행하세요.',
    );
    expect(followupFreezeBannerText(FOLLOWUP_RESTART_FREEZE_REASON)).toBe(FOLLOWUP_RESTART_FREEZE_NOTICE);
    expect(followupFreezeBannerText('  process restart  ')).toBe(FOLLOWUP_RESTART_FREEZE_NOTICE);
    expect(followupFreezeBannerText('process restart (crash)')).toContain('process restart (crash)');
    expect(followupFreezeBannerText('사용자 중지')).toContain('사용자 중지');
  });
});

describe('buildFollowupItemMessage — one queued message, one thread message (A39)', () => {
  const REAL_KEY = 'work:C08ABCDEFGH:1726500000.123456';

  function realItem(over: Partial<FollowupItem> = {}): FollowupItem {
    const seq = over.seq ?? 9999;
    return item({ sessionKey: REAL_KEY, seq, id: `${REAL_KEY}#${seq}`, epoch: 99, ...over });
  }

  it('renders exactly one section line and one actions row carrying both controls', () => {
    const { blocks, text } = buildFollowupItemMessage(item({ seq: 3 }), 4);

    expect(text).toBe(`${FOLLOWUP_QUEUE_TITLE} 3. 진행중인거 알려줘? · queued`);
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as Record<string, unknown>).type).toBe('section');
    expect((blocks[1] as Record<string, unknown>).type).toBe('actions');
    expect(sectionTexts(blocks)[0]).toBe('3. 진행중인거 알려줘? · _queued_');
    expect(collectButtons(blocks).map((button) => button.action_id)).toEqual([
      FOLLOWUP_SEND_NOW_ACTION_ID,
      FOLLOWUP_CANCEL_ACTION_ID,
    ]);
    expect(collectButtons(blocks).map((button) => (button.text as Record<string, unknown>).text)).toEqual([
      FOLLOWUP_SEND_NOW_LABEL,
      FOLLOWUP_CANCEL_LABEL,
    ]);
  });

  it('stamps the turn epoch on `Send now` and withholds it from `Cancel`', () => {
    // Same fence as the panel (A12/A28): steering targets the LIVE turn, so a
    // `Send now` minted in an earlier generation must be refused. `Cancel` acts
    // on an item that is not running, so it carries no turn generation at all.
    const { blocks } = buildFollowupItemMessage(item({ seq: 2, epoch: 7 }), 5);

    const [sendNow, cancel] = collectButtons(blocks);
    expect(parseFollowupItemActionValue(sendNow.value as string)).toEqual({
      sessionKey: SESSION,
      itemId: `${SESSION}#2`,
      epoch: 7,
      turnEpoch: 5,
    });
    expect(parseFollowupItemActionValue(cancel.value as string)).toEqual({
      sessionKey: SESSION,
      itemId: `${SESSION}#2`,
      epoch: 7,
    });
  });

  it('keeps a REAL session key far inside the 150-char value budget', () => {
    const { blocks } = buildFollowupItemMessage(realItem(), 9999);

    for (const button of collectButtons(blocks)) {
      expect((button.value as string).length).toBeLessThanOrEqual(150);
    }
    expect(parseFollowupItemActionValue(collectButtons(blocks)[0].value as string)).toEqual({
      sessionKey: REAL_KEY,
      itemId: `${REAL_KEY}#9999`,
      epoch: 99,
      turnEpoch: 9999,
    });
  });

  it('clamps the preview to 80 characters on one line, keeping the state last', () => {
    const long = `${'가'.repeat(200)}`;
    const { blocks } = buildFollowupItemMessage(item({ seq: 1, message: event({ text: long }) }), 0);

    const line = sectionTexts(blocks)[0];
    expect(line.startsWith(`1. ${'가'.repeat(80)}…`)).toBe(true);
    expect(line.endsWith('· _queued_')).toBe(true);
    expect(line).not.toContain('\n');
  });

  it('says 전달됨 for a steered item instead of the internal state word', () => {
    const steered = item({ seq: 1, state: 'steered', stateReason: 'steered', steerUuid: 'uuid-1' });

    const { blocks, text } = buildFollowupItemMessage(steered, 1);

    expect(sectionTexts(blocks)[0]).toBe(`1. 진행중인거 알려줘? · _${FOLLOWUP_STEERED_LABEL}_`);
    expect(text).toContain(FOLLOWUP_STEERED_LABEL);
    expect(sectionTexts(blocks)[0]).not.toContain('· steered');
  });

  it('numbers the line with the item seq unless the caller supplies its own index', () => {
    expect(sectionTexts(buildFollowupItemMessage(item({ seq: 12 }), 0).blocks)[0].startsWith('12. ')).toBe(true);
    expect(sectionTexts(buildFollowupItemMessage(item({ seq: 12 }), 0, { index: 1 }).blocks)[0].startsWith('1. ')).toBe(
      true,
    );
  });

  /**
   * The controls are picked from the STATE, exactly as the panel's
   * `accessoryFor` picks them — a `paused` row offering `Send now` is a control
   * whose only possible answer is `frozen`, and a `failed` row offering it is a
   * control the dispatcher refuses outright. `Cancel` is on every row because
   * dropping the user's message is legal from all four of them.
   */
  describe('controls follow the item state (M4)', () => {
    function ids(state: FollowupItemState): string[] {
      const { blocks } = buildFollowupItemMessage(item({ seq: 1, state }), 4);
      return collectButtons(blocks).map((button) => String(button.action_id));
    }

    it('offers Send now + Cancel on a queued row', () => {
      expect(ids('queued')).toEqual([FOLLOWUP_SEND_NOW_ACTION_ID, FOLLOWUP_CANCEL_ACTION_ID]);
    });

    it('offers Send now + Cancel on a steered row — it is the same waiting message', () => {
      expect(ids('steered')).toEqual([FOLLOWUP_SEND_NOW_ACTION_ID, FOLLOWUP_CANCEL_ACTION_ID]);
    });

    it('offers Resume + Cancel on a paused row', () => {
      expect(ids('paused')).toEqual([FOLLOWUP_RESUME_ACTION_ID, FOLLOWUP_CANCEL_ACTION_ID]);
    });

    it('offers Retry + Cancel on a failed row, with no confirm dialog', () => {
      const { blocks } = buildFollowupItemMessage(item({ seq: 1, state: 'failed' }), 4);
      const [retry, cancel] = collectButtons(blocks);
      expect(retry.action_id).toBe(FOLLOWUP_RETRY_ACTION_ID);
      expect(cancel.action_id).toBe(FOLLOWUP_CANCEL_ACTION_ID);
      // `failed` never ran to completion, so re-running it repeats nothing.
      expect(retry.confirm).toBeUndefined();
    });

    it('confirm-gates the Retry of an uncertain row and says the caution on the line (R6)', () => {
      // The item may already have produced side effects, so the click that
      // re-runs it is a decision — and the button message has room for the
      // dialog the compact overflow menu could not attach to one option only.
      const { blocks } = buildFollowupItemMessage(item({ seq: 1, state: 'uncertain' }), 4);

      const [retry, cancel] = collectButtons(blocks);
      expect(retry.action_id).toBe(FOLLOWUP_RETRY_ACTION_ID);
      expect(cancel.action_id).toBe(FOLLOWUP_CANCEL_ACTION_ID);
      expect((retry.confirm as Record<string, unknown>).style).toBe('danger');
      expect(cancel.confirm).toBeUndefined();
      expect(sectionTexts(blocks)[0]).toContain('재실행 전 확인');
    });

    it('stamps the turn epoch on Send now only — never on Resume, Retry or Cancel', () => {
      for (const state of ['paused', 'failed', 'uncertain'] as const) {
        const { blocks } = buildFollowupItemMessage(item({ seq: 1, state }), 5);
        for (const button of collectButtons(blocks)) {
          expect(parseFollowupItemActionValue(button.value as string)?.turnEpoch).toBeUndefined();
        }
      }
      const queued = buildFollowupItemMessage(item({ seq: 1 }), 5);
      expect(parseFollowupItemActionValue(collectButtons(queued.blocks)[0].value as string)?.turnEpoch).toBe(5);
    });

    it('leaves a terminal row without controls — there is no operation left', () => {
      for (const state of ['resolved', 'cancelled'] as const) {
        const { blocks } = buildFollowupItemMessage(item({ seq: 1, state }), 4);
        expect(collectButtons(blocks)).toHaveLength(0);
        // …and it does not claim a control was LOST, which is a different fact.
        expect(sectionTexts(blocks)[0]).not.toContain('action unavailable');
      }
    });
  });

  /**
   * A restart freeze used to be readable only on the panel's freeze line, and
   * the panel no longer renders the queue (A39) — so the sentence that tells the
   * user why a restored row is not running by itself had no surface left. It
   * rides the parked row's own message now.
   */
  describe('freeze notice on a parked row (M4)', () => {
    const freeze = { reason: FOLLOWUP_RESTART_FREEZE_REASON, at: 1_700_000_000_000 };

    it('prefixes the restart notice on a row the freeze parked, in blocks and fallback', () => {
      const { blocks, text } = buildFollowupItemMessage(item({ seq: 1, state: 'paused' }), 0, { freeze });

      expect(contextTexts(blocks)[0]).toBe(FOLLOWUP_RESTART_FREEZE_NOTICE);
      // Before the item line, so the notice is read first.
      expect((blocks[0] as Record<string, unknown>).type).toBe('context');
      expect((blocks[1] as Record<string, unknown>).type).toBe('section');
      expect(text.startsWith(FOLLOWUP_RESTART_FREEZE_NOTICE)).toBe(true);
    });

    it('carries the generic freeze sentence for any other reason', () => {
      const { blocks } = buildFollowupItemMessage(item({ seq: 1, state: 'uncertain' }), 0, {
        freeze: { reason: '중지됨', at: 1 },
      });

      expect(contextTexts(blocks)[0]).toBe(followupFreezeBannerText('중지됨'));
    });

    it('says nothing on a row the freeze did not park — it drains normally (A29)', () => {
      // The live bug: a `queued` message that arrived AFTER the freeze read as
      // "this queue is stopped" because the notice was session-scoped.
      for (const state of ['queued', 'steered'] as const) {
        const { blocks, text } = buildFollowupItemMessage(item({ seq: 1, state }), 0, { freeze });
        expect(contextTexts(blocks)).toEqual([]);
        expect(text).not.toContain(FOLLOWUP_RESTART_FREEZE_NOTICE);
      }
    });

    it('says nothing when the session is not frozen at all', () => {
      const { blocks } = buildFollowupItemMessage(item({ seq: 1, state: 'paused' }), 0);
      expect(contextTexts(blocks)).toEqual([]);
    });
  });

  it('mints no mention from the message, in the blocks OR in the fallback text', () => {
    // The fallback `text` is parsed as mrkdwn by Slack, and unlike the panel's
    // counts-only fallback this one carries the user's message — so it takes the
    // same escaping the block line takes, not a weaker one.
    const hostile = item({ seq: 1, message: event({ text: '<!channel> <@U999> *urgent*' }) });

    const { blocks, text } = buildFollowupItemMessage(hostile, 0);

    const line = sectionTexts(blocks)[0];
    expect(line).not.toContain('<!channel>');
    expect(line).not.toContain('<@U999>');
    expect(line).toContain('&lt;!channel&gt;');
    expect((blocks[0] as any).text.verbatim).toBe(true);
    expect(text).not.toContain('<!channel>');
    expect(text).not.toContain('<@U999>');
    // The real state is the LAST italic run on the line: the message's own
    // emphasis characters are neutralised so they cannot read as a state label.
    expect(line).not.toContain('*urgent*');
    expect(line.endsWith('· _queued_')).toBe(true);
  });

  it('names the attachments a text+files item carries', () => {
    const withFiles = item({
      seq: 1,
      message: event({
        text: '이 로그 봐줘',
        files: [
          {
            id: 'F1',
            name: 'log.txt',
            mimetype: 'text/plain',
            filetype: 'text',
            url_private: 'https://x/1',
            url_private_download: 'https://x/1d',
            size: 12,
          },
        ],
      }),
    });

    expect(sectionTexts(buildFollowupItemMessage(withFiles, 0).blocks)[0]).toContain('(📎1)');
  });

  it('drops a control it cannot encode and says the row lost it', () => {
    // A key no real session has, to force the defensive drop deterministically.
    const sessionKey = `work:${'X'.repeat(3000)}`;
    const oversized = item({ sessionKey, seq: 1, id: `${sessionKey}#1` });

    const { blocks } = buildFollowupItemMessage(oversized, 0);

    expect(collectButtons(blocks)).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    expect(sectionTexts(blocks)[0]).toContain('action unavailable');
  });

  it('names the states the `queue` command lists as pending (A40)', () => {
    // The five states an item can still be acted on from. `resolved`/`cancelled`
    // are history, and the in-flight trio is the running turn's business.
    expect([...FOLLOWUP_PENDING_STATES].sort()).toEqual(['failed', 'paused', 'queued', 'steered', 'uncertain'].sort());
  });
});
