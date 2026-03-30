import { describe, it, expect } from 'vitest';
import { SessionLinkDirectiveHandler } from './session-link-directive';

describe('SessionLinkDirectiveHandler', () => {
  describe('extract', () => {
    it('should return null links for plain text without directives', () => {
      const result = SessionLinkDirectiveHandler.extract('Hello, this is a regular message.');
      expect(result.links).toBeNull();
      expect(result.cleanedText).toBe('Hello, this is a regular message.');
    });

    it('should return null links for empty text', () => {
      const result = SessionLinkDirectiveHandler.extract('');
      expect(result.links).toBeNull();
      expect(result.cleanedText).toBe('');
    });

    // JSON code block format tests
    describe('JSON code block format', () => {
      it('should extract Jira issue link from json code block', () => {
        const text = `PR created!

\`\`\`json
{
  "type": "session_links",
  "jira": "https://myteam.atlassian.net/browse/PTN-123"
}
\`\`\`

Done.`;

        const result = SessionLinkDirectiveHandler.extract(text);
        expect(result.links).not.toBeNull();
        expect(result.links!.issue).toEqual({
          url: 'https://myteam.atlassian.net/browse/PTN-123',
          type: 'issue',
          provider: 'jira',
          label: 'PTN-123',
        });
        expect(result.cleanedText).toBe('PR created!\n\n\n\nDone.');
      });

      it('should extract GitHub PR link from json code block', () => {
        const text = `\`\`\`json
{
  "type": "session_links",
  "pr": "https://github.com/org/repo/pull/42"
}
\`\`\``;

        const result = SessionLinkDirectiveHandler.extract(text);
        expect(result.links!.pr).toEqual({
          url: 'https://github.com/org/repo/pull/42',
          type: 'pr',
          provider: 'github',
          label: 'PR #42',
        });
        expect(result.cleanedText).toBe('');
      });

      it('should extract Confluence doc link from json code block', () => {
        const text = `\`\`\`json
{
  "type": "session_links",
  "doc": "https://myteam.atlassian.net/wiki/spaces/DEV/pages/123/My+Page"
}
\`\`\``;

        const result = SessionLinkDirectiveHandler.extract(text);
        expect(result.links!.doc).toEqual({
          url: 'https://myteam.atlassian.net/wiki/spaces/DEV/pages/123/My+Page',
          type: 'doc',
          provider: 'confluence',
          label: 'My Page',
        });
      });

      it('should extract all three link types at once', () => {
        const text = `\`\`\`json
{
  "type": "session_links",
  "jira": "https://myteam.atlassian.net/browse/PTN-456",
  "pr": "https://github.com/org/repo/pull/99",
  "doc": "https://myteam.atlassian.net/wiki/spaces/DEV/pages/789/Docs"
}
\`\`\``;

        const result = SessionLinkDirectiveHandler.extract(text);
        expect(result.links!.issue?.label).toBe('PTN-456');
        expect(result.links!.pr?.label).toBe('PR #99');
        expect(result.links!.doc?.label).toBe('Docs');
      });
    });

    // Raw JSON format tests
    describe('Raw JSON format', () => {
      it('should extract from raw JSON object', () => {
        const text = `Here is the summary.
{"type": "session_links", "pr": "https://github.com/org/repo/pull/10"}
What would you like to do next?`;

        const result = SessionLinkDirectiveHandler.extract(text);
        expect(result.links!.pr?.label).toBe('PR #10');
        expect(result.cleanedText).toBe('Here is the summary.\n\nWhat would you like to do next?');
      });

      it('should handle raw JSON with nested braces in URLs', () => {
        const text = `Done! {"type": "session_links", "jira": "https://myteam.atlassian.net/browse/ABC-1"}`;

        const result = SessionLinkDirectiveHandler.extract(text);
        expect(result.links!.issue?.label).toBe('ABC-1');
        expect(result.cleanedText).toBe('Done!');
      });

      it('should ignore other JSON objects (user_choice)', () => {
        const text = `{"type": "user_choice", "question": "What next?", "choices": ["A", "B"]}`;

        const result = SessionLinkDirectiveHandler.extract(text);
        expect(result.links).toBeNull();
        expect(result.cleanedText).toBe(text);
      });
    });

    // Provider detection tests
    describe('Provider detection', () => {
      it('should detect GitHub issue provider', () => {
        const text = `\`\`\`json
{
  "type": "session_links",
  "issue": "https://github.com/org/repo/issues/55"
}
\`\`\``;

        const result = SessionLinkDirectiveHandler.extract(text);
        expect(result.links!.issue?.provider).toBe('github');
        expect(result.links!.issue?.label).toBe('#55');
      });

      it('should detect Linear provider', () => {
        const text = `\`\`\`json
{
  "type": "session_links",
  "issue": "https://linear.app/myteam/issue/ENG-123"
}
\`\`\``;

        const result = SessionLinkDirectiveHandler.extract(text);
        expect(result.links!.issue?.provider).toBe('linear');
        expect(result.links!.issue?.label).toBe('ENG-123');
      });

      it('should detect unknown provider', () => {
        const text = `\`\`\`json
{
  "type": "session_links",
  "doc": "https://example.com/docs/page"
}
\`\`\``;

        const result = SessionLinkDirectiveHandler.extract(text);
        expect(result.links!.doc?.provider).toBe('unknown');
      });
    });

    // Edge cases
    describe('Edge cases', () => {
      it('should ignore invalid URLs', () => {
        const text = `\`\`\`json
{
  "type": "session_links",
  "pr": "not-a-url"
}
\`\`\``;

        const result = SessionLinkDirectiveHandler.extract(text);
        expect(result.links).toBeNull();
      });

      it('should ignore JSON with wrong type', () => {
        const text = `\`\`\`json
{
  "type": "something_else",
  "pr": "https://github.com/org/repo/pull/1"
}
\`\`\``;

        const result = SessionLinkDirectiveHandler.extract(text);
        expect(result.links).toBeNull();
      });

      it('should handle issue key as alias for jira', () => {
        const text = `\`\`\`json
{
  "type": "session_links",
  "issue": "https://myteam.atlassian.net/browse/PROJ-99"
}
\`\`\``;

        const result = SessionLinkDirectiveHandler.extract(text);
        expect(result.links!.issue?.label).toBe('PROJ-99');
        expect(result.links!.issue?.provider).toBe('jira');
      });

      it('should truncate long labels for unknown providers', () => {
        const text = `\`\`\`json
{
  "type": "session_links",
  "doc": "https://example.com/very/long/path/to/some/document/that/is/quite/lengthy"
}
\`\`\``;

        const result = SessionLinkDirectiveHandler.extract(text);
        expect(result.links!.doc?.label?.length).toBeLessThanOrEqual(40);
        expect(result.links!.doc?.label).toContain('...');
      });

      it('should handle malformed JSON gracefully', () => {
        const text = `\`\`\`json
{
  "type": "session_links",
  "pr": "https://github.com/org/repo/pull/1"
  // missing closing brace
\`\`\``;

        const result = SessionLinkDirectiveHandler.extract(text);
        expect(result.links).toBeNull();
      });

      it('should prefer code block over raw JSON when both present', () => {
        const text = `{"type": "session_links", "pr": "https://github.com/org/repo/pull/1"}
\`\`\`json
{
  "type": "session_links",
  "pr": "https://github.com/org/repo/pull/2"
}
\`\`\``;

        const result = SessionLinkDirectiveHandler.extract(text);
        // Code block is searched first, so PR #2 should be extracted
        expect(result.links!.pr?.label).toBe('PR #2');
      });
    });
  });
});
