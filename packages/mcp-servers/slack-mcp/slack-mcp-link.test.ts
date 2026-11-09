/**
 * send_link — post a URL the session served or published into the thread, so the daemon records it as a
 * session artifact (SSOT 2026-11-09 T3). The helpers are pure; the tool's wiring is checked on the source,
 * like the other slack-mcp contract tests.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatLinkMessage, validateLinkUrl } from './helpers/link.js';

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

describe('send_link tool wiring', () => {
  const source = () => fs.readFile(path.resolve(__dirname, 'slack-mcp-server.ts'), 'utf-8');

  it('is listed, requires url, posts with chat.postMessage and reports sent + ts', async () => {
    const s = await source();
    expect(s).toContain("name: 'send_link'");
    expect(s).toMatch(/name: 'send_link'[\s\S]*?required: \['url'\]/);
    expect(s).toMatch(/handleSendLink[\s\S]*?validateLinkUrl[\s\S]*?chat\.postMessage/);
    expect(s).toMatch(/sent: true/);
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
