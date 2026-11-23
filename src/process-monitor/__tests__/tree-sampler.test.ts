import { describe, expect, it } from 'vitest';
import { FakePs } from '../__fixtures__/fake-ps';
import { TreeSampler } from '../tree-sampler';

/** soma daemon 100 → claude 200 (session A) → bash 300 → node 400; claude 250 (no session); an unrelated 900. */
function machine(): FakePs {
  return new FakePs()
    .set(1, { ppid: 0, args: '/sbin/launchd' })
    .set(100, { ppid: 1, args: 'node /opt/soma/dist/index.js' })
    .set(200, { ppid: 100, args: '/usr/local/bin/claude --model opus', rssKb: 300_000, cpu: 10 })
    .set(300, { ppid: 200, args: '/bin/bash -c npm test', rssKb: 4_000, cpu: 1 })
    .set(400, { ppid: 300, args: '/usr/bin/node vitest.mjs', rssKb: 200_000, cpu: 5 })
    .set(250, { ppid: 100, args: '/usr/local/bin/claude -p title', rssKb: 100_000 })
    .set(900, { ppid: 1, args: '/Applications/Other.app/x', rssKb: 999_999 });
}

describe('TreeSampler', () => {
  it('does no ps work while nothing is tracked or remembered', async () => {
    const ps = machine();
    const sampler = new TreeSampler(ps.run, () => 0);
    const out = await sampler.sample([], 'n1');
    expect(out.sessions).toEqual([]);
    expect(ps.calls).toEqual([]);
  });

  it('groups each session’s root and every descendant, in tree order, and nothing else', async () => {
    const ps = machine();
    const sampler = new TreeSampler(ps.run, () => 1_000);
    const out = await sampler.sample([{ pid: 200, sessionKey: 'A' }, { pid: 250 }], 'n1');

    expect(out.sessions).toHaveLength(1);
    const a = out.sessions[0];
    expect(a.sessionKey).toBe('A');
    expect(a.nodeId).toBe('n1');
    expect(a.rootAlive).toBe(true);
    expect(a.processes.map((p) => [p.pid, p.depth, p.role])).toEqual([
      [200, 0, 'root'],
      [300, 1, 'child'],
      [400, 2, 'child'],
    ]);
    expect(a.processCount).toBe(3);
    expect(a.rssBytes).toBe((300_000 + 4_000 + 200_000) * 1024);
    expect(a.processes[0].name).toBe('claude');
    expect(a.processes[2].name).toBe('node vitest.mjs');
    // The one-shot helper is the node's, not a card's.
    expect(out.unattributed).toEqual({ processCount: 1, cpuPercent: 0, rssBytes: 100_000 * 1024 });
    // Only tracked pids reach the detail call (the unrelated 900 never does).
    const detail = ps.calls.find((c) => c[0] === '-ww') as string[];
    expect(detail[detail.indexOf('-p') + 1].split(',').map(Number).sort()).toEqual([200, 250, 300, 400]);
  });

  it('computes CPU from the cputime change between samples (100% = one core)', async () => {
    const ps = machine();
    let now = 10_000;
    const sampler = new TreeSampler(ps.run, () => now);
    (ps.procs.get(300) as { psCpu: number }).psCpu = 12.5;
    const first = await sampler.sample([{ pid: 200, sessionKey: 'A' }], 'n1');
    // First sight: ps's own %cpu — 12.5 for bash 300, 0 for node 400.
    expect(first.sessions[0].processes[1].cpuPercent).toBe(12.5);
    expect(first.sessions[0].processes[2].cpuPercent).toBe(0);

    now += 2_000; // 2 s later
    (ps.procs.get(400) as { cpu: number }).cpu = 5 + 3; // +3 s CPU in 2 s = 150% (multi-threaded)
    (ps.procs.get(200) as { cpu: number }).cpu = 10 + 0.5; // 25%
    const second = await sampler.sample([{ pid: 200, sessionKey: 'A' }], 'n1');
    const byPid = new Map(second.sessions[0].processes.map((p) => [p.pid, p.cpuPercent]));
    expect(byPid.get(400)).toBe(150);
    expect(byPid.get(200)).toBe(25);
    // From the second sample on, the cputime change — bash 300 used none.
    expect(byPid.get(300)).toBe(0);
    expect(second.sessions[0].cpuPercent).toBe(175);
  });

  it('keeps an orphan the OS re-parented — and what it spawns — under its session', async () => {
    const ps = machine();
    const sampler = new TreeSampler(ps.run, () => 0);
    await sampler.sample([{ pid: 200, sessionKey: 'A' }], 'n1');

    // bash 300 exits; node 400 is re-parented to launchd and spawns 401. The turn ends: claude 200 exits too.
    ps.remove(300).reparent(400, 1).set(401, { ppid: 400, args: '/usr/bin/esbuild' }).remove(200);
    const out = await sampler.sample([], 'n1');
    const a = out.sessions.find((s) => s.sessionKey === 'A');
    expect(a?.rootAlive).toBe(false);
    expect(a?.processes.map((p) => [p.pid, p.role])).toEqual([
      [400, 'orphan'],
      [401, 'child'],
    ]);
  });

  it('drops a remembered pid the OS reused for another program (different start time)', async () => {
    const ps = machine();
    const sampler = new TreeSampler(ps.run, () => 0);
    await sampler.sample([{ pid: 200, sessionKey: 'A' }], 'n1');

    ps.remove(200).remove(300).remove(400);
    ps.set(400, { ppid: 1, start: 'Tue Nov 24 08:00:00 2026', args: '/usr/bin/somebody-else' });
    ps.set(410, { ppid: 400, args: '/usr/bin/its-child' });
    const out = await sampler.sample([], 'n1');
    expect(out.sessions).toEqual([]);
    expect(sampler.rememberedStart('A', 400)).toBeUndefined();
  });

  it('forgets a session once every process of it has exited', async () => {
    const ps = machine();
    const sampler = new TreeSampler(ps.run, () => 0);
    await sampler.sample([{ pid: 200, sessionKey: 'A' }], 'n1');
    ps.remove(200).remove(300).remove(400);
    expect((await sampler.sample([], 'n1')).sessions).toEqual([]);
    expect(sampler.hasWork([])).toBe(false);
  });

  it('a pid reused between the two ps calls (its parent differs) is not counted nor remembered', async () => {
    const ps = machine();
    // Call 1 sees 400 under bash 300; by call 2 that 400 exited and an unrelated program got the pid.
    const run = ps.run;
    let calls = 0;
    const racing = async (args: readonly string[]) => {
      calls++;
      if (calls === 2) ps.set(400, { ppid: 1, args: '/usr/bin/someone-else', start: 'Tue Nov 24 08:00:00 2026' });
      return run(args);
    };
    const s2 = new TreeSampler(racing, () => 0);
    const out = await s2.sample([{ pid: 200, sessionKey: 'A' }], 'n1');
    expect(out.sessions[0].processes.map((p) => p.pid)).toEqual([200, 300]);
    expect(s2.rememberedStart('A', 400)).toBeUndefined();
  });

  it('a remembered process re-parented between the two ps calls stays', async () => {
    const ps = machine();
    const run = ps.run;
    let calls = 0;
    let reparent = false;
    const racing = async (args: readonly string[]) => {
      calls++;
      if (reparent && args[0] === '-ww') ps.reparent(400, 1);
      return run(args);
    };
    const sampler = new TreeSampler(racing, () => 0);
    await sampler.sample([{ pid: 200, sessionKey: 'A' }], 'n1');
    reparent = true;
    const out = await sampler.sample([{ pid: 200, sessionKey: 'A' }], 'n1');
    expect(out.sessions[0].processes.map((p) => p.pid)).toContain(400);
    expect(calls).toBe(4);
  });

  it('takes finer CPU seconds when the platform reader has them (Linux /proc)', async () => {
    const ps = machine();
    let now = 0;
    let fine = 10;
    const sampler = new TreeSampler(
      ps.run,
      () => now,
      async (pids) => new Map(pids.filter((p) => p === 400).map((p) => [p, fine])),
    );
    await sampler.sample([{ pid: 200, sessionKey: 'A' }], 'n1');
    now += 5_000;
    fine += 0.37; // ps time would still read whole seconds; /proc says 0.37 s in 5 s = 7.4%
    const out = await sampler.sample([{ pid: 200, sessionKey: 'A' }], 'n1');
    expect(out.sessions[0].processes.find((p) => p.pid === 400)?.cpuPercent).toBe(7.4);
  });

  it('an orphan whose detail row is missing once is still remembered, and comes back with its session (round 8)', async () => {
    const ps = machine();
    let hide = false;
    const run = async (a: readonly string[]) => {
      const out = await ps.run(a);
      if (!hide || a[0] === '-A') return out;
      return out
        .split('\n')
        .filter((line) => line.trim().split(/\s+/)[0] !== '300')
        .join('\n');
    };
    let now = 1_000;
    const sampler = new TreeSampler(run, () => now);
    await sampler.sample([{ pid: 200, sessionKey: 'A' }], 'n1');
    // Claude Code exits; bash 300 is re-parented. One sample loses 300's row (ps skipped it).
    ps.remove(200).reparent(300, 1);
    hide = true;
    now += 5_000;
    const gap = await sampler.sample([], 'n1');
    expect(gap.sessions.find((s) => s.sessionKey === 'A')?.processes.map((p) => p.pid) ?? []).not.toContain(300);
    expect(sampler.rememberedAnywhere(300, 'Mon Nov 23 10:00:00 2026')).toBe(true);
    hide = false;
    now += 5_000;
    const back = await sampler.sample([], 'n1');
    expect(back.sessions.find((s) => s.sessionKey === 'A')?.processes.map((p) => [p.pid, p.role])).toEqual([
      [300, 'orphan'],
      [400, 'child'],
    ]);
  });

  it('a remembered process that left the parent map is gone and not carried', async () => {
    const ps = machine();
    let now = 1_000;
    const sampler = new TreeSampler(ps.run, () => now);
    await sampler.sample([{ pid: 200, sessionKey: 'A' }], 'n1');
    ps.remove(200).remove(300).remove(400);
    now += 5_000;
    await sampler.sample([], 'n1');
    expect(sampler.rememberedAnywhere(300, 'Mon Nov 23 10:00:00 2026')).toBe(false);
    expect(sampler.hasWork([])).toBe(false);
  });

  it('reads details in batches: a failing batch costs only its rows; all failing fails the sample', async () => {
    const ps = new FakePs().set(100, { ppid: 1, args: 'node soma' }).set(200, { ppid: 100, args: 'claude' });
    for (let i = 0; i < 450; i++) ps.set(1_000 + i, { ppid: 200, args: '/bin/sleep 9' });
    let failFirst = false;
    let failAll = false;
    let batch = 0;
    const run = async (a: readonly string[]) => {
      if (a[0] !== '-A') {
        batch++;
        if (failAll || (failFirst && batch === 1)) throw new Error('ps: output too large');
      }
      return ps.run(a);
    };
    const sampler = new TreeSampler(run, () => 1_000);
    const full = await sampler.sample([{ pid: 200, sessionKey: 'A' }], 'n1');
    expect(batch).toBe(3); // 451 pids, 200 per call
    expect(full.sessions[0].processCount).toBe(451);

    failFirst = true;
    batch = 0;
    const partial = await sampler.sample([{ pid: 200, sessionKey: 'A' }], 'n1');
    expect(partial.sessions[0].processCount).toBe(251);

    failAll = true;
    await expect(sampler.sample([{ pid: 200, sessionKey: 'A' }], 'n1')).rejects.toThrow('output too large');
  });

  it('reports stopped processes', async () => {
    const ps = machine();
    (ps.procs.get(400) as { stat: string }).stat = 'T';
    const sampler = new TreeSampler(ps.run, () => 0);
    const out = await sampler.sample([{ pid: 200, sessionKey: 'A' }], 'n1');
    expect(out.sessions[0].stoppedCount).toBe(1);
    expect(out.sessions[0].processes.find((p) => p.pid === 400)?.state).toBe('stopped');
  });

  it('never gives one process to two sessions — a live tree wins over a memory', async () => {
    const ps = machine();
    const sampler = new TreeSampler(ps.run, () => 0);
    await sampler.sample([{ pid: 200, sessionKey: 'A' }], 'n1');
    // Session B's new claude adopts 400 (contrived: a re-parent onto a tracked root).
    ps.set(500, { ppid: 100, args: '/usr/local/bin/claude' }).reparent(400, 500).remove(300);
    const out = await sampler.sample(
      [
        { pid: 200, sessionKey: 'A' },
        { pid: 500, sessionKey: 'B' },
      ],
      'n1',
    );
    const owners = out.sessions.flatMap((s) => s.processes.filter((p) => p.pid === 400).map(() => s.sessionKey));
    expect(owners).toEqual(['B']);
  });
});
