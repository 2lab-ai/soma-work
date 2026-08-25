#!/usr/bin/env node
/**
 * `payload-tools.js` — the two payload operations that must not be shell.
 *
 * `package-somawork.sh` used to carry both of these as inline `node -e` blobs.
 * They live here instead because both are correctness-critical and neither was
 * testable where it was:
 *
 * **`normalize-mtimes <dir> <epoch>`** forces every mtime, symlinks included, to
 * `SOURCE_DATE_EPOCH`. Not `touch -t`: that parses its stamp in the local
 * timezone, so the same command on two machines writes two different mtimes into
 * the archive — the exact class of drift the determinism work exists to remove.
 *
 * **`tar-list <dir> <out>`** writes the member list `tar --null -T` consumes.
 * The list is:
 *
 * - built from a real directory walk, never from `find | sed | sort`, because
 *   that pipeline's separator IS the newline it is trying to defend against;
 * - sorted by raw bytes, so member order is locale-independent and two runs
 *   agree;
 * - NUL-delimited, so a name containing a newline cannot split into two members;
 * - and **refused outright** if any name contains a control character.
 *
 * That last rule is what the old guard was supposed to enforce and never did: it
 * compared `wc -l` of the list with `wc -l` of `find`, and a newline in a path
 * increments both sides equally. With colliding siblings present, `tar` exited 0,
 * silently dropped the newline-bearing file, and duplicated two others.
 *
 * Refusal rather than faithful archiving is deliberate. `bsdtar --null -T` does
 * archive such a name correctly (verified), but these are public artifacts and a
 * member name carrying a newline breaks every consumer that pipes `tar -t`
 * through `read`. The payload is `stage-bundle.sh` output plus an `npm ci` tree,
 * so no legitimate input can contain one.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** C0 controls and DEL. A member name containing any of these is refused. */
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;

/** Printable rendering of an offending name — never the raw bytes. */
function describeName(name) {
  return JSON.stringify(name);
}

/**
 * Every entry under `root`, relative, depth-first, directories included.
 *
 * Symlinks are listed but never descended: `tar` stores the link itself, and
 * following one would archive the target under the link's name.
 */
function collectEntries(root) {
  const entries = [];
  const visit = (relative) => {
    const dirents = fs.readdirSync(relative === '' ? root : path.join(root, relative), { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = relative === '' ? dirent.name : `${relative}/${dirent.name}`;
      entries.push(rel);
      if (dirent.isDirectory()) visit(rel);
    }
  };
  visit('');
  return entries;
}

function normalizeMtimes(root, epoch) {
  const stamp = Number(epoch);
  if (!Number.isFinite(stamp)) throw new Error('normalize-mtimes needs an integer epoch');
  const visit = (dir) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, dirent.name);
      if (dirent.isDirectory()) visit(child);
      else fs.lutimesSync(child, stamp, stamp);
    }
    // After its children: creating them bumped this directory's own mtime.
    fs.lutimesSync(dir, stamp, stamp);
  };
  visit(root);
}

/** The member list in archive order, or a throw naming the first offenders. */
function buildTarList(root) {
  const entries = collectEntries(root);
  const offending = entries.filter((rel) => CONTROL_CHARACTER_RE.test(rel));
  if (offending.length > 0) {
    throw new Error(
      `payload member name contains a control character: ${offending.slice(0, 3).map(describeName).join(', ')}`,
    );
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return entries;
}

function main(argv) {
  const [command, ...rest] = argv;
  try {
    if (command === 'normalize-mtimes') {
      const [root, epoch] = rest;
      if (root === undefined || epoch === undefined) throw new Error('usage: normalize-mtimes <dir> <epoch>');
      normalizeMtimes(root, epoch);
      return 0;
    }
    if (command === 'tar-list') {
      const [root, out] = rest;
      if (root === undefined || out === undefined) throw new Error('usage: tar-list <dir> <out>');
      const entries = buildTarList(root);
      fs.writeFileSync(out, `${entries.join('\0')}\0`);
      process.stdout.write(`${entries.length}\n`);
      return 0;
    }
    throw new Error(`unknown command: ${String(command)}`);
  } catch (error) {
    process.stderr.write(`payload-tools: ${error && error.message ? error.message : 'failed'}\n`);
    return 1;
  }
}

module.exports = { buildTarList, collectEntries, normalizeMtimes, CONTROL_CHARACTER_RE };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
