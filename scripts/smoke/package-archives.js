#!/usr/bin/env node
/**
 * `package-archives.js` — the gate on the tar archives themselves.
 *
 * ## Why a second gate exists
 *
 * `scripts/smoke/setup-package.js` checks the *staged runtime tree*: the 798
 * files `stage-bundle.sh` copies, with no dependencies in them. That tree is
 * not what a user installs. What a user installs is a tar downloaded from a
 * public release page, containing the staged tree **plus 300-odd third-party
 * packages**, or — for the controller — a bundle that never existed as a staged
 * file at all. Nothing had ever looked at those bytes.
 *
 * So this script starts from the manifest, verifies each recorded SHA-256
 * against the file on disk, extracts each archive into a throwaway directory,
 * and asks of the extraction:
 *
 * - is the layout the one the formula and the controller expect;
 * - is every member inside the archive root (no absolute path, no `..`, and no
 *   symlink pointing out of the tree);
 * - does any file carry credential bytes, or a private operator identity or
 *   machine name;
 * - is there any instance state, source, map, test, or plist in it;
 * - does the controller archive actually *run* when it is the only somawork on
 *   the machine.
 *
 * The pattern tables are imported from `setup-package.js` rather than copied:
 * two independently maintained copies of a credential table is one table plus
 * one blind spot.
 *
 * ## Usage
 *
 *   node scripts/smoke/package-archives.js --manifest <somawork-manifest.json>
 *                                          [--dir <directory holding the assets>]
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { scanFileForForbiddenText, FORBIDDEN_TEXT_PATTERNS } = require('./setup-package.js');

const repoRoot = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// The archive contracts
// ---------------------------------------------------------------------------

/**
 * Runtime-root-relative paths a runtime archive is unusable without, beyond the
 * ones the manifest's own layout block names.
 *
 * The layout paths (`marker`, `manifest`, `controllerEntry`, `supervisor`,
 * `daemon`) are read from the manifest rather than duplicated here — that is the
 * point of publishing them: a manifest that describes a shape the archive does
 * not have must fail, and it cannot fail against a copy of itself.
 */
/**
 * The grant every archive carries at its root.
 *
 * `package.json` naming ISC is a claim; this file is the grant. An archive that
 * shipped one without the other would put a tree in front of a user with no
 * text saying what they may do with it, and an identifier recorded somewhere
 * upstream — a formula, a tap, a manifest — is not a substitute for the file
 * the user actually receives.
 *
 * Deliberately NOT in `RUNTIME_EXTRA_REQUIRED_FILES`: `checkLicense` runs for
 * every asset, controller included, so listing it there as well reported one
 * missing file as two failures per runtime archive.
 */
const LICENSE_MEMBER = 'LICENSE';

/**
 * The a2t pair is here and not in the controller's required set on
 * purpose: the runtime archives are `cp -R` of the staged bundle, which stages
 * `services/`, while the controller archive is the single bundled executable
 * and nothing runtime. Pinning it here closes the last hole in the chain —
 * `stage-bundle.sh` asserted the worker and `setup-package.js` now requires it
 * of the staged tree, but the tarball that actually reaches a user was checked
 * by neither.
 */
const RUNTIME_EXTRA_REQUIRED_FILES = [
  'config.default.json',
  '.system.prompt.example',
  'infra/slack/slack-app-manifest.json',
  'services/a2t/worker.py',
  'services/a2t/requirements.txt',
];

/**
 * Workspace packages whose *production* entry point must resolve inside a
 * runtime archive.
 *
 * Derived from the archive's own root manifest `workspaces` patterns and each
 * workspace manifest's declared `main`/`exports['.']`, so this list does not go
 * stale when a package is added. It is the closure `npm ci --omit=dev
 * --workspaces --include-workspace-root` is supposed to have produced — and the
 * thing that had no real-archive assertion at all: only root `node_modules`
 * existence was checked, so an install missing an unhoistable nested tree (the
 * bug this task actually hit with `somalib/node_modules/soma-lib`) shipped green.
 */
const REQUIRED_NESTED_DEPENDENCIES = ['somalib/node_modules/soma-lib/dist/index.js'];

/** Which package installs which profile. `null` is the profile-less controller. */
const EXPECTED_PROFILE = {
  'somawork-cli': null,
  somawork: 'production',
  'somawork-preview': 'preview',
};

/** Never in any archive, at any depth, first-party or dependency. */
const FORBIDDEN_BASENAMES_ANYWHERE = new Set([
  '.env',
  '.env.dev',
  '.env.local',
  '.env.prod',
  '.env.stage',
  '.env.test',
  'secrets.env',
  '.system.prompt',
  'setup-state.json',
  '.setup-wizard-state',
  '.new-deploy-state',
]);

/** Never in any archive: a repository inside a release artifact. */
const FORBIDDEN_DIRNAMES_ANYWHERE = new Set(['.git', '.worktrees', '.deploy-bundle']);

/**
 * Never in the FIRST-PARTY half of an archive.
 *
 * Scoped away from `node_modules` because the same shapes are ordinary there: a
 * published package legitimately ships `.d.ts`, source maps, and its own tests,
 * and deleting them from a dependency tree is how a runtime stops resolving.
 */
const FORBIDDEN_FIRST_PARTY_BASENAMES = new Set(['config.json', 'provision-agent.ts']);
const FORBIDDEN_FIRST_PARTY_DIRNAMES = new Set(['src', '__tests__', '__fixtures__', '__mocks__']);
const FORBIDDEN_FIRST_PARTY_ROOT_DIRNAMES = new Set(['data', 'logs', '.claude']);
const FORBIDDEN_FIRST_PARTY_PATTERNS = [
  { test: (rel) => rel === 'scripts/setup' || rel.startsWith('scripts/setup/'), why: 'deprecated shell setup collector' },
  { test: (rel) => rel === 'dist/test-utils' || rel.startsWith('dist/test-utils/'), why: 'compiled test helper' },
  { test: (rel) => /\.map$/.test(rel), why: 'source map' },
  { test: (rel) => /\.tsx?$/.test(rel), why: 'TypeScript source' },
  { test: (rel) => /\.test\.[cm]?[jt]s$/.test(rel), why: 'test file' },
  { test: (rel) => /\.bak$/.test(rel), why: 'backup file' },
  { test: (rel) => /\.plist$/.test(rel), why: 'launchd plist' },
  { test: (rel) => /\.pid$/.test(rel), why: 'pid file' },
  { test: (rel) => /\.log$/.test(rel), why: 'log file' },
];

/**
 * The dependency-tree scan table.
 *
 * Identical to the first-party table except for one entry. A bare
 * `-----BEGIN PRIVATE KEY-----` **header** is a parser constant, not a key, and
 * three packages the runtime genuinely needs contain one: `jose` (it parses PEM)
 * and `dotenv`'s two READMEs (they document `.env` values). Requiring a base64
 * body after the header keeps every real key a failure while removing a class of
 * false positive we cannot fix at the source, because the source is somebody
 * else's package.
 *
 * This is deliberately NOT an allowlist of files: a real key in any of those
 * same three files still fails. The rest of the table — every token family, and
 * every private identity string — applies to dependencies unchanged.
 */
const DEPENDENCY_PEM_PATTERN = {
  name: 'PEM private key',
  re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s]+[A-Za-z0-9+/=]{40,}/,
};
const DEPENDENCY_TEXT_PATTERNS = FORBIDDEN_TEXT_PATTERNS.map((pattern) =>
  pattern.name === 'PEM private key' ? DEPENDENCY_PEM_PATTERN : pattern,
);

/**
 * Leading bytes of a native executable.
 *
 * `@anthropic-ai/claude-agent-sdk` vendors six `ripgrep` binaries, and four of
 * them have no file extension at all (`vendor/ripgrep/arm64-darwin/rg`). The
 * extension list in `setup-package.js` cannot classify those, so the byte scan
 * called them "unscannable" — correctly, and uselessly: they are machine code,
 * there is no text in them to scan, and the archive cannot ship without them.
 *
 * Sniffing the format is the honest way to say so. It is a statement about what
 * the file *is* (Mach-O, ELF, PE), not an allowlist of paths, so a text file
 * that hides a NUL byte is still reported and a new vendored binary needs no
 * maintenance here. Skips are counted and printed rather than silent.
 */
const EXECUTABLE_MAGICS = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32-bit
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64-bit
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32-bit, byte-swapped
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64-bit, byte-swapped
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal
];

/** Bytes read to classify a file. Enough to reach a PE header at its offset. */
const MAGIC_WINDOW_BYTES = 1024;

/**
 * A PE image, verified through its header chain — not by two bytes.
 *
 * `MZ` alone is a two-byte prefix any file can start with, and a file that did
 * would have been counted "native" and excused from the credential scan. A real
 * PE stores the offset of its NT header at 0x3c and `PE\0\0` at that offset;
 * requiring both keeps the two genuinely vendored `rg.exe` classified while
 * closing the free pass.
 */
function isPortableExecutable(head, length) {
  if (length < 0x40 || head[0] !== 0x4d || head[1] !== 0x5a) return false;
  const offset = head.readUInt32LE(0x3c);
  if (offset + 4 > length) return false;
  return head[offset] === 0x50 && head[offset + 1] === 0x45 && head[offset + 2] === 0 && head[offset + 3] === 0;
}

function isNativeExecutable(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return false;
  }
  try {
    const head = Buffer.alloc(MAGIC_WINDOW_BYTES);
    const read = fs.readSync(fd, head, 0, MAGIC_WINDOW_BYTES, 0);
    if (EXECUTABLE_MAGICS.some((magic) => read >= magic.length && magic.every((byte, index) => head[index] === byte))) {
      return true;
    }
    return isPortableExecutable(head, read);
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** Private routes that must never surface in help output. */
const PRIVATE_ROUTES = ['_capture-slack-auth', '_print-slack-manifest'];

/** The shipped skill script whose banner must name an interpreter the runtime has. */
const SKILL_SCRIPT = 'dist/local/skills/github-pr/scripts/extract-pr-data.js';

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
  checks += 1;
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
// Helpers
// ---------------------------------------------------------------------------

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function tarList(archive) {
  const result = spawnSync('tar', ['-tf', archive], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`tar -tf failed: ${String(result.stderr).slice(0, 200)}`);
  return String(result.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function extractArchive(archive, into) {
  fs.mkdirSync(into, { recursive: true });
  const result = spawnSync('tar', ['-xf', archive, '-C', into], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`tar -xf failed: ${String(result.stderr).slice(0, 200)}`);
  return into;
}

/**
 * A gate failure whose message is composed here and therefore safe to print.
 *
 * Everything else caught by {@link main} is reduced to a class name, because the
 * operator's home and the extraction paths are both in scope for a foreign
 * throw.
 */
class ArchiveGateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArchiveGateError';
  }
}

/**
 * Every entry under `root`, relative, never following a symlink.
 *
 * A directory this cannot read is a **thrown error**, not a silently pruned
 * subtree. Swallowing it made every rule downstream — symlink policy, path
 * shapes, the byte scan — fail open on whatever was behind it, inside a gate
 * whose whole stated discipline is that "we could not look" is never "we looked
 * and it was clean". The caller turns the throw into a FAIL line naming the path.
 */
function walk(root) {
  const entries = [];
  const visit = (relative) => {
    let dirents;
    try {
      dirents = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch (error) {
      throw new ArchiveGateError(
        `unreadable directory in the extraction: ${relative === '' ? '.' : relative} (${error && error.code ? error.code : 'Error'})`,
      );
    }
    for (const dirent of dirents) {
      const rel = relative === '' ? dirent.name : `${relative}/${dirent.name}`;
      entries.push({ rel, dirent });
      if (dirent.isDirectory()) visit(rel);
    }
  };
  visit('');
  return entries;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Is this path inside an installed dependency tree?
 *
 * Any `node_modules` segment, not just a leading one: `npm ci` cannot hoist a
 * workspace's unhoistable dependency, so a production install also writes
 * `somalib/node_modules/soma-lib/**`. Treating only the root tree as dependency
 * territory made a correct archive fail on a published package's own `.d.ts`.
 */
function isDependencyPath(rel) {
  return rel === 'node_modules' || rel.split('/').includes('node_modules');
}

// ---------------------------------------------------------------------------
// Rules shared by every archive
// ---------------------------------------------------------------------------

/**
 * Member names, before extraction.
 *
 * An absolute or `..`-bearing member is a tar that writes outside the directory
 * it is extracted into. `bsdtar` refuses most of these on extraction, but a
 * consumer may not be using `bsdtar`, and "our archive is safe because their
 * extractor is careful" is not a property of our archive.
 */
function checkMemberNames(asset, archive) {
  const members = tarList(archive);
  const escaping = members.filter(
    (member) => member.startsWith('/') || member.split('/').some((segment) => segment === '..'),
  );
  check(members.length > 0, `${asset}: archive is not empty`);
  check(escaping.length === 0, `${asset}: every member stays inside the archive root`, escaping.slice(0, 5).join(', '));
  return members;
}

/**
 * Symlinks.
 *
 * The staged runtime tree may contain none at all — that rule is
 * `setup-package.js`'s and it is absolute. A packaged runtime is different: npm
 * links every workspace package and every `.bin` entry, so the archive would be
 * unusable without them. The rule that survives both facts is: no symlink
 * outside `node_modules`, and every symlink inside it relative and resolving to
 * something still inside the archive.
 */
function checkSymlinks(asset, root) {
  const outside = [];
  const escaping = [];

  for (const { rel, dirent } of walk(root)) {
    if (!dirent.isSymbolicLink()) continue;
    if (!isDependencyPath(rel)) {
      outside.push(rel);
      continue;
    }
    const target = fs.readlinkSync(path.join(root, rel));
    if (path.isAbsolute(target)) {
      escaping.push(`${rel} -> (absolute)`);
      continue;
    }
    const resolved = path.resolve(path.dirname(path.join(root, rel)), target);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) escaping.push(rel);
  }

  check(outside.length === 0, `${asset}: contains no symlink outside node_modules`, outside.slice(0, 5).join(', '));
  check(
    escaping.length === 0,
    `${asset}: every dependency symlink resolves inside the archive`,
    escaping.slice(0, 5).join(', '),
  );
}

function checkForbiddenShapes(asset, root) {
  const problems = [];

  for (const { rel, dirent } of walk(root)) {
    const base = path.basename(rel);
    if (dirent.isDirectory() && FORBIDDEN_DIRNAMES_ANYWHERE.has(base)) {
      problems.push(`${rel} (repository directory)`);
      continue;
    }
    if (!dirent.isDirectory() && FORBIDDEN_BASENAMES_ANYWHERE.has(base)) {
      problems.push(`${rel} (instance state or credential file)`);
      continue;
    }
    if (isDependencyPath(rel)) continue;

    if (dirent.isDirectory() && FORBIDDEN_FIRST_PARTY_DIRNAMES.has(base)) {
      problems.push(`${rel} (source or test directory)`);
      continue;
    }
    if (dirent.isDirectory() && rel === base && FORBIDDEN_FIRST_PARTY_ROOT_DIRNAMES.has(base)) {
      problems.push(`${rel} (mutable runtime-root directory)`);
      continue;
    }
    if (!dirent.isDirectory() && FORBIDDEN_FIRST_PARTY_BASENAMES.has(base)) {
      problems.push(`${rel} (materialized profile state)`);
      continue;
    }
    for (const pattern of FORBIDDEN_FIRST_PARTY_PATTERNS) {
      if (pattern.test(rel)) {
        problems.push(`${rel} (${pattern.why})`);
        break;
      }
    }
  }

  check(problems.length === 0, `${asset}: contains no forbidden path shape`, problems.slice(0, 8).join(', '));
}

/**
 * The byte scan, over every regular file in the extraction.
 *
 * Reported separately for credentials and for private identity strings because
 * they are different failures with different remedies: a credential means
 * something leaked, a private string means a comment nobody thought of as
 * published. Neither report quotes what it found.
 */
function checkBytes(asset, root) {
  const credentials = [];
  const priv = [];
  const unscannable = [];
  const skippedByExtension = new Map();
  let nativeBinaries = 0;
  let scanned = 0;

  for (const { rel, dirent } of walk(root)) {
    if (dirent.isDirectory() || dirent.isSymbolicLink()) continue;
    const target = path.join(root, rel);
    const table = isDependencyPath(rel) ? DEPENDENCY_TEXT_PATTERNS : FORBIDDEN_TEXT_PATTERNS;
    const scan = scanFileForForbiddenText(target, table);
    if (scan.kind === 'credential') credentials.push(`${scan.name}: ${rel}`);
    else if (scan.kind === 'private') priv.push(`${scan.name}: ${rel}`);
    else if (scan.kind === 'clean') scanned += 1;
    else if (scan.kind === 'skipped') {
      const extension = path.extname(rel).toLowerCase();
      skippedByExtension.set(extension, (skippedByExtension.get(extension) ?? 0) + 1);
    } else if (scan.kind === 'unscannable' || scan.kind === 'unreadable') {
      if (scan.kind === 'unscannable' && isNativeExecutable(target)) nativeBinaries += 1;
      else unscannable.push(`${scan.kind}: ${rel}`);
    }
  }

  check(credentials.length === 0, `${asset}: contains no credential bytes`, credentials.slice(0, 8).join(', '));
  check(
    priv.length === 0,
    `${asset}: contains no private operator identity or topology string`,
    priv.slice(0, 8).join(', '),
  );
  // Fail closed: "we could not look" is never "we looked and it was clean".
  // A native executable is the one case where "we could not look" is a fact
  // about the file's format, and it is reported rather than dropped.
  check(unscannable.length === 0, `${asset}: every file was scannable`, unscannable.slice(0, 8).join(', '));
  // Everything the scan did NOT read, itemized. The binary-extension list is
  // reviewed and defensible, but a gate that reports only its successes lets a
  // growing pile of unexamined files stay invisible.
  const skippedTotal = [...skippedByExtension.values()].reduce((sum, count) => sum + count, 0);
  const skippedDetail = [...skippedByExtension.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([extension, count]) => `${extension || '<none>'}×${count}`)
    .join(', ');
  console.log(
    `     (${scanned} file(s) text-scanned; ${skippedTotal} skipped by reviewed binary extension${skippedTotal > 0 ? `: ${skippedDetail}` : ''}; ${nativeBinaries} classified native by header)`,
  );
}

function checkMetadata(asset, root, expectedPackage, manifest) {
  const metadata = readJson(path.join(root, manifest.layout.runtime.marker));
  if (!check(metadata !== null, `${asset}: carries a readable .somawork-package.json`)) return;
  check(metadata.package === expectedPackage, `${asset}: metadata names package ${expectedPackage}`, String(metadata.package));
  check(
    (metadata.profile ?? null) === EXPECTED_PROFILE[expectedPackage],
    `${asset}: metadata names profile ${String(EXPECTED_PROFILE[expectedPackage])}`,
    String(metadata.profile),
  );
  check(metadata.version === manifest.version, `${asset}: metadata version matches the manifest`, String(metadata.version));
  check(metadata.sourceSha === manifest.sourceSha, `${asset}: metadata source sha matches the manifest`);
  check(metadata.channel === manifest.channel, `${asset}: metadata channel matches the manifest`);
  check(
    metadata.layoutVersion === manifest.layoutVersion,
    `${asset}: metadata layout version matches the manifest`,
    String(metadata.layoutVersion),
  );
}

/**
 * The SPDX identifier the repository itself declares.
 *
 * Read rather than hardcoded, for the same reason the packaging script reads
 * it: a gate carrying its own copy of the answer stops checking that the
 * archives agree with the repository and starts checking that they agree with
 * the gate. An unreadable root manifest yields `null`, which no archive can
 * match, so the failure mode is a refusal rather than a pass.
 */
function repositoryLicenseId() {
  const rootManifest = readJson(path.join(repoRoot, 'package.json'));
  return rootManifest === null ? null : rootManifest.license;
}

/**
 * Does this extraction carry the repository's own grant, byte for byte?
 *
 * Compared by hash against the canonical root file rather than pattern-matched
 * for a clause: a reworded "ISC-like" text is a different license, and an
 * archive gate is not the place to judge how different. If the canonical file
 * cannot be read the check FAILS instead of skipping — "we could not look" is
 * never "we looked and it was clean".
 */
function checkLicense(asset, root) {
  const canonical = path.join(repoRoot, LICENSE_MEMBER);
  if (!check(fs.existsSync(canonical), `${asset}: the repository's canonical ${LICENSE_MEMBER} is readable`)) return;
  const shipped = path.join(root, LICENSE_MEMBER);
  // `lstat`, not `existsSync`: a symlinked LICENSE would hash through to
  // whatever it points at, and an extraction is not a place to grant that.
  let shippedStat = null;
  try {
    shippedStat = fs.lstatSync(shipped);
  } catch {
    shippedStat = null;
  }
  if (!check(shippedStat !== null && shippedStat.isFile(), `${asset}: carries ${LICENSE_MEMBER}`)) return;
  check(
    sha256(shipped) === sha256(canonical),
    `${asset}: ${LICENSE_MEMBER} is byte-identical to the repository's`,
    sha256(shipped),
  );
}

// ---------------------------------------------------------------------------
// Controller archive
// ---------------------------------------------------------------------------

function checkControllerArchive(asset, archive, root, manifest, members) {
  // Straight from the manifest: the archive must match what the document tells
  // a formula, not what this file happens to believe.
  const layout = manifest.layout.controller;
  const expectedFiles = [manifest.layout.runtime.marker, layout.entry, layout.manifest, LICENSE_MEMBER].sort();

  const files = walk(root)
    .filter(({ dirent }) => !dirent.isDirectory())
    .map(({ rel }) => rel)
    .sort();
  check(
    JSON.stringify(files) === JSON.stringify(expectedFiles),
    `${asset}: contains exactly the controller files the manifest layout names`,
    files.join(', '),
  );
  check(
    !members.some((member) => member.startsWith('dist/') || member.startsWith('node_modules/')),
    `${asset}: carries no runtime payload or dependency tree`,
  );

  const entry = path.join(root, layout.entry);
  if (!check(fs.existsSync(entry), `${asset}: carries the manifest's controller entry ${layout.entry}`)) return;
  const mode = fs.statSync(entry).mode & 0o7777;
  check((mode & 0o111) !== 0, `${asset}: ${layout.entry} is executable`, mode.toString(8));
  // The depth that makes `__dirname/../../package.json` land on the archive's
  // own manifest. The renderer enforces it on the document; this enforces the
  // same fact on the bytes.
  check(
    path.resolve(path.dirname(entry), '..', '..', layout.manifest) === path.join(root, layout.manifest),
    `${asset}: the controller entry resolves its own package.json two directories up`,
  );

  const manifestJson = readJson(path.join(root, layout.manifest));
  if (check(manifestJson !== null, `${asset}: carries a readable package.json`)) {
    check(manifestJson.name === 'somawork-cli', `${asset}: package.json names somawork-cli`, String(manifestJson.name));
    check(manifestJson.version === manifest.version, `${asset}: package.json version matches the manifest`);
    check(
      manifestJson.bin !== undefined && manifestJson.bin.somawork === layout.entry,
      `${asset}: package.json points bin.somawork at the bundle`,
    );
    check(
      typeof manifestJson.engines?.node === 'string' && manifestJson.engines.node.includes(manifest.minimumNode),
      `${asset}: package.json declares the manifest's minimum Node`,
      JSON.stringify(manifestJson.engines),
    );
    // The identifier beside the grant `checkLicense` verified. This manifest is
    // the installed tree's own — what `readControllerVersion` opens and what
    // anyone inspecting an extraction reads — so it must agree with the
    // repository. Checked against the root manifest rather than a constant
    // here: a gate carrying its own copy of the answer stops checking the
    // archives and starts checking itself.
    check(
      manifestJson.license === repositoryLicenseId(),
      `${asset}: package.json declares the repository's license`,
      String(manifestJson.license),
    );
  }

  const bundle = fs.readFileSync(entry, 'utf8');
  check(bundle.startsWith('#!/usr/bin/env node\n'), `${asset}: the bundle is directly executable by node`);
  // `esbuild` folds every module into one CommonJS file, so every original
  // `require.main === module` guard resolves against the bundle's own module.
  // More than one means a second module's entrypoint runs inside the controller —
  // which is how the supervisor's daemon spawn ended up executing on
  // `somawork profile list`.
  check(
    (bundle.match(/require\.main === module/g) || []).length === 1,
    `${asset}: exactly one entrypoint guard survives bundling`,
  );
  // The supervisor's *module*, not its path: `src/cli/service.ts` legitimately
  // names `dist/run-with-rotating-logs.js` as the file the LaunchAgent execs, so
  // the string alone proves nothing. `esbuild` keys each bundled module by its
  // source path, and the supervisor's only third-party dependency is a log
  // rotator no controller command has any use for.
  for (const excluded of ['"src/run-with-rotating-logs.ts"', 'rotating-file-stream']) {
    check(!bundle.includes(excluded), `${asset}: the bundle carries no ${excluded}`);
  }

  checkControllerBehaviour(asset, root, manifest, layout.entry);
}

/**
 * Run the extracted controller the way a freshly `brew install`ed one runs:
 * no source checkout, no repository `node_modules`, no real Homebrew on PATH,
 * a hermetic profile home, and a decoy HOME it must not read.
 */
function checkControllerBehaviour(asset, root, manifest, entryPath) {
  const harness = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'somawork-archive-smoke-')));
  try {
    const home = path.join(harness, 'home');
    const bin = path.join(harness, 'bin');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'brew'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const run = (args) =>
      spawnSync(process.execPath, [path.join(root, entryPath), ...args], {
        cwd: harness,
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, SOMAWORK_HOME: home },
        encoding: 'utf8',
      });

    const version = run(['--version']);
    check(
      version.status === 0 && version.stdout.trim() === manifest.version,
      `${asset}: controller archive runs \`--version\` from a fresh extraction`,
      `exit ${String(version.status)} printed ${JSON.stringify(version.stdout.trim())}`,
    );

    const help = run(['--help']);
    check(help.status === 0 && help.stdout.includes('somawork setup'), `${asset}: \`--help\` documents \`somawork setup\``);
    for (const route of PRIVATE_ROUTES) {
      check(!help.stdout.includes(route), `${asset}: \`--help\` never names ${route}`);
    }

    const profiles = run(['profile', 'list', '--json']);
    check(
      profiles.status === 0 && profiles.stdout.trim() === '[]',
      `${asset}: \`profile list --json\` is [] with no runtime installed`,
      `exit ${String(profiles.status)} ${JSON.stringify(profiles.stdout.slice(0, 120))}`,
    );

    const show = run(['profile', 'show', '--profile', 'preview', '--json']);
    let view = null;
    try {
      view = JSON.parse(show.stdout);
    } catch {
      view = null;
    }
    check(
      show.status === 0 && view !== null && String(view.configDir).startsWith(`${home}/`),
      `${asset}: \`profile show\` resolves under the hermetic SOMAWORK_HOME`,
      `exit ${String(show.status)}`,
    );

    // The private Slack hook route, against a manifest materialized the way
    // `somawork setup` materializes one.
    const projectDir = path.join(harness, 'slack-project');
    fs.mkdirSync(projectDir, { recursive: true });
    const canonical = path.join(repoRoot, 'infra', 'slack', 'slack-app-manifest.json');
    const body = fs.existsSync(canonical)
      ? fs.readFileSync(canonical, 'utf8')
      : `${JSON.stringify(
          { display_information: { name: 'somawork' }, features: {}, oauth_config: {}, settings: { socket_mode_enabled: true } },
          null,
          2,
        )}\n`;
    const materialized = path.join(projectDir, 'manifest.json');
    fs.writeFileSync(materialized, body);

    const helper = run(['_print-slack-manifest', '--path', materialized]);
    let emitted = null;
    try {
      emitted = JSON.parse(helper.stdout);
    } catch {
      emitted = null;
    }
    check(
      helper.status === 0 && emitted !== null && JSON.stringify(emitted) === JSON.stringify(JSON.parse(body)),
      `${asset}: the private manifest helper emits exactly the manifest it was given`,
      `exit ${String(helper.status)}`,
    );
    check(helper.stderr === '', `${asset}: the private manifest helper writes nothing to stderr`);
  } finally {
    fs.rmSync(harness, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Runtime archives
// ---------------------------------------------------------------------------

function checkRuntimeArchive(asset, root, manifest, members) {
  const layout = manifest.layout.runtime;
  const required = [
    layout.manifest,
    layout.marker,
    layout.controllerEntry,
    layout.supervisor,
    layout.daemon,
    ...RUNTIME_EXTRA_REQUIRED_FILES,
  ];
  for (const rel of required) {
    const target = path.join(root, rel);
    let stat = null;
    try {
      stat = fs.lstatSync(target);
    } catch {
      stat = null;
    }
    check(stat !== null && stat.isFile(), `${asset}: carries ${rel}`);
  }

  const controller = path.join(root, layout.controllerEntry);
  if (fs.existsSync(controller)) {
    check(
      (fs.statSync(controller).mode & 0o111) !== 0,
      `${asset}: ${layout.controllerEntry} is executable`,
      (fs.statSync(controller).mode & 0o7777).toString(8),
    );
  }

  // Only the controller formula links `somawork`. Two runtimes that both shipped
  // one could not be installed side by side.
  check(
    !members.some((member) => member === 'bin/somawork' || member.endsWith('/bin/somawork')),
    `${asset}: links no somawork executable of its own`,
  );

  const pkg = readJson(path.join(root, layout.manifest));
  if (check(pkg !== null, `${asset}: carries a readable package.json`)) {
    check(pkg.version === manifest.version, `${asset}: package.json version matches the manifest`, String(pkg.version));
    const bin = pkg.bin === undefined ? undefined : pkg.bin.somawork;
    check(
      typeof bin === 'string' && fs.existsSync(path.join(root, bin)),
      `${asset}: bin.somawork resolves inside the archive`,
      String(bin),
    );
    // This manifest is the root one, carried through staging, so the identifier
    // arrives for free — which is precisely why it is worth pinning: a staging
    // change that started rewriting it would otherwise be invisible here.
    check(
      pkg.license === repositoryLicenseId(),
      `${asset}: package.json declares the repository's license`,
      String(pkg.license),
    );
  }

  checkRuntimeDependencies(asset, root, layout);

  checkSkillScript(asset, root);
}

/**
 * Does this extraction actually carry a working production install?
 *
 * Until now the only dependency assertion against a real archive was
 * `existsSync(node_modules)`. That answers "is there a directory", not "did the
 * install produce the closure the runtime needs" — and the difference is not
 * hypothetical: this task shipped, briefly, archives missing
 * `somalib/node_modules/soma-lib` because the packaging flag only copied the
 * root tree. Only a synthetic fixture caught it.
 *
 * Three questions, in increasing strength:
 *
 * 1. the nested trees `npm ci` cannot hoist are present;
 * 2. every workspace package the archive's OWN root manifest expands to has the
 *    entry point that package's manifest declares (derived, so a new workspace
 *    is covered without editing this file);
 * 3. the runtime's controller entry actually executes out of the extraction.
 */
function checkRuntimeDependencies(asset, root, layout) {
  const modules = path.join(root, 'node_modules');
  if (!check(fs.existsSync(modules), `${asset}: carries its production dependencies`)) return;

  for (const rel of REQUIRED_NESTED_DEPENDENCIES) {
    check(
      fs.existsSync(path.join(root, rel)),
      `${asset}: carries the unhoistable workspace dependency ${rel}`,
    );
  }

  const workspaces = archiveWorkspaceEntries(root);
  check(workspaces.unsupported.length === 0, `${asset}: every workspace pattern is one this gate can expand`, workspaces.unsupported.join(', '));
  check(workspaces.entries.length > 0, `${asset}: the archive manifest expands to at least one workspace package`);
  const missing = workspaces.entries.filter((rel) => !fs.existsSync(path.join(root, rel)));
  check(
    missing.length === 0,
    `${asset}: every workspace package's declared entry point is present`,
    missing.slice(0, 8).join(', '),
  );
  console.log(`     (${workspaces.entries.length} workspace entry point(s) resolved inside the archive)`);

  // The strongest statement available without a Homebrew prefix: run the thing.
  const run = spawnSync(process.execPath, [path.join(root, layout.controllerEntry), '--version'], {
    cwd: root,
    env: { PATH: '/usr/bin:/bin', HOME: path.join(root, '.no-home'), SOMAWORK_HOME: path.join(root, '.no-home') },
    encoding: 'utf8',
    timeout: 120_000,
  });
  check(
    run.status === 0 && run.stdout.trim().length > 0,
    `${asset}: the runtime's controller entry runs from the extraction`,
    `exit ${String(run.status)} ${String(run.stderr).slice(0, 160)}`,
  );
}

/**
 * Workspace entry points, expanded from the ARCHIVE's own root manifest.
 *
 * Only the bounded `<dir>/*` form the root manifest actually uses is supported;
 * anything else is reported rather than silently ignored. A package that
 * declares no `main`/`exports['.']` (`somalib` compiles in place) contributes no
 * requirement instead of a false one.
 */
function archiveWorkspaceEntries(root) {
  const entries = [];
  const unsupported = [];
  const rootManifest = readJson(path.join(root, 'package.json'));
  const patterns = rootManifest === null ? null : rootManifest.workspaces;
  if (!Array.isArray(patterns)) return { entries, unsupported: ['<archive package.json declares no workspaces array>'] };

  const dirs = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      unsupported.push(String(pattern));
      continue;
    }
    if (!pattern.includes('*')) {
      dirs.push(pattern);
      continue;
    }
    if (!pattern.endsWith('/*') || pattern.slice(0, -2).includes('*')) {
      unsupported.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    let children;
    try {
      children = fs.readdirSync(path.join(root, parent), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) if (child.isDirectory()) dirs.push(`${parent}/${child.name}`);
  }

  for (const dir of dirs.sort()) {
    const manifest = readJson(path.join(root, dir, 'package.json'));
    if (manifest === null) continue;
    const exported = manifest.exports === undefined || manifest.exports === null ? undefined : manifest.exports['.'];
    const entry = typeof manifest.main === 'string' ? manifest.main : typeof exported === 'string' ? exported : null;
    if (entry === null) continue;
    entries.push(path.posix.join(dir, entry.replace(/^\.\//, '')));
  }
  return { entries, unsupported };
}

/**
 * The shipped `extract-pr-data.js` must name an interpreter an installed
 * runtime has.
 *
 * Its compiled banner advertised `npx tsx extract-pr-data.ts`: `tsx` is a
 * devDependency the target never installs (`npm ci --omit=dev`) and the `.ts` is
 * pruned from the bundle, so every line of that help text named two things that
 * are not on the machine reading it.
 */
function checkSkillScript(asset, root) {
  const script = path.join(root, SKILL_SCRIPT);
  if (!fs.existsSync(script)) return;
  const body = fs.readFileSync(script, 'utf8');
  check(body.startsWith('#!/usr/bin/env node\n'), `${asset}: ${SKILL_SCRIPT} names an interpreter the runtime has`);
  check(
    !body.includes('extract-pr-data.ts'),
    `${asset}: ${SKILL_SCRIPT} never points the operator at a pruned TypeScript source`,
  );
  check(
    body.includes('node local/skills/github-pr/scripts/extract-pr-data.js'),
    `${asset}: ${SKILL_SCRIPT} documents its runnable invocation`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  let manifestPath = null;
  let dir = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--manifest') {
      manifestPath = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--dir') {
      dir = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unexpected argument: ${argv[index]}`);
    }
  }
  if (manifestPath === null) throw new Error('--manifest is required');
  return { manifestPath: path.resolve(manifestPath), dir: dir === null ? null : path.resolve(dir) };
}

function main() {
  let options;
  try {
    options = parseArgv(process.argv.slice(2));
  } catch (error) {
    console.error(`package-archives: ${error.message}`);
    process.exit(2);
  }

  const manifest = readJson(options.manifestPath);
  if (manifest === null) {
    console.error(`package-archives: cannot read manifest ${options.manifestPath}`);
    process.exit(2);
  }
  const assetDir = options.dir === null ? path.dirname(options.manifestPath) : options.dir;
  console.log(`manifest: ${options.manifestPath}`);

  check(manifest.schemaVersion === 1, 'manifest declares a schema version this gate understands');
  check(Array.isArray(manifest.assets) && manifest.assets.length === 3, 'manifest describes three assets');
  // Still absent, and now deliberately so rather than for want of a license.
  // ISC is fixed repository metadata that every archive carries as a file at its
  // root; it is not release-varying authority a consumer has to be told. Adding
  // a field to schema 1 that the tap renderer does not read would be a schema
  // change bought with nothing.
  check(manifest.license === undefined, 'manifest makes no license claim, because the archives carry the grant itself');
  // Every layout assertion below reads from here. A manifest without it cannot
  // be checked against its own archives, so this is fatal rather than skipped.
  check(
    manifest.layout !== null &&
      typeof manifest.layout === 'object' &&
      manifest.layout.install === 'prefix' &&
      typeof manifest.layout.controller?.entry === 'string' &&
      typeof manifest.layout.runtime?.marker === 'string',
    'manifest publishes the install layout a formula needs',
  );
  check(
    typeof manifest.baseUrl === 'string' && manifest.baseUrl.endsWith(`/${manifest.tag}`),
    'manifest binds its asset base URL to its own tag',
    String(manifest.baseUrl),
  );
  if (failures.length > 0) {
    console.error(`\nFAILED ${failures.length} check(s).`);
    process.exit(1);
  }

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'somawork-archive-gate-')));
  try {
    // The `try` is INSIDE the loop on purpose. With it outside, one unreadable
    // directory in the first archive aborted the run before the other two were
    // examined — still fail-closed, but a single run then told you nothing about
    // the state of the assets it never opened. Each asset is now reported on its
    // own, and the accumulated failures still exit non-zero.
    for (const asset of manifest.assets) {
      try {
        const archive = path.join(assetDir, asset.filename);
        if (!check(fs.existsSync(archive), `${asset.filename}: exists in ${assetDir}`)) continue;

        check(sha256(archive) === asset.sha256, `${asset.filename}: recorded sha256 matches the file on disk`);
        check(
          asset.url === `${manifest.baseUrl}/${asset.filename}`,
          `${asset.filename}: recorded url is this release's own download URL`,
          String(asset.url),
        );
        check(fs.statSync(archive).size === asset.bytes, `${asset.filename}: recorded byte count matches the file on disk`);

        const members = checkMemberNames(asset.filename, archive);
        const root = extractArchive(archive, path.join(scratch, asset.package));

        checkSymlinks(asset.filename, root);
        checkForbiddenShapes(asset.filename, root);
        checkBytes(asset.filename, root);
        checkMetadata(asset.filename, root, asset.package, manifest);
        checkLicense(asset.filename, root);

        if (asset.package === 'somawork-cli') checkControllerArchive(asset.filename, archive, root, manifest, members);
        else checkRuntimeArchive(asset.filename, root, manifest, members);

        fs.rmSync(root, { recursive: true, force: true });
      } catch (error) {
        // Our own failures carry a message this file composed, so it is
        // printable. Anything else is reduced to a class name: archive paths and
        // the operator's home are both in scope for a foreign throw.
        if (error instanceof ArchiveGateError) {
          fail(`${asset.filename}: the archive gate refused the extraction — ${error.message}`);
        } else {
          fail(`${asset.filename}: the archive gate could not complete (${error && error.name ? error.name : 'Error'})`);
        }
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`FAILED ${failures.length} check(s); ${checks} passed.`);
    process.exit(1);
  }
  console.log(`OK release archives: ${checks} checks passed against ${options.manifestPath}`);
}

module.exports = {
  DEPENDENCY_TEXT_PATTERNS,
  RUNTIME_EXTRA_REQUIRED_FILES,
  REQUIRED_NESTED_DEPENDENCIES,
  archiveWorkspaceEntries,
  isNativeExecutable,
  walk,
};

if (require.main === module) {
  main();
}
