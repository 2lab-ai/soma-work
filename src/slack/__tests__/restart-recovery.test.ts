/** .prd/39 S5 — the restart recovery's records and boot phase. */
import { describe, expect, it } from 'vitest';
import { RestartRecovery } from '../restart-recovery';

describe('RestartRecovery', () => {
  it('starts recovering, and the goal pass reads its records once and makes the boot live', () => {
    const recovery = new RestartRecovery();
    expect(recovery.bootPhase).toBe('recovering');
    recovery.cut.add('a');
    recovery.resumed.add('a');

    recovery.passRan();

    expect(recovery.bootPhase).toBe('live');
    expect(recovery.cut.size).toBe(0);
    expect(recovery.resumed.size).toBe(0);
  });
});
