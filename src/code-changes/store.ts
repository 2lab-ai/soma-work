/**
 * Where a conversation's code changes live: `DATA_DIR/code-changes/<conversationId>.json`, one document, written whole
 * with `atomicWriteJson` (+ `.bak`, rules/config.md). The dashboard and the sweeper read it; only the collector writes.
 */

import fs from 'node:fs';
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

function validate(raw: unknown): CodeChangesDoc {
  const d = raw as CodeChangesDoc;
  if (!d || typeof d !== 'object' || d.version !== 1 || !Array.isArray(d.checkouts) || !Array.isArray(d.prs)) {
    throw new Error('not a code-changes document');
  }
  if (!d.counted || !Array.isArray(d.counted.commits)) d.counted = { commits: [] };
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

  /** The conversation ids with a document, each with its last write time (the sweeper's list). */
  list(): Array<{ conversationId: string; mtimeMs: number }> {
    let names: string[];
    try {
      names = fs.readdirSync(this.baseDir);
    } catch {
      return [];
    }
    const out: Array<{ conversationId: string; mtimeMs: number }> = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const conversationId = name.slice(0, -'.json'.length);
      if (!isStoreKey(conversationId)) continue;
      try {
        out.push({ conversationId, mtimeMs: fs.statSync(path.join(this.baseDir, name)).mtimeMs });
      } catch {
        /* removed meanwhile */
      }
    }
    return out;
  }
}

let _store: CodeChangesStore | undefined;
export function getCodeChangesStore(): CodeChangesStore {
  if (!_store) _store = new CodeChangesStore();
  return _store;
}
