/**
 * #846 item 2 — the host writes what it applied to the session's receipt file; the model-command server reads it
 * back on GET_SESSION (`host`). Written by the same session lookup as the card TL;DR (channel + thread), so the path
 * the context hands the server is the path the host writes.
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

  it('a turn-start write has no last write; an unknown session writes nothing', () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'User', 'C1', '100.004');
    reg.writeModelCommandReceipt('C1', '100.004');
    expect(readHostReceipt(reg.modelCommandReceiptFile('C1', '100.004'))?.lastWrite).toBeUndefined();
    reg.writeModelCommandReceipt('C9', '9.999');
    expect(fs.existsSync(reg.modelCommandReceiptFile('C9', '9.999'))).toBe(false);
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

  it('an ended session archived on load takes its receipt with it', () => {
    const now = Date.now();
    const saved = [
      {
        // The persisted `key` field stays in the legacy form; the loader derives the live key (grok R2 P2).
        key: 'C1-100.006',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: '100.006',
        sessionId: 's-ended',
        isActive: false,
        // Asleep past the (default 7-day) sleep time: the loader archives it.
        state: 'SLEEPING',
        sleepStartedAt: new Date(now - 8 * 24 * 3600_000).toISOString(),
        lastActivity: new Date(now - 9 * 24 * 3600_000).toISOString(),
      },
    ];
    fs.writeFileSync(path.join(TEST_DATA_DIR, 'sessions.json'), JSON.stringify(saved));
    const probe = new SessionRegistry();
    const file = probe.modelCommandReceiptFile('C1', '100.006');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}');
    const reg = new SessionRegistry();
    reg.loadSessions();
    expect(reg.getSession('C1', '100.006')).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a repeated ⚠️ reason keeps the follow-up time (the idle clock does not restart)', () => {
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'User', 'C1', '100.007');
    reg.setExecutiveSummary('C1', '100.007', ['a', '⚠️ **PR #1 open**', 'b']);
    const first = s.followUp?.at;
    s.lastWarningSentAt = 600_000;
    reg.setExecutiveSummary('C1', '100.007', ['a2', '⚠️ **PR #1 open**', 'b2']);
    expect(s.followUp?.at).toBe(first);
    expect(s.lastWarningSentAt).toBe(600_000);
  });

  it('keeps an ack per write (astra R1 P1): a later write or a late callback never erases another write’s ack', () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'User', 'C1', '100.008');
    reg.writeModelCommandReceipt('C1', '100.008', { receiptId: 'r_new', ok: true, at: 2 });
    // A superseded turn's callback lands late with its own write.
    reg.writeModelCommandReceipt('C1', '100.008', {
      receiptId: 'r_old',
      ok: false,
      reason: 'SEQUENCE_MISMATCH',
      at: 1,
    });
    // The next turn start writes with no write of its own.
    reg.writeModelCommandReceipt('C1', '100.008');
    const r = readHostReceipt(reg.modelCommandReceiptFile('C1', '100.008'));
    expect(r?.acks?.r_new).toMatchObject({ ok: true });
    expect(r?.acks?.r_old).toMatchObject({ ok: false, reason: 'SEQUENCE_MISMATCH' });
  });

  it('the ack ledger is bounded (the most recent 20)', () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'User', 'C1', '100.009');
    for (let i = 0; i < 25; i++)
      reg.writeModelCommandReceipt('C1', '100.009', { receiptId: `r_${i}`, ok: true, at: i });
    const acks = readHostReceipt(reg.modelCommandReceiptFile('C1', '100.009'))?.acks ?? {};
    expect(Object.keys(acks)).toHaveLength(20);
    expect(acks.r_24).toBeDefined();
    expect(acks.r_0).toBeUndefined();
  });

  it('a corrupt receipt on disk never breaks the write (astra R2 P2)', () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'User', 'C1', '100.010');
    const file = reg.modelCommandReceiptFile('C1', '100.010');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ sequence: 1, at: 1, session: { issues: [], prs: [], docs: [] }, acks: { r_null: null } }),
    );
    expect(() => reg.writeModelCommandReceipt('C1', '100.010', { receiptId: 'r_1', ok: true, at: 2 })).not.toThrow();
    expect(readHostReceipt(file)?.acks).toEqual({ r_1: { receiptId: 'r_1', ok: true, at: 2 } });
  });

  it('a link the host notes itself reaches the receipt; the ack ledger stays (#881 C2)', () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'User', 'C1', '100.011');
    reg.writeModelCommandReceipt('C1', '100.011', { receiptId: 'r_a', ok: true, at: 1 });
    const file = reg.modelCommandReceiptFile('C1', '100.011');
    expect(readHostReceipt(file)?.session.prs).toEqual([]);
    expect(
      reg.noteSessionLinks(
        'C1',
        '100.011',
        [{ url: 'https://github.com/o/r/pull/5', type: 'pr', provider: 'github' }],
        'always',
      ),
    ).toBe(true);
    const r = readHostReceipt(file);
    expect(r?.session.prs.map((l) => l.url)).toEqual(['https://github.com/o/r/pull/5']);
    expect(r?.acks?.r_a).toMatchObject({ ok: true });
  });

  it('/new rewrites the receipt without the old conversation’s verdict (#881 C2)', () => {
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'User', 'C1', '100.012');
    s.sessionId = 'sess-1';
    reg.setExecutiveSummary('C1', '100.012', ['a', '⚠️ **PR #1 open**', 'b']);
    reg.writeModelCommandReceipt('C1', '100.012');
    const file = reg.modelCommandReceiptFile('C1', '100.012');
    expect(readHostReceipt(file)?.followUp).toBe('PR #1 open');
    expect(reg.resetSessionContext('C1', '100.012')).toBe(true);
    const r = readHostReceipt(file);
    expect(r?.followUp).toBeUndefined();
    expect(r?.tldr).toBeUndefined();
  });

  it('the es TL;DR keeps when the model issued it — the time in its receiptId, not the late apply (#881 B1)', () => {
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'User', 'C1', '100.013');
    const t = 1_793_700_000_000;
    reg.setExecutiveSummary('C1', '100.013', ['a', 'b', 'c'], `r_${t.toString(36)}_1_abcd1234`);
    expect(s.executiveSummary?.issuedAt).toBe(t);
    expect(s.executiveSummary?.source).toBe('es');
    reg.setExecutiveSummary('C1', '100.013', ['a', 'b', 'c']);
    expect(s.executiveSummary?.issuedAt).toBeUndefined();
  });
});
