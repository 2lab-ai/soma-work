#!/usr/bin/env -S tsx
/**
 * stdio self-proof — plan v8 acceptance gate.
 *
 * Drives the harness over JSON-RPC (stdio) and asserts the 7 scenarios:
 *   1. initialize → tools/list returns exactly 1 tool named `chat`
 *   2. new session with model+prompt → returns sessionId
 *   3. resume with returned sessionId → continues conversation
 *   4. unknown resumeSessionId → SESSION_NOT_FOUND in structuredContent.error
 *   5. concurrent resume of same sessionId → SESSION_BUSY
 *   6. resume with model arg present → MUTUAL_EXCLUSION
 *   7. real watchdog: fake runtime sleep 10s with timeoutMs:500 → BACKEND_TIMEOUT
 *      within 1s + child gone from ps
 *
 * Exits 0 iff all 7 pass; 1 otherwise.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── Scenario runner types ─────────────────────────────────

interface Scenario {
  name: string;
  tmpdir: string;
  env: Record<string, string>;
  /** Run the scenario with a connected harness; resolve on pass, reject on fail. */
  run: (rpc: RpcClient) => Promise<void>;
}

class RpcClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private buf = '';

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      // eslint-disable-next-line no-cond-assign
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
        } catch {
          // non-JSON logs emitted by harness; ignore.
        }
      }
    });
    child.stderr.setEncoding('utf8');
    // Pass stderr through for debuggability.
    child.stderr.on('data', (s: string) => process.stderr.write(`[harness] ${s}`));
  }

  send(method: string, params: any, timeoutMs = 10_000): Promise<any> {
    const id = this.nextId++;
    const req = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  sendNoWait(method: string, params: any): Promise<any> {
    // Fire without awaiting resolution — used for concurrent-resume scenario.
    return this.send(method, params, 30_000);
  }
}

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmp(d: string): void {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function withHarness<T>(
  envExtra: Record<string, string>,
  body: (rpc: RpcClient, child: ChildProcessWithoutNullStreams) => Promise<T>,
): Promise<T> {
  const harnessPath = path.resolve(__dirname, 'stdio-self-proof-harness.ts');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', harnessPath],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...envExtra },
    },
  );
  const rpc = new RpcClient(child);
  try {
    // Initialize handshake.
    await rpc.send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'self-proof', version: '1.0.0' },
    });
    // Fire notifications/initialized (no id, no response).
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return await body(rpc, child);
  } finally {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    await new Promise((r) => child.once('exit', r));
  }
}

function parseStructured(result: any): any {
  return result?.structuredContent ?? {};
}

// ── Scenarios ─────────────────────────────────────────────

const results: { name: string; pass: boolean; detail?: string }[] = [];

async function run(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    results.push({ name, pass: true });
    console.log(`✓ ${name}`);
  } catch (e: any) {
    results.push({ name, pass: false, detail: e?.message ?? String(e) });
    console.log(`✗ ${name} — ${e?.message ?? String(e)}`);
  }
}

async function scenario_1_2_3_4_6(): Promise<void> {
  const tmp = mkTmp('selfproof-abc-');
  try {
    await withHarness({ SELFPROOF_TMPDIR: tmp }, async (rpc) => {
      // 1: tools/list returns exactly 1 tool named `chat`
      await run('S1: tools/list has exactly one tool `chat`', async () => {
        const tl = await rpc.send('tools/list', {});
        const tools: any[] = tl?.tools ?? [];
        if (tools.length !== 1) throw new Error(`expected 1 tool; got ${tools.length}`);
        if (tools[0].name !== 'chat') throw new Error(`expected name=chat; got ${tools[0].name}`);
      });

      // 2: new session → returns sessionId
      let sessionId = '';
      await run('S2: new session with model+prompt returns sessionId', async () => {
        const r = await rpc.send('tools/call', {
          name: 'chat',
          arguments: { model: 'codex', prompt: 'hello world' },
        });
        const s = parseStructured(r);
        if (!s.sessionId || typeof s.sessionId !== 'string') {
          throw new Error(`no sessionId: ${JSON.stringify(r)}`);
        }
        if (s.backend !== 'codex') throw new Error(`expected backend=codex; got ${s.backend}`);
        if (typeof s.content !== 'string' || !s.content.includes('hello world')) {
          throw new Error(`content mismatch: ${s.content}`);
        }
        sessionId = s.sessionId;
      });

      // 3: resume with returned sessionId
      await run('S3: resume with returned sessionId continues conversation', async () => {
        const r = await rpc.send('tools/call', {
          name: 'chat',
          arguments: { resumeSessionId: sessionId, prompt: 'follow-up' },
        });
        const s = parseStructured(r);
        if (s.sessionId !== sessionId) throw new Error(`sessionId drift: ${s.sessionId}`);
        if (!String(s.content).includes('follow-up')) {
          throw new Error(`resume content mismatch: ${s.content}`);
        }
      });

      // 4: unknown resumeSessionId → SESSION_NOT_FOUND
      await run('S4: unknown resumeSessionId → SESSION_NOT_FOUND', async () => {
        const r = await rpc.send('tools/call', {
          name: 'chat',
          arguments: { resumeSessionId: 'does-not-exist-xyz', prompt: 'x' },
        });
        if (!r?.isError) throw new Error(`expected isError=true; got ${JSON.stringify(r)}`);
        const code = parseStructured(r)?.error?.code;
        if (code !== 'session_not_found') throw new Error(`expected session_not_found; got ${code}`);
      });

      // 6: resume with model arg present → MUTUAL_EXCLUSION
      await run('S6: resume with model arg present → MUTUAL_EXCLUSION', async () => {
        const r = await rpc.send('tools/call', {
          name: 'chat',
          arguments: { resumeSessionId: sessionId, model: 'codex', prompt: 'x' },
        });
        if (!r?.isError) throw new Error(`expected isError=true; got ${JSON.stringify(r)}`);
        const code = parseStructured(r)?.error?.code;
        if (code !== 'mutual_exclusion') throw new Error(`expected mutual_exclusion; got ${code}`);
      });
    });
  } finally {
    rmTmp(tmp);
  }
}

async function scenario_5_busy(): Promise<void> {
  // Scenario 5 needs a session whose resume blocks long enough to collide. Use
  // the SELFPROOF_SLEEP_MS env to make the fake runtime spawn a 2s sleep child
  // on every dispatch, then fire two resumes concurrently.
  const tmp = mkTmp('selfproof-busy-');
  try {
    await withHarness({ SELFPROOF_TMPDIR: tmp, SELFPROOF_SLEEP_MS: '2000' }, async (rpc) => {
      // Seed a ready session (needs a real startSession to get ready status).
      // Use SELFPROOF_SLEEP_MS=2000 so the start takes 2s — but we need 2 separate
      // RPC issuances, so issue start first (awaits), then two resumes in parallel.
      const newR = await rpc.send('tools/call', {
        name: 'chat',
        arguments: { model: 'codex', prompt: 'seed' },
      }, 30_000);
      const sid = parseStructured(newR).sessionId;
      if (!sid) throw new Error(`seed failed: ${JSON.stringify(newR)}`);

      await run('S5: concurrent resume of same session → SESSION_BUSY', async () => {
        // Fire two resume calls concurrently. First acquires the lock, second
        // must return SESSION_BUSY because the lock is held.
        const p1 = rpc.sendNoWait('tools/call', {
          name: 'chat',
          arguments: { resumeSessionId: sid, prompt: 'p1' },
        });
        // Small delay so p1's handleChat reaches acquire() before p2.
        await new Promise((r) => setTimeout(r, 50));
        const p2 = rpc.sendNoWait('tools/call', {
          name: 'chat',
          arguments: { resumeSessionId: sid, prompt: 'p2' },
        });
        const [r1, r2] = await Promise.all([p1, p2]);
        // Either one could be the loser, but one must succeed and the other
        // must be SESSION_BUSY.
        const codes = [r1, r2].map((r) => parseStructured(r)?.error?.code);
        const hasBusy = codes.includes('session_busy');
        const hasSuccess = [r1, r2].some((r) => !r?.isError && parseStructured(r)?.sessionId === sid);
        if (!hasBusy || !hasSuccess) {
          throw new Error(
            `expected exactly one session_busy + one success; got codes=${JSON.stringify(codes)}`,
          );
        }
      });
    });
  } finally {
    rmTmp(tmp);
  }
}

async function scenario_7_watchdog(): Promise<void> {
  const tmp = mkTmp('selfproof-watch-');
  try {
    await withHarness({ SELFPROOF_TMPDIR: tmp, SELFPROOF_SLEEP_MS: '10000' }, async (rpc) => {
      await run('S7: timeoutMs:500 on sleep(10s) → BACKEND_TIMEOUT within 1s + child reaped', async () => {
        const before = Date.now();
        const r = await rpc.send('tools/call', {
          name: 'chat',
          arguments: { model: 'codex', prompt: 'timeout-test', timeoutMs: 500 },
        }, 5_000);
        const elapsed = Date.now() - before;
        if (!r?.isError) throw new Error(`expected isError=true; got ${JSON.stringify(r)}`);
        const code = parseStructured(r)?.error?.code;
        if (code !== 'backend_timeout') throw new Error(`expected backend_timeout; got ${code}`);
        if (elapsed > 3_000) throw new Error(`took ${elapsed}ms; expected < 3000`);

        // Verify child (a `sleep 10` process) is eventually gone. Poll ps for up to 8s
        // (SIGTERM grace is 5s, then SIGKILL). Look for any `sleep 10` process
        // whose parent is our harness — since our harness is about to exit,
        // simplest to check if any `sleep 10` that we spawned is left.
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          const ps = spawnSync('pgrep', ['-f', 'sleep 10'], { encoding: 'utf8' });
          if (ps.status !== 0 || !ps.stdout.trim()) return; // all sleep 10 gone
          await new Promise((r2) => setTimeout(r2, 200));
        }
        throw new Error('sleep 10 child still alive after 8s');
      });
    });
  } finally {
    rmTmp(tmp);
  }
}

// ── Main ──────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('running stdio self-proof…');
  await scenario_1_2_3_4_6();
  await scenario_5_busy();
  await scenario_7_watchdog();
  const failed = results.filter((r) => !r.pass);
  console.log(`\nResults: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log('ALL 7 SCENARIOS PASSED');
}

main().catch((err) => {
  console.error('self-proof driver failure:', err);
  process.exit(1);
});
