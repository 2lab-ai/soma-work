#!/usr/bin/env -S tsx
/**
 * Self-proof harness — spawned as a child of stdio-self-proof.ts.
 *
 * Runs a real LlmMCPServer over stdio, but replaces the production
 * CodexRuntime/GeminiRuntime with fakes whose behavior is controlled
 * via env vars. This lets the parent drive the acceptance scenarios
 * without real backend CLIs.
 *
 * Config via env:
 *   SELFPROOF_SLEEP_MS — when set, fake runtime's startSession spawns a real
 *                        `sleep` child of this duration (for watchdog test)
 *                        and awaits it; otherwise resolves synchronously.
 *
 * SELFPROOF_TMPDIR is still accepted for callers that set it, but is
 * ignored — the simplified server has no on-disk state.
 */
import { spawn } from 'node:child_process';
import { LlmMCPServer } from '../llm-mcp-server.js';
import { runWithWatchdog } from '../runtime/watchdog.js';
import type { Backend, LlmRuntime, RuntimeCallOptions, StartSessionResult, ResumeSessionResult } from '../runtime/types.js';

const sleepMs = process.env.SELFPROOF_SLEEP_MS ? Number(process.env.SELFPROOF_SLEEP_MS) : 0;

class FakeRuntime implements LlmRuntime {
  constructor(public readonly name: Backend) {}

  async ensureReady(): Promise<void> {}

  async startSession(
    _model: string,
    prompt: string,
    opts: RuntimeCallOptions,
  ): Promise<StartSessionResult> {
    return this.dispatch(`fake-bsid-${this.name}-new`, prompt, opts, true);
  }

  async resumeSession(
    backendSessionId: string,
    prompt: string,
    opts: RuntimeCallOptions,
  ): Promise<ResumeSessionResult> {
    const r = await this.dispatch(backendSessionId, prompt, opts, false);
    return { backendSessionId: r.backendSessionId, content: r.content };
  }

  async shutdown(): Promise<void> {}

  private async dispatch(
    backendSessionId: string,
    prompt: string,
    opts: RuntimeCallOptions,
    isNew: boolean,
  ): Promise<StartSessionResult> {
    if (sleepMs > 0) {
      // Watchdog scenario: spawn a real `sleep` child, await via watchdog.
      const seconds = Math.ceil(sleepMs / 1000);
      const child = spawn('sleep', [String(seconds)], { stdio: 'ignore' });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });
      const waitForResult = new Promise<StartSessionResult>((resolve, reject) => {
        child.once('exit', () => resolve({
          backendSessionId,
          content: `[fake ${this.name}] ${prompt}`,
        }));
        child.once('error', reject);
      });
      return runWithWatchdog(waitForResult, {
        timeoutMs: opts.timeoutMs ?? 300_000,
        signal: opts.signal,
        killChild: (sig) => { try { child.kill(sig); } catch { /* ignore */ } },
      });
    }
    return {
      backendSessionId,
      content: `[fake ${this.name}] ${prompt}${isNew ? ' (new)' : ' (resumed)'}`,
    };
  }
}

async function main(): Promise<void> {
  const runtimes: Record<Backend, LlmRuntime> = {
    codex: new FakeRuntime('codex'),
    gemini: new FakeRuntime('gemini'),
  };
  const server = new LlmMCPServer({ runtimes });
  await server.run();
}

main().catch((err) => {
  console.error('harness failed', err);
  process.exit(1);
});
