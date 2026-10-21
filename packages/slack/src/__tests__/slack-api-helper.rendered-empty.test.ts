/**
 * U11 — central rendered-empty guard (RED tests).
 *
 * Spec: `.prd/04-slack-agent-ui-spec.md:57-58` (A23) — "빈 텍스트 fallback: 접근 가능한
 * **의미 있는** fallback 텍스트를 요구하되 첨부만 있는 메시지는 허용. 중앙의 rendered-empty
 * 가드로 처리하고, 통짜 거절(blanket rejection)로 막지 않는다" and
 * `.prd/05-slack-agent-ui-architecture.md:196` — "rendered-empty 가드는 중앙 1곳".
 * Platform rule: `docs/misc/reference/slack-block-kit.md:83` — `chat.postMessage` with
 * `blocks` must carry a top-level `text` fallback.
 *
 * The guard lives in ONE place (`resolveRenderedMessageText`) and both
 * `postMessage` and `updateMessage` route through it:
 *   - non-blank caller text is passed through byte-for-byte,
 *   - blank text + meaningful blocks/attachments derives an accessibility fallback,
 *   - a payload that would render empty is rejected BEFORE the API call.
 *
 * Payload fixtures below are captured from real senders:
 *   - attachment-only banner: `src/slack-handler.ts:778-781` +
 *     `packages/slack/src/tool-formatter.ts:655-658`
 *   - attachment-wrapped blocks: `packages/slack/src/choice-message-builder.ts:212-218`
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRenderedMessageText, SlackApiHelper } from '../slack-api-helper';

/** Fake Slack client that captures the exact payload handed to the Web API. */
const createFakeApp = () => ({
  client: {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: '1700000000.000100', channel: 'C123' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({ ok: true }),
    },
  },
});

/** Real capture: autoskill force-fire banner (attachment-only, blank text). */
const AUTOSKILL_BANNER_ATTACHMENTS = [
  {
    color: '#FF0000',
    text: "⚡ '<@U08ABCDE>'가(이) `soma:using-ssot`을 *강제 발동*했습니다. 데미지 87!",
  },
];

/** Real capture: ChoiceMessageBuilder.wrapAttachment — blocks nested in an attachment. */
const CHOICE_ATTACHMENTS = [
  {
    color: '#0052CC',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '*어떤 브랜치에 배포할까요?*' } },
      { type: 'divider' },
      {
        type: 'actions',
        block_id: 'choice_actions',
        elements: [
          { type: 'button', action_id: 'choice_pick', value: 'main', text: { type: 'plain_text', text: 'main' } },
        ],
      },
    ],
  },
];

const platformError = (code: string) => {
  const error: any = new Error(`An API error occurred: ${code}`);
  error.code = 'slack_webapi_platform_error';
  error.data = { ok: false, error: code };
  return error;
};

describe('rendered-empty guard — resolveRenderedMessageText', () => {
  it('passes non-blank caller text through byte-for-byte', () => {
    const text = '  🟢 배포 완료\n\n`main` → dev2  ';
    expect(resolveRenderedMessageText({ text, blocks: [{ type: 'divider' }] }, 'chat.postMessage')).toBe(text);
  });

  it('derives a fallback from section / header / context / markdown / rich_text blocks', () => {
    expect(
      resolveRenderedMessageText(
        { text: '', blocks: [{ type: 'header', text: { type: 'plain_text', text: '배포 현황' } }] },
        'chat.postMessage',
      ),
    ).toBe('배포 현황');

    expect(
      resolveRenderedMessageText(
        { text: '', blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: '마지막 활동 2분 전' }] }] },
        'chat.postMessage',
      ),
    ).toBe('마지막 활동 2분 전');

    expect(
      resolveRenderedMessageText(
        { text: '', blocks: [{ type: 'markdown', text: '**요약** 완료' }] },
        'chat.postMessage',
      ),
    ).toBe('**요약** 완료');

    expect(
      resolveRenderedMessageText(
        {
          text: '',
          blocks: [
            {
              type: 'rich_text',
              elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: '진행 중인 작업 3개' }] }],
            },
          ],
        },
        'chat.postMessage',
      ),
    ).toBe('진행 중인 작업 3개');
  });

  it('ignores whitespace-only text objects and uses the next meaningful one', () => {
    expect(
      resolveRenderedMessageText(
        {
          text: '   \n\t ',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: '   ' } },
            { type: 'section', text: { type: 'mrkdwn', text: '실제 내용' } },
          ],
        },
        'chat.postMessage',
      ),
    ).toBe('실제 내용');
  });

  it('uses image alt_text without ever echoing the image URL', () => {
    const resolved = resolveRenderedMessageText(
      {
        text: '',
        blocks: [
          {
            type: 'image',
            image_url: 'https://files.slack.com/secret-token/usage-card.png',
            alt_text: 'Usage card · 30d',
          },
        ],
      },
      'chat.postMessage',
    );
    expect(resolved).toBe('Usage card · 30d');
    expect(resolved).not.toContain('https://');
  });

  it('rejects a payload with no meaningful content, naming the API method', () => {
    expect(() => resolveRenderedMessageText({ text: '', blocks: [], attachments: [] }, 'chat.postMessage')).toThrow(
      /chat\.postMessage/,
    );
    expect(() => resolveRenderedMessageText({ text: '', blocks: [], attachments: [] }, 'chat.postMessage')).toThrow(
      /rendered-empty/i,
    );
  });

  it('treats divider/actions-only payloads as no meaningful content', () => {
    expect(() =>
      resolveRenderedMessageText(
        {
          text: '',
          blocks: [
            { type: 'divider' },
            {
              type: 'actions',
              elements: [
                { type: 'button', action_id: 'send_now', value: 'q1', text: { type: 'plain_text', text: 'Send now' } },
              ],
            },
          ],
        },
        'chat.update',
      ),
    ).toThrow(/chat\.update/);
  });

  it('truncates an oversized derived fallback but keeps it meaningful', () => {
    const long = `시작 신호 ${'가'.repeat(5000)}`;
    const resolved = resolveRenderedMessageText(
      { text: '', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: long } }] },
      'chat.postMessage',
    );
    expect(resolved.startsWith('시작 신호 ')).toBe(true);
    expect(resolved.length).toBeLessThanOrEqual(300);
  });
});

describe('rendered-empty guard — postMessage', () => {
  let app: ReturnType<typeof createFakeApp>;
  let helper: SlackApiHelper;

  beforeEach(() => {
    app = createFakeApp();
    helper = new SlackApiHelper(app as any, { minInterval: 0 });
  });

  it('leaves a non-blank text payload untouched', async () => {
    await helper.postMessage('C123', '배포 완료', {
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '다른 내용' } }],
    });

    expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(app.client.chat.postMessage.mock.calls[0][0].text).toBe('배포 완료');
  });

  it('derives the fallback for the real attachment-only banner (A23)', async () => {
    await helper.postMessage('C123', '', { threadTs: '111.222', attachments: AUTOSKILL_BANNER_ATTACHMENTS });

    const payload = app.client.chat.postMessage.mock.calls[0][0];
    expect(payload.text).toBe(AUTOSKILL_BANNER_ATTACHMENTS[0].text);
    expect(payload.attachments).toEqual(AUTOSKILL_BANNER_ATTACHMENTS);
    expect(payload.thread_ts).toBe('111.222');
  });

  it('derives the fallback from blocks nested inside an attachment', async () => {
    await helper.postMessage('C123', '', { attachments: CHOICE_ATTACHMENTS });

    expect(app.client.chat.postMessage.mock.calls[0][0].text).toBe('*어떤 브랜치에 배포할까요?*');
  });

  it('rejects a rendered-empty payload before any API call', async () => {
    await expect(helper.postMessage('C123', '', { blocks: [] })).rejects.toThrow(/rendered-empty/i);
    await expect(helper.postMessage('C123', '   ', { blocks: [{ type: 'divider' }] })).rejects.toThrow(
      /rendered-empty/i,
    );
    expect(app.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('carries the derived fallback into the invalid_blocks text-only retry', async () => {
    app.client.chat.postMessage
      .mockRejectedValueOnce(platformError('invalid_blocks'))
      .mockResolvedValueOnce({ ts: '1700000000.000200', channel: 'C123' });

    const result = await helper.postMessage('C123', '', {
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `요약 ${'x'.repeat(4000)}` } }],
    });

    // postMessage also reports where Slack ACTUALLY threaded the message and
    // whether it echoed one back; the retry must carry that same shape. The
    // stub returns no `message`, so both stay at their "not threaded" values.
    expect(result).toEqual({
      ts: '1700000000.000200',
      channel: 'C123',
      threadTs: undefined,
      echoedMessage: false,
    });
    const retry = app.client.chat.postMessage.mock.calls[1][0];
    expect(retry.blocks).toBeUndefined();
    expect(retry.text.startsWith('요약 ')).toBe(true);
    expect(retry.text.trim().length).toBeGreaterThan(0);
  });
});

describe('rendered-empty guard — updateMessage', () => {
  let app: ReturnType<typeof createFakeApp>;
  let helper: SlackApiHelper;

  beforeEach(() => {
    app = createFakeApp();
    helper = new SlackApiHelper(app as any, { minInterval: 0 });
  });

  it('leaves a non-blank text update untouched (blocks/attachments clearing still works)', async () => {
    await helper.updateMessage(
      'C123',
      '1700000000.000100',
      '✅ 모든 선택 완료',
      [{ type: 'section', text: { type: 'mrkdwn', text: 'x' } }],
      [],
    );

    expect(app.client.chat.update).toHaveBeenCalledWith({
      channel: 'C123',
      ts: '1700000000.000100',
      text: '✅ 모든 선택 완료',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'x' } }],
      attachments: [],
    });
  });

  it('derives a fallback for a blank-text update that still renders content', async () => {
    await helper.updateMessage('C123', '1700000000.000100', '', [
      { type: 'header', text: { type: 'plain_text', text: '진행 중' } },
      { type: 'divider' },
    ]);

    expect(app.client.chat.update.mock.calls[0][0].text).toBe('진행 중');
  });

  it('rejects a rendered-empty update before any API call', async () => {
    await expect(helper.updateMessage('C123', '1700000000.000100', '', [], [])).rejects.toThrow(/rendered-empty/i);
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });
});
