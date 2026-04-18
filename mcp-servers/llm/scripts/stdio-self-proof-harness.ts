#!/usr/bin/env -S tsx
/**
 * Self-proof harness — spawned as a child of stdio-self-proof.ts.
 *
 * Runs a real LlmMCPServer over stdio, but replaces the production
 * CodexRuntime/GeminiRuntime with fakes whose behavior is controlled
 * via env vars. This lets the parent drive the 7 plan-spec scenarios
 * without real backend CLIs.
 *
 * Config via env:
 *   SELFPROOF_TMPDIR       — isolated state dir (pidfile + sessions + children live here)
 *   SELFPROOF_SLEEP_MS     — when set, fake runtime's startSession spawns a real
 *                            `sleep` child of this duration (for watchdog test 7)
 *                            and awaits it; otherwise resolves synchronously.
 */
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { LlmMCPServer } from '../llm-mcp-server.js';
import { FileSessionStore } from '../runtime/session-store.js';
import { ChildRegistry } from '../runtime/child-registry.js';
import { SessionLocks } from '../runtime/session-locks.js';
import { ShutdownCoordinator } from '../runtime/shutdown.js';
import { acquirePidfile } from '../runtime/pidfile.js';
import { runWithWatchdog } from '../runtime/watchdog.js';
import type { Backend, LlmRuntime, RuntimeCallOptions, StartSessionResult, ResumeSessionResult } from '../runtime/types.js';

const tmpdir = process.env.SELFPROOF_TMPDIR;
if (!tmpdir) {
  console.error('SELFPROOF_TMPDIR required');
  process.exit(2);
}
const sleepMs = process.env.SELFPROOF_SLEEP_MS ? Number(process.env.SELFPROOF_SLEEP_MS) : 0;

const pidPath = path.join(tmpdir, 'llm-mcp-server.pid');
const sessionPath = path.join(tmpdir, 'sessions.jsonl');
const childPath = path.join(tmpdir, 'children.jsonl');

class FakeRuntime implements LlmRuntime {
  readonly capabilities = {
    supportsReview: false,
    supportsInterrupt: false,
    supportsResume: true,
    supportsEventStream: false,
  };
  constructor(public readonly name: Backend, private readonly childRegistry: ChildRegistry) {}

  async ensureReady(): Promise<void> {}

  async startSession(
    model: string,
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
      // Scenario 7: spawn a real `sleep` child, register it, await via watchdog.
      const seconds = Math.ceil(sleepMs / 1000);
      const child = spawn('sleep', [String(seconds)], { stdio: 'ignore' });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });
      const pid = child.pid!;
      await this.childRegistry.append(pid, this.name);
      const waitForResult = new Promise<StartSessionResult>((resolve, reject) => {
        child.once('exit', () => resolve({
          backendSessionId,
          content: `[fake ${this.name}] ${prompt}`,
          resolvedConfig: opts.resolvedConfig ?? {},
        }));
        child.once('error', reject);
      });
      return runWithWatchdog(waitForResult, {
        timeoutMs: opts.timeoutMs ?? 300_000,
        signal: opts.signal,
        killChild: (sig) => { try { child.kill(sig); } catch { /* ignore */ } },
      }).finally(() => {
        void this.childRegistry.remove(pid).catch(() => { /* best-effort */ });
      });
    }
    return {
      backendSessionId,
      content: `[fake ${this.name}] ${prompt}${isNew ? ' (new)' : ' (resumed)'}`,
      resolvedConfig: opts.resolvedConfig ?? {},
    };
  }
}

async function main(): Promise<void> {
  const pidfile = acquirePidfile(pidPath);
  const sessionStore = new FileSessionStore(sessionPath);
  const childRegistry = new ChildRegistry(childPath);
  await childRegistry.replayAndReap();

  const runtimes: Record<Backend, LlmRuntime> = {
    codex: new FakeRuntime('codex', childRegistry),
    gemini: new FakeRuntime('gemini', childRegistry),
  };
  const sessionLocks = new SessionLocks();
  const shutdownCoordinator = new ShutdownCoordinator({
    pidfile,
    sessionStore,
    childRegistry,
    runtimes,
  });

  const server = new LlmMCPServer({
    runtimes,
    sessionStore,
    childRegistry,
    sessionLocks,
    shutdownCoordinator,
  });

  shutdownCoordinator.installSignalHandlers();
  await server.run();
}

main().catch((err) => {
  console.error('harness failed', err);
  process.exit(1);
});
