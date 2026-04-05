import { describe, expect, it } from 'vitest';
import { decodeSlackEntities } from './dispatch-service';

describe('decodeSlackEntities', () => {
  it('decodes &gt; to >', () => {
    expect(decodeSlackEntities('foo &gt; bar')).toBe('foo > bar');
  });

  it('decodes &lt; to <', () => {
    expect(decodeSlackEntities('foo &lt; bar')).toBe('foo < bar');
  });

  it('decodes &amp; to &', () => {
    expect(decodeSlackEntities('foo &amp; bar')).toBe('foo & bar');
  });

  it('decodes all entities in a single string', () => {
    expect(decodeSlackEntities('a &lt; b &amp;&amp; b &gt; c')).toBe('a < b && b > c');
  });

  it('handles double-encoded &amp;gt; correctly (single pass only)', () => {
    // &amp;gt; should become &gt; (not >)
    expect(decodeSlackEntities('&amp;gt;')).toBe('&gt;');
  });

  it('handles double-encoded &amp;lt; correctly (single pass only)', () => {
    expect(decodeSlackEntities('&amp;lt;')).toBe('&lt;');
  });

  it('handles double-encoded &amp;amp; correctly (single pass only)', () => {
    expect(decodeSlackEntities('&amp;amp;')).toBe('&amp;');
  });

  it('returns the same string when no entities present', () => {
    expect(decodeSlackEntities('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(decodeSlackEntities('')).toBe('');
  });

  it('handles multiple occurrences', () => {
    expect(decodeSlackEntities('&gt;&gt;&gt; blockquote')).toBe('>>> blockquote');
  });
});
