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
import * as fs from 'fs';
import * as path from 'path';

export const MEMORY_DIR = 'memory';

/** Semantic page categories addressable by the model. */
export type SemanticPageType = 'agent' | 'sites' | 'concepts' | 'project' | 'cron';

const SEMANTIC_TYPES: SemanticPageType[] = ['agent', 'sites', 'concepts', 'project', 'cron'];

/** Where a semantic page lives. project/issue/cron use nested locators. */
export interface PageLocator {
  type: SemanticPageType;
  /** agent | sites | concepts page slug */
  slug?: string;
  /** projects/<project>/... */
  project?: string;
  /** projects/<project>/issues/<issue>.md (omit → project-level MEMORY.md) */
  issue?: string;
  /** cron/<routine>/MEMORY.md */
  routine?: string;
}

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

function isSafeSegment(s: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(s) && s !== '.' && s !== '..';
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
    const legacyContent = fs.readFileSync(legacy, 'utf-8');
    const newExists = fs.existsSync(newPath);
    const newEmpty = newExists ? fs.readFileSync(newPath, 'utf-8').trim().length === 0 : true;
    if ((!newExists || newEmpty) && legacyContent.trim().length > 0) {
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      fs.writeFileSync(newPath, legacyContent, 'utf-8');
    }
    // Delete the legacy root file — one-way migration, no rollback leftover.
    fs.rmSync(legacy, { force: true });
    return true;
  } catch {
    return false;
  }
}

// ── Engine ───────────────────────────────────────────────────────────────────

export class HierarchicalMemoryFileStore {
  constructor(private readonly dataDir: string) {}

  private root(user: string): string {
    return memoryRoot(this.dataDir, user);
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
    if (!SEMANTIC_TYPES.includes(loc.type)) throw new Error(`Invalid memory page type: ${loc.type}`);
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

  /** Parse a canonical id (as stored in the index) back into a locator. */
  static parseId(id: string): PageLocator {
    const parts = id.split('/');
    const type = parts[0] as SemanticPageType;
    if (type === 'project') {
      if (parts.length === 3) return { type, project: parts[1], issue: parts[2] };
      return { type, project: parts[1] };
    }
    if (type === 'cron') return { type, routine: parts[1] };
    return { type, slug: parts.slice(1).join('/') };
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
    const { relPath, id } = this.resolve(loc);
    this.ensureTaxonomy(user);
    const filePath = path.join(this.root(user), relPath);
    const existing = fs.existsSync(filePath) ? parsePage(fs.readFileSync(filePath, 'utf-8'), id, loc.type, relPath) : null;

    const title = (fields.title || existing?.title || defaultTitle(loc)).trim();
    const aliases = fields.aliases ?? existing?.aliases ?? [];
    const current = fields.current !== undefined ? fields.current.trim() : existing?.current ?? '';
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
  }

  removePage(user: string, loc: PageLocator): { ok: boolean; message: string } {
    const { relPath, id } = this.resolve(loc);
    const filePath = path.join(this.root(user), relPath);
    if (!fs.existsSync(filePath)) return { ok: false, message: `No page at ${id}` };
    fs.rmSync(filePath, { force: true });
    this.rebuildIndex(user);
    return { ok: true, message: `Removed ${id}` };
  }

  // ── Episodic ───────────────────────────────────────────────────────────────

  appendEpisodic(user: string, content: string, date?: string): { ok: boolean; message: string; relPath: string } {
    const trimmed = (content || '').trim();
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

  // ── Index ──────────────────────────────────────────────────────────────────

  private indexPath(user: string): string {
    return path.join(this.root(user), 'memory-index.json');
  }

  /** Scan all semantic dirs and rewrite memory-index.json. Cheap (few files). */
  rebuildIndex(user: string): MemoryIndex {
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
        if (fs.existsSync(projMem)) pushPage(path.join('projects', project, 'MEMORY.md'), 'project', `project/${project}`);
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
    const fp = path.join(this.root(user), 'TAXONOMY.md');
    if (fs.existsSync(fp)) return;
    this.writeFileAtomic(fp, TAXONOMY_TEMPLATE);
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
        ? (loc.routine || loc.slug) ?? ''
        : (loc.slug ?? '');
  const aliasesYaml = `[${page.aliases.map((a) => a.replace(/[[\]]/g, '')).join(', ')}]`;
  const historyBlock =
    page.history.length > 0 ? page.history.map((h) => `- ${h}`).join('\n') : '- (no history yet)';
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
