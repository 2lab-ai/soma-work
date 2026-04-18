import { describe, expect, it } from 'vitest';
import { ZTopicRegistry } from '../../actions/z-settings-actions';
import { buildDefaultTopicRegistry, registerAllTopics } from './index';

const EXPECTED_TOPICS = [
  'bypass',
  'cct',
  'cwd',
  'email',
  'memory',
  'model',
  'notify',
  'persona',
  'sandbox',
  'theme',
  'usage',
  'verbosity',
];

describe('topics/index.registerAllTopics', () => {
  it('registers all Phase 2 topic bindings', () => {
    const registry = new ZTopicRegistry();
    registerAllTopics(registry);
    const topics = registry.topics().sort();
    expect(topics).toEqual([...EXPECTED_TOPICS].sort());
  });

  it('each binding exposes apply + renderCard', () => {
    const registry = new ZTopicRegistry();
    registerAllTopics(registry);
    for (const topic of EXPECTED_TOPICS) {
      const b = registry.get(topic);
      expect(b, `missing binding: ${topic}`).toBeDefined();
      expect(typeof b?.apply).toBe('function');
      expect(typeof b?.renderCard).toBe('function');
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
