/**
 * `config.json#workQueues` (.prd/36 §4.4): lane → environments; queue id `<lane>:<env>`.
 */
import { describe, expect, it } from 'vitest';
import { normalizeQueueId, parseWorkQueuesConfig } from './config';

describe('parseWorkQueuesConfig', () => {
  it('reads lane → environments into `<lane>:<env>` queues, in order', () => {
    expect(parseWorkQueuesConfig({ deploy: ['dev2', 'stage0'], qa: ['dev2'] })).toEqual({
      queues: [
        { id: 'deploy:dev2', lane: 'deploy', env: 'dev2' },
        { id: 'deploy:stage0', lane: 'deploy', env: 'stage0' },
        { id: 'qa:dev2', lane: 'qa', env: 'dev2' },
      ],
      warnings: [],
    });
  });

  it('no key means no queues', () => {
    expect(parseWorkQueuesConfig(undefined)).toEqual({ queues: [], warnings: [] });
  });

  it('lower-cases names, drops duplicates, and warns on a bad lane or environment', () => {
    const { queues, warnings } = parseWorkQueuesConfig({
      QA: ['Dev', 'dev', 'bad name'],
      'x y': ['dev'],
      deploy: 'dev',
    });
    expect(queues).toEqual([{ id: 'qa:dev', lane: 'qa', env: 'dev' }]);
    expect(warnings).toHaveLength(3);
  });

  it('reads the old array form (#726): workflow → lane, targets → environments, with a warning', () => {
    const { queues, warnings } = parseWorkQueuesConfig([
      { id: 'deploy-dev2', workflow: 'deploy', targets: ['deploy/dev2', 'refs/heads/deploy/stage0'], concurrency: 1 },
    ]);
    expect(queues.map((q) => q.id)).toEqual(['deploy:dev2', 'deploy:stage0']);
    expect(warnings.join(' ')).toMatch(/old array form/);
  });

  it('anything else is no queues and a warning', () => {
    expect(parseWorkQueuesConfig('deploy')).toEqual({ queues: [], warnings: [expect.stringMatching(/workQueues/)] });
  });
});

describe('normalizeQueueId', () => {
  it('reads a queue name the way the config reads environments: lower case, no deploy/ or refs/heads/ prefix', () => {
    expect(normalizeQueueId('deploy:dev2')).toBe('deploy:dev2');
    expect(normalizeQueueId(' QA:Stage0 ')).toBe('qa:stage0');
    expect(normalizeQueueId('deploy:deploy/dev2')).toBe('deploy:dev2');
    expect(normalizeQueueId('deploy:refs/heads/deploy/DEV2')).toBe('deploy:dev2');
  });
  it('leaves a name without a lane as written (lower-cased) — the caller reports it unknown', () => {
    expect(normalizeQueueId('dev2')).toBe('dev2');
  });
});
