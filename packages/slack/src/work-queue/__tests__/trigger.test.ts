import { describe, expect, it } from 'vitest';
import { parseWorkQueuesConfig } from '../config';
import { matchWorkQueue, normalizeRepo, normalizeTargetBranch, parseDeployTrigger } from '../trigger';

// ssot-task T1/T3: the host must recognise which deploys belong to a queue
// without asking the model — the trigger text is the only signal it has before
// the deploy turn starts.

describe('parseDeployTrigger', () => {
  it('reads the colon form the requester uses (`Projalpha: develop -> deploy/dev2`)', () => {
    expect(parseDeployTrigger('Projalpha: develop -> deploy/dev2')).toEqual({
      repos: ['Projalpha'],
      source: 'develop',
      target: 'deploy/dev2',
    });
  });

  it('decodes the Slack-escaped arrow (`-&gt;`) the message event carries', () => {
    expect(parseDeployTrigger('Projalpha develop-&gt;deploy/dev2')).toEqual({
      repos: ['Projalpha'],
      source: 'develop',
      target: 'deploy/dev2',
    });
  });

  it('accepts the `deploy` keyword, owner/repo, comma lists and the unicode arrow', () => {
    expect(parseDeployTrigger('deploy acme/Projalpha, other develop → dev2')).toEqual({
      repos: ['acme/Projalpha', 'other'],
      source: 'develop',
      target: 'dev2',
    });
  });

  it('drops a leading Slack mention and trailing Korean words after the target', () => {
    expect(parseDeployTrigger('<@U123ABC> Projalpha develop -> deploy/dev2로 배포해줘')).toEqual({
      repos: ['Projalpha'],
      source: 'develop',
      target: 'deploy/dev2',
    });
  });

  it('returns undefined when there is no arrow or no source', () => {
    expect(parseDeployTrigger('dev2 장애 봐줘')).toBeUndefined();
    expect(parseDeployTrigger('-> dev2')).toBeUndefined();
    expect(parseDeployTrigger('')).toBeUndefined();
  });
});

describe('normalizers', () => {
  it('treats `dev2`, `deploy/dev2` and `refs/heads/deploy/dev2` as one target', () => {
    expect(normalizeTargetBranch('deploy/dev2')).toBe('dev2');
    expect(normalizeTargetBranch('DEV2')).toBe('dev2');
    expect(normalizeTargetBranch('refs/heads/deploy/dev2')).toBe('dev2');
  });

  it('compares repos by their last path segment, case-insensitively', () => {
    expect(normalizeRepo('acme/Projalpha')).toBe('projalpha');
    expect(normalizeRepo('Projalpha.git')).toBe('projalpha');
  });
});

describe('matchWorkQueue', () => {
  const { queues } = parseWorkQueuesConfig(undefined);

  it('puts a dev2 deploy in the default dev2 queue, whatever the repo or source', () => {
    expect(matchWorkQueue(queues, 'deploy', 'Projalpha: develop -> deploy/dev2')?.id).toBe('deploy-dev2');
    expect(matchWorkQueue(queues, 'deploy', 'other main -> dev2')?.id).toBe('deploy-dev2');
  });

  it('leaves other targets and other workflows alone', () => {
    expect(matchWorkQueue(queues, 'deploy', 'Projalpha develop -> deploy/dev3')).toBeUndefined();
    expect(matchWorkQueue(queues, 'default', 'Projalpha develop -> deploy/dev2')).toBeUndefined();
    expect(matchWorkQueue(queues, undefined, 'Projalpha develop -> deploy/dev2')).toBeUndefined();
  });

  it('falls back to a whole-word target scan when a deploy request has no arrow', () => {
    expect(matchWorkQueue(queues, 'deploy', 'Projalpha develop 브랜치를 dev2에 배포해줘')?.id).toBe('deploy-dev2');
    expect(matchWorkQueue(queues, 'deploy', 'Projalpha develop 브랜치를 dev20에 배포해줘')).toBeUndefined();
  });

  it('honours a repo filter when the queue sets one', () => {
    const scoped = parseWorkQueuesConfig([
      { id: 'g', workflow: 'deploy', targets: ['deploy/dev2'], repos: ['Projalpha'] },
    ]).queues;
    expect(matchWorkQueue(scoped, 'deploy', 'acme/projalpha develop -> dev2')?.id).toBe('g');
    expect(matchWorkQueue(scoped, 'deploy', 'other develop -> dev2')).toBeUndefined();
  });
});
