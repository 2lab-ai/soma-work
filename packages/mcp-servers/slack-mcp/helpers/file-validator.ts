/**
 * File validation and media type detection for Slack MCP uploads.
 */
import { createWriteStream, constants as fsConstants } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pipeline } from 'stream/promises';

/** Maximum file size for uploads: 1 GB */
const MAX_FILE_SIZE = 1_073_741_824;

/** Allowlisted root directories for file uploads */
const ALLOWED_UPLOAD_ROOTS = ['/tmp', '/private/tmp'];

const IMAGE_EXTENSIONS = new Set([
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
]);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp']);
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
  if (mimetype && (mimetype.startsWith('image/') || mimetype.startsWith('video/') || mimetype.startsWith('audio/')))
    return true;
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext);
  }
  return false;
}

/**
 * Check if a file is non-visual media (audio/video only).
 * Images are excluded because Claude can read them via multimodal Read tool.
 */
export function isNonVisualMedia(mimetype?: string, filename?: string): boolean {
  if (mimetype && (mimetype.startsWith('video/') || mimetype.startsWith('audio/'))) return true;
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext);
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
 *   3. Allowlisted root directory (/tmp, and the speaker's uploads directory)
 *   4. Symlink rejection
 *   5. Regular-file check, then — for a non-admin — the real path inside the session's own roots
 *   6. Readability check
 *   7. Size cap (1 GB)
 */
export async function validateFilePath(
  filePath: string,
  ownRoots: readonly string[] = [],
  extraRoots: readonly string[] = [],
): Promise<{ resolvedPath: string; size: number; cleanup?: () => Promise<void> }> {
  if (!filePath) {
    throw new Error('file_path is required');
  }

  // A relative path would resolve against this server's working directory, which is the MCP launch directory, not
  // the session's (env-access #1241): ask for the absolute path instead of guessing.
  if (!path.isAbsolute(filePath)) {
    throw new Error(`file_path must be absolute: ${filePath}`);
  }
  const resolvedPath = path.resolve(filePath);

  const segments = resolvedPath.split(path.sep);
  if (segments.some((seg) => seg === '..')) {
    throw new Error(`Path traversal not allowed: ${filePath}`);
  }

  // /tmp, plus the speaker's uploads directory (where thread files the model downloads are saved); a non-admin's
  // own roots are checked again, strictly, below.
  const underAllowedRoot = [...ALLOWED_UPLOAD_ROOTS, ...extraRoots, ...ownRoots].some((root) =>
    resolvedPath.startsWith(path.resolve(root) + path.sep),
  );
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

  // A non-admin session uploads only from its own roots, checked where the file really is (a link in a parent
  // directory included): its reads stop there too (src/sandbox/tenant-read-boundary.ts). The bytes come from a
  // snapshot of the file that was checked, so swapping the path afterwards uploads nothing else.
  if (ownRoots.length > 0) {
    if (lstatResult.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${lstatResult.size} bytes. Maximum: ${MAX_FILE_SIZE} bytes (1GB)`);
    }
    return snapshotInsideRoots(resolvedPath, ownRoots);
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

/** macOS links the OS keeps at the root: a root reached through one of them is not a planted link. */
const OS_ROOT_LINKS: Readonly<Record<string, string>> = {
  tmp: '/private/tmp',
  var: '/private/var',
  etc: '/private/etc',
};

/** `root` where it really is, or undefined when it is missing or reached through a link (one a session may plant). */
async function realRoot(root: string): Promise<string | undefined> {
  const lexical = path.resolve(root);
  const real = await fs.realpath(lexical).catch(() => undefined);
  if (!real) return undefined;
  const first = lexical.split(path.sep)[1] ?? '';
  const viaOsLink = process.platform === 'darwin' && OS_ROOT_LINKS[first];
  const expected = viaOsLink ? viaOsLink + lexical.slice(first.length + 1) : lexical;
  return real === expected ? real : undefined;
}

/** `real` is one of `roots` (each only where it really is, never through a link) or inside one. */
async function insideRoots(real: string, roots: readonly string[]): Promise<boolean> {
  const realRoots = (await Promise.all(roots.map(realRoot))).filter((r): r is string => r !== undefined);
  return realRoots.some((root) => real === root || real.startsWith(root + path.sep));
}

/**
 * Open the file without following a final link, check that the file opened is the one whose real path lies in
 * `roots`, and copy it from that handle into a fresh directory of the bot's own temp dir.
 */
async function snapshotInsideRoots(
  resolvedPath: string,
  roots: readonly string[],
): Promise<{ resolvedPath: string; size: number; cleanup: () => Promise<void> }> {
  const refuse = () =>
    new Error(`Upload restricted to your own folder (${roots.join(', ')}). Rejected: ${resolvedPath}`);
  const handle = await fs.open(resolvedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => {
    throw new Error(`File not found or not readable: ${resolvedPath}`);
  });
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`Not a regular file: ${resolvedPath}`);
    if (opened.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${opened.size} bytes. Maximum: ${MAX_FILE_SIZE} bytes (1GB)`);
    }
    const real = await fs.realpath(resolvedPath).catch(() => '');
    if (!real || !(await insideRoots(real, roots))) throw refuse();
    const atReal = await fs.lstat(real);
    if (atReal.ino !== opened.ino || atReal.dev !== opened.dev) throw refuse();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-mcp-upload-'));
    const copy = path.join(dir, path.basename(resolvedPath));
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      createWriteStream(copy, { flags: 'wx', mode: 0o600 }),
    );
    return {
      resolvedPath: copy,
      size: opened.size,
      cleanup: () => fs.rm(dir, { recursive: true, force: true }),
    };
  } finally {
    await handle.close();
  }
}
