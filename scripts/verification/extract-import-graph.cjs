#!/usr/bin/env node
/**
 * extract-import-graph.cjs — the runtime import graph of every production TypeScript file, as
 * the Lean data `verification/lean/SomaVerify/ImportGraph` proves things about. See
 * verification/README.md for the method and `ImportGraph/Spec.lean` for what is proven.
 *
 *   node scripts/verification/extract-import-graph.cjs
 *       writes verification/lean/SomaVerify/ImportGraph/Generated.lean (gitignored).
 *       scripts/verification/lean-verify.sh runs every extract-*.cjs before `lake build`.
 *   node scripts/verification/extract-import-graph.cjs [--lean <file>] [--json <file>]
 *       writes the Lean data and/or a JSON dump of the same graph elsewhere; the vitest suite
 *       (scripts/verification/__tests__/import-graph.test.ts) runs it into a temp dir.
 *
 * The proofs take this program's output on trust. What it guarantees:
 *
 *   nodes       exactly the production TypeScript files `git ls-files` lists: *.ts, *.tsx,
 *               *.mts, *.cts, minus declaration files, *.test.* and *.spec.* files, and anything
 *               under __tests__/, __fixtures__/ or node_modules/. Numbered in path order, one
 *               path each.
 *   edges       runtime loads only. Every node is compiled by the repository's own TypeScript to
 *               CommonJS, and each `require("…")` in the emitted JavaScript is one load;
 *               `import("…")` compiles to a `require` too, so lazy loads are edges as well. The
 *               compiler erases `import type`, and value-syntax imports whose bindings are used
 *               only as types or as a const enum it inlines, so neither becomes an edge. What the
 *               emit keeps is decided by ELISION below, and every tsconfig*.json git lists,
 *               `extends` applied, must set the same, so the real build keeps nothing more.
 *   resolution  A relative specifier resolves against the importing file's directory, the way
 *               Node's CommonJS loader resolves it next to the compiled file (each package
 *               compiles its tree to its outDir unchanged): the exact file, then `.js`, `.json`,
 *               then `/index.js`, each compiled file mapped back to its `.ts`/`.tsx` source; a
 *               specifier that is `.` or `..` or ends in `/`, `/.` or `/..` names the directory
 *               only, so its `/index.js` (namesDirectory). A
 *               workspace package name resolves through that package's `exports` the way Node's
 *               CommonJS loader does (the exact subpath, else the `*` pattern with the longest
 *               prefix; the target file must exist as written), or through the package directory
 *               when it has no `exports`; the file reached is mapped back to its source through
 *               the package's tsconfig rootDir/outDir. No `dist/` output is read. Not followed: a
 *               `#` specifier (package.json `imports`), and a directory with a package.json on
 *               disk, whose "main" Node reads before the directory's index.
 *   failure     Node built-ins and npm dependencies are dropped. Everything else is fatal, and
 *               nothing is written: a relative, workspace or `#` specifier that does not resolve
 *               to a production file (a tracked `.json` file is the one allowed non-code target,
 *               and a leaf), a load whose specifier is not a string literal, any other hold on
 *               the module loader in the emitted JavaScript (collectLoads lists them: `require`
 *               other than `require("…")`, `typeof require`, `require.resolve` and
 *               `require.main === module`; `module.require`, `createRequire`, `node:module`, …),
 *               what runs a string as code (`eval` and `Function` as a variable, a member or a
 *               key, a `.constructor` called with arguments, `node:vm`), a production file the
 *               compiler did not emit, a tsconfig that differs from ELISION. The graph is
 *               complete or there is no graph, as far as loads are spelled out in the code: code
 *               built from strings by other means, and npm packages that load files on a caller's
 *               behalf, are beyond this analysis.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { builtinModules } = require('node:module');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ts = require(require.resolve('typescript', { paths: [REPO_ROOT] }));

const DEFAULT_LEAN_OUT = 'verification/lean/SomaVerify/ImportGraph/Generated.lean';

/** The controller CLI's entry point: the root of the closure the Lean side reasons about. */
const CLI_ROOT = 'src/cli/index.ts';

/**
 * Where the MCP server packages live. The daemon spawns each one's `bin` with `node`
 * (src/internal-mcp-server-resolver.ts) and speaks MCP with it over the child's stdio, so every
 * `bin` target of a workspace package in here is a stdio MCP server entry.
 */
const MCP_SERVERS_DIR = 'packages/mcp-servers/';

/**
 * The two env-paths files. `packages/common/src/env-paths.ts` spawns `git`, calls
 * `dotenv.config()` and prints a banner when it loads; `src/env-paths.ts` re-exports it, so
 * loading either loads the banner.
 */
const ENV_PATHS = ['src/env-paths.ts', 'packages/common/src/env-paths.ts'];

/**
 * Path prefix → Lean `Layer` constructor, first match wins; any other file is `other`. The first
 * four are the ranked layers of rules/packaging.md rule 4.
 */
const GROUPS = [
  ['packages/common/', 'common'],
  ['packages/process-shared/', 'processShared'],
  ['packages/slack/', 'slack'],
  ['src/', 'src'],
  ['somalib/', 'somalib'],
  ['packages/test-utils/', 'testUtils'],
  ['packages/mcp-servers/', 'mcpServers'],
  ['scripts/', 'scripts'],
];
const OTHER = 'other';

/** Edges per Lean list literal: keeps every literal shallow for the elaborator. */
const EDGE_CHUNK = 200;

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const toPosix = (p) => p.split(path.sep).join('/');

function fail(lines) {
  const error = new Error(lines.join('\n'));
  error.extractFailure = true;
  throw error;
}

/** The group (Lean `Layer` constructor name) of a repository path. */
function layerOf(file) {
  const hit = GROUPS.find(([prefix]) => file.startsWith(prefix));
  return hit ? hit[1] : OTHER;
}

/** Whether `git ls-files` entry `file` is a production TypeScript file (see the header). */
function isProductionTs(file) {
  const base = path.posix.basename(file);
  return (
    /\.(ts|tsx|mts|cts)$/.test(file) &&
    !/\.d\.(ts|mts|cts)$/.test(file) &&
    !/\.(test|spec)\./.test(base) &&
    !/(^|\/)(__tests__|__fixtures__|node_modules)\//.test(file)
  );
}

function gitLsFiles(repoRoot) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28 });
  return out.split('\0').filter((file) => file !== '');
}

/** The production TypeScript files, repository-relative, in path order. */
function listProductionFiles(repoRoot = REPO_ROOT) {
  return gitLsFiles(repoRoot).filter(isProductionTs).sort(byString);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The compiler options that decide which loads the emit keeps, as the graph's compile sets them:
 * CommonJS, and tsc's default import elision, which erases an import whose bindings are used
 * only as types or as a const enum it inlines. Under isolatedModules or verbatimModuleSyntax tsc
 * keeps such imports, and under preserveConstEnums a re-exported const enum's, and under
 * emitDecoratorMetadata the imports a decorated signature names as types
 * (markAliasReferenced in TypeScript's checker). A build under any of them loads modules the
 * graph has no edge to, so every tsconfig must set these as they are set here.
 */
const ELISION = {
  module: ts.ModuleKind.CommonJS,
  isolatedModules: false,
  verbatimModuleSyntax: false,
  preserveConstEnums: false,
  emitDecoratorMetadata: false,
};

/** The compiler options of `config`, `extends` applied. Only options: no directory is scanned. */
function readCompilerOptions(config) {
  return ts.getParsedCommandLineOfConfigFile(
    config,
    {},
    {
      ...ts.sys,
      readDirectory: () => [],
      onUnRecoverableConfigFileDiagnostic: (diagnostic) =>
        fail([`extract-import-graph: ${config}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`]),
    },
  ).options;
}

/** The options of `options` that differ from ELISION, as `name value` for the message. */
function elisionDrift(options) {
  const drift = [];
  // The module format tsc emits, with its default applied when a config leaves `module` out.
  const moduleKind = ts.getEmitModuleKind(options);
  if (moduleKind !== ELISION.module) drift.push(`module ${ts.ModuleKind[moduleKind]}`);
  for (const [name, value] of Object.entries(ELISION)) {
    if (name !== 'module' && Boolean(options[name]) !== value) drift.push(`${name} ${options[name]}`);
  }
  // Deprecated in TypeScript 5.0 and removed in 5.5; while read, both kept imports the default
  // elision erases. A config that still sets them is refused rather than guessed at.
  if (options.preserveValueImports) drift.push('preserveValueImports true');
  if (options.importsNotUsedAsValues !== undefined && options.importsNotUsedAsValues !== ts.ImportsNotUsedAsValues.Remove) {
    drift.push(`importsNotUsedAsValues ${ts.ImportsNotUsedAsValues[options.importsNotUsedAsValues]}`);
  }
  return drift;
}

/**
 * Holds every tsconfig*.json `git ls-files` lists to ELISION. Whichever of them builds a
 * production file, the root one or a package's (package.json runs `tsc -p` on each), and
 * whatever it extends, it then keeps no load the graph's compile erases. Options given to tsc
 * on a command line are not seen.
 */
function checkTsconfigs(repoRoot, tracked) {
  const drifted = [];
  for (const file of tracked.filter((name) => /^tsconfig.*\.json$/.test(path.posix.basename(name)))) {
    const drift = elisionDrift(readCompilerOptions(path.join(repoRoot, file)));
    if (drift.length > 0) drifted.push(`  ${file}: ${drift.join(', ')}`);
  }
  if (drifted.length > 0) {
    fail([
      'extract-import-graph: tsconfig options under which tsc keeps loads the graph does not have',
      `(the graph compiles with ${JSON.stringify({ ...ELISION, module: 'CommonJS' })}):`,
      ...drifted,
    ]);
  }
}

/**
 * rootDir/outDir of the tsconfig in `dir` (absolute): a compiled file `<outDir>/x.js` comes from
 * `<rootDir>/x.ts`. Without a tsconfig, or without an outDir, files run where they are.
 */
function compileDirs(dir) {
  const config = path.join(dir, 'tsconfig.json');
  if (!fs.existsSync(config)) return { rootDir: dir, outDir: dir };
  const { rootDir, outDir } = readCompilerOptions(config);
  if (!outDir) return { rootDir: dir, outDir: dir };
  if (!rootDir) fail([`extract-import-graph: ${config} sets outDir without rootDir; cannot map outputs to sources`]);
  return { rootDir: path.resolve(rootDir), outDir: path.resolve(outDir) };
}

/** Every workspace package of the root package.json, by package name. */
function loadWorkspaces(repoRoot) {
  const dirs = [];
  for (const pattern of readJson(path.join(repoRoot, 'package.json')).workspaces || []) {
    if (pattern.endsWith('/*') && !pattern.slice(0, -2).includes('*')) {
      const parent = path.join(repoRoot, pattern.slice(0, -2));
      for (const name of fs.readdirSync(parent).sort(byString)) {
        if (fs.existsSync(path.join(parent, name, 'package.json'))) dirs.push(path.join(parent, name));
      }
    } else if (!pattern.includes('*')) {
      dirs.push(path.join(repoRoot, pattern));
    } else {
      fail([`extract-import-graph: unsupported workspaces pattern ${JSON.stringify(pattern)}`]);
    }
  }
  const packages = new Map();
  for (const dir of dirs) {
    const pkg = readJson(path.join(dir, 'package.json'));
    packages.set(pkg.name, { name: pkg.name, dir, pkg, ...compileDirs(dir) });
  }
  return packages;
}

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

/**
 * Node's PATTERN_KEY_COMPARE (esm/resolve.js), as a sort comparator: the key with the longer
 * prefix before `*` first, then the longer key.
 */
function patternKeyCompare(a, b) {
  const aStar = a.indexOf('*');
  const bStar = b.indexOf('*');
  const aBase = aStar === -1 ? a.length : aStar + 1;
  const bBase = bStar === -1 ? b.length : bStar + 1;
  if (aBase > bBase) return -1;
  if (bBase > aBase) return 1;
  if (aStar === -1) return 1;
  if (bStar === -1) return -1;
  if (a.length > b.length) return -1;
  if (b.length > a.length) return 1;
  return 0;
}

/** A conditional export target, under the conditions Node's CommonJS loader uses. */
function pickTarget(target) {
  if (typeof target === 'string' || target === null) return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const picked = pickTarget(item);
      if (picked !== undefined && picked !== null) return picked;
    }
    return null;
  }
  if (typeof target === 'object') {
    for (const [condition, value] of Object.entries(target)) {
      if (condition === 'require' || condition === 'node' || condition === 'default') {
        const picked = pickTarget(value);
        if (picked !== undefined) return picked;
      }
    }
  }
  return undefined;
}

/**
 * The file `exports` maps `subpath` ('.' or './x') to, relative to the package directory, or
 * null when the subpath is not exported. Mirrors Node's packageExportsResolve.
 */
function resolveExports(exportsField, subpath) {
  const isSubpathMap =
    exportsField !== null &&
    typeof exportsField === 'object' &&
    !Array.isArray(exportsField) &&
    Object.keys(exportsField).some((key) => key.startsWith('.'));
  const map = isSubpathMap ? exportsField : { '.': exportsField };
  if (Object.hasOwn(map, subpath) && !subpath.includes('*')) {
    const target = pickTarget(map[subpath]);
    return typeof target === 'string' ? target : null;
  }
  let bestKey = null;
  let bestMatch = '';
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*');
    if (star === -1 || key.indexOf('*', star + 1) !== -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.startsWith(prefix) &&
      subpath.length >= key.length &&
      subpath.endsWith(suffix) &&
      (bestKey === null || patternKeyCompare(bestKey, key) === 1)
    ) {
      bestKey = key;
      bestMatch = subpath.slice(prefix.length, subpath.length - suffix.length);
    }
  }
  if (bestKey === null) return null;
  const target = pickTarget(map[bestKey]);
  return typeof target === 'string' ? target.split('*').join(bestMatch) : null;
}

/**
 * Whether a relative specifier names a directory outright. Checked on Node v26.9.0:
 * `Module._findPath` sets `trailingSlash` for a request that is `.` or `..` or ends in `/`, `/.`
 * or `/..`, and then skips the file lookup (the exact file, then each extension) and resolves the
 * path only as a directory (`tryPackage`: package.json "main", else the index), so with both
 * `x.js` and `x/index.js` present `require('./x')` loads the file and `require('./x/')`,
 * `require('./x/.')`, `require('.')` and `require('..')` load the index. path.resolve drops the
 * trailing part, so it is read off the specifier.
 */
const namesDirectory = (specifier) => /(?:^|\/)\.\.?$|\/$/.test(specifier);

/**
 * `resolve` resolves specifiers from production files: `node` results carry the
 * repository-relative path of a production file; `json` is a tracked JSON file (a leaf);
 * `external` is a Node built-in or an npm dependency; `error` is fatal. `packageFile` maps a file
 * a package names directly (a `bin` target) to its production source, the same way.
 */
function createResolver(repoRoot, productionSet, trackedSet, workspaces) {
  const rootName = readJson(path.join(repoRoot, 'package.json')).name;
  const rel = (abs) => toPosix(path.relative(repoRoot, abs));
  const builtins = new Set(builtinModules);

  /** A runtime file → its production source, a JSON leaf, an error, or null (no such file). */
  function sourceOf(runtimeFile) {
    const extension = path.extname(runtimeFile);
    const stem = runtimeFile.slice(0, runtimeFile.length - extension.length);
    const sourceExtensions = { '.js': ['.ts', '.tsx'], '.cjs': ['.cts'], '.mjs': ['.mts'] }[extension] || [];
    for (const sourceExtension of sourceExtensions) {
      const source = rel(stem + sourceExtension);
      if (productionSet.has(source)) return { kind: 'node', target: source };
      if (trackedSet.has(source)) return { kind: 'error', reason: `resolves to non-production file ${source}` };
    }
    const asIs = rel(runtimeFile);
    if (extension === '.json' && trackedSet.has(asIs)) return { kind: 'json', target: asIs };
    if (trackedSet.has(asIs)) return { kind: 'error', reason: `resolves to non-production file ${asIs}` };
    return null;
  }

  /** sourceOf for runtime files, through `toSourcePath` (runtime path → source-tree path or null). */
  const sourceVia = (toSourcePath) => (runtimeFile) => {
    const sourcePath = toSourcePath(runtimeFile);
    return sourcePath === null ? null : sourceOf(sourcePath);
  };

  /**
   * Node's LOAD_AS_FILE, then LOAD_AS_DIRECTORY, for a runtime path; `toSourcePath` maps a
   * runtime path to its place in the source tree (null: none). With `directoryOnly` the
   * LOAD_AS_FILE step is skipped (see namesDirectory). LOAD_AS_DIRECTORY reads the directory's
   * package.json before its index and follows its "main", which can name any file and which this
   * resolver does not follow: a directory with a package.json on disk, tracked or not, is an
   * error. Without one, the directory's index.
   */
  function loadAsFileOrDirectory(runtimeBase, toSourcePath, directoryOnly = false) {
    const toSource = sourceVia(toSourcePath);
    for (const candidate of directoryOnly ? [] : [runtimeBase, `${runtimeBase}.js`, `${runtimeBase}.json`]) {
      const hit = toSource(candidate);
      if (hit) return hit;
    }
    const directory = toSourcePath(runtimeBase);
    if (directory !== null && fs.existsSync(path.join(directory, 'package.json'))) {
      return {
        kind: 'error',
        reason: `resolves to directory ${rel(directory) || '.'}/, whose package.json Node reads for "main", which this resolver does not follow`,
      };
    }
    return toSource(path.join(runtimeBase, 'index.js'));
  }

  /** Maps a runtime path inside a package's outDir to its place in the package's source tree. */
  function sourcePathVia(pkg) {
    return (runtimePath) => {
      const inOut = path.relative(pkg.outDir, runtimePath);
      return inOut.startsWith('..') || path.isAbsolute(inOut) ? null : path.join(pkg.rootDir, inOut);
    };
  }

  /** Maps a runtime file inside a package's outDir back to its source. */
  function viaCompileDirs(pkg) {
    return sourceVia(sourcePathVia(pkg));
  }

  function resolveWorkspace(pkg, subpath) {
    if (pkg.pkg.exports !== undefined) {
      const target = resolveExports(pkg.pkg.exports, subpath === '' ? '.' : `./${subpath}`);
      if (target === null) return { kind: 'error', reason: `not exported by ${pkg.name}` };
      if (!target.startsWith('./')) return { kind: 'error', reason: `invalid exports target ${target}` };
      // Node requires the export target to exist exactly as written: no extension probing.
      const hit = viaCompileDirs(pkg)(path.join(pkg.dir, target));
      return hit || { kind: 'error', reason: `exports target ${target} of ${pkg.name} has no production source` };
    }
    const base = path.join(pkg.dir, subpath === '' ? pkg.pkg.main || 'index.js' : subpath);
    return (
      loadAsFileOrDirectory(base, sourcePathVia(pkg)) || {
        kind: 'error',
        reason: `no production source for ${subpath === '' ? pkg.name : `${pkg.name}/${subpath}`}`,
      }
    );
  }

  function resolve(specifier, fromFile) {
    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
      const base = path.resolve(path.dirname(path.join(repoRoot, fromFile)), specifier);
      // Each package compiles its tree to its outDir unchanged: the runtime path is the source's.
      return (
        loadAsFileOrDirectory(base, (runtimePath) => runtimePath, namesDirectory(specifier)) || {
          kind: 'error',
          reason: 'no such production file',
        }
      );
    }
    // Node resolves `#…` through the nearest package.json's `imports`, which can name any file.
    if (specifier.startsWith('#')) {
      return { kind: 'error', reason: 'is a package.json "imports" specifier, which this resolver does not follow' };
    }
    if (path.isAbsolute(specifier)) return { kind: 'error', reason: 'absolute specifier' };
    if (specifier.startsWith('node:') || builtins.has(specifier) || builtins.has(specifier.split('/')[0])) {
      return { kind: 'external' };
    }
    const segments = specifier.split('/');
    const scoped = specifier.startsWith('@');
    const name = segments.slice(0, scoped ? 2 : 1).join('/');
    const pkg = workspaces.get(name);
    if (pkg) return resolveWorkspace(pkg, segments.slice(scoped ? 2 : 1).join('/'));
    if (name === rootName) return { kind: 'error', reason: 'the root package is not importable by name' };
    return { kind: 'external' };
  }

  function packageFile(pkg, target) {
    return viaCompileDirs(pkg)(path.join(pkg.dir, target));
  }

  return { resolve, packageFile };
}

// ---------------------------------------------------------------------------------------------
// Loads in the emitted JavaScript
// ---------------------------------------------------------------------------------------------

/**
 * Names that reach the module loader, or run a string as code (which could reach it unseen),
 * refused wherever they appear in the emitted JavaScript: as a variable, a member (`x.name`,
 * `x['name']`, so `globalThis.eval` too) or a key. `require` as a member or key is
 * `module.require` and its kind (every module object has one); `require` and `module` as
 * variables are the loader's own handles and have their harmless forms (see collectLoads).
 */
const REFUSED_NAMES = new Map([
  ['require', 'a require other than the module\'s own require("…")'],
  ['createRequire', 'createRequire, a require for any directory'],
  ['mainModule', 'process.mainModule, a module object with its own require'],
  ['getBuiltinModule', 'process.getBuiltinModule, which hands out node:module'],
  ['eval', 'eval, which runs a string as code'],
  ['Function', 'the Function constructor, which runs a string as code'],
]);

/** Built-in modules whose exports load modules (`Module._load`, `createRequire`) or run code. */
const LOADER_BUILTINS = new Set(['module', 'node:module', 'vm', 'node:vm']);

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

const isEqualityOperand = (node) => ts.isBinaryExpression(node.parent) && EQUALITY.has(node.parent.operatorToken.kind);

/** Whether `node` names a property (`x.name`, `x['name']`, `{ name: … }`, a class member, a destructured key). */
function isPropertyName(node) {
  const parent = node.parent;
  return (
    ((ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    ts.isComputedPropertyName(parent)
  );
}

/** Whether `node` is the name a declaration binds (a variable, a parameter, a function, a class). */
function isDeclaredName(node) {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent)) &&
    parent.name === node
  );
}

/** Whether `node` lies outside every function with its own `arguments` (an arrow function has none). */
function atModuleScope(node) {
  for (let up = node.parent; up; up = up.parent) {
    if (ts.isFunctionLike(up) && !ts.isArrowFunction(up)) return false;
  }
  return true;
}

/** The member a callee reads (`x.name`, `x['name']`), past parentheses and tsc's `(0, f)` form. */
function calleeMemberName(callee) {
  let inner = callee;
  while (
    ts.isParenthesizedExpression(inner) ||
    (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.CommaToken)
  ) {
    inner = ts.isParenthesizedExpression(inner) ? inner.expression : inner.right;
  }
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text;
  if (ts.isElementAccessExpression(inner) && ts.isStringLiteralLike(inner.argumentExpression)) {
    return inner.argumentExpression.text;
  }
  return undefined;
}

/**
 * The loads in one emitted file: `{ specifier, line }` for each `require("…")` and
 * `import("…")`, and `{ problem, line }` for anything this analysis cannot follow, one per
 * construct.
 *
 * A CommonJS module is handed the loader as `require` and `module` (the wrapper's `arguments`
 * hold both), so each use of those is checked. `require` may only be called on one string
 * literal, probed with `typeof`, or used as `require.resolve` (a path, not a load) and
 * `require.main === module`; `module` only as `module.exports`, `typeof module` or an operand of
 * `===`. Everything else that leads to a loader is a problem: the names in REFUSED_NAMES as a
 * variable, a member or a key (`module.require`, `require.main.require`, `createRequire`,
 * `globalThis.eval`, …), a load of a LOADER_BUILTINS module, `arguments` at module scope, and a
 * `.constructor` called with arguments (a function's constructor is Function).
 */
function collectLoads(fileName, text) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const loads = [];
  const reported = new Set();
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  // The expression `node` begins, up through member accesses, calls, and the `(0, f)` form tsc
  // emits for a call to an imported function: `module.require('x')` for `module`. A name that
  // begins nothing (`const load = require`, `f(require)`) is shown with what holds it.
  const excerptOf = (node) => {
    let top = node;
    for (let up = top.parent; up; top = up, up = up.parent) {
      const climbs =
        ts.isPropertyAccessExpression(up) ||
        ts.isElementAccessExpression(up) ||
        ts.isParenthesizedExpression(up) ||
        ((ts.isCallExpression(up) || ts.isNewExpression(up)) && up.expression === top) ||
        (ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.CommaToken && up.right === top);
      if (!climbs) break;
    }
    if (top === node && ts.isIdentifier(node)) {
      while (top.parent && !ts.isSourceFile(top.parent) && top.getText(sourceFile) === node.text) top = top.parent;
    }
    const excerpt = top.getText(sourceFile).replace(/\s+/g, ' ');
    return excerpt.length > 160 ? `${excerpt.slice(0, 157)}...` : excerpt;
  };
  const problem = (node, reason) => {
    const line = lineOf(node);
    const excerpt = excerptOf(node);
    if (reported.has(`${line} ${excerpt}`)) return;
    reported.add(`${line} ${excerpt}`);
    loads.push({ problem: `${reason}: ${excerpt}`, line });
  };
  const checkRequire = (node) => {
    const parent = node.parent;
    const harmless =
      (ts.isCallExpression(parent) && parent.expression === node) ||
      ts.isTypeOfExpression(parent) ||
      (ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        (parent.name.text === 'resolve' || (parent.name.text === 'main' && isEqualityOperand(parent))));
    if (!harmless) {
      problem(node, 'require other than require("…"), typeof require, require.resolve or require.main === module');
    }
  };
  const checkModule = (node) => {
    const parent = node.parent;
    const harmless =
      isPropertyName(node) ||
      isDeclaredName(node) ||
      (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === 'exports') ||
      ts.isTypeOfExpression(parent) ||
      isEqualityOperand(node);
    if (!harmless) problem(node, 'module other than module.exports, typeof module or require.main === module');
  };
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      const [argument] = node.arguments;
      if (node.arguments.length !== 1 || !ts.isStringLiteralLike(argument)) {
        problem(node, 'load with a non-literal specifier');
      } else if (LOADER_BUILTINS.has(argument.text)) {
        problem(node, `loads ${argument.text}, whose exports load modules or run code no require("…") names`);
      } else {
        loads.push({ specifier: argument.text, line: lineOf(node) });
      }
    } else if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      (node.arguments || []).length > 0 &&
      calleeMemberName(node.expression) === 'constructor'
    ) {
      problem(node, "a constructor called with arguments: a function's is Function, which runs a string as code");
    } else if (ts.isIdentifier(node)) {
      if (node.text === 'require') checkRequire(node);
      else if (node.text === 'module') checkModule(node);
      else if (REFUSED_NAMES.has(node.text)) problem(node, REFUSED_NAMES.get(node.text));
      else if (node.text === 'arguments' && !isPropertyName(node) && atModuleScope(node)) {
        problem(node, "the module wrapper's arguments, which hold require and module");
      }
    } else if (ts.isStringLiteralLike(node) && isPropertyName(node) && REFUSED_NAMES.has(node.text)) {
      problem(node, REFUSED_NAMES.get(node.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return loads;
}

// ---------------------------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------------------------

/**
 * Compiles every production file to CommonJS in memory and returns its JavaScript by
 * repository path. Module resolution for the type checker goes through `resolve`, so a
 * production import resolves to its production source (which decides what the emit erases)
 * and nothing outside the repository is loaded.
 */
function emitAll(repoRoot, files, resolve) {
  const options = {
    // module and what the emit erases: the options every tsconfig is held to.
    ...ELISION,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
    resolveJsonModule: true,
    jsx: ts.JsxEmit.React,
    noLib: true,
    types: [],
    declaration: false,
    sourceMap: false,
    noEmitOnError: false,
    rootDir: repoRoot,
    outDir: path.join(repoRoot, '.import-graph-emit'),
  };
  const host = ts.createCompilerHost(options, true);
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map((literal) => {
      const result = resolve(literal.text, toPosix(path.relative(repoRoot, containingFile)));
      if (result.kind !== 'node') return { resolvedModule: undefined };
      const resolvedFileName = path.join(repoRoot, result.target);
      return {
        resolvedModule: {
          resolvedFileName,
          extension: ts.extensionFromPath(resolvedFileName),
          isExternalLibraryImport: false,
        },
      };
    });
  const program = ts.createProgram({ rootNames: files.map((file) => path.join(repoRoot, file)), options, host });
  const emitted = new Map();
  // The callback receives the output instead of a disk write: nothing lands under outDir.
  const result = program.emit(undefined, (fileName, text, _bom, _onError, sourceFiles) => {
    if (!/\.(js|cjs|mjs)$/.test(fileName) || !sourceFiles || sourceFiles.length !== 1) return;
    const source = toPosix(path.relative(repoRoot, sourceFiles[0].fileName));
    if (emitted.has(source)) fail([`extract-import-graph: ${source} was emitted twice`]);
    emitted.set(source, text);
  });
  if (result.emitSkipped) fail(['extract-import-graph: TypeScript skipped the emit']);
  const missing = files.filter((file) => !emitted.has(file));
  if (missing.length > 0) fail(['extract-import-graph: production files TypeScript did not emit:', ...missing]);
  return emitted;
}

/**
 * The stdio MCP server entries: the `bin` targets of every workspace package under
 * MCP_SERVERS_DIR, as production sources, in path order. A package in there without a `bin`, or
 * a `bin` without a production source, is fatal: an entry left out would be a server no theorem
 * covers.
 */
function listMcpServerEntries(repoRoot, workspaces, packageFile) {
  const entries = new Set();
  for (const pkg of workspaces.values()) {
    if (!`${toPosix(path.relative(repoRoot, pkg.dir))}/`.startsWith(MCP_SERVERS_DIR)) continue;
    const { bin } = pkg.pkg;
    const targets = typeof bin === 'string' ? [bin] : Object.values(bin || {});
    if (targets.length === 0) fail([`extract-import-graph: ${pkg.name} is under ${MCP_SERVERS_DIR} but has no bin`]);
    for (const target of targets) {
      const hit = packageFile(pkg, target);
      if (!hit || hit.kind !== 'node') {
        fail([`extract-import-graph: bin ${target} of ${pkg.name} has no production source`]);
      }
      entries.add(hit.target);
    }
  }
  if (entries.size === 0) fail([`extract-import-graph: no workspace package under ${MCP_SERVERS_DIR}`]);
  return [...entries].sort(byString);
}

/** Breadth-first closure of `roots` over `edges` (`{ src, dst }` ids), as sorted ids. */
function closureOf(nodeCount, edges, roots) {
  const out = Array.from({ length: nodeCount }, () => []);
  for (const edge of edges) out[edge.src].push(edge.dst);
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    for (const next of out[queue.shift()]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/** Builds the graph; throws (extractFailure) listing every problem when it cannot be complete. */
function extractGraph(repoRoot = REPO_ROOT) {
  const tracked = gitLsFiles(repoRoot);
  // Counted here, straight from `git ls-files`; the nodes below are the files the compiler
  // emitted. The Lean coverage theorem checks that the two agree.
  const productionFileCount = tracked.filter(isProductionTs).length;
  const files = listProductionFiles(repoRoot);
  const absent = files.filter((file) => !fs.existsSync(path.join(repoRoot, file)));
  if (absent.length > 0) fail(['extract-import-graph: tracked production files missing from the checkout:', ...absent]);
  checkTsconfigs(repoRoot, tracked);
  const workspaces = loadWorkspaces(repoRoot);
  const { resolve, packageFile } = createResolver(repoRoot, new Set(files), new Set(tracked), workspaces);
  const emitted = emitAll(repoRoot, files, resolve);

  const nodes = [...emitted.keys()].sort(byString);
  const id = new Map(nodes.map((file, index) => [file, index]));
  const problems = [];
  const edgeMap = new Map();
  const stats = { loads: 0, productionLoads: 0, jsonLoads: 0, externalLoads: 0 };
  for (const file of nodes) {
    for (const load of collectLoads(file, emitted.get(file))) {
      if (load.problem) {
        problems.push(`${file} (emitted line ${load.line}): ${load.problem}`);
        continue;
      }
      stats.loads += 1;
      const result = resolve(load.specifier, file);
      if (result.kind === 'error') {
        problems.push(`${file} (emitted line ${load.line}): '${load.specifier}' ${result.reason}`);
      } else if (result.kind === 'external') {
        stats.externalLoads += 1;
      } else if (result.kind === 'json') {
        stats.jsonLoads += 1;
      } else {
        stats.productionLoads += 1;
        const key = `${id.get(file)}>${id.get(result.target)}`;
        const edge = edgeMap.get(key);
        if (!edge) {
          edgeMap.set(key, { src: id.get(file), dst: id.get(result.target), specifiers: [load.specifier] });
        } else if (!edge.specifiers.includes(load.specifier)) {
          edge.specifiers.push(load.specifier);
        }
      }
    }
  }
  if (problems.length > 0) {
    fail([
      `extract-import-graph: ${problems.length} load(s) the graph cannot follow:`,
      ...problems.map((p) => `  ${p}`),
    ]);
  }
  for (const anchor of [CLI_ROOT, ...ENV_PATHS]) {
    if (!id.has(anchor)) fail([`extract-import-graph: ${anchor} is not a production file`]);
  }
  const mcpServerEntries = listMcpServerEntries(repoRoot, workspaces, packageFile).map((file) => id.get(file));

  const edges = [...edgeMap.values()].sort((a, b) => a.src - b.src || a.dst - b.dst);
  const root = id.get(CLI_ROOT);
  return {
    productionFileCount,
    nodes: nodes.map((file, index) => ({ id: index, path: file, layer: layerOf(file) })),
    edges,
    root,
    envPaths: ENV_PATHS.map((file) => id.get(file)),
    closure: closureOf(nodes.length, edges, [root]),
    mcpServerEntries,
    mcpServerClosure: closureOf(nodes.length, edges, mcpServerEntries),
    stats,
    unresolved: problems,
  };
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

/**
 * A path as a Lean string literal, written as it is. Only printable ASCII without `"` or `\` is
 * accepted, so nothing needs escaping and no invisible or non-ASCII white space reaches the file.
 * lean-verify.sh's source gate reads code only (it blanks comments and string literals), so a
 * path may contain any word the gate forbids in code.
 */
function leanString(file) {
  if (!/^[\x20-\x7e]*$/.test(file) || /["\\]/.test(file)) {
    fail([`extract-import-graph: path needs escaping this renderer does not do: ${JSON.stringify(file)}`]);
  }
  return `"${file}"`;
}

/** `items` rendered `perLine` to a line, indented, comma-separated. */
function leanRows(items, perLine) {
  const rows = [];
  for (let i = 0; i < items.length; i += perLine) rows.push(`  ${items.slice(i, i + perLine).join(', ')}`);
  return rows.join(',\n');
}

function renderLean(graph) {
  const chunks = [];
  for (let i = 0; i < graph.edges.length; i += EDGE_CHUNK) chunks.push(graph.edges.slice(i, i + EDGE_CHUNK));
  const lines = [
    '-- Generated by scripts/verification/extract-import-graph.cjs, which',
    '-- scripts/verification/lean-verify.sh runs before every build. Do not edit; not committed.',
    'import SomaVerify.ImportGraph.Model',
    '',
    '/-!',
    '# The runtime import graph of the production TypeScript files',
    '',
    'Data only. What the extractor guarantees about it is stated in `ImportGraph/Spec.lean`;',
    'the theorems about it are in `ImportGraph/Proofs.lean`.',
    '-/',
    '',
    'namespace SomaVerify.ImportGraph.Generated',
    '',
    'open SomaVerify.ImportGraph',
    '',
    '/-- How many production TypeScript files `git ls-files` lists, counted before compiling. -/',
    `def productionFileCount : Nat := ${graph.productionFileCount}`,
    '',
    '/-- The layer of each node, by node id: one entry per compiled production file. -/',
    'def layers : List Layer := [',
    leanRows(
      graph.nodes.map((node) => `.${node.layer}`),
      8,
    ),
    ']',
    '',
  ];
  chunks.forEach((chunk, index) => {
    lines.push(
      `/-- Runtime edges ${index * EDGE_CHUNK} to ${index * EDGE_CHUNK + chunk.length - 1}, as ⟨importer, imported⟩. -/`,
      `def edges${index} : List Edge := [`,
      leanRows(
        chunk.map((edge) => `⟨${edge.src}, ${edge.dst}⟩`),
        10,
      ),
      ']',
      '',
    );
  });
  lines.push(
    '/-- Every runtime edge. -/',
    `def edges : List Edge := ${chunks.length === 0 ? '[]' : chunks.map((_, index) => `edges${index}`).join(' ++ ')}`,
    '',
    '/-- The graph the theorems are about. -/',
    'def graph : Graph := ⟨layers, edges⟩',
    '',
    `/-- Node id of \`${CLI_ROOT}\`. -/`,
    `def cliRoot : Nat := ${graph.root}`,
    '',
    `/-- Node ids of ${ENV_PATHS.map((file) => `\`${file}\``).join(' and ')}, in that order. -/`,
    `def envPaths : List Nat := [${graph.envPaths.join(', ')}]`,
    '',
    '/-- The nodes reachable from `cliRoot`: the closure certificate. -/',
    'def cliClosure : List Nat := [',
    leanRows(graph.closure.map(String), 20),
    ']',
    '',
    `/-- Node ids of the stdio MCP server entries: the \`bin\` target of every package under`,
    `\`${MCP_SERVERS_DIR}\`, as its source file. -/`,
    `def mcpServerEntries : List Nat := [${graph.mcpServerEntries.join(', ')}]`,
    '',
    '/-- The nodes reachable from any of `mcpServerEntries`: their shared closure certificate. -/',
    'def mcpServerClosure : List Nat := [',
    leanRows(graph.mcpServerClosure.map(String), 20),
    ']',
    '',
    '/-- The repository path of each node, by node id. -/',
    'def paths : Array String := #[',
    leanRows(
      graph.nodes.map((node) => leanString(node.path)),
      1,
    ),
    ']',
    '',
    'end SomaVerify.ImportGraph.Generated',
    '',
  );
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { lean: null, json: null };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== '--lean' && flag !== '--json') || value === undefined) {
      fail(['usage: extract-import-graph.cjs [--lean <file>] [--json <file>]']);
    }
    args[flag.slice(2)] = path.resolve(value);
  }
  if (args.lean === null && args.json === null) args.lean = path.join(REPO_ROOT, DEFAULT_LEAN_OUT);
  return args;
}

function writeAtomically(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const graph = extractGraph(REPO_ROOT);
    if (args.lean) writeAtomically(args.lean, renderLean(graph));
    if (args.json) writeAtomically(args.json, `${JSON.stringify(graph, null, 2)}\n`);
    console.log(
      `extract-import-graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ` +
        `${graph.closure.length} nodes reachable from ${CLI_ROOT}, ` +
        `${graph.mcpServerClosure.length} from the ${graph.mcpServerEntries.length} MCP server entries`,
    );
  } catch (error) {
    if (!error.extractFailure) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { GROUPS, OTHER, extractGraph, isProductionTs, layerOf, listProductionFiles, renderLean };

if (require.main === module) main();
