import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelEphemeralZRespond, DmZRespond, SlashZRespond } from './respond';
import { markBotMessageTs } from './types';

// Mock global fetch for response_url POSTs.
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('SlashZRespond', () => {
  it('send() uses response_type=ephemeral by default', async () => {
    const respondFn = vi.fn().mockResolvedValue(undefined);
    const r = new SlashZRespond(respondFn as any);
    await r.send({ text: 'hi' });
    expect(respondFn).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral', text: 'hi' }));
  });

  it('send({ephemeral:false}) uses in_channel', async () => {
    const respondFn = vi.fn().mockResolvedValue(undefined);
    const r = new SlashZRespond(respondFn as any);
    await r.send({ text: 'hi', ephemeral: false });
    expect(respondFn).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'in_channel' }));
  });

  it('replace() uses replace_original:true', async () => {
    const respondFn = vi.fn().mockResolvedValue(undefined);
    const r = new SlashZRespond(respondFn as any);
    await r.replace({ text: 'updated' });
    expect(respondFn).toHaveBeenCalledWith(expect.objectContaining({ replace_original: true, text: 'updated' }));
  });

  it('replace() falls back to UI-expired notice when respond throws', async () => {
    const respondFn = vi.fn().mockRejectedValueOnce(new Error('token expired')).mockResolvedValue(undefined);
    const r = new SlashZRespond(respondFn as any);
    await r.replace({ text: 'updated' });
    expect(respondFn).toHaveBeenCalledTimes(2);
    const second = respondFn.mock.calls[1][0];
    expect(second.text).toContain('UI가 만료');
  });

  it('dismiss() uses delete_original:true', async () => {
    const respondFn = vi.fn().mockResolvedValue(undefined);
    const r = new SlashZRespond(respondFn as any);
    await r.dismiss();
    expect(respondFn).toHaveBeenCalledWith(expect.objectContaining({ delete_original: true }));
  });
});

describe('ChannelEphemeralZRespond', () => {
  function makeClient(overrides: Record<string, any> = {}) {
    return {
      chat: {
        postEphemeral: vi.fn().mockResolvedValue({ message_ts: '111.222' }),
        postMessage: vi.fn().mockResolvedValue({ ts: '333.444' }),
        ...overrides,
      },
    };
  }

  it('send() calls chat.postEphemeral with channel/user/thread_ts', async () => {
    const client = makeClient();
    const r = new ChannelEphemeralZRespond({
      client: client as any,
      channel: 'C1',
      user: 'U1',
      threadTs: 't1',
    });
    const out = await r.send({ text: 'hi' });
    expect(out.ts).toBe('111.222');
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', user: 'U1', thread_ts: 't1', text: 'hi' }),
    );
  });

  it('send() falls back to DM postMessage on user_not_in_channel', async () => {
    const postEphemeral = vi.fn().mockRejectedValue({ data: { error: 'user_not_in_channel' } });
    const postMessage = vi.fn().mockResolvedValue({ ts: 'dm_ts' });
    const client = { chat: { postEphemeral, postMessage } };
    const r = new ChannelEphemeralZRespond({ client: client as any, channel: 'C1', user: 'U1' });
    const out = await r.send({ text: 'hi' });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'U1', text: 'hi' }));
    expect(out.ts).toBe('dm_ts');
  });

  it('replace() without response_url surfaces UI-expired notice', async () => {
    const client = makeClient();
    const r = new ChannelEphemeralZRespond({ client: client as any, channel: 'C1', user: 'U1' });
    await r.replace({ text: 'update' });
    // Should have called postEphemeral with UI-expired msg (via send fallback).
    const call = (client.chat.postEphemeral as any).mock.calls[0][0];
    expect(call.text).toContain('UI가 만료');
  });

  it('replace() with response_url posts replace_original payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    globalThis.fetch = fetchMock as any;
    const client = makeClient();
    const r = new ChannelEphemeralZRespond({
      client: client as any,
      channel: 'C1',
      user: 'U1',
      responseUrl: 'https://hooks.slack.com/abc',
    });
    await r.replace({ text: 'updated' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.replace_original).toBe(true);
    expect(body.text).toBe('updated');
  });

  it('setResponseUrl() rebinds response_url', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    globalThis.fetch = fetchMock as any;
    const client = makeClient();
    const r = new ChannelEphemeralZRespond({ client: client as any, channel: 'C1', user: 'U1' });
    r.setResponseUrl('https://new.url');
    await r.replace({ text: 'x' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://new.url');
  });

  it('dismiss() without response_url is a no-op (does not throw)', async () => {
    const client = makeClient();
    const r = new ChannelEphemeralZRespond({ client: client as any, channel: 'C1', user: 'U1' });
    await expect(r.dismiss()).resolves.toBeUndefined();
  });
});

describe('DmZRespond', () => {
  function makeClient(overrides: Record<string, any> = {}) {
    return {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '555.666' }),
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        ...overrides,
      },
    };
  }

  it('send() stores botMessageTs for subsequent replace', async () => {
    const client = makeClient();
    const r = new DmZRespond({ client: client as any, channel: 'D1' });
    const out = await r.send({ text: 'hi' });
    expect(out.ts).toBe('555.666');
    // Now replace should use chat.update with the stored ts.
    await r.replace({ text: 'updated' });
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'D1', ts: '555.666', text: 'updated' }),
    );
  });

  it('replace() without botMessageTs sends UI-expired notice (does not call chat.update)', async () => {
    const client = makeClient();
    const r = new DmZRespond({ client: client as any, channel: 'D1' });
    await r.replace({ text: 'updated' });
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('UI가 만료') }),
    );
  });

  it('replace() falls back to postMessage when chat.update throws', async () => {
    const client = makeClient({ update: vi.fn().mockRejectedValue(new Error('message_not_found')) });
    const r = new DmZRespond({
      client: client as any,
      channel: 'D1',
      botMessageTs: markBotMessageTs('777'),
    });
    await r.replace({ text: 'updated' });
    expect(client.chat.update).toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('UI가 만료') }),
    );
  });

  it('dismiss() calls chat.delete only when botMessageTs present', async () => {
    const client = makeClient();
    const r = new DmZRespond({ client: client as any, channel: 'D1' });
    await r.dismiss();
    expect(client.chat.delete).not.toHaveBeenCalled();

    const r2 = new DmZRespond({
      client: client as any,
      channel: 'D1',
      botMessageTs: markBotMessageTs('888'),
    });
    await r2.dismiss();
    expect(client.chat.delete).toHaveBeenCalledWith(expect.objectContaining({ channel: 'D1', ts: '888' }));
  });
});
