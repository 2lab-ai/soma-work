import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';
import { isSafePathSegment } from './path-utils';

const ENTRY_DELIMITER = '\n§\n';
const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
const DEFAULT_USER_CHAR_LIMIT = 1375;

export type MemoryTarget = 'memory' | 'user';
export type MemoryAction = 'add' | 'replace' | 'remove';

export interface MemoryEntry {
  index: number;
  content: string;
}

export interface MemoryBlock {
  entries: string[];
  charLimit: number;
  totalChars: number;
  percentUsed: number;
}

interface MemoryOperationResult {
  ok: boolean;
  message: string;
  entries?: string[];
}

const logger = new Logger('UserMemoryStore');

function getUserMemoryDir(userId: string): string {
  if (!isSafePathSegment(userId)) {
    throw new Error(`Invalid userId for memory storage: ${userId}`);
  }
  return path.join(DATA_DIR, userId);
}

function getFilePath(userId: string, target: MemoryTarget): string {
  const dir = getUserMemoryDir(userId);
  return path.join(dir, target === 'memory' ? 'MEMORY.md' : 'USER.md');
}

function getCharLimit(target: MemoryTarget): number {
  return target === 'memory' ? DEFAULT_MEMORY_CHAR_LIMIT : DEFAULT_USER_CHAR_LIMIT;
}

function readEntries(userId: string, target: MemoryTarget): string[] {
  const filePath = getFilePath(userId, target);
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.trim()) return [];
    return content
      .split(ENTRY_DELIMITER)
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
  } catch {
    return [];
  }
}

function writeEntries(userId: string, target: MemoryTarget, entries: string[]): void {
  const filePath = getFilePath(userId, target);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const content = entries.join(ENTRY_DELIMITER);
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

function totalChars(entries: string[]): number {
  if (entries.length === 0) return 0;
  return entries.join(ENTRY_DELIMITER).length;
}

// --- Public API ---

export function loadMemory(userId: string, target: MemoryTarget): MemoryBlock {
  const entries = readEntries(userId, target);
  const charLimit = getCharLimit(target);
  const chars = totalChars(entries);
  return {
    entries,
    charLimit,
    totalChars: chars,
    percentUsed: charLimit > 0 ? Math.round((chars / charLimit) * 100) : 0,
  };
}

export function addMemory(userId: string, target: MemoryTarget, content: string): MemoryOperationResult {
  const trimmed = content.trim();
  if (!trimmed) {
    return { ok: false, message: 'Empty content' };
  }

  const entries = readEntries(userId, target);
  const charLimit = getCharLimit(target);

  // Reject exact duplicates
  if (entries.some((e) => e === trimmed)) {
    return { ok: false, message: 'Duplicate entry already exists' };
  }

  // Check char limit
  const newEntries = [...entries, trimmed];
  if (totalChars(newEntries) > charLimit) {
    const used = totalChars(entries);
    return {
      ok: false,
      message: `Would exceed char limit (${used}/${charLimit} used, need ${trimmed.length} more chars). Remove old entries first.`,
    };
  }

  writeEntries(userId, target, newEntries);
  logger.info('Memory added', { userId, target, entryLength: trimmed.length });
  return { ok: true, message: 'Entry added', entries: newEntries };
}

export function replaceMemory(
  userId: string,
  target: MemoryTarget,
  oldText: string,
  newContent: string,
): MemoryOperationResult {
  const trimmedNew = newContent.trim();
  if (!trimmedNew) {
    return { ok: false, message: 'Replacement content is empty' };
  }

  const entries = readEntries(userId, target);
  const matches = entries.filter((e) => e.includes(oldText));

  if (matches.length === 0) {
    return { ok: false, message: `No entry matching "${oldText}" found` };
  }
  if (matches.length > 1 && new Set(matches).size > 1) {
    return { ok: false, message: `Multiple entries match "${oldText}". Be more specific.` };
  }

  const idx = entries.findIndex((e) => e.includes(oldText));
  const updated = [...entries];
  updated[idx] = trimmedNew;

  const charLimit = getCharLimit(target);
  if (totalChars(updated) > charLimit) {
    return { ok: false, message: `Replacement would exceed char limit (${charLimit})` };
  }

  writeEntries(userId, target, updated);
  logger.info('Memory replaced', { userId, target, index: idx });
  return { ok: true, message: 'Entry replaced', entries: updated };
}

export function removeMemory(userId: string, target: MemoryTarget, oldText: string): MemoryOperationResult {
  const entries = readEntries(userId, target);
  const matches = entries.filter((e) => e.includes(oldText));

  if (matches.length === 0) {
    return { ok: false, message: `No entry matching "${oldText}" found` };
  }
  if (matches.length > 1 && new Set(matches).size > 1) {
    return { ok: false, message: `Multiple entries match "${oldText}". Be more specific.` };
  }

  const idx = entries.findIndex((e) => e.includes(oldText));
  const updated = [...entries];
  updated.splice(idx, 1);

  writeEntries(userId, target, updated);
  logger.info('Memory removed', { userId, target, index: idx });
  return { ok: true, message: 'Entry removed', entries: updated };
}

export function removeMemoryByIndex(userId: string, target: MemoryTarget, index: number): MemoryOperationResult {
  const entries = readEntries(userId, target);

  if (index < 1 || index > entries.length) {
    return { ok: false, message: `Invalid index ${index}. Valid range: 1-${entries.length}` };
  }

  const updated = [...entries];
  updated.splice(index - 1, 1);

  writeEntries(userId, target, updated);
  logger.info('Memory removed by index', { userId, target, index });
  return { ok: true, message: `Entry #${index} removed`, entries: updated };
}

/**
 * Replace entry at 1-based index atomically.
 * Validates newText.length against per-entry cap and total char limit.
 * Returns {ok:false, reason} WITHOUT mutating store on failure.
 */
export function replaceMemoryByIndex(
  userId: string,
  target: MemoryTarget,
  index: number,
  newText: string,
): { ok: boolean; reason?: string } {
  const entries = readEntries(userId, target);
  if (index < 1 || index > entries.length) {
    return { ok: false, reason: `index ${index} out of range (1..${entries.length})` };
  }
  const perEntryCap = Math.floor(getCharLimit(target) * 0.3);
  if (newText.length > perEntryCap) {
    return { ok: false, reason: `entry too long (${newText.length} > ${perEntryCap})` };
  }
  if (newText.length === 0) {
    return { ok: false, reason: 'empty entry' };
  }
  const next = [...entries];
  next[index - 1] = newText;
  if (totalChars(next) > getCharLimit(target)) {
    return { ok: false, reason: 'total over charLimit' };
  }
  writeEntries(userId, target, next);
  logger.info('Memory replaced by index', { userId, target, index });
  return { ok: true };
}

/**
 * Replace entire entries array atomically.
 * Prevalidates: non-empty array, no duplicates, per-entry cap, total cap.
 * Returns {ok:false, reason} WITHOUT mutating store on failure.
 */
export function replaceAllMemory(
  userId: string,
  target: MemoryTarget,
  entries: string[],
): { ok: boolean; reason?: string } {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, reason: 'empty entries array' };
  }
  if (new Set(entries).size !== entries.length) {
    return { ok: false, reason: 'duplicate entries' };
  }
  const perEntryCap = Math.floor(getCharLimit(target) * 0.3);
  for (const s of entries) {
    if (typeof s !== 'string' || s.length === 0) {
      return { ok: false, reason: 'empty entry in array' };
    }
    if (s.length > perEntryCap) {
      return { ok: false, reason: `entry too long (max ${perEntryCap})` };
    }
  }
  if (totalChars(entries) > getCharLimit(target)) {
    return { ok: false, reason: 'total over charLimit' };
  }
  writeEntries(userId, target, entries);
  logger.info('Memory replaced in full', { userId, target, count: entries.length });
  return { ok: true };
}

export function clearMemory(userId: string, target: MemoryTarget): MemoryOperationResult {
  writeEntries(userId, target, []);
  logger.info('Memory cleared', { userId, target });
  return { ok: true, message: `All ${target} entries cleared`, entries: [] };
}

export function clearAllMemory(userId: string): MemoryOperationResult {
  clearMemory(userId, 'memory');
  clearMemory(userId, 'user');
  return { ok: true, message: 'All memory and user profile entries cleared', entries: [] };
}

/**
 * Format memory block for system prompt injection (hermes-agent style)
 */
export function formatMemoryForPrompt(userId: string): string {
  const mem = loadMemory(userId, 'memory');
  const usr = loadMemory(userId, 'user');

  if (mem.entries.length === 0 && usr.entries.length === 0) {
    return '';
  }

  const parts: string[] = [];

  if (mem.entries.length > 0) {
    parts.push(
      [
        '══════════════════════════════════════════════',
        `MEMORY (your personal notes) [${mem.percentUsed}% -- ${mem.totalChars}/${mem.charLimit} chars]`,
        '══════════════════════════════════════════════',
        mem.entries.join('\n§\n'),
      ].join('\n'),
    );
  }

  if (usr.entries.length > 0) {
    parts.push(
      [
        '══════════════════════════════════════════════',
        `USER PROFILE (who the user is) [${usr.percentUsed}% -- ${usr.totalChars}/${usr.charLimit} chars]`,
        '══════════════════════════════════════════════',
        usr.entries.join('\n§\n'),
      ].join('\n'),
    );
  }

  return parts.join('\n\n');
}

/**
 * Format memory for user-facing display with numbered entries
 */
export function formatMemoryForDisplay(userId: string): string {
  const mem = loadMemory(userId, 'memory');
  const usr = loadMemory(userId, 'user');

  if (mem.entries.length === 0 && usr.entries.length === 0) {
    return '📭 No saved memories.';
  }

  const parts: string[] = [];

  if (mem.entries.length > 0) {
    const list = mem.entries.map((e, i) => `${i + 1}. ${e}`).join('\n');
    parts.push(
      `📝 *MEMORY* (${mem.entries.length} entries, ${mem.percentUsed}% -- ${mem.totalChars}/${mem.charLimit} chars)\n${list}`,
    );
  }

  if (usr.entries.length > 0) {
    const list = usr.entries.map((e, i) => `${i + 1}. ${e}`).join('\n');
    parts.push(
      `👤 *USER PROFILE* (${usr.entries.length} entries, ${usr.percentUsed}% -- ${usr.totalChars}/${usr.charLimit} chars)\n${list}`,
    );
  }

  return parts.join('\n\n');
}
