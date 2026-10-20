/**
 * Behavioral tests for send_file / send_media upload helpers.
 *
 * validateFilePath runs against the real filesystem; getMediaType and ALLOWED_MEDIA_EXTENSIONS
 * are the real exports of helpers/file-validator.ts.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALLOWED_MEDIA_EXTENSIONS, getMediaType, validateFilePath } from './helpers/file-validator.js';

// ── validateFilePath tests (real filesystem) ──────────────────

describe('validateFilePath — real filesystem', () => {
  let tmpDir: string;

  beforeAll(async () => {
    // Use /tmp directly (not os.tmpdir() which may be /var/folders on macOS)
    // because validateFilePath restricts uploads to /tmp root
    tmpDir = await fs.mkdtemp(path.join('/tmp', 'slack-mcp-test-'));
  });

  afterAll(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it('accepts a valid file under /tmp', async () => {
    const filePath = path.join(tmpDir, 'valid.txt');
    await fs.writeFile(filePath, 'hello world');
    const result = await validateFilePath(filePath);
    expect(result.resolvedPath).toBe(filePath);
    expect(result.size).toBe(11);
  });

  it('rejects empty file_path', async () => {
    await expect(validateFilePath('')).rejects.toThrow('file_path is required');
  });

  it('rejects file outside /tmp (e.g. /etc/passwd)', async () => {
    await expect(validateFilePath('/etc/passwd')).rejects.toThrow('Upload restricted to /tmp directory');
  });

  it('rejects path with .. segments', async () => {
    const traversal = path.join(tmpDir, '..', '..', 'etc', 'passwd');
    await expect(validateFilePath(traversal)).rejects.toThrow(/traversal|restricted/i);
  });

  it('allows filenames containing double dots (report..txt)', async () => {
    const filePath = path.join(tmpDir, 'report..txt');
    await fs.writeFile(filePath, 'data');
    const result = await validateFilePath(filePath);
    expect(result.resolvedPath).toBe(filePath);
  });

  it('rejects nonexistent file', async () => {
    const filePath = path.join(tmpDir, 'does-not-exist.txt');
    await expect(validateFilePath(filePath)).rejects.toThrow('File not found');
  });

  it('rejects a directory', async () => {
    const dirPath = path.join(tmpDir, 'subdir');
    await fs.mkdir(dirPath, { recursive: true });
    await expect(validateFilePath(dirPath)).rejects.toThrow('Not a regular file');
  });

  it('rejects symlinks', async () => {
    const realFile = path.join(tmpDir, 'real.txt');
    const linkFile = path.join(tmpDir, 'link.txt');
    await fs.writeFile(realFile, 'real');
    await fs.symlink(realFile, linkFile);
    await expect(validateFilePath(linkFile)).rejects.toThrow('Symlinks not allowed');
  });
});

// ── Media type validation ─────────────────────────────────────

describe('Media type classification', () => {
  it('classifies image extensions correctly', () => {
    expect(getMediaType('png')).toBe('image');
    expect(getMediaType('jpg')).toBe('image');
    expect(getMediaType('gif')).toBe('image');
    expect(getMediaType('webp')).toBe('image');
  });

  it('classifies audio extensions correctly', () => {
    expect(getMediaType('mp3')).toBe('audio');
    expect(getMediaType('wav')).toBe('audio');
    expect(getMediaType('flac')).toBe('audio');
  });

  it('classifies video extensions correctly', () => {
    expect(getMediaType('mp4')).toBe('video');
    expect(getMediaType('mov')).toBe('video');
    expect(getMediaType('webm')).toBe('video');
  });

  it('returns null for non-media extensions', () => {
    expect(getMediaType('txt')).toBeNull();
    expect(getMediaType('pdf')).toBeNull();
    expect(getMediaType('zip')).toBeNull();
  });

  it('rejects non-media extensions from ALLOWED set', () => {
    expect(ALLOWED_MEDIA_EXTENSIONS.has('txt')).toBe(false);
    expect(ALLOWED_MEDIA_EXTENSIONS.has('exe')).toBe(false);
    expect(ALLOWED_MEDIA_EXTENSIONS.has('sh')).toBe(false);
  });

  it('accepts all specified media extensions', () => {
    const allMedia = [
      'jpg',
      'jpeg',
      'png',
      'gif',
      'webp',
      'svg',
      'bmp',
      'ico',
      'tiff',
      'tif',
      'heic',
      'heif',
      'avif',
      'mp3',
      'wav',
      'ogg',
      'flac',
      'm4a',
      'aac',
      'wma',
      'mp4',
      'mov',
      'avi',
      'mkv',
      'webm',
      'wmv',
      'm4v',
      'mpg',
      'mpeg',
      '3gp',
    ];
    for (const ext of allMedia) {
      expect(ALLOWED_MEDIA_EXTENSIONS.has(ext)).toBe(true);
    }
  });
});
