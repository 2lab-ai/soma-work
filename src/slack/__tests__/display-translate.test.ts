/**
 * #774 — the bot's Slack text in the user's display language, translated where
 * it leaves the process. Only bot chrome the catalog knows changes; ids,
 * values, rich text (people's and the model's words) and Korean users' text
 * pass through untouched.
 */

import { WebClient } from '@slack/web-api';
import { currentDisplayLang, registerDisplayCatalog, runWithDisplayLang } from '@soma/common/i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSlackDisplayTranslationForTests,
  displayLangMiddleware,
  installRespondTranslation,
  installSlackDisplayTranslation,
  readerOf,
  slackUserOf,
  translateApiOptions,
  translateBlockTree,
  translateMessagePayload,
} from '../display-translate';

registerDisplayCatalog('en', {
  '__dt 세션 종료': '__dt Session closed',
  '__dt ✅ {0} 저장 완료 ({1}개)': '__dt ✅ Saved {0} ({1} items)',
  '__dt 취소': '__dt Cancel',
  '__dt 생각 중': '__dt Thinking',
  '__dt 설정': '__dt Settings',
});

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });

describe('translateBlockTree', () => {
  it('translates text objects, keeps ids and values, and never edits the caller', () => {
    const blocks = [
      section('__dt 세션 종료'),
      {
        type: 'actions',
        block_id: '__dt 세션 종료',
        elements: [
          { type: 'button', action_id: 'cancel', value: '__dt 취소', text: { type: 'plain_text', text: '__dt 취소' } },
        ],
      },
    ];
    const frozen = JSON.stringify(blocks);
    const out = translateBlockTree(blocks, 'en') as any[];
    expect(out[0].text.text).toBe('__dt Session closed');
    expect(out[1].elements[0].text.text).toBe('__dt Cancel');
    expect(out[1].elements[0].value).toBe('__dt 취소');
    expect(out[1].block_id).toBe('__dt 세션 종료');
    expect(JSON.stringify(blocks)).toBe(frozen);
  });

  it('fills templates and translates line by line, leaving unknown lines (titles, answers) as written', () => {
    const out = translateBlockTree([section('*제목은 그대로*\n__dt ✅ 설정 저장 완료 (3개)')], 'en') as any[];
    expect(out[0].text.text).toBe('*제목은 그대로*\n__dt ✅ Saved 설정 (3 items)');
  });

  it('leaves rich_text (the model and people) and Korean users alone', () => {
    const rich = [
      {
        type: 'rich_text',
        elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: '__dt 세션 종료' }] }],
      },
    ];
    expect(translateBlockTree(rich, 'en')).toBe(rich);
    const ko = [section('__dt 세션 종료')];
    expect(translateBlockTree(ko, 'ko')).toBe(ko);
  });
});

describe('translateMessagePayload / translateApiOptions', () => {
  it('a message: the fallback text, blocks and attachments', () => {
    const out = translateMessagePayload(
      {
        channel: 'C1',
        text: '__dt 세션 종료',
        blocks: [section('__dt 취소')],
        attachments: [{ blocks: [section('__dt 설정')] }],
      },
      'en',
    ) as any;
    expect(out.text).toBe('__dt Session closed');
    expect(out.blocks[0].text.text).toBe('__dt Cancel');
    expect(out.attachments[0].blocks[0].text.text).toBe('__dt Settings');
    expect(out.channel).toBe('C1');
  });

  it('a view: its title, buttons and blocks', () => {
    const out = translateApiOptions(
      'views.open',
      {
        trigger_id: 't',
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: '__dt 설정' },
          close: { type: 'plain_text', text: '__dt 취소' },
          blocks: [],
        },
      },
      'en',
    ) as any;
    expect(out.view.title.text).toBe('__dt Settings');
    expect(out.view.close.text).toBe('__dt Cancel');
    expect(out.trigger_id).toBe('t');
  });

  it('the assistant status line; a streamed answer is never touched', () => {
    const status = translateApiOptions(
      'assistant.threads.setStatus',
      { status: '__dt 생각 중', loading_messages: ['__dt 생각 중'] },
      'en',
    ) as any;
    expect(status.status).toBe('__dt Thinking');
    expect(status.loading_messages).toEqual(['__dt Thinking']);
    const stream = { markdown_text: '__dt 세션 종료' };
    expect(translateApiOptions('chat.appendStream', stream, 'en')).toBe(stream);
    const stop = translateApiOptions(
      'chat.stopStream',
      { markdown_text: '__dt 세션 종료', blocks: [section('__dt 취소')] },
      'en',
    ) as any;
    expect(stop.markdown_text).toBe('__dt 세션 종료');
    expect(stop.blocks[0].text.text).toBe('__dt Cancel');
  });

  it('reads who the call is for: an ephemeral user, a DM by user id, else nobody', () => {
    expect(readerOf('chat.postEphemeral', { channel: 'C1', user: 'U9' })).toBe('U9');
    expect(readerOf('chat.postMessage', { channel: 'U7' })).toBe('U7');
    expect(readerOf('chat.postMessage', { channel: 'C1' })).toBeUndefined();
    expect(readerOf('chat.postMessage', { channel: 'D1' })).toBeUndefined();
  });
});

describe('installSlackDisplayTranslation — every Web API call', () => {
  const proto = WebClient.prototype as any;
  const original = proto.makeRequest;
  afterEach(() => {
    proto.makeRequest = original;
    __resetSlackDisplayTranslationForTests();
  });

  it('reaches a client built BEFORE the install (Bolt app.client) through its bound methods', async () => {
    const sent: Array<{ url: string; body: any }> = [];
    proto.makeRequest = vi.fn(async (url: string, body: any) => {
      sent.push({ url, body });
      return { status: 200, headers: {}, request: { path: '/api/x' }, data: { ok: true, channel: { id: 'D_OPENED' } } };
    });
    const early = new WebClient('xoxb-test'); // methods bound now, like app.client
    installSlackDisplayTranslation((u) => (u === 'U_EN' ? 'en' : 'ko'));
    await early.chat.postMessage({ channel: 'C1', text: '__dt 세션 종료' });
    await runWithDisplayLang('en', () => early.chat.postMessage({ channel: 'C1', text: '__dt 세션 종료' }));
    await early.chat.postEphemeral({ channel: 'C1', user: 'U_EN', text: '__dt 세션 종료' });
    const late = new WebClient('xoxb-test');
    await runWithDisplayLang('en', () => late.chat.update({ channel: 'C1', ts: '1.1', text: '__dt 세션 종료' }));
    expect(sent.map((r) => r.body.text)).toEqual([
      '__dt 세션 종료',
      '__dt Session closed',
      '__dt Session closed',
      '__dt Session closed',
    ]);
    expect(sent[0].url).toMatch(/chat\.postMessage$/);
  });

  it('a DM the bot opened is read by that user, not by whoever triggered it', async () => {
    const sent: any[] = [];
    proto.makeRequest = vi.fn(async (_url: string, body: any) => {
      sent.push(body);
      return {
        status: 200,
        headers: {},
        request: { path: '/api/x' },
        data: { ok: true, channel: { id: 'D_ADMIN_KO' } },
      };
    });
    installSlackDisplayTranslation((u) => (u === 'U_ADMIN' ? 'ko' : 'en'));
    const client = new WebClient('xoxb-test');
    // The requester (en) triggers an approval request DM to a Korean admin.
    await runWithDisplayLang('en', async () => {
      await client.conversations.open({ users: 'U_ADMIN' });
      await client.chat.postMessage({ channel: 'D_ADMIN_KO', text: '__dt 세션 종료' });
    });
    expect(sent[1].text).toBe('__dt 세션 종료');
  });
});

describe('installRespondTranslation — Bolt respond()', () => {
  it('adds a request interceptor that translates the posted message', () => {
    let fn: ((c: any) => any) | undefined;
    installRespondTranslation({ axios: { interceptors: { request: { use: (f: any) => (fn = f) } } } });
    const out = runWithDisplayLang('en', () => fn!({ data: { text: '__dt 취소', replace_original: true } }));
    expect(out.data).toEqual({ text: '__dt Cancel', replace_original: true });
  });
});

describe('displayLangMiddleware — each Slack event runs in its user language', () => {
  it('finds the user of events, actions and slash commands', () => {
    expect(slackUserOf({ event: { user: 'U1' } })).toBe('U1');
    expect(slackUserOf({ user: { id: 'U2' } })).toBe('U2');
    expect(slackUserOf({ user_id: 'U3' })).toBe('U3');
    expect(slackUserOf({})).toBeUndefined();
  });

  it('runs the listeners (next) in that language', async () => {
    const mw = displayLangMiddleware((u) => (u === 'U_EN' ? 'en' : 'ko'));
    let seen = '';
    await mw({ body: { event: { user: 'U_EN' } }, next: async () => void (seen = currentDisplayLang()) } as any);
    expect(seen).toBe('en');
    await mw({ body: { event: { user: 'U_KO' } }, next: async () => void (seen = currentDisplayLang()) } as any);
    expect(seen).toBe('ko');
  });
});
