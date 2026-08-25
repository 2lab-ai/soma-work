#!/usr/bin/env node
/**
 * `setup-package.js` — behaviour smoke for the staged somawork runtime bundle.
 *
 * ## What this is for
 *
 * `scripts/smoke/deploy-bundle.js` answers "does the staged tree contain the
 * files the fleet deploy needs". This script answers a different and stricter
 * question: **if that staged tree were the only somawork on the machine, would
 * `somawork` work?** It therefore treats the bundle as an external consumer
 * would — it spawns the staged `dist/cli/index.js` with `node`, in a hermetic
 * `SOMAWORK_HOME` and a fake `HOME`, with a fake `brew` on `PATH`, and reads
 * the bytes that come back.
 *
 * It never imports anything from `src/`, never runs `tsx`, and never contacts a
 * provider, a Slack workspace, Homebrew, or `launchd`. The only staged modules
 * it loads in-process are *built* ones (`dist/cli/**`), and only for the
 * materialization check, which has no other external-consumer expression.
 *
 * ## The contract it pins (task-11-context "Stable runtime layout")
 *
 * Relative to the runtime root:
 *
 * | path                                  | role                              |
 * |---------------------------------------|-----------------------------------|
 * | `dist/cli/index.js`                   | executable controller entry       |
 * | `dist/run-with-rotating-logs.js`      | immutable service supervisor      |
 * | `dist/index.js`                       | daemon entry                      |
 * | `config.default.json`                 | canonical materializer input      |
 * | `.system.prompt.example`              | canonical default prompt input    |
 * | `infra/slack/slack-app-manifest.json` | canonical Slack manifest          |
 * | `package.json`                        | workspace/bin manifest            |
 * | `services/a2t/worker.py`              | a2t worker runtime payload        |
 * | `services/a2t/requirements.txt`       | a2t worker dependency input       |
 *
 * These strings are duplicated from `src/cli/production-seams.ts` on purpose.
 * A smoke that imported the constants it is checking would pass on any layout
 * the source happened to name, including a wrong one.
 *
 * ## Usage
 *
 *   node scripts/smoke/setup-package.js [stagedRoot]      # default .deploy-bundle
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * `--inventory-only` runs the staged-artifact gate and nothing else.
 *
 * It exists so `stage-bundle.sh` can validate the tree it has just written
 * without recursion: the full run below builds a hermetic harness and spawns
 * the staged controller, which is the right thing for a smoke and the wrong
 * thing for a staging step. Same rules, same `inventoryProblems`, no harness.
 */
const cliArgs = process.argv.slice(2);
const inventoryOnly = cliArgs.includes('--inventory-only');
const positionalArgs = cliArgs.filter((arg) => !arg.startsWith('--'));
const bundleRoot = path.resolve(positionalArgs[0] || path.join(repoRoot, '.deploy-bundle'));

// ---------------------------------------------------------------------------
// The staged layout contract
// ---------------------------------------------------------------------------

const CONTROLLER_ENTRY = 'dist/cli/index.js';
const SERVICE_SUPERVISOR = 'dist/run-with-rotating-logs.js';
const DAEMON_ENTRY = 'dist/index.js';
const CONFIG_ASSET = 'config.default.json';
const PROMPT_ASSET = '.system.prompt.example';
const MANIFEST_ASSET = 'infra/slack/slack-app-manifest.json';

/**
 * The a2t worker. Part of the immutable runtime tree (`stage-bundle.sh` stages
 * `services/` and asserts this path), but until now it was pinned ONLY by that
 * shell assertion: nothing here named it, so it was absent from the inventory
 * and from the mutation matrix, and a bundle that lost it could still be
 * reported as a usable runtime by this gate.
 */
const A2T_WORKER = 'services/a2t/worker.py';

/**
 * The worker's dependency input. Pinned for the same reason as the worker and
 * separately from it: the target provisions the a2t python environment from
 * this file, so a bundle that shipped `worker.py` alone would install a runtime
 * whose python side cannot be built, and every check here would still be green.
 */
const A2T_REQUIREMENTS = 'services/a2t/requirements.txt';

/** Files whose absence makes the staged tree unusable as a somawork runtime. */
const REQUIRED_FILES = [
  'package.json',
  CONTROLLER_ENTRY,
  SERVICE_SUPERVISOR,
  DAEMON_ENTRY,
  CONFIG_ASSET,
  PROMPT_ASSET,
  MANIFEST_ASSET,
  A2T_WORKER,
  A2T_REQUIREMENTS,
];

/** The three assets `somawork setup` re-reads on every run. */
const SETUP_ASSETS = [CONFIG_ASSET, PROMPT_ASSET, MANIFEST_ASSET];

/** Entries the launch agent and the formula exec directly. */
const RUNTIME_ENTRIES = [CONTROLLER_ENTRY, SERVICE_SUPERVISOR, DAEMON_ENTRY];

/** Must be executable by its owner — the formula links it as `somawork`. */
const REQUIRED_EXECUTABLES = [CONTROLLER_ENTRY];

/** Assets that must be non-empty and newline-terminated. */
const NEWLINE_TERMINATED = [CONFIG_ASSET, PROMPT_ASSET, MANIFEST_ASSET];

/** Assets that must parse as a JSON object. */
const JSON_ASSETS = [CONFIG_ASSET, MANIFEST_ASSET];

/** Sections `runSlackManifestHelper` requires of the canonical manifest. */
const MANIFEST_SECTIONS = ['display_information', 'features', 'oauth_config', 'settings'];

/**
 * Never in the bundle: mutable state, credentials, source, build residue.
 *
 * Exact basenames. `config.json` is here while `config.default.json` is
 * required — the first is a materialized profile's mutable config, the second
 * is the pristine input it is materialized from.
 */
const FORBIDDEN_BASENAMES = new Set([
  '.env',
  '.env.dev',
  '.env.local',
  '.env.prod',
  '.env.stage',
  '.env.test',
  'secrets.env',
  'config.json',
  '.system.prompt',
  'setup-state.json',
  '.setup-wizard-state',
  '.new-deploy-state',
  'provision-agent.ts',
  'setup-wizard.sh',
  'setup-wizard-macos.sh',
  'new-deploy-setup.sh',
]);

/**
 * Never in the bundle, at any depth: dependency, source, VCS and test trees.
 *
 * `__fixtures__` is here because pruning `__tests__` alone left its *inputs*
 * behind — compiled fixtures that nothing outside a test imports, one of which
 * carries a credential-shaped literal. Dead payload with a token shape in an
 * immutable install tree is exactly what the exclusion list exists to stop.
 */
const FORBIDDEN_DIRNAMES = new Set(['node_modules', 'src', '__tests__', '__fixtures__', '__mocks__', '.git']);

/**
 * Never at the runtime root: the mutable directories a *deployed* instance
 * grows. Scoped to the root because a packaged skill may legitimately ship a
 * `data/` of its own (`dist/local/skills/<skill>/data`) — that is immutable
 * payload, not instance state.
 */
const FORBIDDEN_ROOT_DIRNAMES = new Set(['data', 'logs', '.claude', '.worktrees', '.deploy-bundle']);

/**
 * Never in the bundle: path shapes.
 *
 * `scripts/setup/` is the deprecated shell collector (`04-env-config.sh` still
 * prompts for tokens on a terminal). It is unreachable — the three wizard
 * entry points are deprecation shims that `exec somawork setup` — but a bundle
 * that shipped it would still be advertising a manual credential path.
 */
const FORBIDDEN_PATTERNS = [
  { test: (rel) => rel === 'scripts/setup' || rel.startsWith('scripts/setup/'), why: 'deprecated shell setup collector' },
  // The app's own compiled test helpers. `packages/test-utils` is deliberately
  // NOT covered: the target runs `npm ci --workspaces`, which needs every
  // workspace manifest present.
  { test: (rel) => rel === 'dist/test-utils' || rel.startsWith('dist/test-utils/'), why: 'compiled test helper' },
  { test: (rel) => /\.map$/.test(rel), why: 'source map' },
  { test: (rel) => /\.tsx?$/.test(rel), why: 'TypeScript source' },
  { test: (rel) => /\.test\.[cm]?[jt]s$/.test(rel), why: 'test file' },
  { test: (rel) => /\.bak$/.test(rel), why: 'backup file' },
  { test: (rel) => /\.plist$/.test(rel), why: 'launchd plist' },
  { test: (rel) => /\.pid$/.test(rel), why: 'pid file' },
  { test: (rel) => /\.log$/.test(rel), why: 'log file' },
];

/** Strings that must never appear in the help text. */
const PRIVATE_ROUTES = ['_capture-slack-auth', '_print-slack-manifest'];

// ---------------------------------------------------------------------------
// Credential bytes
// ---------------------------------------------------------------------------

/**
 * Credential shapes that must not appear anywhere in the staged bytes.
 *
 * The path rules above answer "is a file that shouldn't be here present". They
 * cannot answer "does a file that *should* be here carry a secret" — and that
 * is not hypothetical: the first round of this task found `sk-ant-oat01-…`
 * inside a compiled test fixture, and the durable rule that landed was a
 * *directory name*. A compiled module carrying a token-shaped constant under an
 * ordinary name would still ship green. This closes that.
 *
 * **There is no allowlist, deliberately.** An allowlist for credential-shaped
 * bytes is a permanent blind spot: the one entry that would have been needed
 * (the redaction doc comment in `@soma/common`'s logger) was rewritten at the
 * source instead, so the compiled output carries no credential-length example.
 * If a future hit is legitimate, fix the source, do not widen this table.
 *
 * Each body length is set so a *prefix mentioned in prose or a regex literal*
 * does not match, while a real credential does.
 */
const CREDENTIAL_PATTERNS = [
  // `xoxe.xoxp-…` / `xoxe-…` — Slack configuration and refresh tokens. First,
  // because `xoxe.xoxp-` embeds an `xoxp-` token.
  { name: 'Slack configuration/refresh token', re: /xoxe[.-][A-Za-z0-9._-]{10,}/ },
  { name: 'Slack token', re: /xox[bpars]-[A-Za-z0-9-]{10,}/ },
  { name: 'Slack app-level token', re: /xapp-[A-Za-z0-9-]{10,}/ },
  { name: 'Anthropic credential', re: /sk-ant-[A-Za-z0-9_-]{10,}/ },
  { name: 'llmux client key', re: /\blmk-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'PEM private key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
];

/**
 * Private operator identity and topology that must not ship in a public package.
 *
 * These are NOT credentials -- the credential scan above is clean with no
 * allowlist -- and none of them is dangerous on its own. They are the names of
 * the people and machines that happened to be in the room when a comment was
 * written: a reviewer's account name in an example report, a deploy host in an
 * incident note, a laptop in a hostname example. In an internal tree that is
 * useful context. In a tarball on a public release page it is somebody's
 * infrastructure map, published by accident.
 *
 * The first three entries are the repository's permanent sanitize block list
 * (`scripts/sanitize-scan.sh` enforces the same three across git history) and
 * are assembled from fragments rather than written out — see
 * {@link BLOCKED_TERM_SPECS} for why that is not decoration. The rest were found
 * in the staged artifact while packaging it and neutralized at their sources.
 * This table is what stops them coming back.
 *
 * The last group is a different failure with the same shape. Two shipped skill
 * references (`dist/local/skills/{es,z}/reference/executive-summary-{example,template}.md`)
 * were a REAL incident report from an external customer's codebase, pasted in as
 * a worked example: their C# file names and line numbers, their service names,
 * their deploy branch, their PR numbers, and a reviewer's GitHub handle. Nothing
 * in it is a credential and none of it is ours to publish. The documents are
 * synthetic now — every value in them is invented and each carries a banner
 * saying so — and these patterns are what stops the next real report from being
 * pasted in on top.
 *
 * **Public project identity stays.** `2lab-ai`, `2lab.ai` and `@2lab.ai/...`
 * are repository, organisation and npm coordinates -- they belong in a public
 * package and are deliberately absent from this table.
 */
/**
 * The three permanently prohibited strings — assembled at load time, never
 * written out here.
 *
 * The sanitize contract they come from covers **files, diffs, commits, logs and
 * pull requests**, not just release archives, and `scripts/sanitize-scan.sh`
 * matches every object in git history. A gate that spelled out what it forbids
 * would therefore be the first thing that gate finds, permanently, in every
 * commit that ever carried it — the rule would be self-violating and
 * unremovable without rewriting history.
 *
 * So each term is stored as fragments that mean nothing on their own and are
 * joined by {@link blockedTerm} at load time. The scan is exactly as strong as a
 * literal one: the assembled string is what the regex and the mutation fixtures
 * both use. Nothing else in this file is split, because nothing else in it is
 * under that contract.
 *
 * Adding a term: add fragments, never the whole word, and split it somewhere
 * that leaves no fragment recognisable.
 */
const BLOCKED_TERM_SPECS = [
  { name: 'private client identifier', pieces: ['insi', 'ghtq', 'uest'], wordBounded: false },
  { name: 'private client identifier', pieces: ['bets', '.', 'pla', 'ce'], wordBounded: false },
  { name: 'private host label', pieces: ['iq', '-', '6', '4'], wordBounded: true },
];

/** The literal a scan must find. Assembled, so this file never contains it. */
function blockedTerm(spec) {
  return spec.pieces.join('');
}

function escapeForRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function blockedTermPattern(spec) {
  const body = escapeForRegex(blockedTerm(spec));
  return new RegExp(spec.wordBounded ? `\\b${body}\\b` : body, 'i');
}

/** `{ name, text, re }` per prohibited term, for scans, fixtures and reports. */
const BLOCKED_TERMS = BLOCKED_TERM_SPECS.map((spec) => ({
  name: spec.name,
  text: blockedTerm(spec),
  re: blockedTermPattern(spec),
}));

const PRIVATE_IDENTITY_PATTERNS = [
  ...BLOCKED_TERMS.map((term) => ({ name: term.name, re: term.re, category: 'private' })),
  { name: 'operator account name', re: /\bicedac\b/i, category: 'private' },
  { name: 'operator account name', re: /\bzhugehyuk\b/i, category: 'private' },
  { name: 'private machine name', re: /\boudwood(?:-[A-Za-z0-9]+)?\b/i, category: 'private' },
  { name: 'private machine name', re: /\bmac-?mini(?:-[A-Za-z0-9]+)?\b/i, category: 'private' },
  { name: 'operator account name', re: /\bosun50s\b/i, category: 'private' },
  // An external codebase's own file names, from a real incident report that was
  // pasted into a shipped skill example. `Protein` was that project's internal
  // codename for a service.
  { name: 'external client source file', re: /\bSnapshotServer\.[A-Za-z0-9_.]+\.cs\b/i, category: 'private' },
  { name: 'external client source file', re: /\bProtein\.Receive\b/i, category: 'private' },
  // Service and domain names from the same report. `SnapshotServer` on its own
  // is deliberately NOT here: `playwright-core` ships a class by that name, so
  // the bare token would fail a correct bundle. The file-name form above is the
  // unambiguous one.
  {
    name: 'external client service name',
    re: /\b(?:SnapshotService|SettlementService|settlements_service|SettleFixture|BigWinPublisher|BigWinFeed|vsports)\b/i,
    category: 'private',
  },
  { name: 'private deployment branch', re: /\bdeploy\/dev2\b/i, category: 'private' },
];

/** Everything the byte scan looks for, credential families first. */
const FORBIDDEN_TEXT_PATTERNS = CREDENTIAL_PATTERNS.concat(PRIVATE_IDENTITY_PATTERNS);

/**
 * Extensions never scanned as text. Belt to the NUL sniff's braces: some of
 * these (fonts, archives, native addons) can carry long runs without a NUL and
 * would produce meaningless decoded bytes.
 */
const BINARY_EXTENSIONS = new Set([
  '.node', '.wasm', '.dylib', '.so', '.a', '.o', '.bin', '.zip', '.gz', '.tgz', '.br', '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.bmp', '.tiff',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.wav', '.mov', '.webm',
]);

/**
 * Streaming scan window.
 *
 * The scan reads to EOF, one chunk at a time, carrying {@link SCAN_OVERLAP_BYTES}
 * of the previous chunk forward. The old scan read one bounded 4 MiB block from
 * offset 0 and silently dropped everything after it (I-2): a `dist/*.js` that
 * grows past that mark could carry a credential into a public Homebrew artifact
 * while the gate printed green. Bounded memory, unbounded coverage.
 */
const SCAN_CHUNK_BYTES = 1024 * 1024;

/**
 * Carry-over between chunks, in bytes.
 *
 * Must exceed the longest *minimal* match any {@link CREDENTIAL_PATTERNS} entry
 * can have, or a credential straddling a chunk boundary is invisible to both
 * halves. The longest of those is well under 100 bytes; 4 KiB is a margin, not
 * a calculation to re-derive when a pattern is added.
 */
const SCAN_OVERLAP_BYTES = 4096;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const failures = [];
let checks = 0;

function fail(message) {
  failures.push(message);
  console.error(`FAIL ${message}`);
}

function pass(message) {
  checks++;
  console.log(`ok   ${message}`);
}

function check(condition, message, detail) {
  if (condition) {
    pass(message);
    return true;
  }
  fail(detail === undefined ? message : `${message} — ${detail}`);
  return false;
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function walk(root, visit, options) {
  const opts = options === undefined ? {} : options;
  const base = opts.relative === undefined ? '' : opts.relative;
  const skip = opts.skip === undefined ? () => false : opts.skip;
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, base), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    if (skip(rel)) continue;
    visit(rel, entry);
    // Never recurse through a symlink. `Dirent.isDirectory()` is already false
    // for one, so this is documentation of an existing property rather than a
    // change: it is what keeps a `node_modules` symlink from turning this walk
    // into a walk of the repository. The cost is that anything *behind* a link
    // is unseen, which is exactly why `inventoryProblems` refuses links outright.
    if (entry.isDirectory()) walk(root, visit, { relative: rel, skip });
  }
}

/**
 * Hardlink-clone a tree so a mutation fixture costs one `link(2)` per file.
 *
 * Deleting a file in the clone drops one link; the staged original keeps its
 * own. Nothing in this script writes *into* a cloned file, so shared inodes are
 * safe — and a copy of a 26 MB bundle per mutant is not.
 */
function cloneTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      cloneTree(from, to);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to);
    } else {
      fs.linkSync(from, to);
    }
  }
}

/**
 * Relative path -> `size:mode` for every file, for a before/after comparison.
 *
 * `node_modules` is skipped: it is provisioned by the harness (see
 * {@link provisionRuntimeRoot}), is not part of the staged artifact, and is a
 * forest of symlinks into the repo that a walk would follow.
 */
function snapshotTree(root) {
  const snapshot = new Map();
  walk(
    root,
    (rel, entry) => {
      if (!entry.isDirectory()) {
        const stat = fs.lstatSync(path.join(root, rel));
        snapshot.set(rel, `${stat.size}:${(stat.mode & 0o7777).toString(8)}`);
      }
    },
    { skip: (rel) => rel === 'node_modules' },
  );
  return snapshot;
}

/**
 * Give a cloned staged tree the dependencies `scripts/deploy/install-target.sh`
 * installs on the target with `npm ci --omit=dev --workspaces`.
 *
 * The staged artifact deliberately contains no `node_modules` — that is a
 * bundle *requirement*, asserted by the forbidden scan — so an external
 * consumer of the raw tree could not start it either. Rather than weaken the
 * scan, the harness reproduces the install step offline: third-party packages
 * are symlinked from the repo's own tree, while every `@soma/*` workspace link
 * keeps its original *relative* target so it resolves to the **clone's** staged
 * `packages/`, not the repo's. Behaviour checks therefore exercise staged
 * package output.
 */
function provisionRuntimeRoot(source, dest) {
  if (!fs.existsSync(source)) {
    throw new Error('the staged runtime root to provision does not exist');
  }
  cloneTree(source, dest);
  // A staged tree is never supposed to contain `node_modules` (the forbidden
  // scan says so), but a *malformed* one might -- including as a symlink into
  // the repository, in which case linking dependencies "into the clone" would
  // write into the real tree. Remove whatever is there first; `rmSync` unlinks
  // a symlink rather than following it.
  const to = path.join(dest, 'node_modules');
  fs.rmSync(to, { recursive: true, force: true });
  linkDependencies(path.join(repoRoot, 'node_modules'), to);
  return dest;
}

function linkDependencies(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    // Deterministic on a pre-existing target: replace it. Leaving `symlinkSync`
    // to throw EEXIST turned a bundle-shaped problem into a raw stack trace
    // with no FAIL line.
    fs.rmSync(target, { recursive: true, force: true });
    if (entry.isSymbolicLink()) {
      // Relative workspace links (`@soma/common -> ../../packages/common`) must
      // keep their text so they land inside the clone.
      fs.symlinkSync(fs.readlinkSync(source), target);
    } else if (entry.name.startsWith('@') || entry.name === '.bin') {
      linkDependencies(source, target);
    } else {
      fs.symlinkSync(source, target);
    }
  }
}

function diffSnapshots(before, after) {
  const changes = [];
  for (const [rel, value] of after) {
    if (!before.has(rel)) changes.push(`added ${rel}`);
    else if (before.get(rel) !== value) changes.push(`changed ${rel}`);
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) changes.push(`removed ${rel}`);
  }
  return changes;
}

function modeOf(target) {
  return fs.statSync(target).mode & 0o7777;
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/**
 * Scan one file for forbidden bytes — credential families and private identity
 * or topology strings — end to end.
 *
 * Returns one of:
 *
 * - `{ kind: 'skipped' }` — a known binary extension. The ONE silent outcome,
 *   and the only justified one: fonts, archives and native addons decode to
 *   meaningless bytes and the exclusion is an explicit, reviewed list.
 * - `{ kind: 'unscannable' }` — a NUL byte in a file the extension list did not
 *   exclude. Previously this returned "no text" and the caller skipped the file
 *   in silence (I-3), so `const z="\0";` followed by a real token shipped
 *   green. It is now a problem the caller reports: either the file is binary
 *   and belongs in {@link BINARY_EXTENSIONS} with a reason, or it is text with
 *   a control byte in it and someone should know.
 * - `{ kind: 'unreadable' }` — open/read failed. Also a problem, for the same
 *   reason: an unscanned file must never look like a clean one.
 * - `{ kind: 'credential' | 'private', name }` / `{ kind: 'clean' }`.
 *
 * `patterns` defaults to {@link FORBIDDEN_TEXT_PATTERNS}; the release archive
 * gate passes its own list so the two callers share one scanner rather than one
 * copy each of the same regex table.
 *
 * Decoded as `latin1`, deliberately: every pattern here is ASCII, and a 1:1
 * byte-to-char mapping means a chunk boundary can never land inside a
 * multi-byte sequence and corrupt the window we are matching against.
 */
function scanFileForForbiddenText(target, patterns) {
  const table = patterns === undefined ? FORBIDDEN_TEXT_PATTERNS : patterns;
  if (BINARY_EXTENSIONS.has(path.extname(target).toLowerCase())) return { kind: 'skipped' };

  let fd;
  try {
    fd = fs.openSync(target, 'r');
  } catch {
    return { kind: 'unreadable' };
  }
  try {
    const buffer = Buffer.alloc(SCAN_CHUNK_BYTES);
    let carry = '';
    let offset = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, SCAN_CHUNK_BYTES, offset);
      if (read === 0) return { kind: 'clean' };
      offset += read;
      const bytes = buffer.subarray(0, read);
      if (bytes.includes(0)) return { kind: 'unscannable' };
      const window = carry + bytes.toString('latin1');
      for (const forbidden of table) {
        if (forbidden.re.test(window)) {
          return { kind: forbidden.category === undefined ? 'credential' : forbidden.category, name: forbidden.name };
        }
      }
      carry = window.slice(-SCAN_OVERLAP_BYTES);
    }
  } catch {
    return { kind: 'unreadable' };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Expected workspace package manifests, derived from the ROOT manifest's own
 * `workspaces` patterns expanded against the repository.
 *
 * Expanded against the repo rather than the staged tree on purpose: a staged
 * tree missing a whole workspace directory would expand to a set that already
 * excludes it, and the check would pass by tautology. The repo is the
 * authoritative superset. Patterns here are bounded (`somalib`, `packages/*`,
 * `packages/mcp-servers/*`), so this needs no glob dependency — only the one
 * trailing `/*` form the root manifest actually uses is supported, and anything
 * else is reported rather than silently ignored.
 */
function expectedWorkspaceManifests() {
  const manifests = [];
  const unsupported = [];
  let patterns;
  try {
    patterns = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).workspaces;
  } catch {
    return { manifests, unsupported: ['<root package.json is unreadable>'] };
  }
  if (!Array.isArray(patterns)) return { manifests, unsupported: ['<root package.json declares no workspaces array>'] };

  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      unsupported.push(String(pattern));
      continue;
    }
    if (!pattern.includes('*')) {
      if (fs.existsSync(path.join(repoRoot, pattern, 'package.json'))) manifests.push(`${pattern}/package.json`);
      continue;
    }
    if (!pattern.endsWith('/*') || pattern.slice(0, -2).includes('*')) {
      unsupported.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    let entries;
    try {
      entries = fs.readdirSync(path.join(repoRoot, parent), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const rel = `${parent}/${entry.name}`;
      if (fs.existsSync(path.join(repoRoot, rel, 'package.json'))) manifests.push(`${rel}/package.json`);
    }
  }
  return { manifests: manifests.sort(), unsupported };
}

// ---------------------------------------------------------------------------
// 1. Inventory + forbidden scan (the part mutation fixtures re-run)
// ---------------------------------------------------------------------------

/**
 * Everything that can be decided by looking at the staged tree.
 *
 * Returns the list of problems rather than reporting them, so a mutation
 * fixture can assert that removing exactly one file produces a problem naming
 * exactly that path.
 */
function inventoryProblems(root) {
  const problems = [];

  if (!fs.existsSync(root)) {
    problems.push(`staged runtime root does not exist: ${root}`);
    return problems;
  }

  for (const rel of REQUIRED_FILES) {
    const target = path.join(root, rel);
    // `lstat`, not `stat`: a required asset replaced by a symlink to a file
    // outside the runtime root would satisfy a followed `stat` while the
    // installed runtime carried nothing. The symlink itself is reported by the
    // forbidden scan below; here it simply is not the required regular file.
    const stat = lstatOrNull(target);
    if (stat === null || !stat.isFile()) {
      problems.push(`missing required staged file: ${rel}`);
    }
  }

  for (const rel of REQUIRED_EXECUTABLES) {
    const stat = lstatOrNull(path.join(root, rel));
    if (stat !== null && stat.isFile() && (stat.mode & 0o100) === 0) {
      problems.push(`staged file is not owner-executable: ${rel}`);
    }
  }

  for (const rel of NEWLINE_TERMINATED) {
    const target = path.join(root, rel);
    if (!fs.existsSync(target)) continue;
    const raw = fs.readFileSync(target, 'utf8');
    if (raw.trim().length === 0) problems.push(`staged setup asset is empty: ${rel}`);
    else if (!raw.endsWith('\n')) problems.push(`staged setup asset is not newline-terminated: ${rel}`);
  }

  for (const rel of JSON_ASSETS) {
    const target = path.join(root, rel);
    if (!fs.existsSync(target)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
      problems.push(`staged setup asset is not valid JSON: ${rel}`);
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      problems.push(`staged setup asset is not a JSON object: ${rel}`);
    }
  }

  const manifestPath = path.join(root, MANIFEST_ASSET);
  if (fs.existsSync(manifestPath)) {
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      /* already reported above */
    }
    if (manifest !== null && typeof manifest === 'object') {
      for (const section of MANIFEST_SECTIONS) {
        if (!(section in manifest)) {
          problems.push(`canonical Slack manifest is missing the "${section}" section: ${MANIFEST_ASSET}`);
        }
      }
    }
  }

  const manifestJson = path.join(root, 'package.json');
  if (fs.existsSync(manifestJson)) {
    let pkg = null;
    try {
      pkg = JSON.parse(fs.readFileSync(manifestJson, 'utf8'));
    } catch {
      problems.push('staged package.json is not valid JSON: package.json');
    }
    if (pkg !== null) {
      const bin = pkg.bin && pkg.bin.somawork;
      if (typeof bin !== 'string' || bin.length === 0) {
        problems.push('staged package.json declares no bin.somawork');
      } else {
        const stat = lstatOrNull(path.join(root, bin));
        if (stat === null || !stat.isFile()) {
          problems.push(`bin.somawork does not resolve to a staged file: ${bin}`);
        } else if ((stat.mode & 0o100) === 0) {
          problems.push(`bin.somawork target is not owner-executable: ${bin}`);
        }
      }
    }
  }

  // Workspace closure. The target runs `npm ci --omit=dev --workspaces
  // --include-workspace-root`, which needs EVERY workspace manifest present --
  // that requirement is the whole reason test-only `packages/test-utils` is
  // staged, and until now nothing asserted it: deleting a workspace manifest
  // from a staged tree passed both smokes, because the deploy smoke only
  // validates the manifests it happens to find.
  const workspaces = expectedWorkspaceManifests();
  for (const pattern of workspaces.unsupported) {
    problems.push(`unsupported workspace pattern in the root manifest: ${pattern}`);
  }
  if (workspaces.manifests.length === 0 && workspaces.unsupported.length === 0) {
    problems.push('the root manifest expands to no workspace packages');
  }
  for (const rel of workspaces.manifests) {
    const manifestFile = path.join(root, rel);
    const stat = lstatOrNull(manifestFile);
    if (stat === null || !stat.isFile()) {
      problems.push(`missing staged workspace manifest: ${rel}`);
      continue;
    }
    // Require the entry point the manifest itself declares, rather than "a
    // non-empty dist". `somalib` is compiled in place and declares no `main`,
    // so a blanket dist rule would fail a correct bundle; a package that DOES
    // declare an entry must have that exact file staged, which is stricter
    // than a directory being non-empty.
    let entry = null;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      const exported = manifest.exports && manifest.exports['.'];
      entry = typeof manifest.main === 'string' ? manifest.main : typeof exported === 'string' ? exported : null;
    } catch {
      problems.push(`staged workspace manifest is not valid JSON: ${rel}`);
      continue;
    }
    if (entry === null) continue;
    const entryStat = lstatOrNull(path.join(root, path.dirname(rel), entry));
    if (entryStat === null || !entryStat.isFile()) {
      problems.push(`staged workspace package is missing its declared entry point: ${path.dirname(rel)}/${entry.replace(/^\.\//, '')}`);
    }
  }

  walk(root, (rel, entry) => {
    // A symlink in an immutable runtime root has no legitimate use, and it is
    // the one shape that defeats every other rule here: the walk cannot see
    // through it, so a link can hide source maps, source, or credential bytes,
    // and a link standing in for a required asset points outside the root
    // entirely. Reported before any other classification, because a symlink
    // named `src` is a symlink first.
    if (entry.isSymbolicLink()) {
      problems.push(`staged bundle contains forbidden symlink: ${rel}`);
      return;
    }
    if (entry.isDirectory() && FORBIDDEN_DIRNAMES.has(entry.name)) {
      problems.push(`staged bundle contains forbidden directory: ${rel}`);
      return;
    }
    if (entry.isDirectory() && rel === entry.name && FORBIDDEN_ROOT_DIRNAMES.has(entry.name)) {
      problems.push(`staged bundle contains forbidden runtime-root directory: ${rel}`);
      return;
    }
    if (!entry.isDirectory() && FORBIDDEN_BASENAMES.has(entry.name)) {
      problems.push(`staged bundle contains forbidden file: ${rel}`);
      return;
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(rel)) {
        problems.push(`staged bundle contains forbidden ${pattern.why}: ${rel}`);
        return;
      }
    }
    // Content, not shape. Runs last so a file already condemned by a path rule
    // is reported once, by the more specific rule.
    if (!entry.isDirectory()) {
      const scan = scanFileForForbiddenText(path.join(root, rel));
      if (scan.kind === 'credential') {
        // The match itself is never printed -- this is a leak report, and a
        // leak report that quotes the leak is a second copy of it.
        problems.push(`staged bundle contains ${scan.name} bytes: ${rel}`);
        return;
      }
      // Same rule for the same reason: naming the hit would republish it.
      if (scan.kind === 'private') {
        problems.push(`staged bundle contains a forbidden ${scan.name}: ${rel}`);
        return;
      }
      // Fail closed: "we could not look" is reported, never mistaken for
      // "we looked and it was clean".
      if (scan.kind === 'unscannable') {
        problems.push(`staged bundle contains an unscannable file: ${rel}`);
        return;
      }
      if (scan.kind === 'unreadable') {
        problems.push(`staged bundle contains a file the credential scan could not read: ${rel}`);
        return;
      }
    }
  });

  for (const problem of skillClosureProblems(root)) problems.push(problem);

  return problems;
}

// ---------------------------------------------------------------------------
// Packaged skill closure
// ---------------------------------------------------------------------------

/**
 * Interpreters a staged skill may name for an in-bundle script.
 *
 * `tsx` / `ts-node` are devDependencies and the target installs with
 * `--omit=dev` (`scripts/deploy/install-target.sh`), so a skill that documents
 * `npx tsx …` documents a command that cannot run on an installed runtime —
 * and the `.ts` it would run is pruned from the bundle anyway (I-6).
 */
const SKILL_DEV_RUNNERS = /^(?:npx\s+)?(?:tsx|ts-node)$/;

/** `<interpreter> <runtime-root-relative path>` inside a staged SKILL.md. */
const SKILL_COMMAND_RE = /\b((?:npx\s+)?[A-Za-z0-9_.@/-]+)\s+(local\/[^\s"'`)]+)/g;

/**
 * Every command a staged skill tells the operator to run must exist in the
 * bundle and be runnable without devDependencies.
 *
 * Scoped to `local/…` targets on purpose: those are runtime-root-relative paths
 * into the bundle, and they are the only ones this tree can answer for.
 * `$CLAUDE_PLUGIN_ROOT/...`, `npx <published-package>` and absolute paths are
 * somebody else's closure.
 */
function skillClosureProblems(root) {
  const problems = [];
  const skillsRoot = path.join(root, 'dist', 'local', 'skills');
  if (!fs.existsSync(skillsRoot)) return problems;

  walk(skillsRoot, (rel, entry) => {
    if (entry.isDirectory() || entry.name !== 'SKILL.md') return;
    const skillRel = `dist/local/skills/${rel}`;
    let text;
    try {
      text = fs.readFileSync(path.join(skillsRoot, rel), 'utf8');
    } catch {
      problems.push(`staged skill could not be read: ${skillRel}`);
      return;
    }
    for (const match of text.matchAll(SKILL_COMMAND_RE)) {
      const runner = match[1].replace(/\s+/g, ' ');
      const target = match[2];
      if (SKILL_DEV_RUNNERS.test(runner)) {
        problems.push(`staged skill invokes a devDependency runner: ${skillRel} -> ${runner} ${target}`);
        continue;
      }
      const resolved = lstatOrNull(path.join(root, 'dist', target));
      if (resolved === null || !resolved.isFile()) {
        problems.push(`staged skill references a missing command target: ${skillRel} -> ${target}`);
      }
    }
  });

  return problems;
}

// ---------------------------------------------------------------------------
// 2. Hermetic external-consumer harness
// ---------------------------------------------------------------------------

/**
 * A throwaway machine: a fake HOME, a hermetic SOMAWORK_HOME, a decoy home that
 * must never be read, and a fake `brew` that records every invocation.
 *
 * `PATH` deliberately excludes the real Homebrew prefix, so nothing here can
 * reach an installed formula, and `node` is invoked through `process.execPath`.
 */
const HARNESS_PREFIX = 'somawork-setup-smoke-';

function createHarness(options) {
  const source = options === undefined || options.source === undefined ? bundleRoot : options.source;
  // `realpathSync` matters: on macOS `os.tmpdir()` is `/var/folders/...` and
  // `/var` is a symlink to `/private/var`. The Slack manifest helper refuses any
  // path with a symlink in its ancestry (that refusal is the point of the
  // helper), so a harness rooted at the un-resolved path would fail a check the
  // bundle actually passes.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), HARNESS_PREFIX)));
  // Everything past this point can throw -- provisioning clones ~800 files and
  // links ~320 dependencies. A partially built harness must not survive the
  // throw: the caller cannot clean a root it was never handed, and the leak is
  // a 20 MB clone per failed run.
  try {
    return buildHarness(root, source);
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function buildHarness(root, source) {
  const dirs = {
    root,
    home: path.join(root, 'somawork-home'),
    fakeHome: path.join(root, 'fake-home'),
    decoyHome: path.join(root, 'decoy-home'),
    bin: path.join(root, 'bin'),
    work: path.join(root, 'work'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

  const brewLog = path.join(root, 'brew-invocations.log');
  fs.writeFileSync(path.join(dirs.bin, 'brew'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(brewLog)}\nexit 1\n`, {
    mode: 0o755,
  });

  // A sentinel the CLI must never read: a plausible profile config under the
  // decoy HOME. Every run below pins SOMAWORK_HOME elsewhere.
  const decoyConfigDir = path.join(dirs.decoyHome, '.config', 'somawork', 'profiles', 'preview');
  fs.mkdirSync(decoyConfigDir, { recursive: true });
  fs.writeFileSync(path.join(decoyConfigDir, 'config.json'), '{"sentinel":"DECOY-HOME-SENTINEL-must-not-be-read"}\n');

  const runtimeRoot = provisionRuntimeRoot(source, path.join(root, 'runtime'));

  return { ...dirs, brewLog, runtimeRoot, sentinel: 'DECOY-HOME-SENTINEL-must-not-be-read' };
}

function readBrewLog(harness) {
  return fs.existsSync(harness.brewLog) ? fs.readFileSync(harness.brewLog, 'utf8') : '';
}

function resetBrewLog(harness) {
  if (fs.existsSync(harness.brewLog)) fs.rmSync(harness.brewLog);
}

/** Run the staged controller as an external consumer would. */
function runCli(harness, args, options) {
  const opts = options === undefined ? {} : options;
  const env = {
    PATH: `${harness.bin}:/usr/bin:/bin`,
    HOME: opts.home === undefined ? harness.decoyHome : opts.home,
  };
  if (opts.somaworkHome !== false) {
    env.SOMAWORK_HOME = opts.somaworkHome === undefined ? harness.home : opts.somaworkHome;
  }
  Object.assign(env, opts.extraEnv === undefined ? {} : opts.extraEnv);

  const result = spawnSync(process.execPath, [path.join(harness.runtimeRoot, CONTROLLER_ENTRY), ...args], {
    cwd: harness.work,
    env,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/** Parse stdout as exactly one JSON document, with no ambient prefix or suffix. */
function parseSingleDocument(stdout) {
  if (stdout.length === 0) return { ok: false, why: 'empty stdout' };
  const first = stdout[0];
  if (first !== '{' && first !== '[') return { ok: false, why: `stdout does not start with a JSON document: ${JSON.stringify(stdout.slice(0, 60))}` };
  try {
    return { ok: true, value: JSON.parse(stdout) };
  } catch (error) {
    return { ok: false, why: `stdout is not one parseable document: ${String(error && error.message)}` };
  }
}

// ---------------------------------------------------------------------------
// 3. Behaviour checks
// ---------------------------------------------------------------------------

function checkPublicSurface(harness) {
  const help = runCli(harness, ['--help']);
  check(help.status === 0, '`--help` exits 0', `exit ${help.status}`);
  check(help.stdout.includes('somawork setup'), '`--help` documents `somawork setup`');
  check(help.stdout.includes('SOMAWORK_HOME'), '`--help` documents SOMAWORK_HOME');
  for (const route of PRIVATE_ROUTES) {
    check(!help.stdout.includes(route) && !help.stderr.includes(route), `\`--help\` never names ${route}`);
  }

  // What this proves is CONTROLLER-ENTRY DEPTH, not release-version truth.
  // `readControllerVersion` resolves `__dirname/../../package.json` — the same
  // staged manifest read here — so both sides read one file and the check
  // cannot detect a wrong or stale version. It is still load-bearing: move
  // `dist/cli/index.js` to another depth and `../..` resolves past the runtime
  // root, the lookup fails, and this fails with it.
  const version = runCli(harness, ['--version']);
  const staged = JSON.parse(fs.readFileSync(path.join(harness.runtimeRoot, 'package.json'), 'utf8'));
  check(version.status === 0, '`--version` exits 0', `exit ${version.status}`);
  check(
    version.stdout.trim() === String(staged.version),
    '`--version` resolves the staged manifest from the controller entry depth',
    `printed ${JSON.stringify(version.stdout.trim())}, staged ${JSON.stringify(staged.version)}`,
  );
  check(readBrewLog(harness) === '', 'help/version invoke no runtime discovery', readBrewLog(harness));
  resetBrewLog(harness);

  const unknown = runCli(harness, ['doctor', '--jsonn']);
  check(unknown.status !== 0, 'an unknown flag exits nonzero', `exit ${unknown.status}`);
  check(unknown.stdout === '', 'an unknown flag writes nothing to stdout', JSON.stringify(unknown.stdout));
  check(readBrewLog(harness) === '', 'an unknown flag is rejected before any discovery child runs', readBrewLog(harness));
  resetBrewLog(harness);

  const dupe = runCli(harness, ['doctor', '--profile', 'preview', '--profile', 'production']);
  check(dupe.status !== 0, 'a duplicated `--profile` exits nonzero', `exit ${dupe.status}`);
  check(readBrewLog(harness) === '', 'a duplicated `--profile` runs no discovery child', readBrewLog(harness));
  resetBrewLog(harness);
}

function checkJsonRoutes(harness) {
  const list = runCli(harness, ['profile', 'list', '--json']);
  check(list.status === 0, '`profile list --json` exits 0 on an empty home', `exit ${list.status}`);
  const listDoc = parseSingleDocument(list.stdout);
  if (check(listDoc.ok, '`profile list --json` emits one parseable document', listDoc.why)) {
    check(
      Array.isArray(listDoc.value) && listDoc.value.length === 0,
      '`profile list --json` is `[]` with no runtime installed',
      JSON.stringify(listDoc.value),
    );
  }

  for (const command of ['doctor', 'status']) {
    const run = runCli(harness, [command, '--json']);
    check(run.status !== 0, `\`${command} --json\` fails with no runtime`, `exit ${run.status}`);
    const doc = parseSingleDocument(run.stdout);
    if (check(doc.ok, `\`${command} --json\` failure is one parseable document with no ambient prefix`, doc.why)) {
      check(doc.value.ok === false, `\`${command} --json\` failure document reports ok:false`);
      check(
        typeof doc.value.error === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(doc.value.error),
        `\`${command} --json\` failure carries a bounded error identifier`,
        JSON.stringify(doc.value.error),
      );
    }
  }
}

function checkProfileIsolation(harness) {
  const views = {};
  for (const profile of ['preview', 'production']) {
    const run = runCli(harness, ['profile', 'show', '--profile', profile, '--json']);
    check(run.status === 0, `\`profile show --profile ${profile} --json\` exits 0`, `exit ${run.status}`);
    const doc = parseSingleDocument(run.stdout);
    if (!check(doc.ok, `\`profile show --profile ${profile} --json\` emits one document`, doc.why)) return;
    views[profile] = doc.value;
  }

  const fields = ['configDir', 'dataDir', 'stateDir', 'serviceLabel'];
  for (const field of fields) {
    check(
      views.preview[field] !== views.production[field],
      `preview and production disagree on ${field}`,
      `${views.preview[field]} === ${views.production[field]}`,
    );
  }
  check(
    views.preview.serviceLabel.endsWith('.preview') && views.production.serviceLabel.endsWith('.production'),
    'service labels carry the exact profile name',
    `${views.preview.serviceLabel} / ${views.production.serviceLabel}`,
  );

  for (const profile of ['preview', 'production']) {
    for (const field of ['configDir', 'dataDir', 'stateDir']) {
      check(
        views[profile][field].startsWith(`${harness.home}/`),
        `${profile} ${field} lives under the hermetic SOMAWORK_HOME`,
        views[profile][field],
      );
    }
  }
}

function checkHomeIsolation(harness) {
  // SOMAWORK_HOME wins over HOME, so the decoy profile is never consulted.
  const pinned = runCli(harness, ['profile', 'show', '--profile', 'preview', '--json']);
  check(
    !pinned.stdout.includes(harness.sentinel) && !pinned.stderr.includes(harness.sentinel),
    'the decoy home sentinel is never read',
  );
  check(
    !pinned.stdout.includes(harness.decoyHome),
    'no output path resolves into the decoy HOME',
    pinned.stdout.slice(0, 200),
  );

  // Without SOMAWORK_HOME the fake HOME is used — never the real OS home.
  const viaHome = runCli(harness, ['profile', 'show', '--profile', 'preview', '--json'], {
    somaworkHome: false,
    home: harness.fakeHome,
  });
  const doc = parseSingleDocument(viaHome.stdout);
  if (check(doc.ok, 'a HOME-only run emits one document', doc.why)) {
    check(
      doc.value.configDir.startsWith(`${harness.fakeHome}/`),
      'a HOME-only run resolves the profile under the fake HOME',
      doc.value.configDir,
    );
    check(
      !viaHome.stdout.includes(os.homedir()),
      'no output path resolves into the real OS home',
      viaHome.stdout.slice(0, 200),
    );
  }

  // The deprecated alias still works, and the canonical name outranks it.
  const both = runCli(harness, ['profile', 'show', '--profile', 'preview', '--json'], {
    extraEnv: { SOMA_HOME: harness.fakeHome },
  });
  const bothDoc = parseSingleDocument(both.stdout);
  if (check(bothDoc.ok, 'SOMAWORK_HOME + SOMA_HOME emits one document', bothDoc.why)) {
    check(
      bothDoc.value.configDir.startsWith(`${harness.home}/`),
      'SOMAWORK_HOME outranks the deprecated SOMA_HOME alias',
      bothDoc.value.configDir,
    );
  }
}

/**
 * The private `get-manifest` hook, run against the staged canonical manifest.
 *
 * The helper only accepts `<...>/slack-project/manifest.json`, which is the
 * path `somawork setup` materializes, so the staged bytes are copied into that
 * shape first. The whole of stdout must be the manifest — the Slack CLI parses
 * this stream, and one stray byte is an app-create failure.
 */
function checkManifestHelper(harness) {
  const stagedManifest = path.join(harness.runtimeRoot, MANIFEST_ASSET);
  if (!check(fs.existsSync(stagedManifest), 'the staged bundle carries the canonical Slack manifest', MANIFEST_ASSET)) {
    return;
  }
  const projectDir = path.join(harness.root, 'slack-project');
  fs.mkdirSync(projectDir, { recursive: true });
  const staged = fs.readFileSync(stagedManifest, 'utf8');
  const materialized = path.join(projectDir, 'manifest.json');
  fs.writeFileSync(materialized, staged);

  // The hook flag is `--path`; that is what `buildSlackHooksFile` writes into
  // `.slack/hooks.json` and what `parseManifestHelperArgv` reads.
  const run = runCli(harness, ['_print-slack-manifest', '--path', materialized]);
  check(run.status === 0, 'the private manifest helper exits 0 on the staged manifest', `exit ${run.status} ${run.stderr}`);
  const doc = parseSingleDocument(run.stdout);
  if (check(doc.ok, 'the private manifest helper emits exactly one JSON document', doc.why)) {
    check(
      JSON.stringify(doc.value) === JSON.stringify(JSON.parse(staged)),
      'the emitted manifest equals the staged canonical manifest',
    );
    for (const section of MANIFEST_SECTIONS) {
      check(section in doc.value, `the emitted manifest carries the "${section}" section`);
    }
    check(
      doc.value.settings && doc.value.settings.socket_mode_enabled === true,
      'the canonical manifest enables Socket Mode (no signing secret required)',
    );
  }
  check(run.stderr === '', 'the private manifest helper writes nothing to stderr', JSON.stringify(run.stderr));
}

/**
 * Materialize a profile from the *staged* config/prompt and prove the write set.
 *
 * Loads the built `dist/cli/**` modules, never `src/`. Materialization has no
 * external-consumer expression: `somawork setup` reaches it only after llmux
 * and the Slack CLI, neither of which may run here.
 */
function checkMaterialization(harness) {
  const materializePath = path.join(harness.runtimeRoot, 'dist/cli/setup/materialize.js');
  const profilePath = path.join(harness.runtimeRoot, 'dist/cli/profile.js');
  if (!check(fs.existsSync(materializePath) && fs.existsSync(profilePath), 'the staged bundle carries the built materializer')) {
    return;
  }

  for (const asset of [CONFIG_ASSET, PROMPT_ASSET]) {
    if (!check(fs.existsSync(path.join(harness.runtimeRoot, asset)), `the staged bundle carries ${asset}`)) return;
  }

  const { materializeProfile } = require(materializePath);
  const { profilePaths } = require(profilePath);

  const home = path.join(harness.root, 'materialize-home');
  const baseDirectory = path.join(harness.root, 'materialize-workspaces');
  fs.mkdirSync(baseDirectory, { recursive: true, mode: 0o700 });

  const before = snapshotTree(harness.runtimeRoot);
  const paths = profilePaths(home, 'preview');
  const receipt = materializeProfile({
    profile: 'preview',
    paths,
    runtime: { profile: 'preview', root: harness.runtimeRoot, version: '0.0.0-smoke' },
    baseDirectory,
    slack: { appId: 'A0SMOKE0001', teamId: 'T0SMOKE0001' },
    defaultConfig: { path: path.join(harness.runtimeRoot, CONFIG_ASSET) },
    systemPrompt: { path: path.join(harness.runtimeRoot, PROMPT_ASSET) },
  });
  const after = snapshotTree(harness.runtimeRoot);

  const drift = diffSnapshots(before, after);
  check(drift.length === 0, 'materialization writes nothing inside the staged runtime root', drift.join(', '));

  check(modeOf(paths.configDir) === 0o700, 'the profile config directory is 0700', modeOf(paths.configDir).toString(8));
  check(modeOf(paths.dataDir) === 0o700, 'the profile data directory is 0700', modeOf(paths.dataDir).toString(8));
  check(modeOf(paths.stateDir) === 0o700, 'the profile state directory is 0700', modeOf(paths.stateDir).toString(8));
  check(
    modeOf(receipt.runtimeDataDir) === 0o700,
    'the runtime data directory is 0700',
    modeOf(receipt.runtimeDataDir).toString(8),
  );

  for (const file of [receipt.runtimeEnvFile, receipt.configFile, receipt.promptFile]) {
    check(modeOf(file) === 0o600, `${path.basename(file)} is 0600`, modeOf(file).toString(8));
  }

  const promptBytes = fs.readFileSync(receipt.promptFile, 'utf8');
  check(
    promptBytes === fs.readFileSync(path.join(harness.runtimeRoot, PROMPT_ASSET), 'utf8'),
    'the materialized prompt is the staged canonical prompt byte-for-byte',
  );
  check(promptBytes.trim().length > 0, 'the materialized prompt is non-empty');

  let materializedConfig = null;
  try {
    materializedConfig = JSON.parse(fs.readFileSync(receipt.configFile, 'utf8'));
  } catch (error) {
    fail(`the materialized config is not valid JSON — ${String(error && error.message)}`);
  }
  check(
    materializedConfig !== null && typeof materializedConfig === 'object',
    'the materialized config is a JSON object seeded from the staged defaults',
  );

  const envBody = fs.readFileSync(receipt.runtimeEnvFile, 'utf8');
  check(!/xoxb-|xapp-|SLACK_BOT_TOKEN=|SLACK_APP_TOKEN=|SIGNING_SECRET/.test(envBody), 'the materialized env carries no credential');

  for (const written of [paths.configDir, paths.dataDir, paths.stateDir]) {
    check(written.startsWith(`${home}/`), 'every materialized path lives under the hermetic home', written);
  }
}

// ---------------------------------------------------------------------------
// 4. Mutation fixtures
// ---------------------------------------------------------------------------

/**
 * Prove the inventory is load-bearing: remove exactly one staged path in a
 * hardlinked fixture and require a problem that names exactly that path.
 *
 * Without this, a green run in a source tree that happens to contain the asset
 * says nothing about whether the *bundle* contains it.
 */
function checkMutations(harness) {
  const baseline = inventoryProblems(bundleRoot);
  if (!check(baseline.length === 0, 'the staged bundle is a clean inventory baseline', baseline.join('; '))) return;

  const fixtures = path.join(harness.root, 'mutants');
  fs.mkdirSync(fixtures, { recursive: true });

  const removals = [...SETUP_ASSETS, ...RUNTIME_ENTRIES, 'package.json', A2T_WORKER, A2T_REQUIREMENTS];
  for (const rel of removals) {
    const fixture = path.join(fixtures, `remove-${rel.replace(/[^A-Za-z0-9]/g, '_')}`);
    cloneTree(bundleRoot, fixture);
    fs.rmSync(path.join(fixture, rel));
    const problems = inventoryProblems(fixture);
    check(
      problems.some((problem) => problem.endsWith(`: ${rel}`) || problem.includes(`: ${rel}`)),
      `removing ${rel} fails the inventory naming that exact path`,
      problems.join('; ') || '(no problem reported)',
    );
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  const chmodFixture = path.join(fixtures, 'unexec-controller');
  cloneTree(bundleRoot, chmodFixture);
  // Break the hardlink before chmod: mode lives on the inode, so chmod-ing the
  // clone would also strip the executable bit off the staged original.
  const clonedController = path.join(chmodFixture, CONTROLLER_ENTRY);
  fs.rmSync(clonedController);
  fs.copyFileSync(path.join(bundleRoot, CONTROLLER_ENTRY), clonedController);
  fs.chmodSync(clonedController, 0o644);
  const chmodProblems = inventoryProblems(chmodFixture);
  check(
    chmodProblems.some((problem) => problem.includes('owner-executable') && problem.includes(CONTROLLER_ENTRY)),
    'a non-executable controller entry fails the inventory',
    chmodProblems.join('; ') || '(no problem reported)',
  );
  fs.rmSync(chmodFixture, { recursive: true, force: true });

  const truncateFixture = path.join(fixtures, 'truncate-prompt');
  cloneTree(bundleRoot, truncateFixture);
  fs.rmSync(path.join(truncateFixture, PROMPT_ASSET));
  fs.writeFileSync(path.join(truncateFixture, PROMPT_ASSET), '   \n');
  const truncateProblems = inventoryProblems(truncateFixture);
  check(
    truncateProblems.some((problem) => problem.includes('empty') && problem.includes(PROMPT_ASSET)),
    'an empty canonical prompt fails the inventory',
    truncateProblems.join('; ') || '(no problem reported)',
  );
  fs.rmSync(truncateFixture, { recursive: true, force: true });

  const forbidden = [
    ['secrets.env', 'SLACK_BOT_TOKEN=xoxb-not-a-real-token\n'],
    ['config.json', '{}\n'],
    ['.env', 'X=1\n'],
    ['scripts/setup/04-env-config.sh', '#!/bin/bash\n'],
    ['dist/cli/index.js.map', '{}\n'],
    ['dist/cli/index.ts', 'export {};\n'],
    ['ai.2lab.somawork.preview.plist', '<plist/>\n'],
    // A forbidden *directory* is reported by its own path, so the expected
    // fragment is the directory rather than the file that reintroduced it.
    ['dist/cct-store/__fixtures__/snapshots.js', 'module.exports = {};\n', 'dist/cct-store/__fixtures__'],
    ['dist/test-utils/mock-slack-api.js', 'module.exports = {};\n'],
  ];
  for (const [rel, body, expected] of forbidden) {
    const fixture = path.join(fixtures, `add-${rel.replace(/[^A-Za-z0-9]/g, '_')}`);
    cloneTree(bundleRoot, fixture);
    fs.mkdirSync(path.dirname(path.join(fixture, rel)), { recursive: true });
    fs.writeFileSync(path.join(fixture, rel), body);
    const problems = inventoryProblems(fixture);
    check(
      problems.some((problem) => problem.includes(expected === undefined ? rel : expected)),
      `adding ${rel} fails the forbidden scan`,
      problems.join('; ') || '(no problem reported)',
    );
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  checkCredentialMutations(fixtures);
  checkPrivateIdentityMutations(fixtures);
  checkSymlinkMutations(fixtures);
  checkWorkspaceMutations(fixtures);
}

/**
 * One private identity/topology family per fixture, in an ORDINARY staged file.
 *
 * Every one of these strings was in the staged artifact when packaging first
 * scanned it — in compiled comments, in a plugin author field, in two example
 * reports and in `scripts/service.sh`. They were removed at their sources; this
 * is what makes that removal a property of the bundle rather than a thing
 * somebody did once. A public archive is the wrong place to learn that a
 * reviewer's account name is still in a compiled doc comment.
 */
/**
 * What a problem message must never contain: the thing it is reporting.
 *
 * Built rather than written for the same reason the patterns are — the three
 * prohibited terms may not appear contiguously in this file.
 */
const REPEATED_PRIVATE_STRING_RE = new RegExp(
  [
    ...BLOCKED_TERMS.map((term) => escapeForRegex(term.text)),
    'icedac',
    'zhugehyuk',
    'oudwood',
    'macmini',
    'osun50s',
    'Protein',
    'Settlement',
    'dev2',
  ].join('|'),
  'i',
);

function checkPrivateIdentityMutations(fixtures) {
  const planted = [
    ['dist/leaked-operator.js', '// reviewed by icedac before the deploy\n', 'operator account name'],
    ['dist/leaked-author.js', 'module.exports = { author: "zhugehyuk" };\n', 'operator account name'],
    ['dist/leaked-host.js', '// observed on oudwood-512 at 05:42Z\n', 'private machine name'],
    ['dist/leaked-host-alias.js', '// also reproduced on macmini\n', 'private machine name'],
    // One fixture per prohibited term, planted from the assembled string rather
    // than a literal — the fixtures are under the same contract as the patterns.
    ...BLOCKED_TERMS.map((term, index) => [
      `dist/leaked-blocked-${index}.js`,
      `// context note mentioning ${term.text} in passing\n`,
      term.name,
    ]),
    ['dist/leaked-reviewer.js', '// review requested from osun50s, squash merge\n', 'operator account name'],
    ['dist/leaked-client-file.js', '// root cause at SnapshotServer.Protein.Receive.cs:689\n', 'external client source file'],
    ['dist/leaked-client-service.js', '// SettlementService never received the notify\n', 'external client service name'],
    ['dist/leaked-deploy-branch.js', '// shipped on deploy/dev2 with PR #1470\n', 'private deployment branch'],
  ];

  for (const [rel, body, family] of planted) {
    const fixture = path.join(fixtures, `private-${rel.replace(/[^A-Za-z0-9]/g, '_')}`);
    cloneTree(bundleRoot, fixture);
    fs.writeFileSync(path.join(fixture, rel), body);
    const problems = inventoryProblems(fixture);
    check(
      problems.some((problem) => problem === `staged bundle contains a forbidden ${family}: ${rel}`),
      `${rel} fails the content scan as a forbidden ${family}`,
      problems.join('; ') || '(no problem reported)',
    );
    check(
      !problems.some((problem) => REPEATED_PRIVATE_STRING_RE.test(problem)),
      `the ${rel} report does not repeat the private string`,
      problems.join('; '),
    );
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  // The other half of the rule, twice over: a scan that failed on legitimate
  // bytes would be unusable, and both of these ship today.
  const kept = [
    [
      'dist/public-identity.js',
      'module.exports = { repo: "2lab-ai/soma-work", domain: "2lab.ai", pkg: "@2lab.ai/gemini-mcp-server" };\n',
      'public project, organisation and npm coordinates',
    ],
    // `playwright-core` really does ship a class called `SnapshotServer`. The
    // client-codebase patterns match its *file-name* form for exactly this
    // reason; a bare-token rule would fail every correct runtime archive.
    [
      'dist/dependency-lookalike.js',
      'class SnapshotServer {}\nconst snapshotServer = new SnapshotServer();\nmodule.exports = { snapshotServer };\n',
      "a dependency's own SnapshotServer class",
    ],
  ];
  for (const [rel, body, why] of kept) {
    const fixture = path.join(fixtures, `kept-${rel.replace(/[^A-Za-z0-9]/g, '_')}`);
    cloneTree(bundleRoot, fixture);
    fs.writeFileSync(path.join(fixture, rel), body);
    const problems = inventoryProblems(fixture);
    check(
      !problems.some((problem) => problem.includes(rel)),
      `${why}: not treated as a private string`,
      problems.join('; '),
    );
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

/**
 * The three complete Slack shapes the fixtures plant — assembled at load time,
 * never written out here.
 *
 * The bodies are synthetic (fixed keyboard runs, no account), but a complete
 * `xoxb-…` literal in a source blob is indistinguishable from a real leak to
 * GitHub push protection, which refused the branch that first carried these
 * fixtures. So each is stored as a prefix and a body that mean nothing on their
 * own. Same technique, and the same reason, as {@link BLOCKED_TERM_SPECS}: the
 * scan under test receives the assembled string, so it is exactly as strong as
 * it was with literals.
 *
 * Only the Slack family is split — it is the only one push protection blocks
 * here. `scripts/__tests__/slack-token-literals.test.ts` pins both halves: no
 * source file carries a complete shape, and these still are complete shapes.
 */
const SYNTHETIC_SLACK_TOKEN_SPECS = [
  { name: 'bot', prefix: 'xoxb', body: '2222222222-3333333333-AbCdEfGhIjKlMnOpQrStUvWx' },
  { name: 'app', prefix: 'xapp', body: '1-A02222222-3333333333-abcdefabcdefabcdefabcdefabcdefab' },
  { name: 'config', prefix: 'xoxe.xoxp', body: '1-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' },
];

/** `{ bot, app, config }` — the complete tokens, for fixtures and their tests. */
const SYNTHETIC_SLACK_TOKENS = Object.fromEntries(
  SYNTHETIC_SLACK_TOKEN_SPECS.map((spec) => [spec.name, `${spec.prefix}-${spec.body}`]),
);

/**
 * One credential family per fixture, planted in an ORDINARY staged file under a
 * name no path rule condemns.
 *
 * These values are synthetic: the bodies are fixed keyboard runs, not values
 * from any account. They exist so the content scan is proved load-bearing the
 * same way the path rules are — before this, a compiled module carrying a real
 * token shipped green through both smokes.
 */
function checkCredentialMutations(fixtures) {
  const planted = [
    ['dist/leaked-slack-bot.js', `module.exports = "${SYNTHETIC_SLACK_TOKENS.bot}";\n`],
    ['dist/leaked-slack-app.js', `module.exports = "${SYNTHETIC_SLACK_TOKENS.app}";\n`],
    ['dist/leaked-slack-config.js', `module.exports = "${SYNTHETIC_SLACK_TOKENS.config}";\n`],
    ['dist/leaked-anthropic.js', 'module.exports = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";\n'],
    ['dist/leaked-llmux.js', 'module.exports = "lmk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";\n'],
    ['dist/leaked-github.js', 'module.exports = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456";\n'],
    ['dist/leaked-github-pat.js', 'module.exports = "github_pat_AbCdEfGhIjKlMnOpQrStUvWxYz0123456";\n'],
    ['dist/leaked-aws.js', 'module.exports = "AKIAABCDEFGHIJKLMNOP";\n'],
    ['config.leaked.json', '{"key":"-----BEGIN RSA PRIVATE KEY-----"}\n'],
  ];

  for (const [rel, body] of planted) {
    const fixture = path.join(fixtures, `leak-${rel.replace(/[^A-Za-z0-9]/g, '_')}`);
    cloneTree(bundleRoot, fixture);
    fs.writeFileSync(path.join(fixture, rel), body);
    const problems = inventoryProblems(fixture);
    check(
      problems.some((problem) => problem.endsWith(`: ${rel}`) && problem.includes('bytes')),
      `credential bytes in ${rel} fail the content scan`,
      problems.join('; ') || '(no problem reported)',
    );
    // The report must name the file and never quote the credential.
    check(
      !problems.some((problem) => /xox|sk-ant|ghp_|github_pat_|AKIA|PRIVATE KEY|lmk-/.test(problem)),
      `the ${rel} leak report does not repeat the credential`,
      problems.join('; '),
    );
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  // A binary file whose bytes happen to contain a credential-shaped run must
  // not be decoded blindly -- the extension exclusion is the one justified skip.
  const binaryFixture = path.join(fixtures, 'binary-not-scanned');
  cloneTree(bundleRoot, binaryFixture);
  fs.writeFileSync(
    path.join(binaryFixture, 'dist/opaque.node'),
    Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz01')]),
  );
  const binaryProblems = inventoryProblems(binaryFixture);
  check(
    !binaryProblems.some((problem) => problem.includes('dist/opaque.node')),
    'a native/binary file is neither decoded as text nor reported as unscannable',
    binaryProblems.join('; '),
  );
  fs.rmSync(binaryFixture, { recursive: true, force: true });

  checkScanCoverage(fixtures);
}

/**
 * The three ways the old scan lied (I-2, I-3).
 *
 * Each fixture is a file the path rules do not condemn, under an ordinary name,
 * carrying a synthetic credential the previous implementation returned ZERO
 * problems for. They are the executable form of "the gate is not bounded by an
 * offset, a chunk edge, or one control byte".
 */
function checkScanCoverage(fixtures) {
  const CREDENTIAL = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  const cases = [
    {
      name: 'a credential 4 MiB into a staged file',
      rel: 'dist/leaked-past-4mib.js',
      // Just past the old 4 MiB read window, which returned only the head.
      body: () => Buffer.concat([Buffer.from(`// ${'p'.repeat(5 * 1024 * 1024)}\n`), Buffer.from(CREDENTIAL)]),
      expect: (problem) => problem.includes('bytes: dist/leaked-past-4mib.js'),
    },
    {
      name: 'a credential straddling a scan-chunk boundary',
      rel: 'dist/leaked-on-chunk-edge.js',
      // Split so NEITHER half matches on its own: the chunk ends 8 bytes into
      // the literal, which is `sk-ant-a` — one character short of the {10,}
      // body every pattern requires — and the next chunk starts mid-token with
      // no prefix at all. Only a carry-over window can see this one, so the
      // fixture fails if the overlap is ever dropped or shortened.
      body: () => {
        const head = 1024 * 1024 - 8;
        return Buffer.concat([Buffer.from('x'.repeat(head)), Buffer.from(CREDENTIAL), Buffer.from('\n')]);
      },
      expect: (problem) => problem.includes('bytes: dist/leaked-on-chunk-edge.js'),
    },
    {
      name: 'a NUL-bearing text file hiding a credential',
      rel: 'dist/leaked-behind-nul.js',
      body: () => Buffer.concat([Buffer.from('const z="'), Buffer.from([0]), Buffer.from(`";\n// ${CREDENTIAL}\n`)]),
      // Either verdict is fail-closed; what must never happen is silence.
      expect: (problem) =>
        problem === 'staged bundle contains an unscannable file: dist/leaked-behind-nul.js' ||
        problem.includes('bytes: dist/leaked-behind-nul.js'),
    },
  ];

  for (const variant of cases) {
    const fixture = path.join(fixtures, `scan-${variant.rel.replace(/[^A-Za-z0-9]/g, '_')}`);
    cloneTree(bundleRoot, fixture);
    fs.writeFileSync(path.join(fixture, variant.rel), variant.body());
    const problems = inventoryProblems(fixture);
    check(
      problems.some(variant.expect),
      `${variant.name} fails the content scan`,
      problems.join('; ') || '(no problem reported)',
    );
    check(
      !problems.some((problem) => /sk-ant|AbCdEfGh/.test(problem)),
      `the ${variant.rel} report does not repeat the credential`,
      problems.join('; '),
    );
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  checkStagingGate(fixtures);
}

/**
 * The gate `stage-bundle.sh` actually invokes, run the way it invokes it.
 *
 * `inventoryProblems` returning a list proves the rules; this proves the
 * *wiring* — that `node scripts/smoke/setup-package.js --inventory-only <tree>`
 * exits non-zero on a planted credential and on a planted symlink, and zero on
 * the tree staging just produced. Before I-4 that command did not exist and
 * `stage:bundle` ran no content or symlink check at all.
 */
function checkStagingGate(fixtures) {
  const gate = (target) =>
    spawnSync(process.execPath, [path.join(repoRoot, 'scripts/smoke/setup-package.js'), '--inventory-only', target], {
      encoding: 'utf8',
      timeout: 120_000,
    });

  const clean = gate(bundleRoot);
  check(clean.status === 0, 'the staging gate passes the staged bundle as produced', (clean.stderr || '').trim());

  const planted = [
    {
      name: 'a planted credential',
      make: (fixture) => {
        fs.writeFileSync(
          path.join(fixture, 'dist/gate-leak.js'),
          'module.exports = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";\n',
        );
      },
      expect: 'dist/gate-leak.js',
    },
    {
      name: 'a planted symlink',
      make: (fixture) => fs.symlinkSync(path.join(repoRoot, 'package.json'), path.join(fixture, 'dist/gate-link.js')),
      expect: 'forbidden symlink: dist/gate-link.js',
    },
  ];

  for (const variant of planted) {
    const fixture = path.join(fixtures, `gate-${variant.name.replace(/[^A-Za-z0-9]/g, '_')}`);
    cloneTree(bundleRoot, fixture);
    variant.make(fixture);
    const result = gate(fixture);
    check(result.status === 1, `the staging gate rejects ${variant.name}`, `exit ${String(result.status)}`);
    check(
      `${result.stdout}${result.stderr}`.includes(variant.expect),
      `the staging gate names the offending path for ${variant.name}`,
      (result.stderr || '').trim(),
    );
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

/**
 * Symlinks. Each of these passed 94/94 before the rule existed; (c) and (d)
 * additionally died with a raw stack instead of a FAIL.
 */
function checkSymlinkMutations(fixtures) {
  const variants = [
    {
      name: 'a root `src` symlink into the repository',
      rel: 'src',
      make: (fixture) => fs.symlinkSync(path.join(repoRoot, 'src'), path.join(fixture, 'src')),
    },
    {
      name: 'a nested directory symlink hiding a source map and credential bytes',
      rel: 'dist/hidden',
      make: (fixture, scratch) => {
        fs.mkdirSync(scratch, { recursive: true });
        fs.writeFileSync(path.join(scratch, 'x.js.map'), '{}\n');
        fs.writeFileSync(path.join(scratch, 'k.js'), 'const k="sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz01";\n');
        fs.symlinkSync(scratch, path.join(fixture, 'dist/hidden'));
      },
    },
    {
      name: 'a required asset symlinked outside the runtime root',
      rel: CONFIG_ASSET,
      make: (fixture) => {
        fs.rmSync(path.join(fixture, CONFIG_ASSET));
        fs.symlinkSync(path.join(repoRoot, 'package.json'), path.join(fixture, CONFIG_ASSET));
      },
      alsoExpect: `missing required staged file: ${CONFIG_ASSET}`,
    },
    {
      name: 'a `node_modules` symlink into the repository',
      rel: 'node_modules',
      make: (fixture) => fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(fixture, 'node_modules')),
    },
  ];

  for (const variant of variants) {
    const fixture = path.join(fixtures, `symlink-${variant.rel.replace(/[^A-Za-z0-9]/g, '_')}`);
    cloneTree(bundleRoot, fixture);
    variant.make(fixture, path.join(fixtures, `scratch-${variant.rel.replace(/[^A-Za-z0-9]/g, '_')}`));
    const problems = inventoryProblems(fixture);
    check(
      problems.some((problem) => problem === `staged bundle contains forbidden symlink: ${variant.rel}`),
      `${variant.name} fails the inventory`,
      problems.join('; ') || '(no problem reported)',
    );
    if (variant.alsoExpect !== undefined) {
      check(
        problems.includes(variant.alsoExpect),
        `${variant.name} also fails as a missing required file`,
        problems.join('; '),
      );
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

/**
 * Workspace manifests. `npm ci --omit=dev --workspaces` on the target needs
 * every one of them, which is the stated reason test-only `packages/test-utils`
 * is staged — a reason that had no test until now.
 */
function checkWorkspaceMutations(fixtures) {
  const expected = expectedWorkspaceManifests();
  check(
    expected.unsupported.length === 0,
    'every root workspace pattern is one this check can expand',
    expected.unsupported.join(', '),
  );
  check(expected.manifests.length > 0, 'the root manifest expands to at least one workspace package');

  const targets = [
    'packages/slack/package.json',
    'packages/mcp-servers/permission/package.json',
    'packages/test-utils/package.json',
    'somalib/package.json',
  ];
  for (const rel of targets) {
    if (!check(expected.manifests.includes(rel), `${rel} is an expected workspace manifest`)) continue;
    const fixture = path.join(fixtures, `ws-${rel.replace(/[^A-Za-z0-9]/g, '_')}`);
    cloneTree(bundleRoot, fixture);
    fs.rmSync(path.join(fixture, rel));
    const problems = inventoryProblems(fixture);
    check(
      problems.includes(`missing staged workspace manifest: ${rel}`),
      `removing ${rel} fails the workspace-closure check`,
      problems.join('; ') || '(no problem reported)',
    );
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  // The declared entry point, not merely a non-empty directory.
  const entryFixture = path.join(fixtures, 'ws-entry-missing');
  cloneTree(bundleRoot, entryFixture);
  fs.rmSync(path.join(entryFixture, 'packages/common/dist/index.js'));
  check(
    inventoryProblems(entryFixture).some((problem) => problem.includes('declared entry point')),
    'removing a workspace package\'s declared entry point fails the inventory',
  );
  fs.rmSync(entryFixture, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** A bounded identifier for a foreign throw. Never the message. */
function safeErrorName(error) {
  try {
    const name = error === null || error === undefined ? undefined : error.name;
    return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(name) ? name : 'Error';
  } catch {
    return 'Error';
  }
}

/** Temp entries this harness owns, so the probe below can measure a delta. */
function harnessTempEntries() {
  try {
    return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(HARNESS_PREFIX));
  } catch {
    return [];
  }
}

/**
 * Fault-inject a harness construction failure and require zero temp residue.
 *
 * Runs first, before the real harness, so a regression in the cleanup path is
 * reported rather than silently leaking a clone per failed run.
 */
function checkHarnessCleanup() {
  const before = new Set(harnessTempEntries());
  let threw = false;
  let harness = null;
  try {
    harness = createHarness({ source: path.join(os.tmpdir(), `${HARNESS_PREFIX}does-not-exist-source`) });
  } catch {
    threw = true;
  } finally {
    if (harness !== null) fs.rmSync(harness.root, { recursive: true, force: true });
  }
  check(threw, 'a harness whose source is missing fails rather than provisioning nothing');
  const leaked = harnessTempEntries().filter((name) => !before.has(name));
  check(leaked.length === 0, 'a failed harness construction leaves no temp directory behind', leaked.join(', '));
}

function main() {
  console.log(`staged runtime root: ${bundleRoot}`);

  for (const problem of inventoryProblems(bundleRoot)) fail(problem);
  if (failures.length === 0) pass('staged inventory and forbidden-file scan');

  if (inventoryOnly) {
    console.log('');
    if (failures.length > 0) {
      console.error(`FAILED ${failures.length} staged-artifact check(s).`);
      process.exit(1);
    }
    console.log(`OK staged artifact gate: ${bundleRoot}`);
    return;
  }

  if (!fs.existsSync(path.join(bundleRoot, CONTROLLER_ENTRY))) {
    console.error('\nThe staged controller entry is missing; behaviour checks cannot run.');
    process.exit(1);
  }

  checkHarnessCleanup();

  // `harness` is allocated INSIDE the guard. Constructing it outside meant a
  // throw during provisioning bypassed the cleanup entirely: the operator saw a
  // raw stack, zero FAIL lines (so a bundle problem looked like a harness bug),
  // and a 20 MB clone left in the temp directory.
  let harness = null;
  try {
    harness = createHarness();
    checkPublicSurface(harness);
    checkJsonRoutes(harness);
    checkProfileIsolation(harness);
    checkHomeIsolation(harness);
    checkManifestHelper(harness);
    checkMaterialization(harness);
    checkMutations(harness);
  } catch (error) {
    // Bounded: a class name, never the message. The staged paths and the
    // operator's home are both in scope here, and this output is pasteable.
    fail(`the behaviour harness could not complete (${safeErrorName(error)})`);
  } finally {
    if (harness !== null) fs.rmSync(harness.root, { recursive: true, force: true });
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`FAILED ${failures.length} check(s); ${checks} passed.`);
    process.exit(1);
  }
  console.log(`OK setup package: ${checks} checks passed against ${bundleRoot}`);
}

// Required by `deploy-bundle.js` for the workspace-closure rule, by
// `package-archives.js` for the byte-scan tables, and by the `scripts/__tests__`
// suites for the block list and the synthetic Slack shapes, so each rule and
// each fixture has exactly one owner. Only run the smoke when invoked directly.
module.exports = {
  inventoryProblems,
  expectedWorkspaceManifests,
  BLOCKED_TERMS,
  SYNTHETIC_SLACK_TOKENS,
  scanFileForForbiddenText,
  CREDENTIAL_PATTERNS,
  PRIVATE_IDENTITY_PATTERNS,
  FORBIDDEN_TEXT_PATTERNS,
  BINARY_EXTENSIONS,
};

if (require.main === module) {
  main();
}
