import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchesAddressPattern, parseMailboxConfig, readClientSettings } from '../config';
import { createMailboxClient, createThreadMap } from '../host';

describe('parseMailboxConfig', () => {
  it('absent or disabled = no poller', () => {
    expect(parseMailboxConfig(undefined)).toBeUndefined();
    expect(parseMailboxConfig({ enabled: false, owner: 'U123' })).toBeUndefined();
  });

  it('reads owner, channel, interval and allowFrom with defaults', () => {
    const r = parseMailboxConfig({
      owner: 'U0ABC',
      channel: 'C0XYZ',
      intervalSeconds: 5,
      allowFrom: ['Soma-Work:*:*'],
    });
    expect(r).toEqual({
      ok: true,
      config: expect.objectContaining({
        owner: 'U0ABC',
        channel: 'C0XYZ',
        intervalMs: 5000,
        allowFrom: ['soma-work:*:*'],
      }),
    });
    const d = parseMailboxConfig({ owner: 'U0ABC' });
    expect(d?.ok && d.config.clientFile).toBe(path.join(os.homedir(), '.config/agent-mailbox/client.json'));
    expect(d?.ok && d.config.channel).toBeUndefined();
    expect(d?.ok && d.config.allowFrom).toEqual(['*:*:*']);
    expect(d?.ok && d.config.cli).toBe('mailbox');
    const c = parseMailboxConfig({ owner: 'U0ABC', cli: '/opt/bin/mailbox' });
    expect(c?.ok && c.config.cli).toBe('/opt/bin/mailbox');
    expect(parseMailboxConfig({ owner: 'U0ABC', cli: 'mailbox; rm -r x' })).toEqual({
      ok: false,
      error: expect.stringContaining('cli'),
    });
  });

  it('rejects what it cannot use', () => {
    expect(parseMailboxConfig('x')).toEqual({ ok: false, error: expect.any(String) });
    expect(parseMailboxConfig({ owner: 'nobody' })).toEqual({ ok: false, error: expect.stringContaining('owner') });
    expect(parseMailboxConfig({ owner: 'U0ABC', channel: '#general' })).toEqual({
      ok: false,
      error: expect.stringContaining('channel'),
    });
    expect(parseMailboxConfig({ owner: 'U0ABC', intervalSeconds: 0 })).toEqual({
      ok: false,
      error: expect.stringContaining('interval'),
    });
    expect(parseMailboxConfig({ owner: 'U0ABC', allowFrom: ['a:b'] })).toEqual({
      ok: false,
      error: expect.stringContaining('allowFrom'),
    });
  });
});

describe('readClientSettings', () => {
  it('reads the mailbox CLI settings and never echoes the token in errors', () => {
    const ok = readClientSettings('/x', () =>
      JSON.stringify({ url: 'http://127.0.0.1:7780/', token: 't', address: 'Soma-Work:Host-A:dev' }),
    );
    expect(ok).toEqual({ url: 'http://127.0.0.1:7780', token: 't', address: 'soma-work:host-a:dev' });
    expect(() =>
      readClientSettings('/x', () => JSON.stringify({ url: 'http://x', token: 'secret-token', address: 'bad' })),
    ).toThrow(/address/);
    try {
      readClientSettings('/x', () => JSON.stringify({ url: 'ftp://x', token: 'secret-token', address: 'a:b:c' }));
    } catch (e) {
      expect(String(e)).not.toContain('secret-token');
    }
  });
});

describe('matchesAddressPattern', () => {
  it('matches whole segments with *', () => {
    expect(matchesAddressPattern('soma-work:host-a:dev', 'soma-work:*:*')).toBe(true);
    expect(matchesAddressPattern('pickle:phone:main', 'soma-work:*:*')).toBe(false);
  });
});

describe('createMailboxClient', () => {
  it('long-polls the unread inbox of the configured address and acks by id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-client-'));
    const file = path.join(dir, 'client.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ url: 'http://127.0.0.1:7780', token: 'tok', address: 'soma-work:host-a:dev' }),
    );
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = url.includes('/inbox')
        ? { address: 'soma-work:host-a:dev', messages: [{ id: 'm1' }] }
        : { acked: 1 };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createMailboxClient(file, fake);
    const r = await client.inbox(25);
    expect(r.messages).toEqual([{ id: 'm1' }]);
    expect(calls[0].url).toBe(
      'http://127.0.0.1:7780/v1/mailboxes/soma-work%3Ahost-a%3Adev/inbox?unread=true&limit=20&wait=25',
    );
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    await client.ack(['m1']);
    expect(calls[1].url).toBe('http://127.0.0.1:7780/v1/mailboxes/soma-work%3Ahost-a%3Adev/ack');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ ids: ['m1'] });
  });

  it('a server error is thrown (the loop backs off)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-client-'));
    const file = path.join(dir, 'client.json');
    fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:7780', token: 'tok', address: 'a:b:c' }));
    const fake = (async () => new Response('{"error":"nope"}', { status: 401 })) as unknown as typeof fetch;
    await expect(createMailboxClient(file, fake).inbox(0)).rejects.toThrow(/401/);
  });
});

describe('createThreadMap', () => {
  it('keeps conversation → thread links across a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-threads-'));
    createThreadMap(dir).set('conv', { channel: 'C0A', threadTs: '1.0' });
    expect(createThreadMap(dir).get('conv')).toEqual({ channel: 'C0A', threadTs: '1.0' });
    expect(createThreadMap(dir).get('other')).toBeUndefined();
  });
});
