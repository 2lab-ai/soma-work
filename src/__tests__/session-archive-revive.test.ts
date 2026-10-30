/**
 * Task revive (SSOT 2026-10-30 T4.2) — the archive half.
 *
 * An archive keeps what a restore needs (the working directory the SDK files
 * the transcript under, incident ownership); a card opens the exact archive
 * file it names; and a restore is allowed only when the transcript exists and
 * the working directory is proven to resolve to it — never a silent fresh
 * conversation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env-paths', () => ({ DATA_DIR: path.join(os.tmpdir(), `soma-archive-revive-data-${process.pid}`) }));

import { type ArchivedSession, resolveArchivedResume, SessionArchiveStore } from '../session-archive';
import type { ConversationSession } from '../types';

const SID = '7f3c2a10-0000-4000-8000-000000000001';
const CWD = '/tmp/U1/session_1793000000000_ab12cd34';

function encode(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function writeTranscript(configDir: string, projectCwd: string, recordedCwd = projectCwd, sid = SID): string {
  const dir = path.join(configDir, 'projects', encode(projectCwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: 'summary', summary: 'x' }),
      JSON.stringify({ type: 'user', sessionId: sid, cwd: recordedCwd, message: { role: 'user', content: 'hi' } }),
    ].join('\n'),
  );
  return file;
}

function archivedRecord(overrides: Partial<ArchivedSession> = {}): ArchivedSession {
  return {
    archivedAt: 1793600000000,
    archiveReason: 'sleep_expired',
    sessionKey: 'work:C1:800.001',
    sessionId: SID,
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: '800.001',
    lastActivity: new Date().toISOString(),
    ...overrides,
  };
}

describe('session archive — revive support (T4.2)', () => {
  let root: string;
  let configDir: string;
  let archiveDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-archive-revive-'));
    configDir = path.join(root, 'claude');
    archiveDir = path.join(root, 'archives');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('the archive keeps the working directory and incident ownership', () => {
    const store = new SessionArchiveStore(archiveDir);
    const incidentRequest = { incident_id: 'INC-1', attempt_id: 'A-1' } as any;
    const session = {
      ownerId: 'U1',
      channelId: 'C1',
      threadTs: '800.001',
      sessionId: SID,
      isActive: true,
      lastActivity: new Date(),
      sessionWorkingDir: CWD,
      incidentRequest,
      incidentAttemptFinishedId: 'A-0',
    } as unknown as ConversationSession;
    store.archive(session, 'work:C1:800.001', 'sleep_expired');
    const [file] = fs.readdirSync(archiveDir);
    const saved = JSON.parse(fs.readFileSync(path.join(archiveDir, file), 'utf-8')) as ArchivedSession;
    expect(saved.sessionWorkingDir).toBe(CWD);
    expect(saved.incidentRequest).toEqual(incidentRequest);
    expect(saved.incidentAttemptFinishedId).toBe('A-0');
  });

  it('load() opens the exact archive the card names, not the latest one for the thread', () => {
    const store = new SessionArchiveStore(archiveDir);
    fs.mkdirSync(archiveDir, { recursive: true });
    const older = archivedRecord({ archivedAt: 1000, title: 'older' });
    const newer = archivedRecord({ archivedAt: 2000, title: 'newer' });
    for (const a of [older, newer]) {
      fs.writeFileSync(path.join(archiveDir, `work-C1-800.001_${a.archivedAt}.json`), JSON.stringify(a));
    }
    expect(store.load('work:C1:800.001', 1000)?.title).toBe('older');
    expect(store.load('work:C1:800.001', 2000)?.title).toBe('newer');
    expect(store.load('work:C1:800.001', 3000)).toBeNull();
    // A file whose content names another session is not this card's archive.
    fs.writeFileSync(
      path.join(archiveDir, 'work-C1-800.002_4000.json'),
      JSON.stringify(archivedRecord({ archivedAt: 4000, sessionKey: 'work:C1:999.999' })),
    );
    expect(store.load('work:C1:800.002', 4000)).toBeNull();
  });

  it('resolves the kept working directory when the transcript sits under it', () => {
    writeTranscript(configDir, `/private${CWD}`);
    expect(resolveArchivedResume(archivedRecord({ sessionWorkingDir: CWD }), { configDir })).toEqual({
      ok: true,
      cwd: CWD,
    });
  });

  it('an archive written before the field: the transcript’s own cwd, proven by its project directory', () => {
    writeTranscript(configDir, `/private${CWD}`);
    expect(resolveArchivedResume(archivedRecord(), { configDir })).toEqual({ ok: true, cwd: CWD });
  });

  it('no transcript → refused (no silent fresh conversation)', () => {
    expect(resolveArchivedResume(archivedRecord({ sessionWorkingDir: CWD }), { configDir })).toMatchObject({
      ok: false,
      code: 'transcript_missing',
    });
  });

  it('no SDK session → refused', () => {
    expect(resolveArchivedResume(archivedRecord({ sessionId: undefined }), { configDir })).toMatchObject({
      ok: false,
      code: 'no_conversation',
    });
  });

  it('a working directory that does not resolve to the transcript → refused', () => {
    writeTranscript(configDir, `/private${CWD}`);
    expect(
      resolveArchivedResume(archivedRecord({ sessionWorkingDir: '/tmp/U1/session_other_ffff' }), { configDir }),
    ).toMatchObject({ ok: false, code: 'invalid_cwd' });
  });

  it("a working directory outside the owner's /tmp/<owner>/ → refused", () => {
    const foreign = '/tmp/U2/session_1793000000000_ab12cd34';
    writeTranscript(configDir, foreign);
    expect(resolveArchivedResume(archivedRecord(), { configDir })).toMatchObject({ ok: false, code: 'invalid_cwd' });
    writeTranscript(configDir, '/Users/someone/repo', '/Users/someone/repo', '7f3c2a10-0000-4000-8000-000000000002');
    expect(
      resolveArchivedResume(archivedRecord({ sessionId: '7f3c2a10-0000-4000-8000-000000000002' }), { configDir }),
    ).toMatchObject({ ok: false, code: 'invalid_cwd' });
  });

  it('an incident-channel archive without its incident ownership → refused; with it → allowed', () => {
    writeTranscript(configDir, `/private${CWD}`);
    const opts = { configDir, incidentChannelIds: ['C1'] };
    expect(resolveArchivedResume(archivedRecord({ sessionWorkingDir: CWD }), opts)).toMatchObject({
      ok: false,
      code: 'incident_provenance',
    });
    expect(
      resolveArchivedResume(
        archivedRecord({ sessionWorkingDir: CWD, incidentRequest: { incident_id: 'I', attempt_id: 'A' } as any }),
        opts,
      ),
    ).toEqual({ ok: true, cwd: CWD });
  });
});
