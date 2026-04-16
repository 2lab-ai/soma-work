import { describe, expect, it } from 'vitest';
import {
  ALLOWLIST_AI_APIS,
  ALLOWLIST_ANTHROPIC,
  ALLOWLIST_CLOUD,
  ALLOWLIST_GIT_HOSTING,
  ALLOWLIST_IDE,
  ALLOWLIST_LINUX_DISTROS,
  ALLOWLIST_NODE,
  ALLOWLIST_OTHER_LANGS,
  ALLOWLIST_PYTHON,
  ALLOWLIST_REGISTRIES,
  DEV_DOMAIN_ALLOWLIST,
} from './dev-domain-allowlist';

describe('DEV_DOMAIN_ALLOWLIST', () => {
  // Pattern matches: "example.com", "*.example.com", "sub.example.com" — but NOT
  // leading "*" without a dot, schemes, paths, spaces, or uppercase letters.
  const DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

  it('is non-empty', () => {
    expect(DEV_DOMAIN_ALLOWLIST.length).toBeGreaterThan(0);
  });

  it('contains only uniquely-named domains', () => {
    const set = new Set(DEV_DOMAIN_ALLOWLIST);
    expect(set.size).toBe(DEV_DOMAIN_ALLOWLIST.length);
  });

  it.each(DEV_DOMAIN_ALLOWLIST.slice())('entry %s matches the domain format', (domain) => {
    expect(domain).toMatch(DOMAIN_RE);
  });

  it('all entries are lowercase', () => {
    const uppercased = DEV_DOMAIN_ALLOWLIST.filter((d) => d !== d.toLowerCase());
    expect(uppercased).toEqual([]);
  });

  it('no entry has a scheme, path, or trailing dot', () => {
    const bad = DEV_DOMAIN_ALLOWLIST.filter(
      (d) => d.includes('://') || d.includes('/') || d.endsWith('.') || d.includes(' '),
    );
    expect(bad).toEqual([]);
  });

  it('covers the core categories', () => {
    // Anthropic
    expect(DEV_DOMAIN_ALLOWLIST).toContain('api.anthropic.com');
    // Git
    expect(DEV_DOMAIN_ALLOWLIST).toContain('github.com');
    expect(DEV_DOMAIN_ALLOWLIST).toContain('*.githubusercontent.com');
    // Node / Python / Rust / Go
    expect(DEV_DOMAIN_ALLOWLIST).toContain('registry.npmjs.org');
    expect(DEV_DOMAIN_ALLOWLIST).toContain('pypi.org');
    expect(DEV_DOMAIN_ALLOWLIST).toContain('crates.io');
    expect(DEV_DOMAIN_ALLOWLIST).toContain('proxy.golang.org');
    // Cloud
    expect(DEV_DOMAIN_ALLOWLIST).toContain('*.amazonaws.com');
    expect(DEV_DOMAIN_ALLOWLIST).toContain('*.googleapis.com');
    // AI
    expect(DEV_DOMAIN_ALLOWLIST).toContain('api.openai.com');
    expect(DEV_DOMAIN_ALLOWLIST).toContain('huggingface.co');
  });

  it('flat list deduplicates entries that appear in multiple categories', () => {
    // Build a concatenation that allows duplicates; the flat list is a Set,
    // so its length must be <= the concat length.
    const concat = [
      ...ALLOWLIST_ANTHROPIC,
      ...ALLOWLIST_GIT_HOSTING,
      ...ALLOWLIST_REGISTRIES,
      ...ALLOWLIST_NODE,
      ...ALLOWLIST_PYTHON,
      ...ALLOWLIST_OTHER_LANGS,
      ...ALLOWLIST_LINUX_DISTROS,
      ...ALLOWLIST_CLOUD,
      ...ALLOWLIST_AI_APIS,
      ...ALLOWLIST_IDE,
    ];
    expect(DEV_DOMAIN_ALLOWLIST.length).toBeLessThanOrEqual(concat.length);
    // And every entry in a category shows up in the flat list.
    for (const d of concat) {
      expect(DEV_DOMAIN_ALLOWLIST).toContain(d);
    }
  });
});
