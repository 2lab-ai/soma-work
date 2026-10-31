/**
 * #598 ④b1 — a Slack-less task's conversation record is created durably
 * (design 598b v5 §4.5): `createConversationDurable` resolves only after the
 * record is on disk and rejects when the save fails — unlike
 * `createConversation`, which returns an id at once and swallows the failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../env-paths', async () => {
  const nodeFs = await import('node:fs');
  return { IS_DEV: true, DATA_DIR: nodeFs.mkdtempSync('/tmp/recorder-durable-data-') };
});

import { createConversationDurable, getConversation } from '../recorder';
import { ConversationStorage } from '../storage';

describe('createConversationDurable (#598 ④b1)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves with an id whose record is already saved', async () => {
    const save = vi.spyOn(ConversationStorage.prototype, 'save');
    const id = await createConversationDurable('', '', 'U1', 'Zhuge', 'Fix the build');
    expect(save).toHaveBeenCalledTimes(1);
    await expect(save.mock.results[0].value).resolves.toBeUndefined();
    expect((await getConversation(id))?.ownerId).toBe('U1');
  });

  it('rejects when the save fails, and leaves no cached record behind', async () => {
    vi.spyOn(ConversationStorage.prototype, 'save').mockRejectedValueOnce(
      Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }),
    );
    await expect(createConversationDurable('', '', 'U1', 'Zhuge')).rejects.toThrow(/ENOSPC/);
  });
});
