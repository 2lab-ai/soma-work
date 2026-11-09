/**
 * send_link — post a URL the session served or published into the thread, so the daemon records it as a
 * session artifact (SSOT 2026-11-09 T3). The helpers are pure; the tool's wiring is checked on the source,
 * like the other slack-mcp contract tests.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatLinkMessage, type LinkClient, postLink, validateLinkUrl } from './helpers/link.js';

describe('validateLinkUrl', () => {
  it.each([
    ['http://192.168.0.10:8763/html-report.html', 'http://192.168.0.10:8763/html-report.html'],
    ['http://localhost:5173/', 'http://localhost:5173/'],
    [' https://youtu.be/rxkAcSqCG2Y ', 'https://youtu.be/rxkAcSqCG2Y'],
    [
      'https://github.com/2lab-ai/soma-work/releases/tag/v0.3',
      'https://github.com/2lab-ai/soma-work/releases/tag/v0.3',
    ],
  ])('accepts %s', (url, out) => {
    expect(validateLinkUrl(url)).toBe(out);
  });

  it.each([
    ['', /url is required/],
    ['not a url', /not a valid URL/],
    ['javascript:alert(1)', /http\(s\)/],
    ['file:///etc/passwd', /http\(s\)/],
    ['ftp://host/x', /http\(s\)/],
    ['https://user:secret@example.com/', /credentials/],
    [`https://a.example/${'x'.repeat(2100)}`, /too long/],
  ])('rejects %s', (url, err) => {
    expect(() => validateLinkUrl(url)).toThrow(err);
  });
});

describe('formatLinkMessage', () => {
  it('a Slack link with the title as its label, the comment above it', () => {
    expect(formatLinkMessage({ url: 'http://localhost:3000/', title: '데모 앱', comment: '로컬에서 띄웠습니다' })).toBe(
      '로컬에서 띄웠습니다\n🔗 <http://localhost:3000/|데모 앱>',
    );
  });

  it('no title → the URL is its own label; mrkdwn control characters cannot break the link', () => {
    expect(formatLinkMessage({ url: 'https://a.example/x' })).toBe('🔗 <https://a.example/x>');
    expect(formatLinkMessage({ url: 'https://a.example/a|b', title: '<b> & |c|' })).toBe(
      '🔗 <https://a.example/a%7Cb|&lt;b&gt; &amp; ¦c¦>',
    );
  });
});

describe('review gate — comment and served pages', () => {
  it('the comment cannot open a second link or break the first', () => {
    expect(
      formatLinkMessage({ url: 'https://a.example/', title: 't', comment: 'see <https://evil.example|here> & more' }),
    ).toBe('see &lt;https://evil.example|here&gt; &amp; more\n🔗 <https://a.example/|t>');
  });

  it('send_file takes the URL the session serves the file at, checks it and echoes it', async () => {
    const s = await fs.readFile(path.resolve(__dirname, 'slack-mcp-server.ts'), 'utf-8');
    const sendFile = s.slice(s.indexOf("name: 'send_file'"), s.indexOf("name: 'send_media'"));
    expect(sendFile).toMatch(/url: \{\s*type: 'string'/);
    expect(s).toMatch(/handleSendFile[\s\S]*?validateLinkUrl\(args\.url\)[\s\S]*?uploaded: true/);
    const desc = s.slice(s.indexOf("name: 'send_link'"), s.indexOf('inputSchema', s.indexOf("name: 'send_link'")));
    expect(desc).toContain('send_file with url');
  });
});

describe('postLink — what send_link does, run against a stub Slack client', () => {
  const target = { channel: 'C1', threadTs: '1700000000.000100' };
  function client(opts: { ts?: string; postFails?: boolean; permalinkFails?: boolean } = {}) {
    const posted: unknown[] = [];
    const c: LinkClient = {
      chat: {
        postMessage: async (args) => {
          posted.push(args);
          if (opts.postFails) throw new Error('channel_not_found');
          return { ts: 'ts' in opts ? opts.ts : '1700000001.000200' };
        },
        getPermalink: async () => {
          if (opts.permalinkFails) throw new Error('ratelimited');
          return { permalink: 'https://x.slack.com/archives/C1/p1700000001000200' };
        },
      },
    };
    return { c, posted };
  }

  it('posts into the thread and returns what capture records: sent, the URL, title, ts, channel, permalink', async () => {
    const { c, posted } = client();
    const reply = await postLink(c, target, {
      url: ' http://localhost:3000/ ',
      title: '데모 앱',
      comment: '띄웠습니다',
    });
    expect(posted).toEqual([
      { channel: 'C1', thread_ts: '1700000000.000100', text: '띄웠습니다\n🔗 <http://localhost:3000/|데모 앱>' },
    ]);
    expect(reply).toEqual({
      sent: true,
      url: 'http://localhost:3000/',
      title: '데모 앱',
      ts: '1700000001.000200',
      permalink: 'https://x.slack.com/archives/C1/p1700000001000200',
      channel: 'C1',
      thread_ts: '1700000000.000100',
    });
  });

  it('a permalink that fails still reports the link as sent (empty permalink)', async () => {
    const reply = await postLink(client({ permalinkFails: true }).c, target, { url: 'https://youtu.be/x' });
    expect(reply).toMatchObject({ sent: true, url: 'https://youtu.be/x', ts: '1700000001.000200', permalink: '' });
  });

  it('a failed post, a reply without ts, a bad URL or an oversized comment never reports sent', async () => {
    await expect(postLink(client({ postFails: true }).c, target, { url: 'https://a.example/' })).rejects.toThrow(
      /channel_not_found/,
    );
    await expect(postLink(client({ ts: undefined }).c, target, { url: 'https://a.example/' })).rejects.toThrow(
      /no message ts/,
    );
    const { c, posted } = client();
    await expect(postLink(c, target, { url: 'javascript:alert(1)' })).rejects.toThrow(/http\(s\)/);
    await expect(postLink(c, target, { url: 'https://a.example/', comment: 'x'.repeat(3001) })).rejects.toThrow(
      /comment is too long/,
    );
    expect(posted).toEqual([]);
  });
});

describe('send_link tool wiring', () => {
  const source = () => fs.readFile(path.resolve(__dirname, 'slack-mcp-server.ts'), 'utf-8');

  it('is listed, requires url, posts with chat.postMessage and reports sent + ts', async () => {
    const s = await source();
    expect(s).toContain("name: 'send_link'");
    expect(s).toMatch(/name: 'send_link'[\s\S]*?required: \['url'\]/);
    expect(s).toMatch(/handleSendLink[\s\S]*?postLink\(/);
    expect(s).toContain("case 'send_link':");
  });

  it('tells the model when to use it: served or published URLs land in the dashboard’s artifacts', async () => {
    const s = await source();
    const desc = s.slice(s.indexOf("name: 'send_link'"), s.indexOf('inputSchema', s.indexOf("name: 'send_link'")));
    expect(desc).toMatch(/serve|served/);
    expect(desc).toMatch(/artifact/i);
    // Files go with send_file / send_media, not as a link to a local path.
    expect(desc).toMatch(/send_file|send_media/);
  });
});
