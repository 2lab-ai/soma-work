/**
 * Last command channel (SSOT 2026-10-23 T5) — "유저가 마지막에 명령을 내린 채널".
 * One channel per user, kept across restarts in DATA_DIR, written atomically.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LastCommandChannelStore } from '../last-command-channel-store';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'last-cmd-store-')), 'last-command-channels.json');
}

describe('LastCommandChannelStore', () => {
  it('remembers the latest channel per user', () => {
    const store = new LastCommandChannelStore(tmpFile());
    store.record('U1', 'C1');
    store.record('U1', 'C2');
    store.record('U2', 'C9');
    expect(store.get('U1')).toBe('C2');
    expect(store.get('U2')).toBe('C9');
    expect(store.get('U3')).toBeNull();
  });

  it('ignores DMs and empty ids', () => {
    const store = new LastCommandChannelStore(tmpFile());
    store.record('U1', 'C1');
    store.record('U1', 'D1');
    store.record('', 'C2');
    store.record('U1', '');
    expect(store.get('U1')).toBe('C1');
  });

  it('survives a restart (flush → new instance reads it back)', () => {
    const file = tmpFile();
    const a = new LastCommandChannelStore(file);
    a.record('U1', 'C1');
    a.flush();
    expect(new LastCommandChannelStore(file).get('U1')).toBe('C1');
  });

  it('an unreadable file does not crash the store (starts empty, warns)', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{not json');
    const store = new LastCommandChannelStore(file);
    expect(store.get('U1')).toBeNull();
    store.record('U1', 'C1');
    expect(store.get('U1')).toBe('C1');
  });
});
