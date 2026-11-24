import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type ActiveUserTaskQueue, setActiveUserTaskQueue, userTaskSlotFree } from '../active';

// a shared dev host (2026-11-24): pr-watch's CI message lined up as a person's request and was replayed into a thread its
// owner had closed, after its PR merged. pr-watch now holds it in its own settled delivery (which drops a merged PR's
// message and a closed session's) until the owner has a free slot.
describe('userTaskSlotFree (pr-watch delivery)', () => {
  afterEach(() => setActiveUserTaskQueue(undefined));

  it('asks the queue for the owner; free when there is no queue, no owner, or the queue throws', () => {
    const asked: string[] = [];
    const make = (free: boolean | 'throw'): ActiveUserTaskQueue =>
      ({
        queue: {
          hasFreeSlot: (u: string, k: string) => {
            asked.push(`${u}|${k}`);
            if (free === 'throw') throw new Error('x');
            return free;
          },
        },
      }) as unknown as ActiveUserTaskQueue;
    expect(userTaskSlotFree('U1', 'C1:1')).toBe(true);
    setActiveUserTaskQueue(make(false));
    expect(userTaskSlotFree('U1', 'C1:1')).toBe(false);
    expect(asked).toEqual(['U1|C1:1']);
    expect(userTaskSlotFree(undefined, 'C1:1')).toBe(true);
    setActiveUserTaskQueue(make('throw'));
    expect(userTaskSlotFree('U1', 'C1:1')).toBe(true);
  });

  it('index.ts: pr-watch waits for the slot and marks what it injects as held for it (source)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'index.ts'), 'utf-8');
    const at = src.indexOf('const delivery = createSettledDelivery({');
    const block = src.slice(at, src.indexOf('prWatchDelivery = delivery;', at));
    expect(block).toContain('userTaskSlotFree(s.ownerId, sessionKey)');
    expect(block).toContain('userTaskReady: true');
  });
});
