import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeSlackEntities, getDispatchService, parseDispatchWorkSize } from '../dispatch-service';

describe('dispatch work size (epic switch on small work)', () => {
  it('parseDispatchWorkSize takes small / large only (any case, trimmed)', () => {
    expect(parseDispatchWorkSize('small')).toBe('small');
    expect(parseDispatchWorkSize(' Large ')).toBe('large');
    for (const raw of [undefined, null, '', 'medium', 1, {}, 'small-ish']) {
      expect(parseDispatchWorkSize(raw)).toBeUndefined();
    }
  });

  it('a dispatch answer carries its size; a missing or odd one is left out', () => {
    const svc = getDispatchService() as any;
    expect(svc.parseResponse('{"workflow":"default","title":"오타","size":"small"}', '오타 고쳐줘').size).toBe('small');
    expect(svc.parseResponse('{"workflow":"default","title":"전부","size":"large"}', '전부 다시').size).toBe('large');
    expect('size' in svc.parseResponse('{"workflow":"default","title":"x"}', 'x')).toBe(false);
    expect('size' in svc.parseResponse('{"workflow":"default","title":"x","size":"huge"}', 'x')).toBe(false);
  });

  it('the dispatch prompt asks for the size and defines small as one task or about 10 minutes', () => {
    const prompt = fs.readFileSync(path.join(__dirname, '..', 'prompt', 'dispatch.prompt'), 'utf-8');
    expect(prompt).toContain('## Work Size Estimate');
    expect(prompt).toContain('"size": "small | large"');
    expect(prompt).toMatch(/`small` — one task or less[^\n]*about 10 minutes/);
    expect(prompt).toContain('When unsure, choose `large`.');
  });
});

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
