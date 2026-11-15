/**
 * Where a conversation's code changes live: `DATA_DIR/code-changes/<conversationId>.json`, one document, written whole
 * with `atomicWriteJson` (+ `.bak`, rules/config.md). The dashboard and the sweeper read it; only the collector writes.
 */

import path from 'node:path';
import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import { isSafePathSegment } from '@soma/common/path-utils';
import { DATA_DIR } from '../env-paths';
import { Logger } from '../logger';
import type { CodeChangesDoc } from './types';

const logger = new Logger('CodeChangesStore');

/** A conversation id usable as a file name. */
export function isStoreKey(conversationId: unknown): conversationId is string {
  return (
    typeof conversationId === 'string' &&
    conversationId.length > 0 &&
    conversationId.length <= 128 &&
    /^[\w.-]+$/.test(conversationId) &&
    isSafePathSegment(conversationId)
  );
}

/** The commit shas one document remembers as counted (the newest). */
export const MAX_COUNTED_COMMITS = 2000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const optStr = (v: unknown) => v === undefined || typeof v === 'string';
/** Every field a reader uses without a check of its own: a path, the counts, the status, a patch (sized by bytes). */
const fileOk = (f: unknown) =>
  isObj(f) &&
  typeof f.path === 'string' &&
  typeof f.status === 'string' &&
  isNum(f.additions) &&
  isNum(f.deletions) &&
  optStr(f.patch) &&
  optStr(f.oldPath);
const filesOk = (v: unknown) => Array.isArray(v) && v.every(fileOk);
const layerOk = (v: unknown) => isObj(v) && filesOk(v.files) && isNum(v.additions) && isNum(v.deletions);

/** The shape every reader relies on — a damaged live file falls back to `.bak` instead of breaking reads and collects. */
function validate(raw: unknown): CodeChangesDoc {
  const d = raw as CodeChangesDoc;
  if (
    !isObj(d) ||
    d.version !== 1 ||
    !Array.isArray(d.checkouts) ||
    !Array.isArray(d.prs) ||
    !d.checkouts.every(
      (c) =>
        isObj(c) &&
        typeof c.id === 'string' &&
        typeof c.repo === 'string' &&
        typeof c.dir === 'string' &&
        layerOk(c.uncommitted) &&
        layerOk(c.committed) &&
        Array.isArray(c.committed.commits),
    ) ||
    !d.prs.every(
      (p) =>
        isObj(p) &&
        typeof p.id === 'string' &&
        typeof p.url === 'string' &&
        typeof p.repo === 'string' &&
        typeof p.state === 'string' &&
        isNum(p.number) &&
        isNum(p.additions) &&
        isNum(p.deletions) &&
        optStr(p.headSha) &&
        filesOk(p.files),
    )
  ) {
    throw new Error('not a code-changes document');
  }
  if (!isObj(d.counted) || !Array.isArray(d.counted.commits)) d.counted = { commits: [] };
  d.counted.commits = d.counted.commits.filter((c): c is string => typeof c === 'string');
  return d;
}

export class CodeChangesStore {
  constructor(readonly baseDir: string = path.join(DATA_DIR, 'code-changes')) {}

  private file(conversationId: string): string {
    return path.join(this.baseDir, `${conversationId}.json`);
  }

  read(conversationId: string): CodeChangesDoc | undefined {
    if (!isStoreKey(conversationId)) return undefined;
    try {
      return readJsonWithBackup(this.file(conversationId), validate);
    } catch (error) {
      logger.warn('code-changes document unreadable', { conversationId, error: (error as Error).message });
      return undefined;
    }
  }

  write(doc: CodeChangesDoc): void {
    if (!isStoreKey(doc.conversationId)) return;
    atomicWriteJson(this.file(doc.conversationId), doc);
  }

  /** The metrics took these commits: later collects do not hand them on again. */
  markCounted(conversationId: string, shas: string[]): void {
    if (shas.length === 0) return;
    const doc = this.read(conversationId);
    if (!doc) return;
    const counted = new Set(doc.counted.commits);
    for (const sha of shas) counted.add(sha);
    doc.counted = { commits: [...counted].slice(-MAX_COUNTED_COMMITS) };
    this.write(doc);
  }
}

let _store: CodeChangesStore | undefined;
export function getCodeChangesStore(): CodeChangesStore {
  if (!_store) _store = new CodeChangesStore();
  return _store;
}
