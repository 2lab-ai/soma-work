/**
 * #1315 — the conversation list routes decide who may list a conversation from the owner and channel the storage
 * lists it with (task-visibility.ts): a list without them would read every private task as an old public one.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationStorage } from '../storage';
import { canViewTask } from '../task-visibility';

describe('ConversationStorage.list — the owner and channel a list is filtered by', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-conv-list-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists each conversation with its ownerId and channelId, so a DM’s is its owner’s only', async () => {
    const storage = new ConversationStorage(dir);
    const record = (id: string, channelId: string) => ({
      id,
      channelId,
      threadTs: '1.1',
      ownerId: 'U_OWNER',
      ownerName: 'Owner',
      title: id,
      createdAt: 1,
      updatedAt: id === 'dm' ? 3 : 2,
      turns: [],
    });
    await storage.save(record('dm', 'D_OWNER'));
    await storage.save(record('web', ''));
    const list = await storage.list();
    expect(list.map((c) => [c.id, c.ownerId, c.channelId])).toEqual([
      ['dm', 'U_OWNER', 'D_OWNER'],
      ['web', 'U_OWNER', ''],
    ]);
    const shown = (userId: string) => list.filter((c) => canViewTask({ userId }, c)).map((c) => c.id);
    expect(shown('U_OTHER')).toEqual(['web']);
    expect(shown('U_OWNER')).toEqual(['dm', 'web']);
  });
});
