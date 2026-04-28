import { describe, expect, it } from 'vitest';
import { defaultTabCache, TabCache, type TabCacheEntry } from '../usage-carousel-cache';

// Trace: docs/usage-card-dark/trace.md, Scenario 7

function makeEntry(expiresAt: number, userId = 'U_ALICE'): TabCacheEntry {
  return {
    fileIds: {
      '24h': 'F_24',
      '7d': 'F_7',
      '30d': 'F_30',
      all: 'F_ALL',
      models: 'F_MODELS',
    },
    userId,
    expiresAt,
  };
}

describe('TabCache', () => {
  it('set → get within TTL returns entry', () => {
    const t = 1_000_000;
    const cache = new TabCache({ now: () => t });
    const entry = makeEntry(t + 1000);
    cache.set('msg1', entry);
    expect(cache.get('msg1')).toBe(entry);
  });

  it('TTL expiry — get returns undefined and size is 0 (lazy purge)', () => {
    let t = 1_000_000;
    const cache = new TabCache({ now: () => t });
    cache.set('msg1', makeEntry(t + 1000));
    t += 2000;
    expect(cache.get('msg1')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('LRU eviction at cap — oldest evicted on overflow', () => {
    const t = 1_000_000;
    const cache = new TabCache({ cap: 3, now: () => t });
    cache.set('A', makeEntry(t + 10_000));
    cache.set('B', makeEntry(t + 10_000));
    cache.set('C', makeEntry(t + 10_000));
    cache.set('D', makeEntry(t + 10_000));
    expect(cache.size()).toBe(3);
    expect(cache.get('A')).toBeUndefined();
    expect(cache.get('B')).toBeDefined();
    expect(cache.get('C')).toBeDefined();
    expect(cache.get('D')).toBeDefined();
  });

  it('LRU on get — accessed entry moves to end', () => {
    const t = 1_000_000;
    const cache = new TabCache({ cap: 3, now: () => t });
    const a = makeEntry(t + 10_000);
    const b = makeEntry(t + 10_000);
    const c = makeEntry(t + 10_000);
    cache.set('A', a);
    cache.set('B', b);
    cache.set('C', c);
    // Touch A — now iteration order is B, C, A
    expect(cache.get('A')).toBe(a);
    cache.set('D', makeEntry(t + 10_000));
    // B is the oldest now → evicted
    expect(cache.get('B')).toBeUndefined();
    expect(cache.get('A')).toBe(a);
    expect(cache.get('C')).toBe(c);
    expect(cache.get('D')).toBeDefined();
  });

  it('re-set same key updates entry (no duplicate)', () => {
    const t = 1_000_000;
    const cache = new TabCache({ now: () => t });
    const e1 = makeEntry(t + 1000, 'U1');
    const e2 = makeEntry(t + 1000, 'U2');
    cache.set('X', e1);
    cache.set('X', e2);
    expect(cache.get('X')).toBe(e2);
    expect(cache.size()).toBe(1);
  });

  it('opportunistic eviction on set — purges expired within first 10 scanned', () => {
    let t = 1_000_000;
    const cache = new TabCache({ cap: 100, now: () => t });
    // Seed: 5 entries inserted while "now" is in the future relative to
    // their expiresAt. They become expired when we advance t.
    cache.set('expired1', makeEntry(t + 1000));
    cache.set('fresh1', makeEntry(t + 1_000_000));
    cache.set('expired2', makeEntry(t + 1000));
    cache.set('fresh2', makeEntry(t + 1_000_000));
    cache.set('expired3', makeEntry(t + 1000));
    expect(cache.size()).toBe(5);

    // Advance past the "expired*" entries but before the fresh ones.
    t += 5000;

    // 6th set() — opportunistic scan sees all 5 existing (<10) entries and
    // drops the 3 expired ones before inserting.
    cache.set('sixth', makeEntry(t + 1_000_000));
    expect(cache.get('expired1')).toBeUndefined();
    expect(cache.get('expired2')).toBeUndefined();
    expect(cache.get('expired3')).toBeUndefined();
    expect(cache.get('fresh1')).toBeDefined();
    expect(cache.get('fresh2')).toBeDefined();
    expect(cache.get('sixth')).toBeDefined();
    expect(cache.size()).toBe(3);
  });

  it('fresh cache — new TabCache() has size 0', () => {
    const cache = new TabCache();
    expect(cache.size()).toBe(0);
  });

  it('default now — uses Date.now() when not injected', () => {
    const cache = new TabCache();
    const entry = makeEntry(Date.now() + 60_000);
    cache.set('msgDefault', entry);
    expect(cache.get('msgDefault')).toBe(entry);
  });

  it('defaultTabCache is a TabCache instance', () => {
    expect(defaultTabCache).toBeInstanceOf(TabCache);
  });
});
