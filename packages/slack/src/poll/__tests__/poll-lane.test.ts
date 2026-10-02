import { describe, expect, it } from 'vitest';
import { PollLane } from '../poll-lane';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('PollLane', () => {
  it('runs tasks for the same poll strictly in call order, even when the first awaits', async () => {
    const lane = new PollLane();
    const order: string[] = [];
    const a = lane.run('p1', async () => {
      order.push('a:start');
      await tick();
      await tick();
      order.push('a:end');
    });
    const b = lane.run('p1', async () => {
      order.push('b:start');
      order.push('b:end');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('does not serialize different polls against each other', async () => {
    const lane = new PollLane();
    const order: string[] = [];
    const a = lane.run('p1', async () => {
      await tick();
      await tick();
      order.push('p1');
    });
    const b = lane.run('p2', async () => {
      order.push('p2');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['p2', 'p1']);
  });

  it('a failing task does not block the next task and its error reaches its own caller', async () => {
    const lane = new PollLane();
    const failing = lane.run('p1', async () => {
      throw new Error('boom');
    });
    const next = lane.run('p1', async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('releases the lane slot once the tail settles (no leak per poll)', async () => {
    const lane = new PollLane();
    await lane.run('p1', async () => 1);
    await tick();
    expect(lane.size()).toBe(0);
  });
});
