import { describe, expect, it } from 'vitest';
import { getCommandHelp } from './command-help';
import { GET_SESSION_MAX_WAIT_MS } from './host-receipt';
import { validateModelCommandRunArgs } from './validator';

/**
 * #881 A — the host applies an UPDATE_SESSION about 20 s after the model got its result (its stream processing waits
 * behind Slack-rate-limited posts), so one immediate re-read reports an applied write as unconfirmed. GET_SESSION takes
 * `waitForAckMs`: the model-command server waits up to that long for the host's ack of its own last write.
 */
describe('GET_SESSION waitForAckMs', () => {
  const run = (params: unknown) => validateModelCommandRunArgs({ commandId: 'GET_SESSION', params });

  it('no params, or empty params, is still a plain read', () => {
    for (const params of [undefined, {}]) {
      const r = run(params);
      expect(r.ok).toBe(true);
      expect(r.ok && r.request.commandId === 'GET_SESSION' ? r.request.params : 'x').toBeUndefined();
    }
  });

  it('refuses keys it does not know, as its schema says (fable · grok R1 P3)', () => {
    const r = run({ waitForAckMs: 1_000, foo: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/foo/);
  });

  it('takes a wait in milliseconds, capped at the maximum', () => {
    const r = run({ waitForAckMs: 20_000 });
    expect(r.ok && r.request.commandId === 'GET_SESSION' ? r.request.params?.waitForAckMs : null).toBe(20_000);
    const capped = run({ waitForAckMs: 10 * 60_000 });
    expect(capped.ok && capped.request.commandId === 'GET_SESSION' ? capped.request.params?.waitForAckMs : null).toBe(
      GET_SESSION_MAX_WAIT_MS,
    );
    expect(GET_SESSION_MAX_WAIT_MS).toBe(30_000);
  });

  it('refuses a wait that is not a non-negative number, with help', () => {
    for (const bad of ['30s', -1, Number.NaN, null]) {
      const r = run({ waitForAckMs: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('INVALID_ARGS');
        expect(r.error.message).toMatch(/waitForAckMs/);
        expect((r.error.details as { help?: { commandId?: string } } | undefined)?.help?.commandId).toBe('GET_SESSION');
      }
    }
  });

  it('GET_SESSION has help that shows the wait', () => {
    const help = getCommandHelp('GET_SESSION');
    expect(help?.examples.some((e) => (e.params as { waitForAckMs?: number }).waitForAckMs === 30_000)).toBe(true);
  });
});
