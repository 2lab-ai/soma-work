import { promises as fs, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readAllInstances,
  removeHeartbeat,
  STALE_THRESHOLD_MS,
  startHeartbeatLoop,
  writeHeartbeat,
} from '../instance-registry';

// ── Test setup ──

let tempDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'soma-instance-registry-'));
  originalEnv = process.env.SOMA_INSTANCE_DIR;
  process.env.SOMA_INSTANCE_DIR = tempDir;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.SOMA_INSTANCE_DIR;
  else process.env.SOMA_INSTANCE_DIR = originalEnv;
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe('instance-registry: writeHeartbeat', () => {
  it('writes a JSON file at <dir>/<port>.json with required payload fields', async () => {
    await writeHeartbeat({
      port: 33000,
      instanceName: 'oudwood-dev',
      host: '127.0.0.1',
      pid: 4242,
    });

    const files = readdirSync(tempDir);
    expect(files).toContain('33000.json');

    const raw = await fs.readFile(join(tempDir, '33000.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.port).toBe(33000);
    expect(parsed.instanceName).toBe('oudwood-dev');
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.pid).toBe(4242);
    expect(typeof parsed.lastSeen).toBe('number');
    expect(parsed.lastSeen).toBeGreaterThan(Date.now() - 5000);
  });

  it('uses 0600 file permissions (owner read/write only) on POSIX', async () => {
    await writeHeartbeat({
      port: 33001,
      instanceName: 'mac-mini-dev',
      host: '127.0.0.1',
      pid: 1234,
    });

    if (process.platform === 'win32') {
      // Windows POSIX permissions are not meaningful — skip the bit check
      return;
    }

    const stat = statSync(join(tempDir, '33001.json'));
    // Mask off file-type bits, keep only the permission bits
    const perm = stat.mode & 0o777;
    expect(perm).toBe(0o600);
  });

  it('atomic write: never leaves a partial file (uses tmp+rename)', async () => {
    // The contract is "atomic write" — there must never be a partial JSON
    // visible to readers during a write. Easiest invariant test: after
    // many concurrent writes, every file we can read parses cleanly.
    const writes = [];
    for (let i = 0; i < 20; i++) {
      writes.push(
        writeHeartbeat({
          port: 33000,
          instanceName: 'oudwood-dev',
          host: '127.0.0.1',
          pid: 100 + i,
        }),
      );
    }
    await Promise.all(writes);

    const raw = await fs.readFile(join(tempDir, '33000.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('overwrites an existing file at the same port (idempotent for a refresh)', async () => {
    await writeHeartbeat({ port: 33000, instanceName: 'a', host: '127.0.0.1', pid: 1 });
    await writeHeartbeat({ port: 33000, instanceName: 'b', host: '127.0.0.1', pid: 2 });

    const raw = await fs.readFile(join(tempDir, '33000.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.instanceName).toBe('b');
    expect(parsed.pid).toBe(2);
  });

  it('creates the heartbeat directory if it does not exist', async () => {
    const nested = join(tempDir, 'sub', 'nested');
    process.env.SOMA_INSTANCE_DIR = nested;

    await writeHeartbeat({
      port: 33000,
      instanceName: 'oudwood-dev',
      host: '127.0.0.1',
      pid: 99,
    });

    const files = readdirSync(nested);
    expect(files).toContain('33000.json');
  });
});

describe('instance-registry: readAllInstances', () => {
  it('returns empty array when directory is empty', async () => {
    const result = await readAllInstances();
    expect(result).toEqual([]);
  });

  it('returns empty array when directory does not exist', async () => {
    process.env.SOMA_INSTANCE_DIR = join(tempDir, 'never-created');
    const result = await readAllInstances();
    expect(result).toEqual([]);
  });

  it('reads all .json files and returns parsed instance records', async () => {
    await writeHeartbeat({ port: 33000, instanceName: 'a', host: '127.0.0.1', pid: 1 });
    await writeHeartbeat({ port: 33001, instanceName: 'b', host: '127.0.0.1', pid: 2 });
    await writeHeartbeat({ port: 33002, instanceName: 'c', host: '127.0.0.1', pid: 3 });

    const result = await readAllInstances();
    expect(result).toHaveLength(3);
    const ports = result.map((r) => r.port).sort();
    expect(ports).toEqual([33000, 33001, 33002]);
  });

  it('filters out stale instances (lastSeen older than STALE_THRESHOLD_MS)', async () => {
    // Write a fresh heartbeat
    await writeHeartbeat({ port: 33000, instanceName: 'fresh', host: '127.0.0.1', pid: 1 });

    // Write a stale heartbeat by directly writing JSON with old lastSeen
    const stalePayload = {
      port: 33001,
      instanceName: 'stale',
      host: '127.0.0.1',
      pid: 2,
      lastSeen: Date.now() - (STALE_THRESHOLD_MS + 5000),
    };
    await fs.writeFile(join(tempDir, '33001.json'), JSON.stringify(stalePayload), { mode: 0o600 });

    const result = await readAllInstances();
    expect(result).toHaveLength(1);
    expect(result[0].instanceName).toBe('fresh');
  });

  it('skips files that fail JSON parse (corrupt or partial)', async () => {
    await writeHeartbeat({ port: 33000, instanceName: 'good', host: '127.0.0.1', pid: 1 });
    await fs.writeFile(join(tempDir, '33999.json'), '{ not valid json', { mode: 0o600 });

    const result = await readAllInstances();
    expect(result).toHaveLength(1);
    expect(result[0].instanceName).toBe('good');
  });

  it('ignores non-.json files in the directory', async () => {
    await writeHeartbeat({ port: 33000, instanceName: 'good', host: '127.0.0.1', pid: 1 });
    await fs.writeFile(join(tempDir, 'README.md'), '# notes', { mode: 0o600 });
    await fs.writeFile(join(tempDir, '33000.json.tmp'), 'partial', { mode: 0o600 });

    const result = await readAllInstances();
    expect(result).toHaveLength(1);
    expect(result[0].port).toBe(33000);
  });
});

describe('instance-registry: removeHeartbeat', () => {
  it('deletes the heartbeat file for the given port', async () => {
    await writeHeartbeat({ port: 33000, instanceName: 'a', host: '127.0.0.1', pid: 1 });
    await writeHeartbeat({ port: 33001, instanceName: 'b', host: '127.0.0.1', pid: 2 });

    await removeHeartbeat(33000);

    const files = readdirSync(tempDir);
    expect(files).not.toContain('33000.json');
    expect(files).toContain('33001.json');
  });

  it('does not throw if the heartbeat file does not exist', async () => {
    await expect(removeHeartbeat(99999)).resolves.toBeUndefined();
  });
});

describe('instance-registry: startHeartbeatLoop', () => {
  it('immediately writes the heartbeat then refreshes on the interval', async () => {
    const handle = startHeartbeatLoop({ port: 33000, instanceName: 'loopy', host: '127.0.0.1', pid: 9999 }, 50);

    try {
      // Wait for at least one immediate write to land
      await new Promise((r) => setTimeout(r, 30));
      const first = JSON.parse(await fs.readFile(join(tempDir, '33000.json'), 'utf8'));
      const firstSeen = first.lastSeen;
      expect(typeof firstSeen).toBe('number');

      // Wait long enough for the interval to fire at least once more
      await new Promise((r) => setTimeout(r, 120));
      const second = JSON.parse(await fs.readFile(join(tempDir, '33000.json'), 'utf8'));
      expect(second.lastSeen).toBeGreaterThanOrEqual(firstSeen);
    } finally {
      clearInterval(handle);
    }
  });

  it('returns a Timeout handle that can be cleared with clearInterval', async () => {
    const handle = startHeartbeatLoop({ port: 33000, instanceName: 'loopy', host: '127.0.0.1', pid: 9999 }, 50);
    expect(handle).toBeTruthy();
    clearInterval(handle);
  });
});
