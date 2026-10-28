/**
 * User media (SSOT 2026-10-25) — the Full Conversation page (viewer.ts) shows
 * the files of each user turn above its text: kept images as thumbnails that
 * open the copy, other files as links, a file without a copy as its Slack link
 * (https only), and a files-only turn without an empty text block.
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

describe('Full Conversation page — user media', () => {
  const html = renderConversationViewPage(record);

  it('shows kept images as thumbnails that open the copy', () => {
    expect(html).toContain('src="/api/dashboard/session/conv-v/media/M1/content"');
    expect(html).toContain('href="/api/dashboard/session/conv-v/media/M1/content"');
  });

  it('links other kept files, and a file without a copy to Slack over https only', () => {
    expect(html).toContain('href="/api/dashboard/session/conv-v/media/M2/content"');
    expect(html).toContain('guide.pdf');
    expect(html).toContain('href="https://x.slack.com/files/U/F/demo.mov"');
    expect(html).not.toContain('javascript:alert');
    expect(html).not.toContain('x<script>');
  });

  it('puts the files above the text and leaves no empty text block for a files-only turn', () => {
    const u1 = html.slice(html.indexOf('id="turn-0"'), html.indexOf('id="turn-1"'));
    expect(u1.indexOf('turn-media')).toBeGreaterThan(-1);
    expect(u1.indexOf('turn-media')).toBeLessThan(u1.indexOf('이 스크린샷처럼'));
    const u2 = html.slice(html.indexOf('id="turn-1"'));
    expect(u2).toContain('M5');
    expect(u2.slice(0, u2.indexOf('</div>', u2.indexOf('turn-content')) + 6)).not.toContain(
      '<pre class="content"></pre>',
    );
  });
});
