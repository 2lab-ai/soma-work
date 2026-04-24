/**
 * Migrate co-located `src/**\/*.test.ts` files into sibling `__tests__/` folders.
 *
 * - AST-based rewrite of every relative module specifier (static import, import
 *   type, typeof import(), dynamic import(), require(), vi.mock(),
 *   vi.importActual(), importOriginal()). Non-literal specifiers → fail-fast.
 * - Text-level rewrite of `__dirname`-based FS paths driven by a hardcoded
 *   DIRNAME_MAP (one live-hit per file).
 * - Three filename collisions handled via hardcoded COLLISION_MAP (renames the
 *   moved file with an `.<aspect>` suffix).
 * - `git mv` preserves history. Preflight phase (`--dry-run`) reports the full
 *   plan without mutating the tree.
 *
 * Usage (from repo root):
 *   npx tsx scripts/migrate-tests-to-__tests__.ts --dry-run
 *   npx tsx scripts/migrate-tests-to-__tests__.ts --execute
 *
 * Scope: `src/**\/*.test.ts` only. somalib/** and mcp-servers/** are out of
 * scope for issue #728.
 *
 * This script is intentionally one-shot: it is committed in a dedicated commit
 * so the migration is reproducible from git history, then removed in the same
 * PR once the migration has been applied.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

// ---------------------------------------------------------------------------
// Configuration (verified during planning — see issue #728 Confirmed Plan)
// ---------------------------------------------------------------------------

// Source path (relative to repo root) → new target basename after the move.
const COLLISION_MAP: Record<string, string> = {
  'src/metrics/token-pricing.test.ts': 'token-pricing.pricing.test.ts',
  'src/metrics/report-aggregator.test.ts': 'report-aggregator.core.test.ts',
  'src/slack/commands/usage-handler.test.ts': 'usage-handler.routing.test.ts',
};

// Source path → list of literal text substitutions to apply to the file
// contents once it has been moved one directory deeper.
// Each `{ find, replace }` pair MUST match exactly once in the file — the
// script fails if a pattern matches 0 or >1 times, to catch drift.
interface DirnameEdit {
  find: string;
  replace: string;
}
const DIRNAME_MAP: Record<string, DirnameEdit[]> = {
  'src/auto-resume.test.ts': [
    {
      find: "path.join(__dirname, 'prompt', 'restart.prompt')",
      replace: "path.join(__dirname, '..', 'prompt', 'restart.prompt')",
    },
  ],
  'src/deploy/deploy-config.test.ts': [
    {
      find: "path.resolve(__dirname, '..', '..')",
      replace: "path.resolve(__dirname, '..', '..', '..')",
    },
  ],
  'src/local/skills/UIAskUserQuestion/templates/templates.test.ts': [
    {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal text-match patterns — the target file contains a template literal with ${name}; these strings describe that source verbatim.
      find: 'join(__dirname, `${name}.json`)',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal text-match patterns — the target file contains a template literal with ${name}; these strings describe that source verbatim.
      replace: "join(__dirname, '..', `${name}.json`)",
    },
  ],
  'src/metrics/event-store.test.ts': [
    {
      find: "path.join(__dirname, '../../.test-data-metrics')",
      replace: "path.join(__dirname, '../../../.test-data-metrics')",
    },
  ],
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpecifierEdit {
  /** Offset into the original source file (0-indexed, pre-rewrite). */
  start: number;
  /** End offset (exclusive) of the string literal in the source. */
  end: number;
  /** Original specifier (without quotes). */
  original: string;
  /** Rewritten specifier (without quotes). */
  rewritten: string;
  /** Context label for preflight output (e.g. 'ImportDeclaration'). */
  kind: string;
}

interface FilePlan {
  /** Repo-relative source path, e.g. `src/foo/bar.test.ts`. */
  oldRelPath: string;
  /** Repo-relative target path, e.g. `src/foo/__tests__/bar.test.ts`. */
  newRelPath: string;
  /** Whether this move used a COLLISION_MAP entry. */
  collisionRenamed: boolean;
  /** Specifier rewrites. */
  specEdits: SpecifierEdit[];
  /** Dirname text edits (from DIRNAME_MAP). */
  dirnameEdits: DirnameEdit[];
  /** Whether this file had any __dirname occurrence (for the report). */
  hadDirname: boolean;
}

interface Preflight {
  plans: FilePlan[];
  nonLiteralErrors: string[];
  dirnameUnmappedErrors: string[];
  collisionErrors: string[];
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

const SPECIFIER_CALL_CALLEES = new Set(['require', 'importOriginal']);
const VI_MEMBER_CALLS = new Set(['mock', 'unmock', 'doMock', 'doUnmock', 'importActual', 'importMock']);

/** Returns true when the CallExpression's callee targets a module specifier. */
function callExprTargetsSpecifier(node: ts.CallExpression): boolean {
  const callee = node.expression;

  // import(...) — ts.SyntaxKind.ImportKeyword, represented as a token
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;

  // require(...) / importOriginal(...)
  if (ts.isIdentifier(callee) && SPECIFIER_CALL_CALLEES.has(callee.text)) {
    return true;
  }

  // vi.mock(...), vi.importActual(...), etc. — we also accept any `x.mock(...)`
  // etc. because the `vi` namespace can be aliased or destructured. Limiting to
  // method name is sufficient: AST walking only runs over .test.ts files.
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    if (VI_MEMBER_CALLS.has(callee.name.text)) return true;
  }

  return false;
}

/** StringLiteral extractor that rejects template literals / non-literals. */
function extractSpecifierLiteral(
  node: ts.Node | undefined,
  contextLabel: string,
  filePath: string,
  errors: string[],
): ts.StringLiteral | null {
  if (!node) return null;
  if (ts.isStringLiteral(node)) return node;
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    // Plain template string with no ${} — still a compile-time literal.
    // We treat this as acceptable: its text is unambiguous.
    return null;
  }
  // Anything else (TemplateExpression, Identifier, BinaryExpression, etc.)
  const { line, character } = ts.getLineAndCharacterOfPosition(node.getSourceFile(), node.getStart());
  errors.push(
    `${filePath}:${line + 1}:${character + 1}: non-literal specifier in ${contextLabel} — refactor required before migration`,
  );
  return null;
}

/** Walks a SourceFile and yields SpecifierEdit plans for every relative spec. */
function collectSpecifierEdits(
  sourceFile: ts.SourceFile,
  filePath: string,
  oldAbsDir: string,
  newAbsDir: string,
  nonLiteralErrors: string[],
): SpecifierEdit[] {
  const edits: SpecifierEdit[] = [];

  function rewriteSpecifier(original: string): string {
    // Only rewrite relative specifiers (./ or ../).
    if (!original.startsWith('./') && !original.startsWith('../')) {
      return original;
    }
    const oldTargetAbs = path.resolve(oldAbsDir, original);
    let rel = path.relative(newAbsDir, oldTargetAbs);
    if (rel === '') rel = '.';
    // Normalize Windows-style separators for cross-platform safety.
    rel = rel.split(path.sep).join('/');
    // Ensure the result is still relative (not "foo" with no prefix).
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return rel;
  }

  function addIfLiteral(node: ts.Node | undefined, kind: string): void {
    const lit = extractSpecifierLiteral(node, kind, filePath, nonLiteralErrors);
    if (!lit) return;
    const original = lit.text;
    const rewritten = rewriteSpecifier(original);
    if (rewritten === original) return; // bare specifier → unchanged
    edits.push({
      // Quote char is at lit.getStart(); the inner text is at lit.getStart()+1.
      // We rewrite the entire literal including quotes to preserve quote style.
      start: lit.getStart(sourceFile),
      end: lit.getEnd(),
      original,
      rewritten,
      kind,
    });
  }

  function visit(node: ts.Node): void {
    // import ... from '...';  export * from '...';  export { x } from '...';
    if (ts.isImportDeclaration(node)) {
      addIfLiteral(node.moduleSpecifier, 'ImportDeclaration');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      addIfLiteral(node.moduleSpecifier, 'ExportDeclaration');
    }
    // typeof import('...') / import('...')  (ImportTypeNode — type position)
    else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) {
        addIfLiteral(node.argument.literal, 'ImportTypeNode');
      } else {
        // Non-literal type argument — surface as error.
        const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, node.argument.getStart());
        nonLiteralErrors.push(`${filePath}:${line + 1}:${character + 1}: non-literal specifier in ImportTypeNode`);
      }
    }
    // Call expressions: import(), require(), vi.mock(), vi.importActual(), importOriginal()
    else if (ts.isCallExpression(node) && callExprTargetsSpecifier(node)) {
      // vi.mock(import('./x'), factory) — first arg is itself a CallExpression
      // containing the specifier. The recursive `visit` below handles it. For
      // the CallExpression's own first argument, rewrite only when it is a
      // direct string literal (e.g. vi.mock('./x', factory)).
      const firstArg = node.arguments[0];
      if (firstArg && (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg))) {
        addIfLiteral(firstArg, getCallLabel(node));
      } else if (firstArg && !isAcceptableNonStringCallArg(firstArg)) {
        // For require('./x') / import('./x') we require a literal. For vi.mock,
        // `import('./x')` as the first arg is legal (handled via ImportType /
        // nested CallExpression walking).
        const callLabel = getCallLabel(node);
        if (callLabel === 'require' || callLabel === 'import()' || callLabel === 'importOriginal') {
          // Allow no-substitution template literals; reject TemplateExpression /
          // Identifier / BinaryExpression / etc.
          if (!ts.isStringLiteral(firstArg) && !ts.isNoSubstitutionTemplateLiteral(firstArg)) {
            const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, firstArg.getStart());
            nonLiteralErrors.push(`${filePath}:${line + 1}:${character + 1}: non-literal specifier in ${callLabel}()`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  // Sort by start offset descending so slice-based rewrite is index-stable.
  edits.sort((a, b) => b.start - a.start);
  return edits;
}

function getCallLabel(node: ts.CallExpression): string {
  const callee = node.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return 'import()';
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    const obj = ts.isIdentifier(callee.expression) ? callee.expression.text : 'obj';
    return `${obj}.${callee.name.text}`;
  }
  return 'callExpression';
}

function isAcceptableNonStringCallArg(node: ts.Node): boolean {
  // For vi.mock(import('./x'), factory) the first arg is a CallExpression with
  // ImportKeyword callee — that's accepted; the nested call is walked on its
  // own and rewritten. Same for any nested literal-bearing construct.
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function listTestFilesUnderSrc(repoRoot: string): string[] {
  const out: string[] = [];
  function walk(absDir: string, relDir: string): void {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const absPath = path.join(absDir, entry.name);
      const relPath = path.join(relDir, entry.name);
      if (entry.isDirectory()) {
        walk(absPath, relPath);
      } else if (entry.isFile() && entry.name.endsWith('.test.ts') && !relPath.split(path.sep).includes('__tests__')) {
        out.push(relPath.split(path.sep).join('/'));
      }
    }
  }
  walk(path.join(repoRoot, 'src'), 'src');
  return out.sort();
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function planFile(
  repoRoot: string,
  oldRelPath: string,
  nonLiteralErrors: string[],
  dirnameUnmappedErrors: string[],
): FilePlan {
  const oldAbsPath = path.join(repoRoot, oldRelPath);
  const oldDirRel = path.dirname(oldRelPath);
  const newDirRel = path.join(oldDirRel, '__tests__').split(path.sep).join('/');
  const collisionBasename = COLLISION_MAP[oldRelPath];
  const newBasename = collisionBasename ?? path.basename(oldRelPath);
  const newRelPath = `${newDirRel}/${newBasename}`;

  const oldAbsDir = path.dirname(oldAbsPath);
  const newAbsDir = path.dirname(path.join(repoRoot, newRelPath));

  const source = fs.readFileSync(oldAbsPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    oldRelPath,
    source,
    ts.ScriptTarget.ES2020,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );

  const specEdits = collectSpecifierEdits(sourceFile, oldRelPath, oldAbsDir, newAbsDir, nonLiteralErrors);

  const dirnameEdits = DIRNAME_MAP[oldRelPath] ?? [];
  // Detect any raw `__dirname` token in the file (source text, not AST — we
  // accept comment hits as long as no mapping was required). Any file with
  // `__dirname` but no DIRNAME_MAP entry must be the skill-force-handler
  // comment-only case; surface others as errors.
  const hasDirnameToken = /\b__dirname\b/.test(source);
  if (hasDirnameToken && dirnameEdits.length === 0) {
    // Allow comment-only occurrences: re-scan the AST looking for any
    // Identifier node with text '__dirname'. If none found in code, it's
    // purely a comment reference and safe to skip.
    const hitsInCode = scanDirnameInCode(sourceFile);
    if (hitsInCode > 0) {
      dirnameUnmappedErrors.push(
        `${oldRelPath}: found ${hitsInCode} __dirname code reference(s) but no DIRNAME_MAP entry`,
      );
    }
  }

  return {
    oldRelPath,
    newRelPath,
    collisionRenamed: Boolean(collisionBasename),
    specEdits,
    dirnameEdits,
    hadDirname: hasDirnameToken,
  };
}

function scanDirnameInCode(sourceFile: ts.SourceFile): number {
  let count = 0;
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === '__dirname') {
      count += 1;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return count;
}

function runPreflight(repoRoot: string): Preflight {
  const nonLiteralErrors: string[] = [];
  const dirnameUnmappedErrors: string[] = [];
  const collisionErrors: string[] = [];

  const files = listTestFilesUnderSrc(repoRoot);
  const plans = files.map((f) => planFile(repoRoot, f, nonLiteralErrors, dirnameUnmappedErrors));

  // Detect target-path collisions that the COLLISION_MAP missed.
  const byTarget = new Map<string, string[]>();
  for (const p of plans) {
    const list = byTarget.get(p.newRelPath) ?? [];
    list.push(p.oldRelPath);
    byTarget.set(p.newRelPath, list);
  }
  // Also check against existing files under __tests__ directories.
  for (const [target, sources] of byTarget) {
    const targetAbs = path.join(repoRoot, target);
    if (sources.length > 1) {
      collisionErrors.push(`target ${target} produced by ${sources.length} sources: ${sources.join(', ')}`);
    }
    if (fs.existsSync(targetAbs)) {
      collisionErrors.push(
        `target ${target} already exists (pre-existing test in __tests__/) — source(s): ${sources.join(', ')}`,
      );
    }
  }

  return { plans, nonLiteralErrors, dirnameUnmappedErrors, collisionErrors };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function applySpecifierEdits(source: string, edits: SpecifierEdit[]): string {
  // edits are pre-sorted descending by start offset → slice-rewriting is safe.
  let out = source;
  for (const e of edits) {
    const before = out.slice(0, e.start);
    const lit = out.slice(e.start, e.end);
    const after = out.slice(e.end);
    // Preserve the original quote style.
    const quote = lit[0];
    if (quote !== '"' && quote !== "'" && quote !== '`') {
      throw new Error(`unexpected quote char at offset ${e.start} for specifier ${e.original}`);
    }
    out = `${before}${quote}${e.rewritten}${quote}${after}`;
  }
  return out;
}

function applyDirnameEdits(source: string, edits: DirnameEdit[], filePath: string): string {
  let out = source;
  for (const edit of edits) {
    const occurrences = countOccurrences(out, edit.find);
    if (occurrences === 0) {
      throw new Error(`${filePath}: DIRNAME_MAP pattern not found: ${JSON.stringify(edit.find)}`);
    }
    if (occurrences > 1) {
      throw new Error(
        `${filePath}: DIRNAME_MAP pattern matches ${occurrences} times (expected 1): ${JSON.stringify(edit.find)}`,
      );
    }
    out = out.replace(edit.find, edit.replace);
  }
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let i = 0;
  let count = 0;
  while (true) {
    const next = haystack.indexOf(needle, i);
    if (next === -1) break;
    count += 1;
    i = next + needle.length;
  }
  return count;
}

function executeMigration(repoRoot: string, plans: FilePlan[]): void {
  // 1. Rewrite source in place first (so git mv preserves the new content).
  //    Actually: git mv renames before we write; but we want history to be
  //    attached to the move. Safer approach — write edits BEFORE the move,
  //    under the old path, then `git mv`. git will then record the changes as
  //    "edit + rename" which `git log --follow` will trace correctly.
  for (const plan of plans) {
    const oldAbsPath = path.join(repoRoot, plan.oldRelPath);
    let source = fs.readFileSync(oldAbsPath, 'utf8');
    source = applySpecifierEdits(source, plan.specEdits);
    if (plan.dirnameEdits.length > 0) {
      source = applyDirnameEdits(source, plan.dirnameEdits, plan.oldRelPath);
    }
    fs.writeFileSync(oldAbsPath, source, 'utf8');
  }

  // 2. Stage content changes so `git mv` doesn't refuse (it works fine with
  //    unstaged edits, but explicit `git add` makes history cleaner).
  //    Actually git mv does NOT refuse with unstaged edits. Skip the add.

  // 3. git mv each file, creating the destination dir as needed.
  for (const plan of plans) {
    const destAbsDir = path.join(repoRoot, path.dirname(plan.newRelPath));
    if (!fs.existsSync(destAbsDir)) {
      fs.mkdirSync(destAbsDir, { recursive: true });
    }
    try {
      execFileSync('git', ['mv', plan.oldRelPath, plan.newRelPath], { cwd: repoRoot, stdio: 'pipe' });
    } catch (err) {
      throw new Error(`git mv failed for ${plan.oldRelPath} -> ${plan.newRelPath}: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printPreflight(pre: Preflight): void {
  const { plans, nonLiteralErrors, dirnameUnmappedErrors, collisionErrors } = pre;
  const totalMoves = plans.length;
  const totalCollisions = plans.filter((p) => p.collisionRenamed).length;
  const totalDirnameLiveHits = plans.filter((p) => p.dirnameEdits.length > 0).length;
  const totalSpecEdits = plans.reduce((s, p) => s + p.specEdits.length, 0);

  console.log('=== Preflight report ===');
  console.log(`total moves:              ${totalMoves}`);
  console.log(`collision renames:        ${totalCollisions}`);
  console.log(`dirname live-hits:        ${totalDirnameLiveHits}`);
  console.log(`specifier edits planned:  ${totalSpecEdits}`);
  console.log();

  if (totalCollisions > 0) {
    console.log('Collision renames:');
    for (const p of plans.filter((pl) => pl.collisionRenamed)) {
      console.log(`  ${p.oldRelPath} -> ${p.newRelPath}`);
    }
    console.log();
  }
  if (totalDirnameLiveHits > 0) {
    console.log('Dirname edits:');
    for (const p of plans.filter((pl) => pl.dirnameEdits.length > 0)) {
      for (const e of p.dirnameEdits) {
        console.log(`  ${p.oldRelPath}:  ${JSON.stringify(e.find)} -> ${JSON.stringify(e.replace)}`);
      }
    }
    console.log();
  }

  let hasErrors = false;
  if (nonLiteralErrors.length > 0) {
    hasErrors = true;
    console.error('FAIL: non-literal module specifiers detected:');
    for (const e of nonLiteralErrors) console.error(`  ${e}`);
  }
  if (dirnameUnmappedErrors.length > 0) {
    hasErrors = true;
    console.error('FAIL: __dirname code references with no DIRNAME_MAP entry:');
    for (const e of dirnameUnmappedErrors) console.error(`  ${e}`);
  }
  if (collisionErrors.length > 0) {
    hasErrors = true;
    console.error('FAIL: target-path collisions:');
    for (const e of collisionErrors) console.error(`  ${e}`);
  }

  if (hasErrors) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const mode = args.includes('--execute') ? 'execute' : args.includes('--dry-run') ? 'dry-run' : null;
  if (!mode) {
    console.error('usage: tsx scripts/migrate-tests-to-__tests__.ts (--dry-run|--execute)');
    process.exit(2);
  }

  const repoRoot = path.resolve(process.cwd());
  if (!fs.existsSync(path.join(repoRoot, 'src'))) {
    console.error(`ERROR: no src/ directory at ${repoRoot} — run from repo root`);
    process.exit(2);
  }

  const pre = runPreflight(repoRoot);
  printPreflight(pre);

  if (mode === 'execute') {
    console.log('=== Executing migration ===');
    executeMigration(repoRoot, pre.plans);
    console.log(`moved ${pre.plans.length} files`);
  } else {
    console.log('(dry-run — no changes written)');
  }
}

main();
