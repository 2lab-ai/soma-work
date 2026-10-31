/**
 * E2 ⑤ — a result whose markdown could not be converted is posted as the
 * Slack-session renderer's plain text (`fallbackText`, §6.3), not as raw
 * markdown (fable #668 P3-3).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@soma/slack/formatters/markdown-to-blocks', () => ({
  markdownToBlocks: () => ({ blocks: [], fallbackText: 'plain words', overflow: [] }),
}));

import { createTaskNoticeDeliverer } from '../task-notice-deliverer';
import { TaskNotificationLedger } from '../task-notification-ledger';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliverer-render-'));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('task notice deliverer — a final that does not convert (E2 ⑤)', () => {
  it('posts the plain-text fallback, with the card link', async () => {
    const ledger = new TaskNotificationLedger(path.join(dir, 'ledger.json'));
    ledger.load();
    const posts: string[] = [];
    const session = {
      taskId: 'task-1',
      slackless: true,
      ownerId: 'U1',
      conversationId: 'conv-1',
      originThread: { channel: 'C1', threadTs: '1.0', messageTs: '1.0' },
      notices: [{ id: 'task-1:c1:result', kind: 'result', chainId: 'c1', turnId: 't1', outcome: 'completed', at: 1 }],
    } as any;
    const deliverer = createTaskNoticeDeliverer({
      ledger,
      post: vi.fn(async (_t, m) => {
        posts.push(m.text);
        return { ts: 'x' };
      }),
      readFinal: vi.fn(async () => ({ text: '| broken | table', clipped: false })),
      cardUrl: () => 'https://dash.example/card',
      getTask: () => ({ session, sessionKey: 'task:task-1' }),
      isApprovalOpen: () => false,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    deliverer.enqueue(session, 'task:task-1');
    await deliverer.deliver();
    expect(posts).toEqual(['plain words\nhttps://dash.example/card']);
    deliverer.stop();
  });
});
