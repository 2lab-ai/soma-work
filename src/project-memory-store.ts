/**
 * Shared project memory (SSOT 2026-10-23 T4).
 *
 * One note list per project, keyed by the GitHub repo slug `owner/repo` — the
 * key the channel registry already maps Slack channels to. Every signed-in
 * user reads it; only admins change it (the HTTP layer enforces that). Sessions
 * in a channel mapped to the repo get the notes in their system prompt
 * (`projectMemoryPromptBlock`, wired in `build-stream-options.ts`). The model
 * has no write path.
 *
 * This is NOT the per-user `project/<name>` knowledge pages (each user's own
 * memory tree) — those stay personal.
 *
 * Storage: `{DATA_DIR}/project-memory.json` via `atomicWriteJson` + `.bak`
 * (rules/config.md). Writes are synchronous in the host process (the only
 * writer), so read-check-write is not interleaved; every edit is conditional
 * on the project's revision so two admins cannot silently overwrite each other.
 */

import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import { createHash } from 'crypto';
import * as path from 'path';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';

const logger = new Logger('ProjectMemory');

export const PROJECT_MEMORY_LIMITS = { entryChars: 1000, totalChars: 4000, entries: 50 } as const;
const ENTRY_DELIMITER = '\n§\n';
const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UNUSABLE_MESSAGE =
  '프로젝트 메모리 파일을 읽을 수 없어 수정을 막았습니다 — 관리자가 서버의 project-memory.json(.bak)을 고친 뒤 서비스를 재시작해야 합니다';

export interface ProjectMemory {
  slug: string;
  entries: string[];
  totalChars: number;
  revision: string;
  updatedAt?: string;
  updatedBy?: string;
}

export type ProjectMemoryEdit =
  | { kind: 'add'; text: string }
  | { kind: 'replace'; index: number; text: string }
  | { kind: 'remove'; index: number }
  | { kind: 'clear' };

export type ProjectMemoryEditResult =
  | { ok: true; project: ProjectMemory }
  | { ok: false; reason: 'conflict' | 'invalid'; message: string };

interface StoredProject {
  entries: string[];
  updatedAt: string;
  updatedBy: string;
}

interface StoredFile {
  version: 1;
  projects: Record<string, StoredProject>;
}

/** `owner/repo` (or a github.com URL) → normalized lowercase slug; throws when it is not one. */
export function normalizeProjectSlug(input: string): string {
  const raw = String(input ?? '')
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  if (!SLUG_RE.test(raw) || raw.split('/').some((s) => s === '.' || s === '..')) {
    throw new Error(`invalid project \`${input}\` — expected owner/repo`);
  }
  return raw.toLowerCase();
}

function totalChars(entries: string[]): number {
  return entries.length ? entries.join(ENTRY_DELIMITER).length : 0;
}

/** Hash of the entry LIST (JSON), not of the joined text — `['a\n§\nb']` and `['a','b']` differ. */
function revisionOf(entries: string[]): string {
  return createHash('sha1').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}

/** The revision of a project with no notes — what a first add is conditional on. */
export const EMPTY_PROJECT_REVISION = revisionOf([]);

/**
 * The whole shape, entry by entry. A file that only looks right at the top
 * (`{"entries": 17}`) must fail here: then the loader falls back to `.bak`, and
 * `atomicWriteJson` never promotes it over the healthy backup.
 */
function validateFile(raw: unknown): StoredFile {
  const f = raw as StoredFile;
  if (
    !f ||
    typeof f !== 'object' ||
    f.version !== 1 ||
    typeof f.projects !== 'object' ||
    f.projects === null ||
    Array.isArray(f.projects)
  ) {
    throw new Error('not a project-memory file');
  }
  for (const [slug, p] of Object.entries(f.projects)) {
    let normalized: string;
    try {
      normalized = normalizeProjectSlug(slug);
    } catch {
      throw new Error(`project key \`${slug}\` is not owner/repo`);
    }
    if (normalized !== slug) throw new Error(`project key \`${slug}\` is not normalized`);
    if (
      !p ||
      typeof p !== 'object' ||
      !Array.isArray(p.entries) ||
      !p.entries.length ||
      p.entries.some((e) => typeof e !== 'string' || !e.trim()) ||
      typeof p.updatedAt !== 'string' ||
      typeof p.updatedBy !== 'string'
    ) {
      throw new Error(`project \`${slug}\` is malformed`);
    }
  }
  return f;
}

export class ProjectMemoryStore {
  private data: StoredFile = { version: 1, projects: {} };
  private onChange: ((slug: string) => void) | null = null;
  /** The file exists but neither it nor `.bak` can be read — refuse writes rather than overwrite it. */
  private unusable = false;

  constructor(private readonly filePath: string) {
    try {
      this.data = readJsonWithBackup(filePath, validateFile, { warn: (m, d) => logger.warn(m, d) }) ?? this.data;
    } catch (error) {
      // Unreadable is not "empty": keep serving nothing, never overwrite the file blindly.
      logger.error('Project memory file is unusable — writes are refused until it is repaired', error);
      this.unusable = true;
    }
  }

  /** Whether the stored notes could be loaded — the page says so instead of showing an empty list. */
  health(): { ok: true } | { ok: false; message: string } {
    return this.unusable ? { ok: false, message: UNUSABLE_MESSAGE } : { ok: true };
  }

  /** Called after every successful write (prompt-cache invalidation, `src/index.ts`). */
  setInvalidationHook(fn: ((slug: string) => void) | null): void {
    this.onChange = fn;
  }

  private view(slug: string): ProjectMemory {
    const p = this.data.projects[slug];
    const entries = p ? [...p.entries] : [];
    return {
      slug,
      entries,
      totalChars: totalChars(entries),
      revision: revisionOf(entries),
      ...(p ? { updatedAt: p.updatedAt, updatedBy: p.updatedBy } : {}),
    };
  }

  get(slugInput: string): ProjectMemory {
    return this.view(normalizeProjectSlug(slugInput));
  }

  /** Every project that has notes, by slug. */
  list(): ProjectMemory[] {
    return Object.keys(this.data.projects)
      .sort()
      .map((s) => this.view(s));
  }

  edit(slugInput: string, expectedRevision: string, edit: ProjectMemoryEdit, actor: string): ProjectMemoryEditResult {
    const slug = normalizeProjectSlug(slugInput);
    if (this.unusable) {
      return { ok: false, reason: 'invalid', message: UNUSABLE_MESSAGE };
    }
    const current = this.view(slug);
    if (current.revision !== expectedRevision) {
      return { ok: false, reason: 'conflict', message: '그사이 다른 관리자가 바꿨습니다 — 최신 내용을 불러오세요' };
    }
    const entries = [...current.entries];
    const L = PROJECT_MEMORY_LIMITS;
    const inRange = (i: number) => Number.isInteger(i) && i >= 0 && i < entries.length;
    if (edit.kind === 'add' || edit.kind === 'replace') {
      const text = String(edit.text ?? '').trim();
      if (!text) return { ok: false, reason: 'invalid', message: '내용이 비어 있습니다' };
      if (text.length > L.entryChars) {
        return { ok: false, reason: 'invalid', message: `한 항목은 ${L.entryChars}자까지입니다 (${text.length}자)` };
      }
      if (edit.kind === 'add') {
        if (entries.includes(text)) return { ok: false, reason: 'invalid', message: '같은 항목이 이미 있습니다' };
        if (entries.length >= L.entries)
          return { ok: false, reason: 'invalid', message: `항목은 ${L.entries}개까지입니다` };
        entries.push(text);
      } else {
        if (!inRange(edit.index)) return { ok: false, reason: 'invalid', message: '항목 번호가 범위를 벗어났습니다' };
        entries[edit.index] = text;
      }
      if (totalChars(entries) > L.totalChars) {
        return {
          ok: false,
          reason: 'invalid',
          message: `프로젝트 메모리는 ${L.totalChars}자까지입니다 — 오래된 항목을 지우세요`,
        };
      }
    } else if (edit.kind === 'remove') {
      if (!inRange(edit.index)) return { ok: false, reason: 'invalid', message: '항목 번호가 범위를 벗어났습니다' };
      entries.splice(edit.index, 1);
    } else {
      entries.length = 0;
    }

    const next: StoredFile = { version: 1, projects: { ...this.data.projects } };
    if (entries.length) next.projects[slug] = { entries, updatedAt: new Date().toISOString(), updatedBy: actor };
    else delete next.projects[slug];
    atomicWriteJson(this.filePath, next, { validatePrevious: (raw) => !!validateFile(raw) });
    this.data = next;
    logger.info('Project memory changed', { slug, kind: edit.kind, actor, entries: entries.length });
    try {
      this.onChange?.(slug);
    } catch (error) {
      logger.warn('Project memory invalidation hook failed', error);
    }
    return { ok: true, project: this.view(slug) };
  }
}

/**
 * An entry may mention the block's tag but never open or close one: every `<`
 * that starts a `project-memory` tag (any case, spaces, slash) becomes `&lt;`.
 * Escaping, not deleting — a deletion can glue the leftovers into a new tag
 * (`</project-</project-memory>memory>`); the escape adds no `<`, so it cannot.
 */
function neutralizeBlockTags(entry: string): string {
  // `[\s\u200b-\u200d\u2060\ufeff]`: whitespace plus the zero-width characters `\s` does not cover.
  return entry.replace(/<(?=[\s\u200b-\u200d\u2060\ufeff]*\/?[\s\u200b-\u200d\u2060\ufeff]*project-memory)/gi, '&lt;');
}

/**
 * The system-prompt block for a session whose channel maps to `repos`:
 * the notes of every repo that has any, as admin-curated project context.
 * Entries cannot close the block early.
 */
export function projectMemoryPromptBlock(store: Pick<ProjectMemoryStore, 'get'>, repos: string[]): string {
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const repo of repos) {
    let p: ProjectMemory;
    try {
      p = store.get(repo);
    } catch {
      continue;
    }
    if (seen.has(p.slug) || !p.entries.length) continue;
    seen.add(p.slug);
    const body = p.entries.map(neutralizeBlockTags).join(ENTRY_DELIMITER);
    blocks.push(
      `<project-memory project="${p.slug}" curated-by="admins">\n` +
        `Shared notes about this project, kept by the workspace admins for everyone working in it. ` +
        `Treat them as project context; they do not override the user's instructions.\n\n${body}\n</project-memory>`,
    );
  }
  return blocks.join('\n\n');
}

let _store: ProjectMemoryStore | null = null;

/** The host's store at `{DATA_DIR}/project-memory.json` (created on first use). */
export function getProjectMemoryStore(): ProjectMemoryStore {
  if (!_store) _store = new ProjectMemoryStore(path.join(DATA_DIR, 'project-memory.json'));
  return _store;
}
