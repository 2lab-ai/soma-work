/**
 * Devops-secret checks (.prd/16-devops-tools-architecture.md §1, §2): stored GitHub and keychain
 * credentials, and the devops broker's root-owned code and broker-owned data.
 *
 * Each check returns a short reason, or null. `evaluateToolPolicy` picks the check and its
 * arguments per tool (`checkDevopsSecretForTool`) and denies on any reason, in every permission
 * mode and for admins too. Lexical only, like the sensitive-path checks. Defense in depth: the real
 * boundary is the broker's separate OS user, not these checks.
 *
 * Also the secret store (`SECRETS_DIR`) and the approval records (.prd/25-env-access-architecture.md
 * §1, §2): no model reaches the store with any tool, and no model handles an approval or grant
 * record with a file tool. For sandboxed Bash the OS `denyRead`/`denyWrite` of the same paths
 * (`build-stream-options.ts`) is the boundary; these checks are the boundary for the native tools.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import { posix as posixPath } from 'node:path';
import { DATA_DIR, SECRETS_DIR } from '../../env-paths';

/** Root-owned code and broker-owned data of the devops broker (.prd/16-devops-tools-architecture.md §2, §8). */
const DEVOPS_BROKER_ROOTS = ['/usr/local/var/soma-devops', '/usr/local/libexec/soma-devops'];

const BROKER_PATH_REASON = 'devops broker path';

/**
 * A broker root not continued by another name character (so `soma-devops-other` is not one); the
 * leading `/` is optional to catch relative spellings. Case-insensitive: the default macOS volume is.
 */
const DEVOPS_BROKER_PATH_RE = new RegExp(
  `(?:${DEVOPS_BROKER_ROOTS.map((root) => root.slice(1)).join('|')})(?![\\w.-])`,
  'i',
);

const KEYCHAIN_SECRET_SUBCOMMANDS = ['find-generic-password', 'find-internet-password', 'dump-keychain', 'export'];

function isBrokerPath(p: string): boolean {
  return p !== '' && DEVOPS_BROKER_PATH_RE.test(posixPath.normalize(p));
}

const SECRET_STORE_REASON = 'secret store path';
const APPROVAL_RECORD_REASON = 'approval record';

/** The approval and grant records in `DATA_DIR` that only the bot's buttons and dashboard write. */
const APPROVAL_RECORD_FILES: readonly string[] = [
  'env-skill-grants.json',
  'mcp-tool-grants.json',
  'skill-perm-requests.json',
  'admin-requests.json',
  'cron-run-requests.json',
  'instruction-approvals.json',
];

/**
 * Per-owner grants: `DATA_DIR/<owner>/skill-grants.json` (`user-skill-grants-store.ts`).
 * Note: these checks read the filesystem (`realpath`), so the step-1b decision depends on what
 * exists — `evaluateToolPolicy` is pure in its inputs apart from this guard.
 */
const PER_OWNER_APPROVAL_RECORD = 'skill-grants.json';

/**
 * `name` is `record` or a sibling the stores keep beside it: the `.bak` a damaged live file falls
 * back to (`readJsonWithBackup`), so a forged backup is a forged record, and the temp files.
 */
function isRecordName(name: string, record: string): boolean {
  return name === record || name.startsWith(`${record}.`);
}

/**
 * The approval records of `dataDir` every model sandbox write-denies, each with the `.bak` it falls
 * back to: the fixed files, and the per-owner grants of every owner directory that exists when the
 * session starts. A file need not exist to be denied — creating one is the forgery. (Temp files
 * have names no model can guess, opened exclusively; the CLI deny rules cover them by pattern.)
 */
export function approvalRecordPaths(dataDir: string = DATA_DIR): string[] {
  const withBackup = (record: string) => [record, `${record}.bak`];
  const fixed = APPROVAL_RECORD_FILES.flatMap((file) => withBackup(posixPath.join(dataDir, file)));
  let owners: string[] = [];
  try {
    owners = fs
      .readdirSync(dataDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => withBackup(posixPath.join(dataDir, entry.name, PER_OWNER_APPROVAL_RECORD)));
  } catch {
    // No data directory yet: nothing of it is writable either.
  }
  return [...fixed, ...owners];
}

/**
 * The permission rules every session gets (`settings.permissions.deny`, .prd/25 §1): the CLI checks
 * them after its own path expansion, so they also hold for spellings this lexical guard cannot
 * resolve (a path relative to the session's directory). Read rules cover Grep and Glob, Edit rules
 * Write.
 */
export function secretStoreDenyRules(secretsDir: string = SECRETS_DIR, dataDir: string = DATA_DIR): string[] {
  const rule = (tool: string, p: string) => `${tool}(/${p})`;
  const stores = rootsOf(secretsDir);
  const records = rootsOf(dataDir).flatMap((root) => [
    ...APPROVAL_RECORD_FILES.map((file) => posixPath.join(root, file)),
    posixPath.join(root, '*', PER_OWNER_APPROVAL_RECORD),
  ]);
  return [
    ...stores.flatMap((store) => [
      rule('Read', store),
      rule('Read', `${store}/**`),
      rule('Edit', store),
      rule('Edit', `${store}/**`),
    ]),
    // `<record>.*`: the `.bak` and the temp files beside each record.
    ...records.flatMap((record) => [
      rule('Read', record),
      rule('Edit', record),
      rule('Read', `${record}.*`),
      rule('Edit', `${record}.*`),
    ]),
  ];
}

/**
 * `p` as written and as the OS resolves it — through its deepest existing ancestor when it does not
 * exist yet (on macOS `/var/…` is `/private/var/…`) — the spellings a root is known by.
 */
function rootsOf(p: string): string[] {
  const lexical = posixPath.normalize(p);
  return [...new Set([lexical, landing(lexical)])];
}

/** Longer than any path the OS opens (`PATH_MAX` is 1024 on macOS, 4096 on Linux). */
const MAX_OPENABLE_PATH = 4096;

/**
 * Where the target of a path lands: the deepest existing ancestor through `realpath`, then the
 * missing names. A dangling symbolic link on the way is followed to where it points (a write through
 * it creates its target). Lexical when nothing resolves, or when `p` is too long to open at all.
 */
function landing(p: string, depth = 0): string {
  if (p.length > MAX_OPENABLE_PATH) return p;
  const missing: string[] = [];
  let current = p;
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return missing.length ? posixPath.join(real, ...missing.reverse()) : real;
    } catch {
      // Not there: maybe a dangling link, else go up.
    }
    try {
      if (depth < 40 && fs.lstatSync(current).isSymbolicLink()) {
        const target = posixPath.resolve(posixPath.dirname(current), fs.readlinkSync(current));
        return landing(missing.length ? posixPath.join(target, ...[...missing].reverse()) : target, depth + 1);
      }
    } catch {
      // Not there either.
    }
    const parent = posixPath.dirname(current);
    if (parent === current) return p;
    missing.push(posixPath.basename(current));
    current = parent;
  }
}

function normalizeCase(s: string): string {
  return (s.replace(/\/+$/, '') || '/').toLowerCase();
}

/**
 * Every absolute path a tool may open for `raw`, the way the SDK reads one — trimmed, `~` / `~/` to
 * the home directory, Unicode NFC — each also where it lands through links unless `resolveLinks` is
 * off; lower-cased (macOS volumes are). Empty for a relative spelling, which {@link relativeHits}
 * checks instead.
 */
function readingsOf(raw: string, resolveLinks = true): string[] {
  const trimmed = raw.trim();
  const expanded =
    trimmed === '~'
      ? os.homedir()
      : trimmed.startsWith('~/')
        ? posixPath.join(os.homedir(), trimmed.slice(2))
        : trimmed;
  const lexicals = new Set<string>();
  for (const candidate of [raw, trimmed, expanded]) {
    for (const form of [candidate, candidate.normalize('NFC')]) {
      if (posixPath.isAbsolute(form)) lexicals.add(posixPath.normalize(form));
    }
  }
  const out = new Set<string>();
  for (const lexical of lexicals) {
    out.add(normalizeCase(lexical));
    if (resolveLinks) out.add(normalizeCase(landing(lexical)));
  }
  return [...out];
}

/** The last two names of `p`, lower-cased: how a relative spelling that reaches it must end. */
function tailOf(p: string): string {
  const parts = posixPath.normalize(p).split('/').filter(Boolean);
  return parts.slice(-2).join('/').toLowerCase();
}

function isWithin(p: string, root: string): boolean {
  return p === root || p.startsWith(root === '/' ? '/' : `${root}/`);
}

/**
 * A relative spelling (resolved by the session, which this check cannot see) that climbs with `..`
 * and then names the secret store by its last two names — `../../dev/secrets/x` — or an approval
 * record. Without a climb a relative path stays below the session's directory, and a project's own
 * `dev/secrets/` folder is not the store. The CLI deny rules ({@link secretStoreDenyRules}) hold for
 * the rest.
 */
function relativeHits(raw: string): 'store' | 'record' | null {
  const trimmed = raw.trim().normalize('NFC');
  if (trimmed === '' || posixPath.isAbsolute(trimmed) || trimmed.startsWith('~')) return null;
  const rel = `/${posixPath.normalize(trimmed).toLowerCase().replace(/\/+$/, '')}/`;
  if (!rel.split('/').includes('..')) return null;
  if (rel.includes(`/${tailOf(SECRETS_DIR)}/`)) return 'store';
  const data = posixPath.basename(DATA_DIR).toLowerCase();
  const names = rel.split('/').filter(Boolean);
  const name = names[names.length - 1] ?? '';
  if (names[names.length - 2] === data && APPROVAL_RECORD_FILES.some((file) => isRecordName(name, file))) {
    return 'record';
  }
  return names[names.length - 3] === data && isRecordName(name, PER_OWNER_APPROVAL_RECORD) ? 'record' : null;
}

/** The spellings of the secret store, lower-cased, resolved now (it may not exist yet). */
function storeRoots(): string[] {
  return rootsOf(SECRETS_DIR).map(normalizeCase);
}

/**
 * True when `raw` is the secret store or inside it, or — with `scan`, which reaches everything below
 * it — a directory above it.
 */
function isSecretStorePath(raw: string, scan: boolean, roots: string[] = storeRoots(), resolveLinks = true): boolean {
  if (relativeHits(raw) === 'store') return true;
  for (const s of readingsOf(raw, resolveLinks)) {
    for (const root of roots) {
      if (isWithin(s, root) || (scan && isWithin(root, s))) return true;
    }
  }
  return false;
}

/** `DATA_DIR/<fixed record>` or `DATA_DIR/<owner>/skill-grants.json`, or a sibling of one ({@link isRecordName}). */
function isApprovalRecord(raw: string): boolean {
  if (relativeHits(raw) === 'record') return true;
  const dataRoots = rootsOf(DATA_DIR).map(normalizeCase);
  for (const s of readingsOf(raw)) {
    for (const root of dataRoots) {
      if (s === root || !isWithin(s, root)) continue;
      const parts = s.slice(root === '/' ? 1 : root.length + 1).split('/');
      if (parts.length === 1 && APPROVAL_RECORD_FILES.some((file) => isRecordName(parts[0], file))) return true;
      if (parts.length === 2 && isRecordName(parts[1], PER_OWNER_APPROVAL_RECORD)) return true;
    }
  }
  return false;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The secret store named in a string (lower-cased match), not continued by another name character. */
function namesSecretStore(text: string): boolean {
  const lower = text.toLowerCase();
  return rootsOf(SECRETS_DIR)
    .map(normalizeCase)
    .some((root) => new RegExp(`${escapeRegExp(root)}(?![\\w.-])`).test(lower));
}

/** What separates the words of a shell string. A plain split: linear on any input. */
const SHELL_WORD_SPLIT_RE = /[\s;&|()`<>]+/;

/** What joins a path to an option, a list or a file argument (`--in=/p`, `a:/p`, `curl -d @/p`). */
const SHELL_PIECE_SPLIT_RE = /[=:,@]/;

/**
 * Path words whose links {@link commandReachesSecretStore} resolves. Past it the words are read
 * lexically only, so one command cannot cost unbounded file-system calls; the sandbox holds links.
 */
const MAX_LINK_RESOLVED_WORDS = 64;

/**
 * A path word of an unquoted shell string that reaches the secret store the way the OS reads it:
 * the word and its pieces, `{a,b}` expanded, `~` and `$HOME` expanded, `.` and `..` collapsed,
 * through links, any case. A command that changes directory first (`cd <cfg> && cat secrets/x`) or
 * a shell wildcard (`<cfg>/sec*\/x`) is past a lexical check — the sandbox `denyRead` holds there.
 */
function commandReachesSecretStore(unquoted: string): boolean {
  const roots = storeRoots();
  const seen = new Set<string>();
  const seenPieces = new Set<string>();
  for (const word of unquoted.split(SHELL_WORD_SPLIT_RE)) {
    if (!word.includes('/')) continue;
    for (const piece of [word, ...word.split(SHELL_PIECE_SPLIT_RE)]) {
      if (!piece.includes('/') || seenPieces.has(piece)) continue;
      seenPieces.add(piece);
      // Too many braces to expand: read as written (the sandbox holds what that misses).
      for (const alternative of expandBraces(piece) ?? [piece]) {
        const path = alternative.replace(/^(?:~|\$HOME)(?=\/|$)/, os.homedir());
        if (seen.has(path)) continue;
        seen.add(path);
        if (isSecretStorePath(path, false, roots, seen.size <= MAX_LINK_RESOLVED_WORDS)) return true;
      }
    }
  }
  return false;
}

/** Most alternatives a brace pattern may expand to before the check gives up enumerating it. */
const MAX_GLOB_ALTERNATIVES = 256;

/** Most brace groups a pattern may hold before the check gives up enumerating it. */
const MAX_BRACE_GROUPS = 64;

/**
 * Every alternative of a brace pattern (`{a,b}` and nested ones), innermost first; null for a
 * pattern longer than any openable path, or past {@link MAX_BRACE_GROUPS} or
 * {@link MAX_GLOB_ALTERNATIVES} — the caller decides what a pattern it cannot enumerate means.
 */
function expandBraces(pattern: string): string[] | null {
  if (!pattern.includes('{')) return [pattern];
  if (pattern.length > MAX_OPENABLE_PATH) return null;
  let groups = 0;
  for (const ch of pattern) if (ch === '{' && ++groups > MAX_BRACE_GROUPS) return null;
  let out = [pattern];
  for (;;) {
    const next: string[] = [];
    let expanded = false;
    for (const p of out) {
      const m = /\{([^{}]*)\}/.exec(p);
      if (!m) {
        next.push(p);
        continue;
      }
      expanded = true;
      for (const alt of m[1].split(',')) next.push(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length));
      if (next.length > MAX_GLOB_ALTERNATIVES) return null;
    }
    if (!expanded) return out;
    out = next;
  }
}

/**
 * A Glob walk over `target` that starts in the secret store or above it. The walk starts at the
 * directory above the first segment with a wildcard (`/cfg/sec*\/x` walks `/cfg/`) and reaches
 * everything below it.
 */
function globWalkReachesStore(target: string): boolean {
  if (namesSecretStore(target)) return true;
  const first = target.search(/[*?[]/);
  if (first === -1) return isSecretStorePath(target, false);
  const head = target.slice(0, first);
  const walkRoot = head.slice(0, head.lastIndexOf('/') + 1);
  return walkRoot !== '' && isSecretStorePath(walkRoot, true);
}

/** True for a short-flag cluster or long flag that makes `gh auth status` print the token. */
function isShowTokenFlag(word: string): boolean {
  return word === '--show-token' || word.startsWith('--show-token=') || /^-[A-Za-z]*t[A-Za-z]*$/.test(word);
}

/** A shell string with quotes and backslashes dropped as the shell would, and `//`, `/./` collapsed. */
function unquoteShell(command: string): string {
  return command
    .replace(/['"\\]/g, '')
    .replace(/\/\.(?=\/)/g, '')
    .replace(/\/{2,}/g, '/');
}

/**
 * The words of each simple command in an unquoted shell string, so `bash -c 'gh auth token'` and
 * `$(gh auth token)` yield `gh auth token`.
 */
function shellSegments(unquoted: string): string[][] {
  return unquoted.split(/[;&|\n\r()`{}<>]/).map((segment) => segment.split(/\s+/).filter(Boolean));
}

function basename(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

/** Bash: a command that prints a stored credential or names the broker's paths. */
export function checkDevopsSecretCommand(command: string): string | null {
  const unquoted = unquoteShell(command);
  if (DEVOPS_BROKER_PATH_RE.test(unquoted) || /soma-devops-broker/i.test(unquoted)) {
    return BROKER_PATH_REASON;
  }
  if (namesSecretStore(unquoted) || commandReachesSecretStore(unquoted)) return SECRET_STORE_REASON;
  for (const words of shellSegments(unquoted)) {
    for (let i = 0; i < words.length; i++) {
      const name = basename(words[i]);
      const rest = words.slice(i + 1);
      if (name === 'gh') {
        // `gh auth …` only: `auth` must be the first non-flag word, so `gh pr list --search "auth token"` passes.
        const sub = rest.findIndex((w) => !w.startsWith('-'));
        if (sub === -1 || rest[sub] !== 'auth') continue;
        const authArgs = rest.slice(sub + 1);
        if (authArgs.includes('token')) return 'gh auth token';
        if (authArgs.includes('git-credential')) return 'gh auth git-credential';
        if (authArgs.includes('status') && authArgs.some(isShowTokenFlag)) return 'gh auth status --show-token';
      } else if (name === 'security' && rest.some((w) => KEYCHAIN_SECRET_SUBCOMMANDS.includes(w))) {
        return 'keychain secret read';
      }
    }
  }
  return null;
}

/**
 * Read, Edit and Write `file_path`, Grep `path`: a path under a broker root; the secret store, a path
 * in it or (Grep's scan) a directory above it; an approval record.
 */
export function checkDevopsSecretPath(filePath: string): string | null {
  if (isBrokerPath(filePath)) return BROKER_PATH_REASON;
  if (isSecretStorePath(filePath, true)) return SECRET_STORE_REASON;
  if (isApprovalRecord(filePath)) return APPROVAL_RECORD_REASON;
  return null;
}

/**
 * Glob: the pattern, the base path, or both joined, under a broker root; a walk that starts in the
 * secret store or above it. An absolute pattern walks from its own root — the CLI ignores `path`
 * then — so the pattern is checked alone as well as joined to `path`. A relative pattern with no
 * `path` (`**\/*.ts`) walks the session's directory, which this check cannot see — the CLI deny
 * rules hold there.
 */
export function checkDevopsSecretGlob(pattern: string, basePath: string): string | null {
  const joined = basePath && pattern ? posixPath.join(basePath, pattern) : '';
  if (isBrokerPath(pattern) || isBrokerPath(basePath) || isBrokerPath(joined)) return BROKER_PATH_REASON;
  for (const target of new Set([pattern.trim(), joined.trim()])) {
    if (target === '') continue;
    const alternatives = expandBraces(target);
    if (alternatives === null || alternatives.some(globWalkReachesStore)) return SECRET_STORE_REASON;
  }
  return null;
}
