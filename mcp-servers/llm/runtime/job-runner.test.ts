/**
 * Unit Tests — JobRunner
 * Issue #334: Persistent Job System
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { JobRunner } from './job-runner.js';
import type { Job, JobStore, LlmRuntime, Backend, SessionResult } from './types.js';

// ── Mock JobStore ────────────────────────────────────────

function createMockStore(): JobStore & { jobs: Map<string, Job> } {
  const jobs = new Map<string, Job>();
  return {
    jobs,
    get: vi.fn((id: string) => jobs.get(id)),
    getAll: vi.fn(() => [...jobs.values()]),
    getRunning: vi.fn(() => [...jobs.values()].filter(j => j.status === 'running' || j.status === 'queued')),
    save: vi.fn((job: Job) => { jobs.set(job.id, { ...job }); }),
    delete: vi.fn((id: string) => { jobs.delete(id); }),
    prune: vi.fn(),
  };
}

// ── Mock Runtime ─────────────────────────────────────────

function createMockRuntime(backend: Backend = 'codex'): LlmRuntime {
  return {
    name: backend,
    capabilities: { supportsReview: false, supportsInterrupt: false, supportsResume: true, supportsEventStream: false },
    ensureReady: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue({
      backendSessionId: 'thread-123',
      content: 'mock response',
      backend,
      model: 'gpt-5.4',
    } as SessionResult),
    resumeSession: vi.fn().mockResolvedValue({
      backendSessionId: 'thread-123',
      content: 'continued response',
      backend,
      model: 'gpt-5.4',
    } as SessionResult),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('JobRunner', () => {
  let store: ReturnType<typeof createMockStore>;
  let codexRuntime: LlmRuntime;
  let geminiRuntime: LlmRuntime;
  let runner: JobRunner;

  beforeEach(() => {
    store = createMockStore();
    codexRuntime = createMockRuntime('codex');
    geminiRuntime = createMockRuntime('gemini');
    runner = new JobRunner({
      jobStore: store,
      runtimes: { codex: codexRuntime, gemini: geminiRuntime },
    });
  });

  describe('startJob() — synchronous', () => {
    it('creates and completes a job', async () => {
      const job = await runner.startJob({
        kind: 'chat',
        prompt: 'hello world',
        backend: 'codex',
        model: 'gpt-5.4',
        sessionOptions: { model: 'gpt-5.4' },
      });

      expect(job.status).toBe('completed');
      expect(job.result).toBe('mock response');
      expect(job.backendSessionId).toBe('thread-123');
      expect(job.id).toMatch(/^chat-[a-z0-9]+-[a-z0-9]+$/);
    });

    it('generates unique job IDs', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const job = await runner.startJob({
          kind: 'chat',
          prompt: 'test',
          backend: 'codex',
          model: 'gpt-5.4',
          sessionOptions: { model: 'gpt-5.4' },
        });
        ids.add(job.id);
      }
      expect(ids.size).toBe(10);
    });

    it('truncates long prompts in summary', async () => {
      const longPrompt = 'x'.repeat(200);
      const job = await runner.startJob({
        kind: 'chat',
        prompt: longPrompt,
        backend: 'codex',
        model: 'gpt-5.4',
        sessionOptions: { model: 'gpt-5.4' },
      });
      expect(job.promptSummary.length).toBeLessThanOrEqual(120);
      expect(job.promptSummary).toContain('...');
    });

    it('handles runtime failure gracefully', async () => {
      (codexRuntime.startSession as any).mockRejectedValue(new Error('backend timeout'));
      const job = await runner.startJob({
        kind: 'chat',
        prompt: 'fail me',
        backend: 'codex',
        model: 'gpt-5.4',
        sessionOptions: { model: 'gpt-5.4' },
      });
      expect(job.status).toBe('failed');
      expect(job.error).toBe('backend timeout');
    });

    it('uses resumeSession when backendSessionId is provided', async () => {
      await runner.startJob({
        kind: 'chat',
        prompt: 'continue',
        backend: 'codex',
        model: 'gpt-5.4',
        sessionOptions: { model: 'gpt-5.4' },
        backendSessionId: 'existing-thread',
      });
      expect(codexRuntime.resumeSession).toHaveBeenCalledWith('existing-thread', 'continue');
    });
  });

  describe('startJob() — background', () => {
    it('returns immediately with queued/running status', async () => {
      // Make runtime slow so we can observe the immediate return
      (codexRuntime.startSession as any).mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve({
          backendSessionId: 'thread-bg',
          content: 'bg response',
          backend: 'codex',
          model: 'gpt-5.4',
        }), 50)),
      );

      const job = await runner.startJob({
        kind: 'chat',
        prompt: 'background task',
        backend: 'codex',
        model: 'gpt-5.4',
        sessionOptions: { model: 'gpt-5.4' },
        background: true,
      });

      // Should return immediately (queued or running, not completed)
      expect(['queued', 'running']).toContain(job.status);

      // Wait for background completion
      await new Promise(r => setTimeout(r, 100));
      const completed = store.get(job.id);
      expect(completed?.status).toBe('completed');
    });
  });

  describe('cancel()', () => {
    it('cancels a running job', async () => {
      // Make runtime hang
      (codexRuntime.startSession as any).mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 5000)),
      );

      const job = await runner.startJob({
        kind: 'chat',
        prompt: 'cancel me',
        backend: 'codex',
        model: 'gpt-5.4',
        sessionOptions: { model: 'gpt-5.4' },
        background: true,
      });

      // Cancel it
      const cancelled = runner.cancel(job.id);
      expect(cancelled?.status).toBe('cancelled');
      expect(cancelled?.completedAt).toBeDefined();
    });

    it('returns job as-is for already completed jobs', async () => {
      const job = await runner.startJob({
        kind: 'chat',
        prompt: 'done',
        backend: 'codex',
        model: 'gpt-5.4',
        sessionOptions: { model: 'gpt-5.4' },
      });

      const result = runner.cancel(job.id);
      expect(result?.status).toBe('completed');
    });

    it('returns undefined for unknown job', () => {
      expect(runner.cancel('nonexistent')).toBeUndefined();
    });
  });

  describe('max running limit', () => {
    it('rejects when max concurrent jobs reached (inflight-based)', async () => {
      // Launch 5 background jobs that hang
      (codexRuntime.startSession as any).mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 10000)),
      );

      const jobs = [];
      for (let i = 0; i < 5; i++) {
        jobs.push(await runner.startJob({
          kind: 'chat',
          prompt: `job ${i}`,
          backend: 'codex',
          model: 'gpt-5.4',
          sessionOptions: { model: 'gpt-5.4' },
          background: true,
        }));
      }

      // 6th job should fail
      await expect(runner.startJob({
        kind: 'chat',
        prompt: 'one too many',
        backend: 'codex',
        model: 'gpt-5.4',
        sessionOptions: { model: 'gpt-5.4' },
      })).rejects.toThrow(/Max concurrent jobs/);

      // Cleanup
      for (const j of jobs) runner.cancel(j.id);
    });
  });

  describe('getInflightIds()', () => {
    it('returns IDs of in-flight jobs', async () => {
      (codexRuntime.startSession as any).mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 5000)),
      );

      const job = await runner.startJob({
        kind: 'chat',
        prompt: 'inflight',
        backend: 'codex',
        model: 'gpt-5.4',
        sessionOptions: { model: 'gpt-5.4' },
        background: true,
      });

      expect(runner.getInflightIds()).toContain(job.id);

      // Cleanup
      runner.cancel(job.id);
    });
  });
});
