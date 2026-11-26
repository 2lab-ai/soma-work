import { describe, expect, it } from 'vitest';
import { HOST_LAG_WARN_MS, ResultTransit } from '../result-transit';

/**
 * How far the host runs behind its Claude Code process, measured on the one
 * frame that matters for delivery: a turn `result`. From the moment the read-
 * ahead sees it until the frame loop handles it, a message pushed into the turn
 * is refused (#1227). On a busy host that gap reached about an hour, and nothing
 * in the log said so.
 */
describe('ResultTransit — how long a turn result waits for the host', () => {
  const clock = () => {
    let now = 1_000;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  };

  it('a result handled at once is no news', () => {
    const c = clock();
    const transit = new ResultTransit(c.now);
    transit.arrived();
    c.advance(200);

    expect(transit.handled()).toBeUndefined();
    expect(transit.inTransit).toBe(0);
  });

  it('a result that waited past the threshold is reported with the ones still waiting', () => {
    const c = clock();
    const transit = new ResultTransit(c.now);
    transit.arrived();
    c.advance(3_000);
    transit.arrived();
    c.advance(HOST_LAG_WARN_MS);

    expect(transit.handled()).toEqual({
      waitedMs: HOST_LAG_WARN_MS + 3_000,
      stillInTransit: 1,
      oldestInTransitMs: HOST_LAG_WARN_MS,
    });
  });

  it('results are handled in the order they arrived', () => {
    const c = clock();
    const transit = new ResultTransit(c.now);
    transit.arrived();
    c.advance(10_000);
    transit.arrived();
    c.advance(1_000);

    expect(transit.handled()?.waitedMs).toBe(11_000);
    expect(transit.handled()).toBeUndefined();
  });

  it('while the host is behind, the oldest waiting result is reported', () => {
    const c = clock();
    const transit = new ResultTransit(c.now);
    expect(transit.behind()).toBeUndefined();

    transit.arrived();
    c.advance(HOST_LAG_WARN_MS - 1);
    expect(transit.behind()).toBeUndefined();

    c.advance(60_000);
    expect(transit.behind()).toEqual({ oldestInTransitMs: HOST_LAG_WARN_MS - 1 + 60_000, stillInTransit: 1 });
  });

  it('a result the loop handles without an arrival on record changes nothing', () => {
    const transit = new ResultTransit(() => 0);
    expect(transit.handled()).toBeUndefined();
    expect(transit.inTransit).toBe(0);
  });
});
