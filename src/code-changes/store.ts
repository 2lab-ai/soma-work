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

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const filesOk = (v: unknown) => Array.isArray(v) && v.every((f) => isObj(f) && typeof f.path === 'string');
const layerOk = (v: unknown) => isObj(v) && filesOk(v.files);

/** The shape every reader relies on — a damaged live file falls back to `.bak` instead of breaking reads and collects. */
function validate(raw: unknown): CodeChangesDoc {
  const d = raw as CodeChangesDoc;
  if (
    !isObj(d) ||
    d.version !== 1 ||
    !Array.isArray(d.checkouts) ||
    !Array.isArray(d.prs) ||
    !d.checkouts.every(
      (c) => isObj(c) && typeof c.repo === 'string' && layerOk(c.uncommitted) && layerOk(c.committed),
    ) ||
    !d.prs.every((p) => isObj(p) && typeof p.id === 'string' && typeof p.repo === 'string' && filesOk(p.files))
  ) {
    throw new Error('not a code-changes document');
  }
  if (!isObj(d.counted) || !Array.isArray(d.counted.commits)) d.counted = { commits: [] };
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
}

let _store: CodeChangesStore | undefined;
export function getCodeChangesStore(): CodeChangesStore {
  if (!_store) _store = new CodeChangesStore();
  return _store;
}
