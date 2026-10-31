/**
 * User media (SSOT 2026-10-25) — the conversation page (viewer.ts) hands <ui-conversation> the files of each
 * user turn in the turn's `media-<id>` slot (the element shows them above the words — its contract) and tells
 * it so (`media: true`): kept images as thumbnails that open the copy, other files as links, a file without
 * a copy as its Slack link (https only); a files-only turn is `text: ''` (the element draws no empty block).
 */

import { describe, expect, it } from 'vitest';
import { renderConversationViewPage } from '../viewer';

const record = {
  id: 'conv-v',
  channelId: 'C1',
  threadTs: 't1',
  ownerId: 'U1',
  ownerName: 'Zhuge',
  createdAt: 1,
  updatedAt: 2,
  turns: [
    {
      id: 'u1',
      role: 'user',
      timestamp: 1792900000000,
      userName: 'Zhuge',
      rawContent: '이 스크린샷처럼 고쳐줘',
      attachments: [
        { id: 'M1', name: 'login.png', kind: 'image', mime: 'image/png', size: 2048, stored: true },
        { id: 'M2', name: 'guide.pdf', kind: 'pdf', mime: 'application/pdf', size: 2_200_000, stored: true },
        {
          id: 'M3',
          name: 'demo.mov',
          kind: 'video',
          mime: 'video/quicktime',
          size: 9_000_000,
          stored: false,
          permalink: 'https://x.slack.com/files/U/F/demo.mov',
        },
        {
          id: 'M4',
          name: 'x<script>.txt',
          kind: 'text',
          mime: 'text/plain',
          size: 1,
          stored: false,
          permalink: 'javascript:alert(1)',
        },
      ],
    },
    {
      id: 'u2',
      role: 'user',
      timestamp: 1792900001000,
      userName: 'Zhuge',
      rawContent: '',
      attachments: [{ id: 'M5', name: 'b.png', kind: 'image', mime: 'image/png', size: 1, stored: true }],
    },
  ],
} as any;

function pageData(html: string): { id: string; turns: Array<Record<string, unknown>> } {
  const m = /<script type="application\/json" id="conv-data">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('no conv-data block');
  return JSON.parse(m[1]);
}

describe('Full Conversation page — user media', () => {
  const html = renderConversationViewPage(record);
  const data = pageData(html);

  it('shows kept images as thumbnails that open the copy', () => {
    expect(html).toContain('src="/api/dashboard/session/conv-v/media/M1/content"');
    expect(html).toContain('href="/api/dashboard/session/conv-v/media/M1/content"');
    expect(html).toContain('alt="login.png"');
  });

  it('links other kept files, and a file without a copy to Slack over https only', () => {
    expect(html).toContain('href="/api/dashboard/session/conv-v/media/M2/content"');
    expect(html).toContain('guide.pdf');
    expect(html).toContain('href="https://x.slack.com/files/U/F/demo.mov"');
    expect(html).not.toContain('javascript:alert');
    expect(html).not.toContain('x<script>');
  });

  it("puts the files in the turn's media slot and marks the turn as having media", () => {
    const u1 = html.slice(html.indexOf('<div slot="media-u1" class="vw-media">'), html.indexOf('<div slot="media-u2"'));
    expect(u1).toContain('M1');
    expect(u1).toContain('M2');
    expect(u1).toContain('demo.mov');
    expect(data.turns.find((t) => t.id === 'u1')).toMatchObject({
      role: 'user',
      media: true,
      text: '이 스크린샷처럼 고쳐줘',
    });
  });

  it('a files-only turn has its files and an empty text, no text block of its own', () => {
    const u2 = html.slice(html.indexOf('<div slot="media-u2" class="vw-media">'));
    expect(u2).toContain('M5');
    expect(data.turns.find((t) => t.id === 'u2')).toMatchObject({ role: 'user', media: true, text: '' });
    expect(html).not.toContain('<pre class="content">');
  });

  it('a turn without files gets no media slot and no media flag', () => {
    const plain = renderConversationViewPage({
      ...record,
      turns: [{ id: 'u3', role: 'user', timestamp: 1, userName: 'Zhuge', rawContent: 'hi' }],
    });
    expect(plain).not.toContain('slot="media-u3"');
    expect(pageData(plain).turns[0]).not.toHaveProperty('media');
  });
});
