/**
 * #846 item 2 — the host writes what it applied to the session's receipt file; the model-command server reads it
 * back on GET_SESSION (`host`). Written by the same session lookup as the card TL;DR (channel + thread, or the key of
 * a Slack-less task), so the path the context hands the server is the path the host writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  return { TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-host-receipt-test-${process.pid}`) };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));

import { hostReceiptPath, readHostReceipt } from 'somalib/model-commands/host-receipt';
import { SessionRegistry } from '../session-registry';

describe('SessionRegistry — the model-command host receipt', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });
  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('the receipt path of a Slack session is its registry key', () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'User', 'C1', '100.001');
    expect(reg.modelCommandReceiptFile('C1', '100.001')).toBe(
      hostReceiptPath(TEST_DATA_DIR, reg.getSessionKey('C1', '100.001')),
    );
    expect(reg.modelCommandReceiptFileByKey('task:k1')).toBe(hostReceiptPath(TEST_DATA_DIR, 'task:k1'));
  });

  it('writes the links, sequence, card TL;DR, follow-up and the last write as the host handled them', () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'User', 'C1', '100.002');
    const applied = reg.updateSessionResources('C1', '100.002', {
      operations: [
        {
          action: 'add',
          resourceType: 'pr',
          link: { url: 'https://github.com/o/r/pull/9', type: 'pr', provider: 'github' },
        },
      ],
    });
    expect(applied.ok).toBe(true);
    reg.setExecutiveSummary('C1', '100.002', ['opened #9', '⚠️ **PR #9 not merged — needs approval**', 'merge it']);

    reg.writeModelCommandReceipt('C1', '100.002', { receiptId: 'r_9', ok: true, tldrApplied: true, at: 5 });

    const r = readHostReceipt(reg.modelCommandReceiptFile('C1', '100.002'));
    expect(r?.sequence).toBe(applied.ok ? applied.snapshot.sequence : -1);
    expect(r?.session.prs.map((l) => l.url)).toEqual(['https://github.com/o/r/pull/9']);
    expect(r?.tldr?.[1]).toContain('⚠️');
    expect(r?.followUp).toBe('PR #9 not merged — needs approval');
    expect(r?.lastWrite).toEqual({ receiptId: 'r_9', ok: true, tldrApplied: true, at: 5 });
  });

  it('a failed write is recorded as one — the card did not change', () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'User', 'C1', '100.003');
    reg.writeModelCommandReceipt('C1', '100.003', { receiptId: 'r_x', ok: false, reason: 'SEQUENCE_MISMATCH', at: 6 });
    const r = readHostReceipt(reg.modelCommandReceiptFile('C1', '100.003'));
    expect(r?.lastWrite).toMatchObject({ receiptId: 'r_x', ok: false, reason: 'SEQUENCE_MISMATCH' });
    expect(r?.followUp).toBeUndefined();
  });

  it('a Slack-less task is written by its key; an unknown session writes nothing', () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'User', 'C1', '100.004');
    const key = reg.getSessionKey('C1', '100.004');
    reg.writeModelCommandReceiptByKey(key);
    expect(readHostReceipt(reg.modelCommandReceiptFileByKey(key))?.lastWrite).toBeUndefined();
    reg.writeModelCommandReceiptByKey('task:nope');
    expect(fs.existsSync(reg.modelCommandReceiptFileByKey('task:nope'))).toBe(false);
  });

  it('the receipt goes with the session', () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'User', 'C1', '100.005');
    reg.writeModelCommandReceipt('C1', '100.005');
    const file = reg.modelCommandReceiptFile('C1', '100.005');
    expect(fs.existsSync(file)).toBe(true);
    reg.terminateSession(reg.getSessionKey('C1', '100.005'));
    expect(fs.existsSync(file)).toBe(false);
    expect(path.dirname(file)).toBe(path.join(TEST_DATA_DIR, 'model-command-receipts'));
  });
});
