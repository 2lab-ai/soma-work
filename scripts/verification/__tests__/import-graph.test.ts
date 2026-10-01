/**
 * Sanity checks on `scripts/verification/extract-import-graph.cjs`, the program whose output the
 * `verification/lean/SomaVerify/ImportGraph` theorems take on trust (see `ImportGraph/Spec.lean`).
 *
 * The extractor runs into a temp dir, as `lean-verify.sh` runs it, and its graph is checked
 * against facts read off the sources: the node set is the production TypeScript set recomputed
 * here from `git ls-files`, a runtime import is an edge, a type-only import is not, and no
 * specifier was left unresolved. Fixture repositories show the other half of "nothing
 * unresolved": a load the extractor cannot follow (a specifier that resolves to nothing, a
 * non-literal specifier, a loader reached other than through `require("…")`, a package.json
 * `imports` specifier) and a tsconfig under which the real build keeps loads the extractor's
 * compile erases each stop the extractor instead of leaving a hole in the graph.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const extractorPath = path.join(repoRoot, 'scripts/verification/extract-import-graph.cjs');

interface Graph {
  productionFileCount: number;
  nodes: { id: number; path: string; layer: string }[];
  edges: { src: number; dst: number; specifiers: string[] }[];
  mcpServerEntries: number[];
  unresolved: string[];
}

const extractor = createRequire(__filename)(extractorPath) as {
  extractGraph(root: string): Graph;
  renderLean(graph: Graph): string;
};

/** The production set as the extractor documents it, spelled out again rather than imported. */
function productionFilesFromGit(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0')
    .filter(
      (file) =>
        /\.(ts|tsx|mts|cts)$/.test(file) &&
        !/\.d\.(ts|mts|cts)$/.test(file) &&
        !/\.(test|spec)\./.test(path.posix.basename(file)) &&
        !/(^|\/)(__tests__|__fixtures__|node_modules)\//.test(file),
    )
    .sort();
}

function tempDir(prefix: string): string {
  // realpath: on macOS the temp dir sits behind a symlink, and the extractor relates paths.
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

describe('import-graph extractor on this repository', () => {
  let workDir = '';
  let graph: Graph;
  let lean = '';

  beforeAll(() => {
    workDir = tempDir('import-graph-');
    const leanFile = path.join(workDir, 'Generated.lean');
    const jsonFile = path.join(workDir, 'graph.json');
    const run = spawnSync(process.execPath, [extractorPath, '--lean', leanFile, '--json', jsonFile], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (run.status !== 0) throw new Error(`extractor exited with ${run.status}:\n${run.stderr}`);
    graph = JSON.parse(fs.readFileSync(jsonFile, 'utf8')) as Graph;
    lean = fs.readFileSync(leanFile, 'utf8');
  }, 180_000);

  afterAll(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  function nodeId(file: string): number {
    const node = graph.nodes.find((candidate) => candidate.path === file);
    if (!node) throw new Error(`${file} is not a node`);
    return node.id;
  }

  function hasEdge(from: string, to: string): boolean {
    const src = nodeId(from);
    const dst = nodeId(to);
    return graph.edges.some((edge) => edge.src === src && edge.dst === dst);
  }

  it('has one node per production TypeScript file that git lists, and counted as many', () => {
    const files = productionFilesFromGit();
    expect(graph.nodes.map((node) => node.path)).toEqual(files);
    expect(graph.productionFileCount).toBe(files.length);
    expect(lean).toContain(`def productionFileCount : Nat := ${files.length}\n`);
  });

  it('has an edge for a runtime import', () => {
    // src/cli/index.ts imports parseCli, CliArgError and publicCommandSummaries from './args'
    // and calls them.
    expect(hasEdge('src/cli/index.ts', 'src/cli/args.ts')).toBe(true);
  });

  it('is floored in Lean too: the kernel proves that same edge, so a graph without edges fails Lean Verify', () => {
    // Every other ImportGraph theorem holds of a graph with no edges at all; this one does not,
    // and it is checked by the gate itself, not only by this suite.
    const proofs = fs.readFileSync(path.join(repoRoot, 'verification/lean/SomaVerify/ImportGraph/Proofs.lean'), 'utf8');
    expect(proofs).toMatch(
      /^theorem \w+ :\s+HasEdge Generated\.graph Generated\.paths "src\/cli\/index\.ts" "src\/cli\/args\.ts" := by\s+unfold HasEdge\s+decide \+kernel$/m,
    );
    expect(hasEdge('src/cli/index.ts', 'src/cli/args.ts')).toBe(true);
  });

  it('has no edge for a type-only import', () => {
    // The premise: query-env-builder reaches llmux-tenant-keys through `import type` only.
    const source = fs.readFileSync(path.join(repoRoot, 'src/auth/query-env-builder.ts'), 'utf8');
    expect(source.match(/from '\.\/llmux-tenant-keys'/g)).toHaveLength(1);
    expect(source).toMatch(/^import type \{[^}]*\} from '\.\/llmux-tenant-keys';$/m);
    expect(hasEdge('src/auth/query-env-builder.ts', 'src/auth/llmux-tenant-keys.ts')).toBe(false);
  });

  it('left no in-repo specifier unresolved', () => {
    expect(graph.unresolved).toEqual([]);
  });

  it('takes as MCP server entries the bin of every MCP server package, which covers every server the daemon launches', () => {
    // Read off the package.json files: each package's bin, mapped to its source by these
    // packages' layout (tsconfig rootDir '.', outDir 'dist').
    const serversDir = path.join(repoRoot, 'packages/mcp-servers');
    const binSources = new Map<string, string[]>();
    for (const dir of fs.readdirSync(serversDir)) {
      const manifest = path.join(serversDir, dir, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
        name: string;
        bin?: string | Record<string, string>;
      };
      const targets = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});
      binSources.set(
        pkg.name,
        targets.map((target) =>
          path.posix.join('packages/mcp-servers', dir, target.replace(/^\.\/dist\//, '').replace(/\.js$/, '.ts')),
        ),
      );
    }
    const entries = graph.mcpServerEntries.map((id) => graph.nodes[id].path);
    expect(entries).toEqual([...binSources.values()].flat().sort());

    // src/internal-mcp-server-resolver.ts names each server it spawns by `<package>/bin`.
    const launcher = fs.readFileSync(path.join(repoRoot, 'src/internal-mcp-server-resolver.ts'), 'utf8');
    const launched = [...launcher.matchAll(/packageBinSpecifier: '(@soma\/[^']+)\/bin'/g)].map((match) => match[1]);
    expect(launched.length).toBeGreaterThan(0);
    for (const name of launched) {
      expect(binSources.get(name)?.every((source) => entries.includes(source))).toBe(true);
    }
  });
});

describe('import-graph extractor on a fixture repository', () => {
  let fixture = '';

  beforeAll(() => {
    fixture = tempDir('import-graph-fixture-');
    fs.mkdirSync(path.join(fixture, 'src'));
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'fixture', private: true }));
    fs.writeFileSync(path.join(fixture, 'src/ok.ts'), 'export const ok = 1;\n');
    fs.writeFileSync(path.join(fixture, 'src/missing.ts'), "import { x } from './nowhere';\nexport const y = x;\n");
    fs.writeFileSync(path.join(fixture, 'src/dynamic.ts'), 'declare const name: string;\nrequire(name);\n');
    execFileSync('git', ['init', '-q'], { cwd: fixture });
    execFileSync('git', ['add', '.'], { cwd: fixture });
  });

  afterAll(() => {
    if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
  });

  it('fails, naming every load it cannot follow, instead of returning a graph', () => {
    let message = '';
    try {
      extractor.extractGraph(fixture);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('2 load(s) the graph cannot follow');
    expect(message).toMatch(/src\/missing\.ts \(emitted line \d+\): '\.\/nowhere' no such production file/);
    expect(message).toContain('src/dynamic.ts (emitted line');
    expect(message).toContain('load with a non-literal specifier: require(name)');
  });
});

describe('import-graph extractor on a complete fixture repository', () => {
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const rootPackage = { name: 'fixture', private: true, workspaces: ['packages/common', 'packages/mcp-servers/*'] };
  const rootOptions = { module: 'commonjs', target: 'ES2020', rootDir: 'src', outDir: 'dist' };
  const cliPrelude = "import { parse } from './args';\nparse();\n";
  /** What the extractor needs to produce a graph: the CLI root, both env-paths files, one MCP server. */
  const baseFiles: Record<string, string> = {
    'package.json': json(rootPackage),
    'tsconfig.json': json({ compilerOptions: rootOptions, include: ['src/**/*.ts'] }),
    'packages/common/package.json': json({ name: '@soma/common', exports: { './env-paths': './dist/env-paths.js' } }),
    'packages/common/tsconfig.json': json({ compilerOptions: { module: 'commonjs', rootDir: 'src', outDir: 'dist' } }),
    'packages/common/src/env-paths.ts': 'export const commonEnv = 1;\n',
    'packages/mcp-servers/demo/package.json': json({ name: '@soma/mcp-demo', bin: './dist/demo.js' }),
    'packages/mcp-servers/demo/tsconfig.json': json({
      compilerOptions: { module: 'commonjs', rootDir: '.', outDir: 'dist' },
    }),
    'packages/mcp-servers/demo/demo.ts': 'export const server = 1;\n',
    'src/env-paths.ts': 'export const env = 1;\n',
    'src/cli/args.ts': 'export function parse(_code?: number): void {}\n',
    'src/cli/index.ts': cliPrelude,
  };
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  function writeFiles(root: string, files: Record<string, string>): void {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
  }

  /** A git repository of `baseFiles`, with `files` added or replacing, and `untracked` on disk only. */
  function fixtureRepo(files: Record<string, string>, untracked: Record<string, string> = {}): string {
    const root = tempDir('import-graph-repo-');
    roots.push(root);
    writeFiles(root, { ...baseFiles, ...files });
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    writeFiles(root, untracked);
    return root;
  }

  /** The graph's edges as `from -> to`, or the extractor's failure message. */
  function extract(
    files: Record<string, string>,
    untracked: Record<string, string> = {},
  ): { edges: string[] } | { error: string } {
    let graph: Graph;
    try {
      graph = extractor.extractGraph(fixtureRepo(files, untracked));
    } catch (error) {
      return { error: (error as Error).message };
    }
    return { edges: graph.edges.map((edge) => `${graph.nodes[edge.src].path} -> ${graph.nodes[edge.dst].path}`) };
  }

  function failureOf(result: { edges: string[] } | { error: string }): string {
    return 'error' in result ? result.error : `no failure; the graph has edges ${JSON.stringify(result.edges)}`;
  }

  function edgesOf(result: { edges: string[] } | { error: string }): string[] {
    if ('error' in result) throw new Error(`the extractor failed: ${result.error}`);
    return result.edges;
  }

  it('follows a plain require of env-paths from the CLI: the loads below differ from it only in how they load', () => {
    expect(extract({ 'src/cli/index.ts': `${cliPrelude}require('../env-paths');\n` })).toEqual({
      edges: ['src/cli/index.ts -> src/cli/args.ts', 'src/cli/index.ts -> src/env-paths.ts'],
    });
  });

  it.each([
    [
      'createRequire',
      "import { createRequire } from 'node:module';\nconst load = createRequire(__filename);\nload('../env-paths');\n",
      '(0, node_module_1.createRequire)(__filename)',
    ],
    ['module.require', "module.require('../env-paths');\n", "module.require('../env-paths')"],
    ["module['require']", "module['require']('../env-paths');\n", "module['require']('../env-paths')"],
    ['require.call', "require.call(null, '../env-paths');\n", "require.call(null, '../env-paths')"],
    ['require.apply', "require.apply(null, ['../env-paths']);\n", "require.apply(null, ['../env-paths'])"],
    ['require aliased', 'const load = require;\nload("../env-paths");\n', 'load = require'],
    [
      'require passed',
      "Reflect.apply(require, null, ['../env-paths']);\n",
      "Reflect.apply(require, null, ['../env-paths'])",
    ],
    ['require bound and aliased', 'const load = require.bind(null);\nload("../env-paths");\n', 'require.bind(null)'],
    ['require.main.require', "require.main.require('../env-paths');\n", "require.main.require('../env-paths')"],
    ['require.cache', 'const loaded = Object.values(require.cache);\n', 'require.cache'],
    [
      'process.mainModule',
      "process.mainModule.require('../env-paths');\n",
      "process.mainModule.require('../env-paths')",
    ],
    [
      'process.getBuiltinModule',
      "const { Module } = process.getBuiltinModule('node:module');\nModule._load('../env-paths', null);\n",
      "process.getBuiltinModule('node:module')",
    ],
    ['the wrapper arguments', "arguments[1]('../env-paths');\n", "arguments[1]('../env-paths')"],
    ['eval', "eval('require')('../env-paths');\n", "eval('require')"],
    ['the Function constructor', "new Function('return process')().mainModule;\n", "new Function('return process')"],
    // Code run from a string, reached as a member or key rather than by name: `code` could say
    // anything, `require('../env-paths')` included.
    ['globalThis.eval', 'declare const code: string;\nglobalThis.eval(code);\n', 'globalThis.eval(code)'],
    ["globalThis['eval']", "declare const code: string;\nglobalThis['eval'](code);\n", "globalThis['eval'](code)"],
    ['window.eval', 'declare const code: string;\nwindow.eval(code);\n', 'window.eval(code)'],
    ['global.Function', 'declare const code: string;\nglobal.Function(code)();\n', 'global.Function(code)()'],
    ['eval destructured', 'declare const code: string;\nconst { eval: run } = globalThis;\nrun(code);\n', 'eval: run'],
    [
      "a function's constructor",
      'declare const code: string;\ndeclare const f: () => void;\nf.constructor(code)();\n',
      'f.constructor(code)()',
    ],
    [
      "a function's constructor under new",
      'declare const code: string;\ndeclare const f: () => void;\nnew f.constructor(code)();\n',
      'new f.constructor(code)()',
    ],
    [
      "a function's constructor as a string key",
      "declare const code: string;\ndeclare const f: () => void;\nf['constructor'](code)();\n",
      "f['constructor'](code)()",
    ],
  ])('stops on a load through %s, naming the file and emitted line', (_shape, load, excerpt) => {
    const failure = failureOf(extract({ 'src/cli/index.ts': `${cliPrelude}${load}` }));
    expect(failure).toContain('src/cli/index.ts (emitted line ');
    expect(failure).toContain(excerpt);
  });

  it.each([
    ['require', "require('#env');\n"],
    ['import', "import { env } from '#env';\nparse(env);\n"],
  ])('stops on a package.json "imports" specifier loaded by %s instead of dropping it as a dependency', (_how, load) => {
    const failure = failureOf(
      extract({
        'package.json': json({ ...rootPackage, imports: { '#env': './dist/env-paths.js' } }),
        'src/cli/index.ts': `${cliPrelude}${load}`,
      }),
    );
    expect(failure).toMatch(/src\/cli\/index\.ts \(emitted line \d+\): '#env' is a package\.json "imports" specifier/);
  });

  // review-pr250-gpt6/probe-directory.cjs: Node's LOAD_AS_DIRECTORY reads the directory's
  // package.json before its index and follows "main", here to env-paths.
  const directory = {
    'src/cli/index.ts': `${cliPrelude}require('./indirect');\n`,
    'src/cli/indirect/index.ts': 'export const benign = 1;\n',
  };
  const directoryManifest = { 'src/cli/indirect/package.json': json({ main: '../../env-paths.js' }) };

  it('follows a relative load of a directory without a package.json to its index', () => {
    expect(extract(directory)).toEqual({
      edges: ['src/cli/index.ts -> src/cli/args.ts', 'src/cli/index.ts -> src/cli/indirect/index.ts'],
    });
  });

  it.each([
    ['tracked', directoryManifest, {}],
    ['on disk only', {}, directoryManifest],
  ])('stops on a relative load of a directory with a package.json (%s), whose "main" Node follows', (_how, files, untracked) => {
    const failure = failureOf(extract({ ...directory, ...files }, untracked));
    expect(failure).toMatch(
      /src\/cli\/index\.ts \(emitted line \d+\): '\.\/indirect' resolves to directory src\/cli\/indirect\/, whose package\.json/,
    );
  });

  // A file and a directory of the same name. Node (v26.9.0, checked) loads the file for './x' but
  // the directory's index for './x/', './x/.', '.' and '..': Module._findPath skips the file
  // lookup for a specifier that is `.` or `..` or ends in `/`, `/.` or `/..`.
  const fileAndDirectory = {
    'src/cli/x.ts': 'export const file = 1;\n',
    'src/cli/x/index.ts': 'export const index = 1;\n',
  };

  it("follows './x' to the file x.ts, not to the directory x/ beside it", () => {
    expect(extract({ ...fileAndDirectory, 'src/cli/index.ts': `${cliPrelude}require('./x');\n` })).toEqual({
      edges: ['src/cli/index.ts -> src/cli/args.ts', 'src/cli/index.ts -> src/cli/x.ts'],
    });
  });

  it.each([
    ["'./x/'", 'src/cli/index.ts', `${cliPrelude}require('./x/');\n`],
    ["'./x/.'", 'src/cli/index.ts', `${cliPrelude}require('./x/.');\n`],
    ["'.'", 'src/cli/x/inner.ts', "require('.');\n"],
    ["'..'", 'src/cli/x/deeper/file.ts', "require('..');\n"],
  ])('follows %s to the directory index x/index.ts, as Node does, not to the file x.ts', (_specifier, from, source) => {
    const edges = edgesOf(extract({ ...fileAndDirectory, [from]: source }));
    expect(edges).toContain(`${from} -> src/cli/x/index.ts`);
    expect(edges).not.toContain(`${from} -> src/cli/x.ts`);
  });

  it("stops on './x/' when x/ has a package.json, though a file x.ts is beside it", () => {
    const failure = failureOf(
      extract({
        ...fileAndDirectory,
        'src/cli/x/package.json': json({ main: '../../env-paths.js' }),
        'src/cli/index.ts': `${cliPrelude}require('./x/');\n`,
      }),
    );
    expect(failure).toMatch(
      /src\/cli\/index\.ts \(emitted line \d+\): '\.\/x\/' resolves to directory src\/cli\/x\/, whose package\.json/,
    );
  });

  // Each of these makes the real build keep `require("../env-paths")` for a const enum that the
  // extractor's compile inlines, or emit something other than CommonJS.
  const constEnum = 'export const enum Code { Ok = 1 }\n';
  it.each([
    [
      'isolatedModules',
      'tsconfig.json',
      {
        'tsconfig.json': json({ compilerOptions: { ...rootOptions, isolatedModules: true } }),
        'src/env-paths.ts': constEnum,
        'src/cli/index.ts': `import { parse } from './args';\nimport { Code } from '../env-paths';\nparse(Code.Ok);\n`,
      },
    ],
    [
      'preserveConstEnums',
      'tsconfig.json',
      {
        'tsconfig.json': json({ compilerOptions: { ...rootOptions, preserveConstEnums: true } }),
        'src/env-paths.ts': constEnum,
        'src/cli/index.ts': `${cliPrelude}import { Code } from '../env-paths';\nexport { Code };\n`,
      },
    ],
    ['module', 'tsconfig.json', { 'tsconfig.json': json({ compilerOptions: { ...rootOptions, module: 'esnext' } }) }],
    [
      'isolatedModules',
      'tsconfig.base.json',
      {
        'tsconfig.base.json': json({ compilerOptions: { isolatedModules: true } }),
        'tsconfig.json': json({ extends: './tsconfig.base.json', compilerOptions: rootOptions }),
        'src/env-paths.ts': constEnum,
        'src/cli/index.ts': `import { parse } from './args';\nimport { Code } from '../env-paths';\nparse(Code.Ok);\n`,
      },
    ],
  ])('stops when a tsconfig sets %s (in %s) differently from the compile the graph comes from', (option, config, files) => {
    expect(failureOf(extract(files))).toContain(`\n  ${config}: ${option} `);
  });

  it('writes each path into the Lean data as it is: the source gate skips string literals', () => {
    const file = 'src/cli/unsafe-sorry-native.ts';
    const graph = extractor.extractGraph(fixtureRepo({ [file]: 'export const words = 1;\n' }));
    expect(extractor.renderLean(graph)).toContain(`\n  "${file}",\n`);
  });
});
