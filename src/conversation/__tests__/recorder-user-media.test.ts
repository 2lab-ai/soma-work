/**
 * User media (SSOT 2026-10-25, review gate P2) — the recorder's order is the
 * contract that keeps the content route honest: the user turn is SAVED, then
 * its copies are COMMITTED, then the dashboard is TOLD. A client that hears
 * about the turn can always fetch its files; a turn that never saved never
 * exposes its copies.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../env-paths', async () => {
  const nodeFs = await import('node:fs');
  return { IS_DEV: true, DATA_DIR: nodeFs.mkdtempSync('/tmp/recorder-um-data-') };
});

import { createConversation, getConversation, recordUserTurn, setOnTurnRecordedCallback } from '../recorder';
import { setUserMediaStoreForTests, UserMediaStore } from '../user-media';

const TMP = fs.realpathSync(os.tmpdir());

describe('recordUserTurn with attachments', () => {
  const made: string[] = [];
  afterEach(() => {
    setUserMediaStoreForTests(null);
    for (const p of made.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  });

  it('saves the turn, commits its copies, then tells the dashboard', async () => {
    const root = fs.mkdtempSync(path.join(TMP, 'rec-um-'));
    made.push(root);
    const store = new UserMediaStore(path.join(root, 'store'));
    setUserMediaStoreForTests(store);
    const src = path.join(TMP, `slack-file-${Date.now()}-shot.png`);
    fs.writeFileSync(src, 'PNG');
    made.push(src);

    const cid = createConversation('C1', '1700000000.000100', 'U1', 'Zhuge');
    const [att] = await store.capture(cid, [{ path: src, name: 'shot.png', mimetype: 'image/png', size: 3 }]);
    expect(store.contentPath(cid, att.id)).toBeNull(); // not before the turn is saved

    const seen = new Promise<{ committed: boolean; saved: boolean; turn: any }>((resolve) => {
      setOnTurnRecordedCallback(async (id, turn) => {
        const record = await getConversation(id);
        resolve({
          committed: store.contentPath(id, att.id) !== null,
          saved: !!record?.turns.some((t) => t.id === turn.id),
          turn,
        });
      });
    });
    recordUserTurn(cid, '', 'Zhuge', 'U1', [att]);
    const at = await seen;

    expect(at.saved).toBe(true);
    expect(at.committed).toBe(true);
    expect(at.turn).toMatchObject({
      role: 'user',
      rawContent: '',
      attachments: [expect.objectContaining({ id: att.id })],
    });
  });

  it('a steered message keeps the time it was sent', async () => {
    const cid = createConversation('C1', '1700000000.000200', 'U1', 'Zhuge');
    const seen = new Promise<any>((resolve) => setOnTurnRecordedCallback((_id, turn) => resolve(turn)));
    recordUserTurn(cid, '이것도', 'Zhuge', 'U1', undefined, { timestamp: 1792900000000 });
    expect((await seen).timestamp).toBe(1792900000000);
  });
});
