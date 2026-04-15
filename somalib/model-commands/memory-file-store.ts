/**
 * Standalone MemoryStore implementation using file I/O.
 * No dependency on app-level modules (Logger, env-paths, etc.).
 * Used by MCP servers that run as separate processes.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MemoryStore } from './catalog';

const ENTRY_DELIMITER = '\n§\n';
const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
const DEFAULT_USER_CHAR_LIMIT = 1375;

function isSafeSegment(s: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(s);
}

function charCount(entries: string[]): number {
  if (entries.length === 0) return 0;
  return entries.join(ENTRY_DELIMITER).length;
}

export class MemoryFileStore implements MemoryStore {
  constructor(private readonly dataDir: string) {}

  private filePath(user: string, target: string): string {
    if (!isSafeSegment(user)) throw new Error(`Invalid userId: ${user}`);
    const fileName = target === 'memory' ? 'MEMORY.md' : 'USER.md';
    return path.join(this.dataDir, user, fileName);
  }

  private charLimit(target: string): number {
    return target === 'memory' ? DEFAULT_MEMORY_CHAR_LIMIT : DEFAULT_USER_CHAR_LIMIT;
  }

  private readEntries(user: string, target: string): string[] {
    const fp = this.filePath(user, target);
    try {
      if (!fs.existsSync(fp)) return [];
      const raw = fs.readFileSync(fp, 'utf-8');
      if (!raw.trim()) return [];
      return raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter((e) => e.length > 0);
    } catch {
      return [];
    }
  }

  private writeEntries(user: string, target: string, entries: string[]): void {
    const fp = this.filePath(user, target);
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, entries.join(ENTRY_DELIMITER), 'utf-8');
  }

  addMemory(user: string, target: string, content: string): { ok: boolean; message: string } {
    const trimmed = content.trim();
    if (!trimmed) return { ok: false, message: 'Empty content' };

    const entries = this.readEntries(user, target);
    if (entries.some((e) => e === trimmed)) return { ok: false, message: 'Duplicate entry already exists' };

    const next = [...entries, trimmed];
    const limit = this.charLimit(target);
    if (charCount(next) > limit) {
      return { ok: false, message: `Would exceed char limit (${charCount(entries)}/${limit} used). Remove old entries first.` };
    }

    this.writeEntries(user, target, next);
    return { ok: true, message: 'Entry added' };
  }

  replaceMemory(user: string, target: string, oldText: string, content: string): { ok: boolean; message: string } {
    const trimmed = content.trim();
    if (!trimmed) return { ok: false, message: 'Replacement content is empty' };

    const entries = this.readEntries(user, target);
    const matches = entries.filter((e) => e.includes(oldText));
    if (matches.length === 0) return { ok: false, message: `No entry matching "${oldText}" found` };
    if (matches.length > 1 && new Set(matches).size > 1) {
      return { ok: false, message: `Multiple entries match "${oldText}". Be more specific.` };
    }

    const idx = entries.findIndex((e) => e.includes(oldText));
    const updated = [...entries];
    updated[idx] = trimmed;

    const limit = this.charLimit(target);
    if (charCount(updated) > limit) return { ok: false, message: `Replacement would exceed char limit (${limit})` };

    this.writeEntries(user, target, updated);
    return { ok: true, message: 'Entry replaced' };
  }

  removeMemory(user: string, target: string, oldText: string): { ok: boolean; message: string } {
    const entries = this.readEntries(user, target);
    const matches = entries.filter((e) => e.includes(oldText));
    if (matches.length === 0) return { ok: false, message: `No entry matching "${oldText}" found` };
    if (matches.length > 1 && new Set(matches).size > 1) {
      return { ok: false, message: `Multiple entries match "${oldText}". Be more specific.` };
    }

    const idx = entries.findIndex((e) => e.includes(oldText));
    const updated = [...entries];
    updated.splice(idx, 1);

    this.writeEntries(user, target, updated);
    return { ok: true, message: 'Entry removed' };
  }

  loadMemory(user: string, target: string): { entries: string[]; charLimit: number; totalChars: number; percentUsed: number } {
    const entries = this.readEntries(user, target);
    const limit = this.charLimit(target);
    const total = charCount(entries);
    return { entries, charLimit: limit, totalChars: total, percentUsed: limit > 0 ? Math.round((total / limit) * 100) : 0 };
  }
}
