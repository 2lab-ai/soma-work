import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type PhoneCallRecord, PhoneCallStore, summarizeCall, WORK_EVENT_CAP } from '../call-store';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-store-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const rec = (over: Partial<PhoneCallRecord> = {}): PhoneCallRecord => ({
  id: 'CA1',
  env: '2lab-ai-dev',
  direction: 'outbound',
  ourNumber: '07000000000',
  peerNumber: '01000000000',
  title: 't',
  status: 'dialing',
  createdAt: 1000,
  conversationId: 'conv-1',
  transcript: [],
  work: [],
  ...over,
});

describe('PhoneCallStore', () => {
  it('writes a new record at once and reads it back in a fresh store', () => {
    const store = new PhoneCallStore(dir);
    store.create(rec());
    expect(fs.existsSync(path.join(dir, 'calls', 'CA1.json'))).toBe(true);
    expect(new PhoneCallStore(dir).get('CA1')?.title).toBe('t');
  });

  it('coalesces updates, writes an ended call at once, and tells listeners each time', () => {
    const store = new PhoneCallStore(dir);
    const seen: string[] = [];
    store.onChange((r) => seen.push(r.status));
    store.create(rec());
    store.update('CA1', (r) => r.transcript.push({ role: 'peer', text: '네', at: 2 }));
    // Not on disk yet (coalesced) …
    expect(JSON.parse(fs.readFileSync(store.fileOf('CA1'), 'utf-8')).transcript).toEqual([]);
    store.update('CA1', (r) => {
      r.status = 'ended';
      r.endedStatus = 'completed';
    });
    // … an ended call is.
    const disk = JSON.parse(fs.readFileSync(store.fileOf('CA1'), 'utf-8'));
    expect(disk.status).toBe('ended');
    expect(disk.transcript).toHaveLength(1);
    expect(seen).toEqual(['dialing', 'dialing', 'ended']);
  });

  it('stamps every change with a strictly newer updatedAt', () => {
    const store = new PhoneCallStore(dir);
    const a = store.create(rec()).updatedAt ?? 0;
    const b = store.update('CA1', (r) => (r.title = 'x'))?.updatedAt ?? 0;
    const c = store.update('CA1', (r) => (r.title = 'y'))?.updatedAt ?? 0;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('caps the work log', () => {
    const store = new PhoneCallStore(dir);
    store.create(rec());
    store.update('CA1', (r) => {
      for (let i = 0; i < WORK_EVENT_CAP + 20; i++) r.work.push({ kind: 'event', at: i, text: String(i) });
    });
    const r = store.get('CA1') as PhoneCallRecord;
    expect(r.work).toHaveLength(WORK_EVENT_CAP);
    expect(r.work[0]).toMatchObject({ text: '20' });
  });

  it('lists a conversation’s calls, newest first, and refuses unsafe ids', () => {
    const store = new PhoneCallStore(dir);
    store.create(rec({ id: 'A', createdAt: 1 }));
    store.create(rec({ id: 'B', createdAt: 2 }));
    store.create(rec({ id: 'C', createdAt: 3, conversationId: 'other' }));
    expect(store.list({ conversationId: 'conv-1' }).map((r) => r.id)).toEqual(['B', 'A']);
    expect(store.get('../etc/passwd')).toBeUndefined();
    expect(() => store.create(rec({ id: '../x' }))).toThrow();
  });

  it('falls back to the last good copy when the live file is torn', () => {
    const store = new PhoneCallStore(dir);
    store.create(rec());
    store.update('CA1', (r) => {
      r.status = 'ended';
    });
    fs.writeFileSync(store.fileOf('CA1'), '{"id":');
    expect(new PhoneCallStore(dir).get('CA1')?.id).toBe('CA1');
  });

  it('a write that fails is kept and written again — the ended state is never lost', () => {
    const store = new PhoneCallStore(dir);
    store.create(rec({ id: 'CA9' }));
    const calls = path.join(dir, 'calls');
    fs.chmodSync(calls, 0o500); // the disk refuses writes for a moment
    try {
      store.update('CA9', (r) => {
        r.status = 'ended';
        r.endedStatus = 'completed';
      });
    } finally {
      fs.chmodSync(calls, 0o700);
    }
    expect(JSON.parse(fs.readFileSync(store.fileOf('CA9'), 'utf-8')).status).not.toBe('ended');
    store.flushAll(); // shutdown (or the retry timer) writes it
    expect(JSON.parse(fs.readFileSync(store.fileOf('CA9'), 'utf-8')).status).toBe('ended');
  });

  it('keeps live calls in memory, not finished ones: a finished record is read from disk', () => {
    const store = new PhoneCallStore(dir);
    store.create(rec({ id: 'OLD1', status: 'ended' }));
    store.create(rec({ id: 'LIVE1', status: 'active' }));
    expect(store.list()).toHaveLength(2);
    const file = store.fileOf('OLD1');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    fs.writeFileSync(file, JSON.stringify({ ...onDisk, title: 'changed on disk' }));
    expect(store.get('OLD1')?.title).toBe('changed on disk');
    // A finished record can still be changed (its summary lands after the end) and is saved.
    store.update('OLD1', (r) => (r.summary = '요약'));
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).summary).toBe('요약');
  });

  it('closes calls a restart cut off: every record still dialing or active ends as interrupted', () => {
    const before = new PhoneCallStore(dir);
    before.create(rec({ id: 'A1', status: 'active', answeredAt: 1_000 }));
    before.create(rec({ id: 'D1', status: 'dialing' }));
    before.create(rec({ id: 'E1', status: 'ended', endedStatus: 'completed' }));
    const after = new PhoneCallStore(dir);
    expect(after.endUnfinished('interrupted', 61_000)).toBe(2);
    expect(after.get('A1')).toMatchObject({ status: 'ended', endedStatus: 'interrupted', durationSec: 60 });
    expect(after.get('D1')).toMatchObject({ status: 'ended', endedStatus: 'interrupted', durationSec: 0 });
    expect(after.get('E1')?.endedStatus).toBe('completed');
  });

  it('summarizes for a card: the last four lines, no work log', () => {
    const r = rec({
      transcript: [1, 2, 3, 4, 5].map((i) => ({ role: 'peer' as const, text: String(i), at: i })),
      work: [{ kind: 'event', at: 1, text: 'x' }],
    });
    const s = summarizeCall(r);
    expect(s.tail.map((l) => l.text)).toEqual(['2', '3', '4', '5']);
    expect(s.lines).toBe(5);
    expect('work' in s).toBe(false);
    expect('transcript' in s).toBe(false);
  });
});
