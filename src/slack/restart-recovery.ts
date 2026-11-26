/**
 * .prd/39 S5 — this process's restart recovery, as named state. It used to be three loose fields on the handler (a
 * cut set, a resumed set and a "pass ran" flag) that every recovery path read differently.
 *
 *   BootPhase: recovering → live
 *     recovering — crash recovery recorded which turns the shutdown cut and which of them it resumed with the restart
 *                  prompt; the startup goal pass has not run yet.
 *     live       — the goal pass ran and read the records once: a later pass refunds nothing and kicks a session the
 *                  restart resumed like any other.
 */
export type BootPhase = 'recovering' | 'live';

export class RestartRecovery {
  /** Sessions whose turn the last shutdown cut short (`wasWorkingAtShutdown`) — a cut goal turn gives its count back. */
  readonly cut = new Set<string>();
  /** Cut sessions crash recovery resumed with the restart prompt: that resume turn carries them (one turn, never two). */
  readonly resumed = new Set<string>();
  private phase: BootPhase = 'recovering';

  get bootPhase(): BootPhase {
    return this.phase;
  }

  /** The startup goal pass ran: the records were read once and the boot is live. */
  passRan(): void {
    this.cut.clear();
    this.resumed.clear();
    this.phase = 'live';
  }
}
