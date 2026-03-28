/**
 * File validation and media type detection for Slack MCP uploads.
 */
import * as fs from 'fs/promises';
import * as path from 'path';

/** Maximum file size for uploads: 1 GB */
export const MAX_FILE_SIZE = 1_073_741_824;

/** Allowlisted root directories for file uploads */
export const ALLOWED_UPLOAD_ROOTS = ['/tmp', '/private/tmp'];

export const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'heic', 'heif', 'avif']);
export const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma']);
export const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp']);
export const ALLOWED_MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);

export function isImageFile(mimetype?: string, filename?: string): boolean {
  if (mimetype && mimetype.startsWith('image/')) return true;
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    if (IMAGE_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

export function isMediaFile(mimetype?: string, filename?: string): boolean {
  if (mimetype && (mimetype.startsWith('image/') || mimetype.startsWith('video/') || mimetype.startsWith('audio/'))) return true;
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext);
  }
  return false;
}

export function getMediaType(ext: string): 'image' | 'audio' | 'video' | null {
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return null;
}

/**
 * Validate a file path for upload security.
 *
 * Defence layers:
 *   1. Absolute path requirement
 *   2. Path-segment traversal check
 *   3. Allowlisted root directory (/tmp only)
 *   4. Symlink rejection
 *   5. Regular-file check
 *   6. Readability check
 *   7. Size cap (1 GB)
 */
export async function validateFilePath(filePath: string): Promise<{ resolvedPath: string; size: number }> {
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
    await fs.access(resolvedPath, (await import('fs')).constants.R_OK);
  } catch {
    throw new Error(`File not found or not readable: ${resolvedPath}`);
  }

  if (lstatResult.size > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${lstatResult.size} bytes. Maximum: ${MAX_FILE_SIZE} bytes (1GB)`);
  }

  return { resolvedPath, size: lstatResult.size };
}
