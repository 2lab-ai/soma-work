/**
 * B-2 producer-side enforcement: every `controller.abort()` / `abortController
 * .abort()` call in production source MUST pass a reason argument.
 *
 * Why: an untagged `.abort()` produces `signal.reason === DOMException("aborted")`,
 * which `coerceAbortReason` collapses to `undefined`, which `handleError`'s
 * notify-worthy gate treats as silent. The turn vanishes without a card.
 * Trace: `docs/current/plans/turn-end-surface-guarantee/exhaustive-paths.md` §B-2.
 *
 * Producer-side enforcement (lint rule equivalent) — repo-local AST-free regex
 * scan that strips comments + strings first to avoid false positives on the
 * many docstring references to `controller.abort()`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** Top-level directories we scan — production TS only (tests, dist, node_modules excluded). */
const SCAN_ROOTS = ['packages', 'src', 'somalib', 'scripts'];

const EXCLUDE_FRAGMENTS = [
  `${path.sep}__tests__${path.sep}`,
  `${path.sep}dist${path.sep}`,
  `${path.sep}node_modules${path.sep}`,
  `${path.sep}.trash${path.sep}`,
];

/**
 * `.abort()` with NO arguments (whitespace tolerated). Matches:
 *   `controller.abort()`
 *   `abortController.abort()`
 *   `foo.abort(\n)`
 *   `foo.abort(   )`
 *
 * Multiline tolerant via `[\s]*` inside the parens.
 */
const NO_ARG_ABORT_RE = /\.abort\s*\(\s*\)/g;

/**
 * Strip block comments, line comments, and string literals from TS source so
 * `controller.abort()` written inside a docstring (we have several) doesn't
 * count as a violation. Cheap heuristic — handles single + double quotes and
 * template literals, doesn't try to parse nested templates perfectly. False
 * positives on edge cases would fail the test, which is the desired direction
 * (over-strict beats under-strict for this contract).
 */
function stripCommentsAndStrings(src: string): string {
  // Build output character-by-character so line indices align with the
  // original source. Comments are replaced with spaces (preserving
  // newlines). String contents are replaced with `x` (non-whitespace,
  // non-paren) so a tagged call like `.abort('stall-timeout')` keeps
  // visible characters between its parens and the no-arg regex
  // `\.abort\s*\(\s*\)` doesn't false-match it. The surrounding quote
  // characters are also replaced with `x` so the regex never sees them.
  let i = 0;
  let out = '';
  while (i < src.length) {
    const two = src.substr(i, 2);
    if (two === '//') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stopAt = end === -1 ? src.length : end + 2;
      for (let j = i; j < stopAt; j++) out += src[j] === '\n' ? '\n' : ' ';
      i = stopAt;
      continue;
    }
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const start = i;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        if (quote === '`' && src.substr(i, 2) === '${') {
          let depth = 1;
          i += 2;
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
          }
          continue;
        }
        i++;
      }
      for (let j = start; j < i; j++) out += src[j] === '\n' ? '\n' : 'x';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Manual recursive walker — `node:fs/promises` `glob` is Node 22+. CI runs
 * on Node 20, so use plain `readdirSync` instead.
 */
function collectProductionFiles(): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const isDir = entry.isDirectory();
      const isFile = entry.isFile();
      if (isDir) {
        // Skip excluded directories cheaply before descending.
        if (
          entry.name === '__tests__' ||
          entry.name === 'dist' ||
          entry.name === 'node_modules' ||
          entry.name === '.trash'
        ) {
          continue;
        }
        visit(full);
        continue;
      }
      if (!isFile) continue;
      if (!full.endsWith('.ts') && !full.endsWith('.tsx')) continue;
      if (full.endsWith('.test.ts') || full.endsWith('.test.tsx')) continue;
      if (EXCLUDE_FRAGMENTS.some((frag) => full.includes(frag))) continue;
      files.push(full);
    }
  };
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO_ROOT, root);
    try {
      if (statSync(abs).isDirectory()) visit(abs);
    } catch {
      // Missing root is fine — skip silently.
    }
  }
  return files;
}

describe('B-2 — no untagged abort() in production source', () => {
  it('every `.abort()` call in production code MUST pass a reason argument', () => {
    const files = collectProductionFiles();
    expect(files.length).toBeGreaterThan(50); // sanity — we are scanning a real codebase

    const violations: Array<{ file: string; line: number; preview: string }> = [];
    for (const abs of files) {
      const raw = readFileSync(abs, 'utf8');
      const stripped = stripCommentsAndStrings(raw);
      // Walk matches in the stripped content but report line numbers from the
      // ORIGINAL content (line indices line up because we preserve newlines
      // via the strip routine — comments are replaced with spaces and strings
      // are replaced with a single space, but newlines are kept verbatim).
      const matches = stripped.matchAll(NO_ARG_ABORT_RE);
      const rawLines = raw.split('\n');
      for (const m of matches) {
        const upto = stripped.slice(0, m.index ?? 0);
        const line = upto.split('\n').length;
        violations.push({
          file: path.relative(REPO_ROOT, abs),
          line,
          preview: rawLines[line - 1]?.trim() ?? '',
        });
      }
    }

    if (violations.length > 0) {
      const detail = violations.map((v) => `  ${v.file}:${v.line}\n    ${v.preview}`).join('\n');
      throw new Error(
        `Found ${violations.length} untagged abort() call(s) in production source.\n` +
          `Tag each with an explicit reason: turn-flow controllers use a RequestAbortReason ` +
          `literal (e.g. \`controller.abort('user-stop' satisfies RequestAbortReason)\`); ` +
          `fetch-timeout / non-turn controllers use a descriptive string (e.g. ` +
          `\`controller.abort('timeout')\`).\n\nViolations:\n${detail}`,
      );
    }
    expect(violations).toEqual([]);
  });
});
