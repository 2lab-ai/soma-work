/**
 * Hierarchical per-user memory store (taxonomy-based).
 *
 * Standalone file I/O — no dependency on app-level modules (Logger, env-paths).
 * Shared by the in-process host (src/hierarchical-memory.ts) and the
 * out-of-process model-command MCP server, which run in different processes
 * over the same filesystem.
 *
 * Layout (per user, under `{dataDir}/{userId}/memory/`):
 *   MEMORY.md            L1 agent briefing  (flat entries, prompt-loaded)
 *   USER.md              L1 user briefing   (flat entries, prompt-loaded)
 *   TAXONOMY.md          routing rules      (seeded once, prompt index hint)
 *   memory-index.json    semantic page index (titles/slugs/aliases/paths)
 *   episodic/YYYY-MM-DD.md   append-only raw observations
 *   agent/<slug>.md          durable agent operating pages
 *   sites/<slug>.md          durable site/browse knowledge pages
 *   concepts/<slug>.md       reusable frameworks / lessons
 *   projects/<project>/MEMORY.md           project-level page
 *   projects/<project>/issues/<issue>.md   project → issue page
 *   cron/<routine>/MEMORY.md               recurring routine memory
 *
 * Semantic page format = YAML-ish frontmatter + `## Current` + `## History`.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { withMemoryLock } from './memory-lock';
import {
  isSafeSegment,
  isSemanticPageType,
  type PageLocator,
  parsePageId,
  type SemanticPageType,
} from './memory-page-id';

export const MEMORY_DIR = 'memory';

export type { PageLocator, SemanticPageType };

export interface SemanticPage {
  id: string; // canonical id, e.g. "agent/foo" or "project/soma/123"
  type: SemanticPageType;
  title: string;
  aliases: string[];
  updated: string; // YYYY-MM-DD
  current: string;
  history: string[]; // raw history bullet lines (without leading "- ")
  relPath: string; // path relative to memory root
}

export interface MemoryIndexEntry {
  id: string;
  type: SemanticPageType;
  title: string;
  aliases: string[];
  relPath: string;
  updated: string;
}

export interface MemoryIndex {
  version: number;
  entries: MemoryIndexEntry[];
}

const INDEX_VERSION = 1;

/** One `## HH:MM - title` block of an episodic day file. */
export interface EpisodicEntry {
  time: string;
  title: string;
  content: string;
}

/** Result of a conditional (revision-checked) dashboard write. */
export type ConditionalWrite =
  | { ok: true; id: string; revision: string | null }
  | { ok: false; reason: 'conflict' | 'invalid' | 'missing'; message: string };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Content hash a dashboard edit is conditional on; null when the file does not exist. */
export function revisionOf(raw: string | null): string | null {
  return raw === null ? null : createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

function readOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** An entry header line (`## HH:MM - title`), tolerating a CRLF line end. */
const ENTRY_HEADER_AT = /(^|\n)## (\d{2}:\d{2}) - ([^\n]*?)\r?(?=\n|$)/g;
/** A line inside a note that would read as an entry header. */
const HEADER_LOOKALIKE = /^## \d{2}:\d{2} - /gm;

/**
 * Normalize note text before it is written into a day file: LF line ends, and
 * a line that would read as an entry header is indented by one space so a note
 * can never split into two entries (review P1).
 */
export function normalizeEpisodicText(text: string): string {
  // trim BEFORE indenting, or the guard space of a first-line header is trimmed away (review R2).
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(HEADER_LOOKALIKE, ' $&');
}

interface EpisodicSpan extends EpisodicEntry {
  /** [start, end) of the block in the raw file, from the newline before its header. */
  start: number;
  end: number;
}

/** Entries of a day file with the byte range each one occupies (everything else is left alone). */
function scanEpisodicDay(raw: string): EpisodicSpan[] {
  const spans: EpisodicSpan[] = [];
  ENTRY_HEADER_AT.lastIndex = 0;
  for (let m = ENTRY_HEADER_AT.exec(raw); m; m = ENTRY_HEADER_AT.exec(raw)) {
    const start = m.index; // the newline before the header (or 0 at the file start)
    spans.push({ time: m[2], title: m[3], content: '', start, end: raw.length });
    if (spans.length > 1) spans[spans.length - 2].end = start;
  }
  for (const sp of spans) {
    const block = raw.slice(sp.start, sp.end);
    const headerEnd = block.indexOf('\n', block.startsWith('\n') ? 1 : 0);
    sp.content = (headerEnd < 0 ? '' : block.slice(headerEnd + 1)).replace(/\r\n?/g, '\n').trim();
  }
  return spans;
}

/** Split an episodic day file into its `## HH:MM - title` entries. */
export function parseEpisodicDay(raw: string): EpisodicEntry[] {
  return scanEpisodicDay(raw).map(({ time, title, content }) => ({ time, title, content }));
}

function episodicBlock(entry: EpisodicEntry): string {
  return `\n## ${entry.time} - ${entry.title}\n\n${entry.content}\n`;
}

export function serializeEpisodicDay(day: string, entries: EpisodicEntry[]): string {
  return `# ${day}\n${entries.map(episodicBlock).join('')}`;
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ').trim();
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowHM(): string {
  return new Date().toISOString().slice(11, 16);
}

// ── Path helpers (shared with the flat L1 stores) ────────────────────────────

/** `{dataDir}/{userId}/memory/` — the per-user memory root. */
export function memoryRoot(dataDir: string, userId: string): string {
  if (!isSafeSegment(userId)) throw new Error(`Invalid userId for memory storage: ${userId}`);
  return path.join(dataDir, userId, MEMORY_DIR);
}

/** New canonical L1 path under `memory/`. target: 'memory' → MEMORY.md, else USER.md. */
export function l1FilePath(dataDir: string, userId: string, target: 'memory' | 'user'): string {
  return path.join(memoryRoot(dataDir, userId), target === 'memory' ? 'MEMORY.md' : 'USER.md');
}

/** Legacy flat L1 path at the user root (pre-hierarchy). */
export function legacyL1FilePath(dataDir: string, userId: string, target: 'memory' | 'user'): string {
  if (!isSafeSegment(userId)) throw new Error(`Invalid userId for memory storage: ${userId}`);
  return path.join(dataDir, userId, target === 'memory' ? 'MEMORY.md' : 'USER.md');
}

/**
 * One-way migration of a legacy root-level L1 file (`{userId}/MEMORY.md` or
 * `{userId}/USER.md`) into the hierarchical `memory/` root, then **removes the
 * legacy file** so the two locations can never coexist ("mixed" state).
 *
 * Resolution:
 *   - No legacy file → nothing to do.
 *   - Legacy exists, new absent → move legacy content into `memory/`.
 *   - Legacy exists, new present but empty while legacy has content → legacy
 *     content is preserved into `memory/` (guards against clobbering real data
 *     with an empty placeholder).
 *   - Legacy exists, new present and non-empty → `memory/` is authoritative.
 *   - In every case where a legacy file existed, it is deleted afterwards.
 *
 * Returns true when a legacy file was consolidated/removed. Idempotent: once the
 * legacy file is gone, subsequent calls are a cheap no-op.
 */
export function migrateLegacyL1(dataDir: string, userId: string, target: 'memory' | 'user'): boolean {
  const legacy = legacyL1FilePath(dataDir, userId, target);
  if (!fs.existsSync(legacy)) return false;
  const newPath = l1FilePath(dataDir, userId, target);
  try {
    // The migration writes `memory/` like every other memory writer, so it takes the
    // same per-user lock and decides inside it: a check made outside could be followed
    // by a locked writer's save, which the write below would then erase (review R4).
    // Re-entrant: a writer already holding the lock runs it in place.
    return withMemoryLock(dataDir, userId, () => {
      if (!fs.existsSync(legacy)) return false;
      const legacyContent = fs.readFileSync(legacy, 'utf-8');
      const newExists = fs.existsSync(newPath);
      const newEmpty = newExists ? fs.readFileSync(newPath, 'utf-8').trim().length === 0 : true;
      if ((!newExists || newEmpty) && legacyContent.trim().length > 0) {
        fs.mkdirSync(path.dirname(newPath), { recursive: true });
        const tmp = `${newPath}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, legacyContent, 'utf-8');
        fs.renameSync(tmp, newPath);
      }
      // Delete the legacy root file — one-way migration, no rollback leftover.
      fs.rmSync(legacy, { force: true });
      return true;
    });
  } catch {
    // Lock timeout or I/O error: the legacy file stays and the next read tries again.
    return false;
  }
}

// ── Engine ───────────────────────────────────────────────────────────────────

export class HierarchicalMemoryFileStore {
  constructor(private readonly dataDir: string) {}

  private root(user: string): string {
    return memoryRoot(this.dataDir, user);
  }

  /**
   * Every write holds the user's memory lock (`memory-lock`) — the host
   * process, the model-command MCP subprocess and the dashboard all run this
   * class, so an edit and an append can never interleave (SSOT 2026-10-23 T3).
   */
  private locked<T>(user: string, fn: () => T): T {
    return withMemoryLock(this.dataDir, user, fn);
  }

  private ensureDir(p: string): void {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }

  private writeFileAtomic(filePath: string, content: string): void {
    this.ensureDir(path.dirname(filePath));
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    try {
      fs.writeFileSync(tmp, content, 'utf-8');
      fs.renameSync(tmp, filePath);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best-effort */
      }
      throw err;
    }
  }

  // ── Locator → path / id resolution ─────────────────────────────────────────

  /** Resolve a locator into {relPath, id}, validating all segments. */
  resolve(loc: PageLocator): { relPath: string; id: string } {
    if (!isSemanticPageType(loc.type)) throw new Error(`Invalid memory page type: ${loc.type}`);
    if (loc.type === 'project') {
      const project = (loc.project || '').trim();
      if (!project || !isSafeSegment(project)) throw new Error('project locator requires a safe `project` segment');
      if (loc.issue) {
        const issue = loc.issue.trim();
        if (!isSafeSegment(issue)) throw new Error('invalid `issue` segment');
        return {
          relPath: path.join('projects', project, 'issues', `${issue}.md`),
          id: `project/${project}/${issue}`,
        };
      }
      return { relPath: path.join('projects', project, 'MEMORY.md'), id: `project/${project}` };
    }
    if (loc.type === 'cron') {
      const routine = (loc.routine || loc.slug || '').trim();
      if (!routine || !isSafeSegment(routine)) throw new Error('cron locator requires a safe `routine` segment');
      return { relPath: path.join('cron', routine, 'MEMORY.md'), id: `cron/${routine}` };
    }
    // agent | sites | concepts
    const slug = (loc.slug || '').trim();
    if (!slug || !isSafeSegment(slug)) throw new Error(`${loc.type} locator requires a safe \`slug\` segment`);
    return { relPath: path.join(loc.type, `${slug}.md`), id: `${loc.type}/${slug}` };
  }

  /**
   * Parse a canonical id (as stored in the index and shown to the model in the
   * prompt's MEMORY INDEX) back into a locator. Throws on a malformed id — see
   * `parsePageId`.
   */
  static parseId(id: string): PageLocator {
    return parsePageId(id);
  }

  // ── Page read / write ──────────────────────────────────────────────────────

  getPage(user: string, loc: PageLocator): SemanticPage | null {
    const { relPath, id } = this.resolve(loc);
    const filePath = path.join(this.root(user), relPath);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return parsePage(raw, id, loc.type, relPath);
  }

  /**
   * Create or update a semantic page.
   * - `current` (when provided) replaces the Current section.
   * - `historyEntry` (when provided) prepends a dated bullet to History.
   * At least one of title/current/historyEntry should be provided on create.
   */
  upsertPage(
    user: string,
    loc: PageLocator,
    fields: { title?: string; aliases?: string[]; current?: string; historyEntry?: string },
  ): { ok: boolean; message: string; id: string } {
    return this.locked(user, () => {
      const { relPath, id } = this.resolve(loc);
      this.ensureTaxonomy(user);
      const filePath = path.join(this.root(user), relPath);
      const existing = fs.existsSync(filePath)
        ? parsePage(fs.readFileSync(filePath, 'utf-8'), id, loc.type, relPath)
        : null;

      const title = (fields.title || existing?.title || defaultTitle(loc)).trim();
      const aliases = fields.aliases ?? existing?.aliases ?? [];
      const current = fields.current !== undefined ? fields.current.trim() : (existing?.current ?? '');
      const history = existing ? [...existing.history] : [];
      if (fields.historyEntry && fields.historyEntry.trim()) {
        history.unshift(`${todayISO()}: ${fields.historyEntry.trim()}`);
      }

      const page: SemanticPage = {
        id,
        type: loc.type,
        title,
        aliases,
        updated: todayISO(),
        current,
        history,
        relPath,
      };
      this.writeFileAtomic(filePath, serializePage(page, loc));
      this.rebuildIndex(user);
      return { ok: true, message: existing ? `Updated ${id}` : `Created ${id}`, id };
    });
  }

  removePage(user: string, loc: PageLocator): { ok: boolean; message: string } {
    return this.locked(user, () => {
      const { relPath, id } = this.resolve(loc);
      const filePath = path.join(this.root(user), relPath);
      if (!fs.existsSync(filePath)) return { ok: false, message: `No page at ${id}` };
      fs.rmSync(filePath, { force: true });
      this.rebuildIndex(user);
      return { ok: true, message: `Removed ${id}` };
    });
  }

  // ── Episodic ───────────────────────────────────────────────────────────────

  appendEpisodic(user: string, content: string, date?: string): { ok: boolean; message: string; relPath: string } {
    return this.locked(user, () => {
      const trimmed = normalizeEpisodicText(content || '');
      if (!trimmed) return { ok: false, message: 'Empty episodic content', relPath: '' };
      const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayISO();
      this.ensureTaxonomy(user);
      const relPath = path.join('episodic', `${day}.md`);
      const filePath = path.join(this.root(user), relPath);
      const firstLine = trimmed.split('\n')[0].slice(0, 80);
      const block = `\n## ${nowHM()} - ${firstLine}\n\n${trimmed}\n`;
      this.ensureDir(path.dirname(filePath));
      // Race-safe: create the day header exactly once with an exclusive open
      // (`wx` throws EEXIST if another process already created it), then always
      // append the block. Using append (never truncating write) means two
      // concurrent first-writers cannot clobber each other's block — both append.
      try {
        fs.writeFileSync(filePath, `# ${day}\n`, { encoding: 'utf-8', flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      fs.appendFileSync(filePath, block, 'utf-8');
      return { ok: true, message: `Appended episodic ${day}`, relPath };
    });
  }

  readEpisodic(user: string, date?: string): string {
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayISO();
    const filePath = path.join(this.root(user), 'episodic', `${day}.md`);
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
  }

  /** Most recent episodic file dates (descending), up to `limit`. */
  recentEpisodicDates(user: string, limit = 5): string[] {
    const dir = path.join(this.root(user), 'episodic');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.replace(/\.md$/, ''))
      .sort()
      .reverse()
      .slice(0, limit);
  }

  // ── Dashboard edits (SSOT 2026-10-23 T3) — revision-checked, under the lock ──

  /**
   * A page, its raw markdown and its revision from ONE read (null when it does
   * not exist). `representable`: the form (title / aliases / Current / History)
   * holds the file exactly — false when saving the parsed fields would drop
   * something the tolerant parser skips (a `## ` heading inside Current, a
   * multi-line History entry, any other section). Such a page is edited raw.
   */
  getPageWithRevision(
    user: string,
    loc: PageLocator,
  ): { page: SemanticPage; revision: string; raw: string; representable: boolean } | null {
    const { relPath, id } = this.resolve(loc);
    const raw = readOrNull(path.join(this.root(user), relPath));
    if (raw === null) return null;
    const page = parsePage(raw, id, loc.type, relPath);
    return { page, revision: revisionOf(raw) as string, raw, representable: isRepresentable(raw, page, loc) };
  }

  /** The revision of a page file (null when it does not exist). */
  pageRevision(user: string, loc: PageLocator): string | null {
    const { relPath } = this.resolve(loc);
    return revisionOf(readOrNull(path.join(this.root(user), relPath)));
  }

  /**
   * Replace a page wholesale — title, aliases, Current and the whole History
   * (the dashboard edits history lines too). `expectedRevision` is the
   * revision the editor loaded: `null` means "create, must not exist".
   */
  writePage(
    user: string,
    loc: PageLocator,
    fields: { title: string; aliases: string[]; current: string; history: string[] },
    expectedRevision: string | null,
  ): ConditionalWrite {
    const { relPath, id } = this.resolve(loc);
    const title = oneLine(String(fields.title ?? ''));
    if (!title) return { ok: false, reason: 'invalid', message: '제목이 비어 있습니다' };
    if (title.length > 200) return { ok: false, reason: 'invalid', message: '제목은 200자까지입니다' };
    const aliases = (Array.isArray(fields.aliases) ? fields.aliases : [])
      .map((a) => oneLine(String(a)))
      .filter(Boolean);
    if (aliases.some((a) => /[,[\]]/.test(a))) {
      return { ok: false, reason: 'invalid', message: '별칭에는 쉼표와 대괄호를 쓸 수 없습니다' };
    }
    if (aliases.length > 20 || aliases.some((a) => a.length > 80)) {
      return { ok: false, reason: 'invalid', message: '별칭은 20개, 각 80자까지입니다' };
    }
    const current = String(fields.current ?? '').trim();
    if (/^##\s/m.test(current)) {
      return {
        ok: false,
        reason: 'invalid',
        message: "Current에는 '## '로 시작하는 줄을 쓸 수 없습니다 ('### '를 쓰세요)",
      };
    }
    if (current.length > 20_000) return { ok: false, reason: 'invalid', message: 'Current는 20,000자까지입니다' };
    const history = (Array.isArray(fields.history) ? fields.history : [])
      .map((h) => oneLine(String(h)))
      .filter((h) => h && h !== '(no history yet)');
    if (history.length > 500) return { ok: false, reason: 'invalid', message: 'History는 500줄까지입니다' };

    return this.locked(user, () => {
      const filePath = path.join(this.root(user), relPath);
      const beforeRaw = readOrNull(filePath);
      const before = revisionOf(beforeRaw);
      if (before !== expectedRevision) {
        return {
          ok: false,
          reason: 'conflict',
          message:
            before === null
              ? `${id}는 이미 지워졌습니다`
              : expectedRevision === null
                ? `${id} 페이지가 이미 있습니다 — 그 페이지를 열어 고치세요`
                : `${id}가 그사이 바뀌었습니다 — 다시 불러오세요`,
        };
      }
      // Saving the form over a page it cannot hold would silently drop the rest (review R3).
      if (beforeRaw !== null && !isRepresentable(beforeRaw, parsePage(beforeRaw, id, loc.type, relPath), loc)) {
        return {
          ok: false,
          reason: 'invalid',
          message: `${id}에는 편집 양식에 담기지 않는 내용이 있습니다 — 원문(markdown)으로 고치세요`,
        };
      }
      this.ensureTaxonomy(user);
      const page: SemanticPage = { id, type: loc.type, title, aliases, updated: todayISO(), current, history, relPath };
      const raw = serializePage(page, loc);
      this.writeFileAtomic(filePath, raw);
      this.rebuildIndex(user);
      return { ok: true, id, revision: revisionOf(raw) };
    });
  }

  /**
   * Replace a page's raw markdown if it is still at `expectedRevision` — for
   * pages the form cannot hold, and anyone who wants the file as it is.
   */
  writePageRaw(user: string, loc: PageLocator, rawInput: string, expectedRevision: string): ConditionalWrite {
    const { relPath, id } = this.resolve(loc);
    let raw = String(rawInput ?? '').replace(/\r\n?/g, '\n');
    if (!raw.trim())
      return { ok: false, reason: 'invalid', message: '내용이 비어 있습니다 — 지우려면 페이지 삭제를 쓰세요' };
    if (raw.length > 60_000) return { ok: false, reason: 'invalid', message: '페이지는 60,000자까지입니다' };
    if (!raw.endsWith('\n')) raw += '\n';
    return this.locked(user, () => {
      const filePath = path.join(this.root(user), relPath);
      const before = revisionOf(readOrNull(filePath));
      if (before === null) return { ok: false, reason: 'missing', message: `${id}가 없습니다` };
      if (before !== expectedRevision) {
        return { ok: false, reason: 'conflict', message: `${id}가 그사이 바뀌었습니다 — 다시 불러오세요` };
      }
      this.writeFileAtomic(filePath, raw);
      this.rebuildIndex(user);
      return { ok: true, id, revision: revisionOf(raw) };
    });
  }

  /** Delete a page if it is still at `expectedRevision`. */
  removePageAt(user: string, loc: PageLocator, expectedRevision: string): ConditionalWrite {
    const { relPath, id } = this.resolve(loc);
    return this.locked(user, () => {
      const filePath = path.join(this.root(user), relPath);
      const before = revisionOf(readOrNull(filePath));
      if (before === null) return { ok: false, reason: 'missing', message: `${id}가 없습니다` };
      if (before !== expectedRevision) {
        return { ok: false, reason: 'conflict', message: `${id}가 그사이 바뀌었습니다 — 다시 불러오세요` };
      }
      fs.rmSync(filePath, { force: true });
      this.rebuildIndex(user);
      return { ok: true, id, revision: null };
    });
  }

  /** Every episodic day, newest first. */
  listEpisodicDates(user: string): string[] {
    return this.recentEpisodicDates(user, Number.MAX_SAFE_INTEGER);
  }

  /** One episodic day split into entries, with the revision edits are conditional on. */
  readEpisodicDay(user: string, day: string): { date: string; revision: string | null; entries: EpisodicEntry[] } {
    if (!DAY_RE.test(day)) throw new Error(`Invalid episodic date: ${day}`);
    const raw = readOrNull(path.join(this.root(user), 'episodic', `${day}.md`));
    return { date: day, revision: revisionOf(raw), entries: raw === null ? [] : parseEpisodicDay(raw) };
  }

  /**
   * Edit (`content` string) or delete (`content` null) entry `index` of a day,
   * if the day file is still at `expectedRevision`. Holding the lock means an
   * append from another process waits and lands after this write, never lost.
   */
  editEpisodicEntry(
    user: string,
    day: string,
    index: number,
    content: string | null,
    expectedRevision: string,
  ): ConditionalWrite {
    if (!DAY_RE.test(day)) return { ok: false, reason: 'invalid', message: `날짜 형식이 아닙니다: ${day}` };
    const text = content === null ? null : normalizeEpisodicText(String(content));
    if (text !== null && !text)
      return { ok: false, reason: 'invalid', message: '내용이 비어 있습니다 — 지우려면 삭제를 쓰세요' };
    const id = `episodic/${day}`;
    return this.locked(user, () => {
      const filePath = path.join(this.root(user), 'episodic', `${day}.md`);
      const raw = readOrNull(filePath);
      const before = revisionOf(raw);
      if (raw === null) return { ok: false, reason: 'missing', message: `${day} 기록이 없습니다` };
      if (before !== expectedRevision) {
        return { ok: false, reason: 'conflict', message: `${day} 기록이 그사이 바뀌었습니다 — 다시 불러오세요` };
      }
      const spans = scanEpisodicDay(raw);
      if (!Number.isInteger(index) || index < 0 || index >= spans.length) {
        return { ok: false, reason: 'invalid', message: `항목 번호가 범위를 벗어났습니다 (0–${spans.length - 1})` };
      }
      // Only this entry's bytes change; text before the first entry, other
      // entries and their line ends stay exactly as they were.
      const sp = spans[index];
      const replacement =
        text === null ? '' : episodicBlock({ time: sp.time, title: text.split('\n')[0].slice(0, 80), content: text });
      const next = raw.slice(0, sp.start) + replacement + raw.slice(sp.end);
      if (!scanEpisodicDay(next).length && !next.replace(/^# \d{4}-\d{2}-\d{2}\s*/, '').trim()) {
        fs.rmSync(filePath, { force: true });
        return { ok: true, id, revision: null };
      }
      this.writeFileAtomic(filePath, next);
      return { ok: true, id, revision: revisionOf(next) };
    });
  }

  // ── Index ──────────────────────────────────────────────────────────────────

  private indexPath(user: string): string {
    return path.join(this.root(user), 'memory-index.json');
  }

  /** Scan all semantic dirs and rewrite memory-index.json. Cheap (few files). */
  rebuildIndex(user: string): MemoryIndex {
    return this.locked(user, () => {
      const root = this.root(user);
      const entries: MemoryIndexEntry[] = [];
      const pushPage = (relPath: string, type: SemanticPageType, id: string) => {
        const fp = path.join(root, relPath);
        try {
          const page = parsePage(fs.readFileSync(fp, 'utf-8'), id, type, relPath);
          entries.push({ id, type, title: page.title, aliases: page.aliases, relPath, updated: page.updated });
        } catch {
          /* skip unreadable page */
        }
      };

      for (const flat of ['agent', 'sites', 'concepts'] as SemanticPageType[]) {
        const dir = path.join(root, flat);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.md')) continue;
          const slug = f.replace(/\.md$/, '');
          pushPage(path.join(flat, f), flat, `${flat}/${slug}`);
        }
      }

      const projectsDir = path.join(root, 'projects');
      if (fs.existsSync(projectsDir)) {
        for (const project of fs.readdirSync(projectsDir)) {
          const projDir = path.join(projectsDir, project);
          if (!fs.statSync(projDir).isDirectory()) continue;
          const projMem = path.join(projDir, 'MEMORY.md');
          if (fs.existsSync(projMem))
            pushPage(path.join('projects', project, 'MEMORY.md'), 'project', `project/${project}`);
          const issuesDir = path.join(projDir, 'issues');
          if (fs.existsSync(issuesDir)) {
            for (const f of fs.readdirSync(issuesDir)) {
              if (!f.endsWith('.md')) continue;
              const issue = f.replace(/\.md$/, '');
              pushPage(path.join('projects', project, 'issues', f), 'project', `project/${project}/${issue}`);
            }
          }
        }
      }

      const cronDir = path.join(root, 'cron');
      if (fs.existsSync(cronDir)) {
        for (const routine of fs.readdirSync(cronDir)) {
          const rMem = path.join(cronDir, routine, 'MEMORY.md');
          if (fs.existsSync(rMem)) pushPage(path.join('cron', routine, 'MEMORY.md'), 'cron', `cron/${routine}`);
        }
      }

      entries.sort((a, b) => (a.id < b.id ? -1 : 1));
      const index: MemoryIndex = { version: INDEX_VERSION, entries };
      this.writeFileAtomic(this.indexPath(user), `${JSON.stringify(index, null, 2)}\n`);
      return index;
    });
  }

  readIndex(user: string): MemoryIndex {
    const fp = this.indexPath(user);
    if (!fs.existsSync(fp)) {
      // Build lazily if pages exist but the index is missing.
      return this.rebuildIndex(user);
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8')) as MemoryIndex;
      if (!parsed.entries) return { version: INDEX_VERSION, entries: [] };
      return parsed;
    } catch {
      return this.rebuildIndex(user);
    }
  }

  /** Keyword search over index id/title/aliases (case-insensitive substring). */
  search(user: string, query: string): MemoryIndexEntry[] {
    const q = (query || '').trim().toLowerCase();
    if (!q) return [];
    return this.readIndex(user).entries.filter(
      (e) =>
        e.id.toLowerCase().includes(q) ||
        e.title.toLowerCase().includes(q) ||
        e.aliases.some((a) => a.toLowerCase().includes(q)),
    );
  }

  // ── TAXONOMY seeding ─────────────────────────────────────────────────────────

  /** Write TAXONOMY.md once (never overwrites a user-edited file). */
  ensureTaxonomy(user: string): void {
    this.locked(user, () => {
      const fp = path.join(this.root(user), 'TAXONOMY.md');
      if (fs.existsSync(fp)) return;
      this.writeFileAtomic(fp, TAXONOMY_TEMPLATE);
    });
  }
}

// ── Page (de)serialization ─────────────────────────────────────────────────────

function defaultTitle(loc: PageLocator): string {
  if (loc.type === 'project') return loc.issue ? `${loc.project} / ${loc.issue}` : (loc.project ?? 'project');
  if (loc.type === 'cron') return (loc.routine || loc.slug) ?? 'routine';
  return loc.slug ?? loc.type;
}

function serializePage(page: SemanticPage, loc: PageLocator): string {
  const slug =
    loc.type === 'project'
      ? loc.issue
        ? `${loc.project}/${loc.issue}`
        : (loc.project ?? '')
      : loc.type === 'cron'
        ? ((loc.routine || loc.slug) ?? '')
        : (loc.slug ?? '');
  const aliasesYaml = `[${page.aliases.map((a) => a.replace(/[[\]]/g, '')).join(', ')}]`;
  const historyBlock = page.history.length > 0 ? page.history.map((h) => `- ${h}`).join('\n') : '- (no history yet)';
  return [
    '---',
    `title: ${page.title}`,
    `slug: ${slug}`,
    `aliases: ${aliasesYaml}`,
    `type: ${page.type}`,
    `updated: ${page.updated}`,
    '---',
    '',
    `# ${page.title}`,
    '',
    '## Current',
    '',
    page.current || '(empty)',
    '',
    '## History',
    '',
    historyBlock,
    '',
  ].join('\n');
}

/**
 * Whether the form fields hold `raw` exactly: re-serializing the parsed page
 * (same `updated`) gives back the same bytes. The parser reads LF lines, so a
 * file with CRLF line ends does not round-trip and opens in the raw editor —
 * the conservative side.
 */
function isRepresentable(raw: string, page: SemanticPage, loc: PageLocator): boolean {
  return serializePage(page, loc) === raw.replace(/\r\n?/g, '\n');
}

/** Tolerant parser: frontmatter (best-effort) + ## Current + ## History. */
export function parsePage(raw: string, id: string, type: SemanticPageType, relPath: string): SemanticPage {
  let title = '';
  let aliases: string[] = [];
  let updated = todayISO();
  let body = raw;

  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fm) {
    body = fm[2];
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      const val = m[2].trim();
      if (key === 'title') title = val;
      else if (key === 'updated') updated = val || updated;
      else if (key === 'aliases') {
        aliases = val
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((a) => a.trim())
          .filter((a) => a.length > 0);
      }
    }
  }

  // Current section: between "## Current" and the next "## "
  let current = '';
  const curMatch = body.match(/##\s+Current\s*\n([\s\S]*?)(?:\n##\s|\s*$)/);
  if (curMatch) current = curMatch[1].trim();
  if (current === '(empty)') current = '';

  // History bullets after "## History"
  const history: string[] = [];
  const histMatch = body.match(/##\s+History\s*\n([\s\S]*)$/);
  if (histMatch) {
    for (const line of histMatch[1].split('\n')) {
      const m = line.match(/^-\s+(.*)$/);
      if (m && m[1].trim() && m[1].trim() !== '(no history yet)') history.push(m[1].trim());
    }
  }

  if (!title) {
    const h1 = body.match(/^#\s+(.+)$/m);
    title = h1 ? h1[1].trim() : id;
  }

  return { id, type, title, aliases, updated, current, history, relPath };
}

// ── TAXONOMY template (seeded per user) ────────────────────────────────────────

const TAXONOMY_TEMPLATE = `# Memory Taxonomy

Per-user hierarchical memory. Seeded automatically; safe to edit.

## Invariants
- Memory lives under \`memory/\`.
- L1 files (\`MEMORY.md\`, \`USER.md\`) are small and loaded into every prompt.
- Semantic pages use frontmatter + Current + History.
- Episodic memory is append-only raw markdown grouped by date.
- Each durable fact has one primary home.

## L1 root files
- \`MEMORY.md\` — globally reusable agent operating rules and conventions.
- \`USER.md\` — stable user profile, preferences, long-running context.
- \`TAXONOMY.md\` — this routing guide.

## Directories
- \`agent/<slug>.md\` — durable agent operating memory and workflow rules.
- \`sites/<slug>.md\` — durable knowledge about an external site/page.
- \`concepts/<slug>.md\` — reusable frameworks and generalized lessons.
- \`projects/<project>/MEMORY.md\` — project-level decisions and threads.
- \`projects/<project>/issues/<issue>.md\` — a specific issue under a project.
- \`cron/<routine>/MEMORY.md\` — recurring routine execution memory.
- \`episodic/YYYY-MM-DD.md\` — date-grouped raw observations.

## Write routing
1. Not durable beyond this session? Keep it out of memory.
2. Sparse / event-like / uncertain? Append to \`episodic/YYYY-MM-DD.md\`.
3. Changed stable understanding of a subject? Update its semantic page
   (append History first, rewrite Current only if the understanding changed).
4. Globally important at session start? Refresh \`MEMORY.md\` or \`USER.md\`.

## Promotion
- Promote episodic → semantic when repeated observations establish a durable fact.
- Promote to L1 only when stable, high-value, and useful at session start.
`;

export { TAXONOMY_TEMPLATE };
