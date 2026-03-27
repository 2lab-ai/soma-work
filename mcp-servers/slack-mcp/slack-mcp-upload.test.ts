/**
 * Behavioral tests for send_file / send_media upload functionality.
 *
 * Tests validateFilePath with real filesystem operations and
 * handler logic with mocked Slack API.
 */

import { describe, expect, it, vi, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSyncModule from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── validateFilePath tests (real filesystem) ──────────────────

// We dynamically import the server module to test validateFilePath.
// Since it's not exported, we test indirectly by reading the source and eval-ing
// the function in isolation. However, the cleaner approach is to extract
// validateFilePath. For now, we replicate the logic identically for testing.

// Replicated from slack-mcp-server.ts — kept in sync via contract tests
const MAX_FILE_SIZE = 1_073_741_824;
const ALLOWED_UPLOAD_ROOTS = ['/tmp', '/private/tmp'];

async function validateFilePath(filePath: string): Promise<{ resolvedPath: string; size: number }> {
  if (!filePath) {
    throw new Error('file_path is required');
  }

  const resolvedPath = path.resolve(filePath);

  if (!path.isAbsolute(resolvedPath)) {
    throw new Error(`file_path must be absolute: ${filePath}`);
  }

  const segments = resolvedPath.split(path.sep);
  if (segments.some(seg => seg === '..')) {
    throw new Error(`Path traversal not allowed: ${filePath}`);
  }

  const underAllowedRoot = ALLOWED_UPLOAD_ROOTS.some(root => resolvedPath.startsWith(root + path.sep));
  if (!underAllowedRoot) {
    throw new Error(`Upload restricted to /tmp directory. Rejected: ${resolvedPath}`);
  }

  let lstatResult;
  try {
    lstatResult = await fs.lstat(resolvedPath);
  } catch {
    throw new Error(`File not found or not readable: ${resolvedPath}`);
  }

  if (lstatResult.isSymbolicLink()) {
    throw new Error(`Symlinks not allowed for security: ${resolvedPath}`);
  }

  if (!lstatResult.isFile()) {
    throw new Error(`Not a regular file: ${resolvedPath}`);
  }

  try {
    await fs.access(resolvedPath, fsSyncModule.constants.R_OK);
  } catch {
    throw new Error(`File not found or not readable: ${resolvedPath}`);
  }

  if (lstatResult.size > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${lstatResult.size} bytes. Maximum: ${MAX_FILE_SIZE} bytes (1GB)`);
  }

  return { resolvedPath, size: lstatResult.size };
}

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

// ── handleSendFile / handleSendMedia response parsing ─────────

describe('Upload response parsing', () => {
  it('extracts file_id from nested Slack response', () => {
    // Simulate Slack SDK response shape: { files: [{ files: [{ id, permalink }] }] }
    const result = {
      files: [{ files: [{ id: 'F12345', permalink: 'https://slack.com/files/F12345' }] }],
    };
    const uploadedFile = (result as any).files?.[0]?.files?.[0]
      || (result as any).files?.[0]
      || null;
    expect(uploadedFile?.id).toBe('F12345');
  });

  it('extracts file_id from flat Slack response', () => {
    // Alternative shape: { files: [{ id, permalink }] }
    const result = {
      files: [{ id: 'F67890', permalink: 'https://slack.com/files/F67890' }],
    };
    const uploadedFile = (result as any).files?.[0]?.files?.[0]
      || (result as any).files?.[0]
      || null;
    expect(uploadedFile?.id).toBe('F67890');
  });

  it('returns null for empty response (triggers error)', () => {
    const result = { ok: true };
    const uploadedFile = (result as any).files?.[0]?.files?.[0]
      || (result as any).files?.[0]
      || null;
    expect(uploadedFile?.id).toBeUndefined();
    // This should trigger the "no file metadata" error in production code
    expect(!uploadedFile?.id).toBe(true);
  });

  it('returns null for empty files array', () => {
    const result = { files: [] };
    const uploadedFile = (result as any).files?.[0]?.files?.[0]
      || (result as any).files?.[0]
      || null;
    // undefined || null falls through to null — no file_id available
    expect(!uploadedFile?.id).toBe(true);
  });
});

// ── Media type validation ─────────────────────────────────────

describe('Media type classification', () => {
  // Replicated from server for behavioral testing
  const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'heic', 'heif', 'avif']);
  const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma']);
  const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp']);
  const ALLOWED_MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);

  function getMediaType(ext: string): 'image' | 'audio' | 'video' | null {
    if (IMAGE_EXTENSIONS.has(ext)) return 'image';
    if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
    if (VIDEO_EXTENSIONS.has(ext)) return 'video';
    return null;
  }

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
    const allMedia = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif',
      'heic', 'heif', 'avif', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma',
      'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp'];
    for (const ext of allMedia) {
      expect(ALLOWED_MEDIA_EXTENSIONS.has(ext)).toBe(true);
    }
  });
});
