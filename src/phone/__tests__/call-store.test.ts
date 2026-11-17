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
