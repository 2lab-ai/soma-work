/**
 * Unit Tests — FileJobStore
 * Issue #334: Persistent Job System
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileJobStore } from './job-store.js';
import type { Job } from './types.js';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `chat-test-${Math.random().toString(36).slice(2, 6)}`,
    kind: 'chat',
    status: 'completed',
    phase: 'done',
    backend: 'codex',
    model: 'gpt-5.4',
    promptSummary: 'test prompt',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    logFile: '/tmp/test.log',
    ...overrides,
  };
}

describe('FileJobStore', () => {
  let tmpDir: string;
  let filePath: string;
  let store: FileJobStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-store-test-'));
    filePath = path.join(tmpDir, 'jobs.json');
    store = new FileJobStore(filePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── CRUD ──────────────────────────────────────────────

  it('save and get a job', () => {
    const job = makeJob({ id: 'chat-abc-123' });
    store.save(job);
    const retrieved = store.get('chat-abc-123');
    expect(retrieved).toEqual(job);
  });

  it('returns undefined for missing job', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('getAll returns all jobs', () => {
    store.save(makeJob({ id: 'j1' }));
    store.save(makeJob({ id: 'j2' }));
    store.save(makeJob({ id: 'j3' }));
    expect(store.getAll()).toHaveLength(3);
  });

  it('getRunning returns only running/queued jobs', () => {
    store.save(makeJob({ id: 'j1', status: 'running' }));
    store.save(makeJob({ id: 'j2', status: 'queued' }));
    store.save(makeJob({ id: 'j3', status: 'completed' }));
    store.save(makeJob({ id: 'j4', status: 'failed' }));
    expect(store.getRunning()).toHaveLength(2);
  });

  it('delete removes a job', () => {
    const job = makeJob({ id: 'to-delete' });
    store.save(job);
    store.delete('to-delete');
    expect(store.get('to-delete')).toBeUndefined();
  });

  // ── Persistence ────────────────────────────────────────

  it('persists to disk and survives reload', () => {
    const job = makeJob({ id: 'persist-test' });
    store.save(job);

    // New store instance reads from same file
    const store2 = new FileJobStore(filePath);
    expect(store2.get('persist-test')).toEqual(job);
  });

  it('starts fresh on missing file', () => {
    expect(store.getAll()).toEqual([]);
  });

  // ── TTL / Pruning ──────────────────────────────────────

  it('prune removes expired completed jobs', () => {
    const old = makeJob({
      id: 'old-job',
      status: 'completed',
      completedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
    });
    store.save(old);
    store.prune();
    expect(store.get('old-job')).toBeUndefined();
  });

  it('prune does NOT remove running jobs regardless of age', () => {
    const old = makeJob({
      id: 'running-old',
      status: 'running',
      startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });
    // Remove completedAt since it's running
    delete (old as any).completedAt;
    store.save(old);
    store.prune();
    expect(store.get('running-old')).toBeDefined();
  });

  it('trims oldest completed when over MAX_JOBS', () => {
    // Save 101 completed jobs
    for (let i = 0; i < 101; i++) {
      store.save(makeJob({
        id: `job-${String(i).padStart(3, '0')}`,
        startedAt: new Date(Date.now() - (101 - i) * 1000).toISOString(),
      }));
    }
    // After the 101st save triggers pruneExcess, should be <= 100
    expect(store.getAll().length).toBeLessThanOrEqual(100);
  });

  // ── Stale Recovery ──────────────────────────────────────

  it('recovers stale running/queued jobs as failed on reload', () => {
    // Write a running job directly to the file
    const staleJob = makeJob({ id: 'stale-running', status: 'running', phase: 'investigating' });
    delete (staleJob as any).completedAt;
    fs.writeFileSync(filePath, JSON.stringify([staleJob]), 'utf-8');

    const freshStore = new FileJobStore(filePath);
    const recovered = freshStore.get('stale-running');
    expect(recovered?.status).toBe('failed');
    expect(recovered?.error).toContain('server restarted');
    expect(recovered?.completedAt).toBeDefined();
  });

  // ── Corruption Handling ─────────────────────────────────

  it('backs up corrupt file and starts fresh', () => {
    fs.writeFileSync(filePath, '{{{{invalid json!!!!', 'utf-8');
    const corruptStore = new FileJobStore(filePath);
    expect(corruptStore.getAll()).toEqual([]);
    // Backup file should exist
    const files = fs.readdirSync(tmpDir);
    expect(files.some(f => f.includes('.corrupt.'))).toBe(true);
  });

  // ── Atomic Write ───────────────────────────────────────

  it('writes atomically via tmp+rename', () => {
    const job = makeJob({ id: 'atomic-test' });
    store.save(job);
    // Verify no .tmp file remains
    const files = fs.readdirSync(tmpDir);
    expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
    // Verify main file exists and is valid JSON
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('atomic-test');
  });
});
