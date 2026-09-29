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
 *               CommonJS, the module format of every tsconfig here, and each `require("…")` in
 *               the emitted JavaScript is one load; `import("…")` compiles to a `require` too,
 *               so lazy loads are edges as well. The compiler erases `import type`, and
 *               value-syntax imports whose bindings are used only as types, so neither becomes
 *               an edge.
 *   resolution  A relative specifier resolves against the importing file's directory, the way
 *               Node's CommonJS loader resolves it next to the compiled file (each package
 *               compiles its tree to its outDir unchanged): the exact file, then `.js`, `.json`,
 *               then `/index.js`, each compiled file mapped back to its `.ts`/`.tsx` source. A
 *               workspace package name resolves through that package's `exports` the way Node's
 *               CommonJS loader does (the exact subpath, else the `*` pattern with the longest
 *               prefix; the target file must exist as written), or through the package directory
 *               when it has no `exports`; the file reached is mapped back to its source through
 *               the package's tsconfig rootDir/outDir. No `dist/` output is read.
 *   failure     Node built-ins and npm dependencies are dropped. Everything else is fatal, and
 *               nothing is written: a relative or workspace specifier that does not resolve to a
 *               production file (a tracked `.json` file is the one allowed non-code target, and
 *               a leaf), a load whose specifier is not a string literal, a `require` used as a
 *               value, a `createRequire` call, a production file the compiler did not emit, a
 *               tsconfig option under which the real build keeps imports this compile erases
 *               (verbatimModuleSyntax, emitDecoratorMetadata, …). The graph is complete or
 *               there is no graph.
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
 * The compiler options of `config`, `extends` applied. The graph compiles every file with
 * import elision as tsc does it by default; an option that makes the real build keep an import
 * whose bindings are only used as types would make that build load modules the graph has no
 * edge to, so such an option is fatal rather than ignored.
 */
function readCompilerOptions(config) {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    config,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) =>
        fail([`extract-import-graph: ${config}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`]),
    },
  );
  const options = parsed.options;
  const keepsTypeImports = [
    options.verbatimModuleSyntax && 'verbatimModuleSyntax',
    options.preserveValueImports && 'preserveValueImports',
    options.emitDecoratorMetadata && 'emitDecoratorMetadata',
    options.importsNotUsedAsValues !== undefined &&
      options.importsNotUsedAsValues !== ts.ImportsNotUsedAsValues.Remove &&
      'importsNotUsedAsValues',
  ].filter(Boolean);
  if (keepsTypeImports.length > 0) {
    fail([
      `extract-import-graph: ${config} sets ${keepsTypeImports.join(', ')}; the graph assumes tsc's default elision`,
    ]);
  }
  return options;
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
  // The root project (src/) is not a workspace, but its options decide what src/ loads too.
  if (fs.existsSync(path.join(repoRoot, 'tsconfig.json'))) readCompilerOptions(path.join(repoRoot, 'tsconfig.json'));
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
 * Resolves specifiers from production files. `node` results carry the repository-relative path
 * of a production file; `json` is a tracked JSON file (a leaf); `external` is a Node built-in or
 * an npm dependency; `error` is fatal.
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

  /** Node's LOAD_AS_FILE, then LOAD_AS_DIRECTORY's index, for a runtime path. */
  function loadAsFileOrDirectory(runtimeBase, toSource) {
    for (const candidate of [
      runtimeBase,
      `${runtimeBase}.js`,
      `${runtimeBase}.json`,
      path.join(runtimeBase, 'index.js'),
    ]) {
      const hit = toSource(candidate);
      if (hit) return hit;
    }
    return null;
  }

  /** Maps a runtime path inside a package's outDir back to its source tree. */
  function viaCompileDirs(pkg) {
    return (runtimeFile) => {
      const inOut = path.relative(pkg.outDir, runtimeFile);
      if (inOut.startsWith('..') || path.isAbsolute(inOut)) return null;
      return sourceOf(path.join(pkg.rootDir, inOut));
    };
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
      loadAsFileOrDirectory(base, viaCompileDirs(pkg)) || {
        kind: 'error',
        reason: `no production source for ${subpath === '' ? pkg.name : `${pkg.name}/${subpath}`}`,
      }
    );
  }

  return function resolve(specifier, fromFile) {
    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
      const base = path.resolve(path.dirname(path.join(repoRoot, fromFile)), specifier);
      return loadAsFileOrDirectory(base, sourceOf) || { kind: 'error', reason: 'no such production file' };
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
  };
}

// ---------------------------------------------------------------------------------------------
// Loads in the emitted JavaScript
// ---------------------------------------------------------------------------------------------

/**
 * The loads in one emitted file: `{ specifier, line }` for each `require("…")` and
 * `import("…")`, and `{ problem, line }` for anything this analysis cannot follow.
 */
function collectLoads(fileName, text) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const loads = [];
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isImport) {
        const [argument] = node.arguments;
        if (node.arguments.length === 1 && ts.isStringLiteralLike(argument)) {
          loads.push({ specifier: argument.text, line: lineOf(node) });
        } else {
          loads.push({ problem: `load with a non-literal specifier: ${node.getText(sourceFile)}`, line: lineOf(node) });
        }
      } else if (
        (ts.isIdentifier(callee) && callee.text === 'createRequire') ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createRequire')
      ) {
        loads.push({ problem: `createRequire: ${node.getText(sourceFile)}`, line: lineOf(node) });
      }
    } else if (ts.isIdentifier(node) && node.text === 'require') {
      const parent = node.parent;
      const called = ts.isCallExpression(parent) && parent.expression === node;
      const member = ts.isPropertyAccessExpression(parent) && parent.expression === node;
      const probed = ts.isTypeOfExpression(parent);
      const named = ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (!called && !member && !probed && !named) {
        loads.push({ problem: `require used as a value: ${parent.getText(sourceFile)}`, line: lineOf(node) });
      }
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
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
    resolveJsonModule: true,
    jsx: ts.JsxEmit.React,
    noLib: true,
    types: [],
    declaration: false,
    sourceMap: false,
    noEmitOnError: false,
    isolatedModules: false,
    verbatimModuleSyntax: false,
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

/** Breadth-first closure of `root` over `edges` (`{ src, dst }` ids), as sorted ids. */
function closureOf(nodeCount, edges, root) {
  const out = Array.from({ length: nodeCount }, () => []);
  for (const edge of edges) out[edge.src].push(edge.dst);
  const seen = new Set([root]);
  const queue = [root];
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
  const resolve = createResolver(repoRoot, new Set(files), new Set(tracked), loadWorkspaces(repoRoot));
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
        problems.push(`${file}: '${load.specifier}' ${result.reason}`);
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

  const edges = [...edgeMap.values()].sort((a, b) => a.src - b.src || a.dst - b.dst);
  const root = id.get(CLI_ROOT);
  return {
    productionFileCount,
    nodes: nodes.map((file, index) => ({ id: index, path: file, layer: layerOf(file) })),
    edges,
    root,
    envPaths: ENV_PATHS.map((file) => id.get(file)),
    closure: closureOf(nodes.length, edges, root),
    stats,
    unresolved: problems,
  };
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

/**
 * A path as a Lean string literal. lean-verify.sh's source gate matches words textually in every
 * .lean file under SomaVerify/, so a word it forbids is written with its first letter as a `\x`
 * escape: the string's value is unchanged and a file name cannot trip the gate.
 */
function leanString(file) {
  if (!/^[\x20-\x7e]*$/.test(file) || /["\\]/.test(file)) {
    fail([`extract-import-graph: path needs escaping this renderer does not do: ${JSON.stringify(file)}`]);
  }
  const neutral = file.replace(/sorry|admit|axiom|native|implemented|extern/g, (word) => {
    return `\\x${word.charCodeAt(0).toString(16)}${word.slice(1)}`;
  });
  return `"${neutral}"`;
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
        `${graph.closure.length} nodes reachable from ${CLI_ROOT}`,
    );
  } catch (error) {
    if (!error.extractFailure) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { GROUPS, OTHER, extractGraph, isProductionTs, layerOf, listProductionFiles };

if (require.main === module) main();
