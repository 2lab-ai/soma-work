import { describe, expect, it } from 'vitest';
import { SourceWorkingDirDirectiveHandler } from '../source-working-dir-directive';

describe('SourceWorkingDirDirectiveHandler', () => {
  describe('extract', () => {
    it('should return null for plain text without directive', () => {
      const result = SourceWorkingDirDirectiveHandler.extract('Hello, this is a regular message.');
      expect(result.action).toBeNull();
      expect(result.path).toBeNull();
      expect(result.cleanedText).toBe('Hello, this is a regular message.');
    });

    it('should return null for empty text', () => {
      const result = SourceWorkingDirDirectiveHandler.extract('');
      expect(result.action).toBeNull();
      expect(result.path).toBeNull();
    });

    describe('json code blocks', () => {
      it('should extract directive from ```json block', () => {
        const text = `소스를 받았습니다.

\`\`\`json
{
  "type": "source_working_dir",
  "action": "add",
  "path": "/tmp/U123/20260323_guci_pr45"
}
\`\`\`

리뷰를 시작합니다.`;

        const result = SourceWorkingDirDirectiveHandler.extract(text);
        expect(result.action).toBe('add');
        expect(result.path).toBe('/tmp/U123/20260323_guci_pr45');
        expect(result.cleanedText).toBe('소스를 받았습니다.\n\n\n\n리뷰를 시작합니다.');
      });
    });

    describe('raw JSON', () => {
      it('should extract directive from raw JSON in text', () => {
        const text =
          '소스를 받았습니다. {"type": "source_working_dir", "action": "add", "path": "/tmp/U123/20260323_guci_pr45"} 리뷰를 시작합니다.';

        const result = SourceWorkingDirDirectiveHandler.extract(text);
        expect(result.action).toBe('add');
        expect(result.path).toBe('/tmp/U123/20260323_guci_pr45');
        expect(result.cleanedText).toContain('소스를 받았습니다.');
        expect(result.cleanedText).toContain('리뷰를 시작합니다.');
      });
    });

    describe('security', () => {
      it('should reject paths not starting with /tmp/', () => {
        const text = '{"type": "source_working_dir", "action": "add", "path": "/home/user/malicious"}';
        const result = SourceWorkingDirDirectiveHandler.extract(text);
        expect(result.action).toBeNull();
        expect(result.path).toBeNull();
      });

      it('should reject paths with path traversal', () => {
        const text = '{"type": "source_working_dir", "action": "add", "path": "/tmp/../../etc/passwd"}';
        const result = SourceWorkingDirDirectiveHandler.extract(text);
        expect(result.action).toBeNull();
        expect(result.path).toBeNull();
      });

      it('should reject relative paths', () => {
        const text = '{"type": "source_working_dir", "action": "add", "path": "tmp/relative/path"}';
        const result = SourceWorkingDirDirectiveHandler.extract(text);
        expect(result.action).toBeNull();
        expect(result.path).toBeNull();
      });
    });

    describe('macOS /private/tmp/', () => {
      it('should accept /private/tmp/ paths (macOS)', () => {
        const text = '{"type": "source_working_dir", "action": "add", "path": "/private/tmp/U123/20260323_guci_pr45"}';
        const result = SourceWorkingDirDirectiveHandler.extract(text);
        expect(result.action).toBe('add');
        expect(result.path).toBe('/private/tmp/U123/20260323_guci_pr45');
      });
    });

    describe('validation', () => {
      it('should reject non-add actions', () => {
        const text = '{"type": "source_working_dir", "action": "remove", "path": "/tmp/U123/dir"}';
        const result = SourceWorkingDirDirectiveHandler.extract(text);
        expect(result.action).toBeNull();
      });

      it('should reject missing path', () => {
        const text = '{"type": "source_working_dir", "action": "add"}';
        const result = SourceWorkingDirDirectiveHandler.extract(text);
        expect(result.action).toBeNull();
      });

      it('should reject wrong type', () => {
        const text = '{"type": "session_links", "action": "add", "path": "/tmp/U123/dir"}';
        const result = SourceWorkingDirDirectiveHandler.extract(text);
        expect(result.action).toBeNull();
      });

      it('should reject non-string path', () => {
        const text = '{"type": "source_working_dir", "action": "add", "path": 123}';
        const result = SourceWorkingDirDirectiveHandler.extract(text);
        expect(result.action).toBeNull();
      });

      it('should handle invalid JSON gracefully', () => {
        const text = '{"type": "source_working_dir", broken json}';
        const result = SourceWorkingDirDirectiveHandler.extract(text);
        expect(result.action).toBeNull();
      });
    });

    describe('text cleanup', () => {
      it('should strip directive and preserve surrounding text', () => {
        const text =
          'Before text.\n{"type": "source_working_dir", "action": "add", "path": "/tmp/U123/dir"}\nAfter text.';
        const result = SourceWorkingDirDirectiveHandler.extract(text);
        expect(result.action).toBe('add');
        expect(result.cleanedText).toContain('Before text.');
        expect(result.cleanedText).toContain('After text.');
        expect(result.cleanedText).not.toContain('source_working_dir');
      });

      it('should handle directive at start of text', () => {
        const text = '{"type": "source_working_dir", "action": "add", "path": "/tmp/U123/dir"}\nAfter.';
        const result = SourceWorkingDirDirectiveHandler.extract(text);
        expect(result.cleanedText).toBe('After.');
      });

      it('should handle directive at end of text', () => {
        const text = 'Before.\n{"type": "source_working_dir", "action": "add", "path": "/tmp/U123/dir"}';
        const result = SourceWorkingDirDirectiveHandler.extract(text);
        expect(result.cleanedText).toBe('Before.');
      });
    });
  });
});
