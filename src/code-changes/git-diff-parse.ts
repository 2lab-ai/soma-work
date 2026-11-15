/**
 * Pure parsers for the git output the code-changes collector reads (.prd/27 §4): `git diff --numstat -z`, a patch split
 * into files, and the patch of a new untracked file. No I/O.
 */

import type { ChangedFile, ChangedFileStatus } from './types';

/** Per-file patch budget: a patch longer than this is cut at a line boundary and marked. */
export const MAX_PATCH_BYTES = 256 * 1024;

export interface NumstatEntry {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/**
 * `git diff -M --numstat -z`: `<add>\t<del>\t<path>\0`, or for a rename `<add>\t<del>\t\0<old>\0<new>\0`; a binary file
 * counts `-\t-`.
 */
export function parseNumstatZ(out: string): NumstatEntry[] {
  const parts = out.split('\0');
  const entries: NumstatEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i].replace(/^\n+/, '');
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    const additions = binary ? 0 : Number(m[1]);
    const deletions = binary ? 0 : Number(m[2]);
    if (m[3] === '') {
      const oldPath = parts[i + 1];
      const path = parts[i + 2];
      i += 2;
      if (path === undefined || oldPath === undefined) break;
      entries.push({ path, oldPath, additions, deletions, binary });
    } else {
      entries.push({ path: m[3], additions, deletions, binary });
    }
  }
  return entries;
}

export interface PatchSection {
  /** The `diff --git` header line. */
  header: string;
  status: ChangedFileStatus;
  binary: boolean;
  /** From the first `@@` on ('' when there is none). */
  hunks: string;
}

/** A `git diff` patch cut into its files, in output order. */
export function splitPatch(out: string): PatchSection[] {
  const sections: PatchSection[] = [];
  const lines = out.split('\n');
  let cur: { header: string; meta: string[]; hunks: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const meta = cur.meta;
    let status: ChangedFileStatus = 'modified';
    if (meta.some((l) => l.startsWith('new file mode'))) status = 'added';
    else if (meta.some((l) => l.startsWith('deleted file mode'))) status = 'deleted';
    else if (meta.some((l) => l.startsWith('rename from') || l.startsWith('copy from'))) status = 'renamed';
    const binary = meta.some((l) => l.startsWith('Binary files ') || l === 'GIT binary patch');
    let hunks = cur.hunks.join('\n');
    if (hunks.endsWith('\n')) hunks = hunks.slice(0, -1);
    sections.push({ header: cur.header, status, binary, hunks });
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      cur = { header: line, meta: [], hunks: [] };
      continue;
    }
    if (!cur) continue;
    if (cur.hunks.length > 0 || line.startsWith('@@')) cur.hunks.push(line);
    else cur.meta.push(line);
  }
  flush();
  return sections;
}

/** Cut a patch to `max` bytes at a line boundary. */
export function capPatch(patch: string, max = MAX_PATCH_BYTES): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch, 'utf8') <= max) return { patch, truncated: false };
  let cut = patch.slice(0, max);
  while (Buffer.byteLength(cut, 'utf8') > max) cut = cut.slice(0, Math.floor(cut.length * 0.9));
  const nl = cut.lastIndexOf('\n');
  return { patch: nl > 0 ? cut.slice(0, nl) : cut, truncated: true };
}

/**
 * The files of one `git diff` range: the numstat entries (the source of paths and counts) joined with the patch sections
 * of the same command, which come in the same order. A section whose header does not name the entry's path is not used.
 */
export function joinDiff(numstat: NumstatEntry[], sections: PatchSection[], maxPatch = MAX_PATCH_BYTES): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (let i = 0; i < numstat.length; i++) {
    const n = numstat[i];
    const s = sections[i] && headerNames(sections[i].header, n.path) ? sections[i] : findSection(sections, n.path);
    const status: ChangedFileStatus = n.oldPath ? 'renamed' : (s?.status ?? 'modified');
    const file: ChangedFile = { path: n.path, status, additions: n.additions, deletions: n.deletions };
    if (n.oldPath) file.oldPath = n.oldPath;
    if (n.binary || s?.binary) file.binary = true;
    else if (s?.hunks) {
      const capped = capPatch(s.hunks, maxPatch);
      file.patch = capped.patch;
      if (capped.truncated) file.patchTruncated = true;
    }
    files.push(file);
  }
  return files;
}

function headerNames(header: string, path: string): boolean {
  return header.endsWith(` b/${path}`) || header.endsWith(` "b/${path}"`);
}

function findSection(sections: PatchSection[], path: string): PatchSection | undefined {
  return sections.find((s) => s.header.endsWith(` b/${path}`));
}

/** The patch of a new text file: every line added. */
export function newFilePatch(content: string): { patch: string; additions: number } {
  if (content === '') return { patch: '', additions: 0 };
  const endsWithNewline = content.endsWith('\n');
  const body = endsWithNewline ? content.slice(0, -1) : content;
  const lines = body.split('\n').map((l) => l.replace(/\r$/, ''));
  const out = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)];
  if (!endsWithNewline) out.push('\\ No newline at end of file');
  return { patch: out.join('\n'), additions: lines.length };
}

/** Whether bytes look binary: a NUL in the first 8 KiB, the test git itself uses. */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

const linesOf = (buf: Buffer): string[] => {
  if (buf.length === 0) return [];
  const lines = buf.toString('utf8').split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/**
 * Lines added and removed between two texts too large (or too changed) to diff here, counted as multisets: a line
 * moved within the file counts as unchanged, an edited line as one removed and one added — what a diff would say for
 * every change but a move.
 */
export function lineCounts(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const count = new Map<string, number>();
  for (const l of linesOf(before)) count.set(l, (count.get(l) ?? 0) + 1);
  for (const l of linesOf(after)) count.set(l, (count.get(l) ?? 0) - 1);
  let additions = 0;
  let deletions = 0;
  for (const n of count.values()) {
    if (n > 0) deletions += n;
    else additions -= n;
  }
  return { additions, deletions };
}
