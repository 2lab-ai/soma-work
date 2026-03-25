import { describe, expect, it } from 'vitest';
import { FileHandler, ProcessedFile } from './file-handler';

describe('FileHandler.formatFilePrompt — image path suppression', () => {
  const handler = new FileHandler();

  function makeImageFile(name = 'screenshot.png'): ProcessedFile {
    return {
      path: '/tmp/slack-file-12345-screenshot.png',
      name,
      mimetype: 'image/png',
      isImage: true,
      isText: false,
      size: 54321,
      tempPath: '/tmp/slack-file-12345-screenshot.png',
    };
  }

  function makeTextFile(): ProcessedFile {
    return {
      path: '/tmp/slack-file-12345-code.ts',
      name: 'code.ts',
      mimetype: 'text/typescript',
      isImage: false,
      isText: true,
      size: 200,
      tempPath: '/tmp/slack-file-12345-code.ts',
    };
  }

  function makePdfFile(): ProcessedFile {
    return {
      path: '/tmp/slack-file-12345-doc.pdf',
      name: 'doc.pdf',
      mimetype: 'application/pdf',
      isImage: false,
      isText: false,
      size: 100000,
      tempPath: '/tmp/slack-file-12345-doc.pdf',
    };
  }

  it('does NOT include Path for image files', async () => {
    const result = await handler.formatFilePrompt([makeImageFile()], '');

    // Must NOT contain the temp path — this is the structural prevention
    expect(result).not.toContain('/tmp/slack-file-12345-screenshot.png');
    expect(result).not.toMatch(/Path:/i);
    // Must still contain image metadata
    expect(result).toContain('screenshot.png');
    expect(result).toContain('image/png');
    expect(result).toContain('54321');
  });

  it('does NOT contain "Read tool" instruction for image files', async () => {
    const result = await handler.formatFilePrompt([makeImageFile()], '');

    expect(result).not.toContain('Read tool');
    expect(result).not.toContain('Read 도구');
  });

  it('includes Path for PDF files', async () => {
    const result = await handler.formatFilePrompt([makePdfFile()], 'check this');

    expect(result).toContain('/tmp/slack-file-12345-doc.pdf');
    expect(result).toContain('Path:');
  });

  it('uses default prompt when no text provided with image-only upload', async () => {
    const result = await handler.formatFilePrompt([makeImageFile()], '');

    expect(result).toContain('Please analyze the uploaded files');
    // Image metadata should be present
    expect(result).toContain('screenshot.png');
  });

  it('handles mixed image + non-image files correctly', async () => {
    const result = await handler.formatFilePrompt(
      [makeImageFile(), makePdfFile()],
      'analyze these'
    );

    // Image path should be suppressed
    expect(result).not.toContain('/tmp/slack-file-12345-screenshot.png');
    // PDF path should be present
    expect(result).toContain('/tmp/slack-file-12345-doc.pdf');
    // Both file names should be present
    expect(result).toContain('screenshot.png');
    expect(result).toContain('doc.pdf');
  });
});
