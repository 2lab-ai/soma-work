import { describe, expect, it } from 'vitest';
import { ZTopicRegistry } from '../../../actions/z-settings-actions';
import { buildDefaultTopicRegistry, registerAllTopics } from '../index';

const EXPECTED_TOPICS = [
  'bypass',
  'auth',
  'cct',
  'cwd',
  'email',
  'goal',
  'memory',
  'model',
  'notify',
  'persona',
  'sandbox',
  'skill',
  'theme',
  'usage',
  'verbosity',
];

describe('topics/index.registerAllTopics', () => {
  it('registers every topic binding', () => {
    const registry = new ZTopicRegistry();
    registerAllTopics(registry);
    const topics = registry.topics().sort();
    expect(topics).toEqual([...EXPECTED_TOPICS].sort());
  });

  it('each binding renders a card; every settings topic also applies (the skill list has nothing to set)', () => {
    const registry = new ZTopicRegistry();
    registerAllTopics(registry);
    for (const topic of EXPECTED_TOPICS) {
      const b = registry.get(topic);
      expect(b, `missing binding: ${topic}`).toBeDefined();
      expect(typeof b?.renderCard).toBe('function');
      expect(typeof b?.apply).toBe(topic === 'skill' ? 'undefined' : 'function');
    }
  });

  it('is idempotent — re-registering overrides the prior binding', () => {
    const registry = new ZTopicRegistry();
    registerAllTopics(registry);
    registerAllTopics(registry);
    const topics = registry.topics().sort();
    expect(topics).toEqual([...EXPECTED_TOPICS].sort());
  });
});

describe('topics/index.buildDefaultTopicRegistry', () => {
  it('returns a populated registry in one call', () => {
    const registry = buildDefaultTopicRegistry();
    expect(registry.topics().sort()).toEqual([...EXPECTED_TOPICS].sort());
  });
});
