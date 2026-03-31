/**
 * Tests for structured repository context injection into system prompt.
 * Verifies that channel-registry repo info is correctly formatted
 * so the model can distinguish soma vs soma-work (and other repos).
 *
 * Issue: #228
 */

import { describe, expect, it } from 'vitest';
import { buildRepoContextBlock } from './claude-handler';

describe('buildRepoContextBlock', () => {
  it('builds block with single repo', () => {
    const result = buildRepoContextBlock(['2lab-ai/soma-work']);

    expect(result).toContain('<channel-repository>');
    expect(result).toContain('</channel-repository>');
    expect(result).toContain('https://github.com/2lab-ai/soma-work');
    expect(result).toContain('mapped to the following repository');
  });

  it('builds block with multiple repos', () => {
    const result = buildRepoContextBlock(['2lab-ai/soma', '2lab-ai/libsoma']);

    expect(result).toContain('https://github.com/2lab-ai/soma');
    expect(result).toContain('https://github.com/2lab-ai/libsoma');
    // Each repo on its own line prefixed with "- "
    expect(result).toMatch(/- https:\/\/github\.com\/2lab-ai\/soma\n/);
    expect(result).toMatch(/- https:\/\/github\.com\/2lab-ai\/libsoma/);
  });

  it('includes confluence URL when provided', () => {
    const result = buildRepoContextBlock(['2lab-ai/soma-work'], 'https://2lab.atlassian.net/wiki/spaces/DEV/overview');

    expect(result).toContain('Project wiki: https://2lab.atlassian.net/wiki/spaces/DEV/overview');
  });

  it('omits confluence URL when not provided', () => {
    const result = buildRepoContextBlock(['2lab-ai/soma-work']);

    expect(result).not.toContain('Project wiki');
  });

  it('distinguishes soma from soma-work correctly', () => {
    const somaBlock = buildRepoContextBlock(['2lab-ai/soma']);
    const somaWorkBlock = buildRepoContextBlock(['2lab-ai/soma-work']);

    // soma block should NOT contain soma-work
    expect(somaBlock).toContain('https://github.com/2lab-ai/soma');
    expect(somaBlock).not.toContain('soma-work');

    // soma-work block should contain soma-work
    expect(somaWorkBlock).toContain('https://github.com/2lab-ai/soma-work');
  });

  // --- Edge cases from Codex review ---

  it('builds block with confluenceUrl only (no repos)', () => {
    const result = buildRepoContextBlock([], 'https://2lab.atlassian.net/wiki/spaces/DEV/overview');

    expect(result).toContain('<channel-repository>');
    expect(result).toContain('</channel-repository>');
    expect(result).toContain('Project wiki: https://2lab.atlassian.net/wiki/spaces/DEV/overview');
    expect(result).not.toContain('mapped to the following repository');
  });

  it('handles pre-prefixed full GitHub URL gracefully', () => {
    const result = buildRepoContextBlock(['https://github.com/2lab-ai/soma-work']);

    // Should NOT double-prefix with https://github.com/
    expect(result).toContain('- https://github.com/2lab-ai/soma-work');
    expect(result).not.toContain('https://github.com/https://');
  });

  it('returns valid block with empty repos and no confluenceUrl', () => {
    const result = buildRepoContextBlock([]);

    expect(result).toContain('<channel-repository>');
    expect(result).toContain('</channel-repository>');
    expect(result).not.toContain('mapped to the following repository');
    expect(result).not.toContain('Project wiki');
  });
});
