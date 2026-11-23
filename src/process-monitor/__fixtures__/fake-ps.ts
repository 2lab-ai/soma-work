/**
 * A process table and the two `ps` calls the sampler makes over it — the same
 * text layout BSD ps and procps print with `LC_ALL=C`.
 */
export interface FakeProc {
  ppid: number;
  stat?: string;
  /** `lstart` text, 5 tokens. */
  start?: string;
  /** cumulative CPU seconds */
  cpu?: number;
  rssKb?: number;
  psCpu?: number;
  args?: string;
}

export class FakePs {
  readonly procs = new Map<number, FakeProc>();
  readonly calls: string[][] = [];

  set(pid: number, p: FakeProc): this {
    this.procs.set(pid, p);
    return this;
  }

  remove(pid: number): this {
    this.procs.delete(pid);
    return this;
  }

  /** The OS re-parents an orphan. */
  reparent(pid: number, ppid: number): this {
    const p = this.procs.get(pid);
    if (p) p.ppid = ppid;
    return this;
  }

  readonly run = async (args: readonly string[]): Promise<string> => {
    this.calls.push([...args]);
    if (args[0] === '-A') {
      return [...this.procs].map(([pid, p]) => `${String(pid).padStart(6)} ${String(p.ppid).padStart(6)}`).join('\n');
    }
    const list = String(args[args.indexOf('-p') + 1] ?? '')
      .split(',')
      .map(Number);
    return list
      .filter((pid) => this.procs.has(pid))
      .map((pid) => {
        const p = this.procs.get(pid) as FakeProc;
        const cpu = p.cpu ?? 0;
        const time = `${Math.floor(cpu / 60)}:${(cpu % 60).toFixed(2).padStart(5, '0')}`;
        return `${String(pid).padStart(6)} ${String(p.ppid).padStart(6)} ${(p.stat ?? 'S').padEnd(4)} ${p.start ?? 'Mon Nov 23 10:00:00 2026'} ${time.padStart(10)} ${String(p.psCpu ?? 0).padStart(5)} ${String(p.rssKb ?? 1000).padStart(8)} ${p.args ?? `/bin/proc${pid}`}`;
      })
      .join('\n');
  };
}
