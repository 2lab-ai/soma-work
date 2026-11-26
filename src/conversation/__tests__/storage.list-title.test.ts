/**
 * The conversation list names each conversation as its page does (viewer.ts titleOf: title, else titleSub). The
 * list's metadata dropped titleSub, so a conversation with only a generated subtitle read "(제목 없음)" in the list
 * while its own page showed the subtitle.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationStorage } from '../storage';
import { renderConversationListPage } from '../viewer';

describe('ConversationStorage.list — the name a conversation is listed by', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-conv-title-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the subtitle, so the list row reads the same name as the page head', async () => {
    const storage = new ConversationStorage(dir);
    const base = {
      channelId: 'C1',
      threadTs: '1.1',
      ownerId: 'U1',
      ownerName: 'Z',
      createdAt: 1,
      updatedAt: 1,
      turns: [],
    };
    await storage.save({ ...base, id: 'sub', titleSub: 'llmux 튜토리얼 영상' });
    await storage.save({ ...base, id: 'both', title: '제목', titleSub: '부제', updatedAt: 2 });
    const list = await storage.list();
    expect(list.map((c) => [c.id, c.title, c.titleSub])).toEqual([
      ['both', '제목', '부제'],
      ['sub', undefined, 'llmux 튜토리얼 영상'],
    ]);
    const html = renderConversationListPage(list);
    expect(html).toContain('<strong>llmux 튜토리얼 영상</strong>');
    expect(html).not.toContain('(제목 없음)');
  });
});
