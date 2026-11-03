import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDefaultSessionSnapshot } from './catalog';
import { type HostReceipt, hostReceiptPath, readHostReceipt } from './host-receipt';

/**
 * #846 item 2 — the host-confirmed card receipt.
 *
 * GET_SESSION answers from the model-command server's own copy, so a re-read never proved the host applied a write,
 * and the card TL;DR / follow-up were not in it at all. The host now writes what it applied to a per-session receipt
 * file; the server reads it back. This module is the one shape and path both sides share.
 */

const receipt = (extra: Partial<HostReceipt> = {}): HostReceipt => ({
  sequence: 4,
  session: { ...getDefaultSessionSnapshot(), sequence: 4 },
  title: 'T',
  tldr: ['done', '⚠️ **PR #1 open — needs approval**', 'next'],
  followUp: 'PR #1 open — needs approval',
  lastWrite: { receiptId: 'r_1', ok: true, tldrApplied: true, at: 1 },
  at: 2,
  ...extra,
});

describe('hostReceiptPath', () => {
  it('is one file per session under the data dir, stable, and safe for any key', () => {
    const a = hostReceiptPath('/data', 'work:C1:1.1');
    expect(a).toBe(hostReceiptPath('/data', 'work:C1:1.1'));
    expect(a).not.toBe(hostReceiptPath('/data', 'work:C1:1.2'));
    expect(path.dirname(a)).toBe(path.join('/data', 'model-command-receipts'));
    expect(path.basename(a)).toMatch(/^[0-9a-f]{24}\.json$/);
    expect(hostReceiptPath('/data', '../../etc/passwd')).toMatch(/model-command-receipts\/[0-9a-f]{24}\.json$/);
  });
});

describe('readHostReceipt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-receipt-'));

  it('reads back what the host wrote', () => {
    const file = path.join(dir, 'ok.json');
    fs.writeFileSync(file, JSON.stringify(receipt()));
    expect(readHostReceipt(file)).toEqual(receipt());
  });

  it('is undefined for a missing, unreadable or malformed file — never a guess', () => {
    expect(readHostReceipt(path.join(dir, 'missing.json'))).toBeUndefined();
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    expect(readHostReceipt(bad)).toBeUndefined();
    const wrong = path.join(dir, 'wrong.json');
    fs.writeFileSync(wrong, JSON.stringify({ sequence: 'x', session: {} }));
    expect(readHostReceipt(wrong)).toBeUndefined();
  });
});
