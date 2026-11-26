/**
 * Lane names and `config.json#workQueues` (.prd/36 v2 D11): lanes need no configuration; the config only pins them.
 */
import { describe, expect, it } from 'vitest';
import { isQueueName, normalizeQueueName, parseWorkQueuesConfig } from './config';

describe('normalizeQueueName', () => {
  it('keeps a lane name as its one spelling: lower case, trimmed', () => {
    expect(normalizeQueueName(' QA-Dev2 ')).toBe('qa-dev2');
    expect(normalizeQueueName('release.train_1')).toBe('release.train_1');
  });
  it('reads the v1 `<lane>:<env>` form as `<lane>-<env>`, the environment without a deploy branch prefix', () => {
    expect(normalizeQueueName('qa:dev2')).toBe('qa-dev2');
    expect(normalizeQueueName('deploy:deploy/dev2')).toBe('deploy-dev2');
    expect(normalizeQueueName('deploy:refs/heads/deploy/DEV2')).toBe('deploy-dev2');
  });
});

describe('isQueueName', () => {
  it('a short lower-case name', () => {
    expect(isQueueName('qa-dev2')).toBe(true);
    expect(isQueueName('a')).toBe(true);
    expect(isQueueName('')).toBe(false);
    expect(isQueueName('-qa')).toBe(false);
    expect(isQueueName('qa dev2')).toBe(false);
    expect(isQueueName('QA')).toBe(false);
    expect(isQueueName('x'.repeat(49))).toBe(false);
  });
});

describe('parseWorkQueuesConfig — the lanes a host pins', () => {
  it('lane → environments pins `<lane>-<env>`, in order, each once', () => {
    expect(parseWorkQueuesConfig({ deploy: ['dev2', 'stage0'], qa: ['dev2', 'DEV2'] })).toEqual({
      queues: ['deploy-dev2', 'deploy-stage0', 'qa-dev2'],
      warnings: [],
    });
  });

  it('nothing configured pins nothing (lanes still work: they exist from their first entry)', () => {
    expect(parseWorkQueuesConfig(undefined)).toEqual({ queues: [], warnings: [] });
    expect(parseWorkQueuesConfig([])).toEqual({ queues: [], warnings: [] });
  });

  it('skips a bad name or shape with a warning', () => {
    const { queues, warnings } = parseWorkQueuesConfig({ qa: ['dev', 'bad name'], 'x y': ['dev'], deploy: 'dev' });
    expect(queues).toEqual(['qa-dev']);
    expect(warnings).toHaveLength(3);
  });

  it('reads the #726 array form with a warning', () => {
    const { queues, warnings } = parseWorkQueuesConfig([
      { id: 'deploy-dev2', workflow: 'deploy', targets: ['deploy/dev2', 'refs/heads/deploy/stage0'] },
    ]);
    expect(queues).toEqual(['deploy-dev2', 'deploy-stage0']);
    expect(warnings.join(' ')).toMatch(/old array form/);
  });

  it('anything else pins nothing, with a warning', () => {
    expect(parseWorkQueuesConfig('deploy')).toEqual({ queues: [], warnings: [expect.stringMatching(/workQueues/)] });
  });
});
