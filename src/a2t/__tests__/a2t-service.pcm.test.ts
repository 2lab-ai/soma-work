/**
 * A2tService.transcribePcm — 받아쓰기 windows through a worker process (epic #737, #739), against a fake worker
 * that speaks the worker's line protocol (services/a2t/worker.py).
 *
 *   P1  the PCM goes as base64 s16le with the language and prompt; the answer's text comes back
 *   P2  requests wait their turn (the worker answers one at a time) and each gets its own answer
 */

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { A2tService } from '../a2t-service';

function fakeWorker(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'a2t-fake-'));
  const file = join(dir, 'python');
  writeFileSync(
    file,
    `#!/usr/bin/env node
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
send({ type: 'ready', model: 'large-v3-turbo', device: 'mps', backend: 'mlx' });
rl.on('line', (line) => { const r = JSON.parse(line); ${body} });
`,
  );
  chmodSync(file, 0o755);
  return file;
}

let service: A2tService | null = null;
afterEach(async () => {
  await service?.shutdown();
  service = null;
});

describe('A2tService.transcribePcm', () => {
  it('P1 — base64 s16le with language and prompt; the text comes back', async () => {
    service = new A2tService({
      pythonPath: fakeWorker(
        `if (r.type === 'transcribe_pcm') { const b = Buffer.from(r.pcm, 'base64'); send({ type: 'result', text: [b.length, b.readInt16LE(0), b.readInt16LE(2), r.language, r.prompt].join('|') }); }`,
      ),
      minMemoryMb: 1,
    });
    await service.initialize();
    expect(service.getStatus()).toMatchObject({ state: 'ready', model: 'large-v3-turbo' });
    const pcm = new Int16Array([1234, -2345, 0, 7]);
    expect(await service.transcribePcm(pcm, { language: 'ko', prompt: '대시보드' })).toBe('8|1234|-2345|ko|대시보드');
    // a view into a larger buffer sends only its own samples
    const view = new Int16Array([9, 9, 42, -42, 9]).subarray(2, 4);
    expect((await service.transcribePcm(view)).split('|').slice(0, 3)).toEqual(['4', '42', '-42']);
  });

  it('P2 — requests wait their turn and each gets its own answer', async () => {
    service = new A2tService({
      pythonPath: fakeWorker(
        `const b = Buffer.from(r.pcm, 'base64'); setTimeout(() => send({ type: 'result', text: 'n=' + b.readInt16LE(0) }), 30 - b.readInt16LE(0) * 5);`,
      ),
      minMemoryMb: 1,
    });
    await service.initialize();
    const answers = await Promise.all([1, 2, 3, 4].map((n) => service!.transcribePcm(new Int16Array([n]))));
    expect(answers).toEqual(['n=1', 'n=2', 'n=3', 'n=4']);
  });

  it('a worker error is that request’s error; the next request still works', async () => {
    service = new A2tService({
      pythonPath: fakeWorker(
        `const b = Buffer.from(r.pcm, 'base64'); if (b.readInt16LE(0) === 1) send({ type: 'error', error: 'bad audio' }); else send({ type: 'result', text: 'ok' });`,
      ),
      minMemoryMb: 1,
    });
    await service.initialize();
    await expect(service.transcribePcm(new Int16Array([1]))).rejects.toThrow('bad audio');
    expect(await service.transcribePcm(new Int16Array([2]))).toBe('ok');
  });

  it('a request cancelled while it waits its turn is never sent to the worker (re-review, PR #751)', async () => {
    service = new A2tService({
      pythonPath: fakeWorker(
        `const b = Buffer.from(r.pcm, 'base64'); setTimeout(() => send({ type: 'result', text: 'n=' + b.readInt16LE(0) }), 60);`,
      ),
      minMemoryMb: 1,
    });
    await service.initialize();
    const ac = new AbortController();
    const first = service.transcribePcm(new Int16Array([1]));
    const second = service.transcribePcm(new Int16Array([2]), { signal: ac.signal });
    const third = service.transcribePcm(new Int16Array([3]));
    ac.abort();
    expect(await first).toBe('n=1');
    await expect(second).rejects.toThrow('cancelled');
    expect(await third).toBe('n=3');
  });

  it('not ready: refuses with the status', async () => {
    service = new A2tService({ enabled: false });
    await expect(service.transcribePcm(new Int16Array([1]))).rejects.toThrow('disabled');
  });
});
