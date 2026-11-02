import { describe, expect, it } from 'vitest';
import { DEFAULT_WORK_QUEUES, parseWorkQueuesConfig } from '../config';

// ssot-task T3: "이건 뭔가 설정할수 있어야" — the queue is data in config.json.
// T1: without any config the dev2 queue (concurrency 1) is on.

describe('parseWorkQueuesConfig', () => {
  it('applies the built-in dev2 queue when config.json has no workQueues key', () => {
    const { queues, warnings } = parseWorkQueuesConfig(undefined);
    expect(warnings).toEqual([]);
    expect(queues).toHaveLength(1);
    expect(queues[0]).toMatchObject({
      id: 'deploy-dev2',
      workflow: 'deploy',
      targets: ['dev2'],
      concurrency: 1,
      askTimeoutMs: 10 * 60_000,
    });
    expect(DEFAULT_WORK_QUEUES[0].id).toBe('deploy-dev2');
  });

  it('turns every queue off with an empty array', () => {
    expect(parseWorkQueuesConfig([]).queues).toEqual([]);
  });

  it('reads a configured queue with its own limits', () => {
    const { queues, warnings } = parseWorkQueuesConfig([
      {
        id: 'stage',
        label: 'stage deploy',
        workflow: 'deploy',
        targets: ['deploy/stage', 'stage2'],
        concurrency: 2,
        askTimeoutMinutes: 5,
        holderIdleMinutes: 30,
      },
    ]);
    expect(warnings).toEqual([]);
    expect(queues[0]).toEqual({
      id: 'stage',
      label: 'stage deploy',
      workflow: 'deploy',
      targets: ['stage', 'stage2'],
      repos: undefined,
      concurrency: 2,
      askTimeoutMs: 5 * 60_000,
      holderIdleMs: 30 * 60_000,
    });
  });

  it('skips a broken entry with a warning and keeps the good ones', () => {
    const { queues, warnings } = parseWorkQueuesConfig([
      { id: 'ok', workflow: 'deploy', targets: ['dev2'] },
      { id: 'no-targets', workflow: 'deploy', targets: [] },
      { id: 'ok', workflow: 'deploy', targets: ['dev3'] },
      { id: 'bad-concurrency', workflow: 'deploy', targets: ['dev4'], concurrency: 0 },
      'nonsense',
    ]);
    expect(queues.map((q) => q.id)).toEqual(['ok']);
    expect(warnings).toHaveLength(4);
  });

  it('keeps the built-in queue when workQueues is not an array, so a typo never removes the dev2 guard', () => {
    const { queues, warnings } = parseWorkQueuesConfig({ id: 'x' });
    expect(queues.map((q) => q.id)).toEqual(['deploy-dev2']);
    expect(warnings).toHaveLength(1);
  });
});
