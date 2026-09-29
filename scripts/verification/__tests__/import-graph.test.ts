/**
 * Sanity checks on `scripts/verification/extract-import-graph.cjs`, the program whose output the
 * `verification/lean/SomaVerify/ImportGraph` theorems take on trust (see `ImportGraph/Spec.lean`).
 *
 * The extractor runs into a temp dir, as `lean-verify.sh` runs it, and its graph is checked
 * against facts read off the sources: the node set is the production TypeScript set recomputed
 * here from `git ls-files`, a runtime import is an edge, a type-only import is not, and no
 * specifier was left unresolved. A fixture repository shows the other half of "nothing
 * unresolved": a specifier that resolves to nothing, or a load whose target is not a string
 * literal, stops the extractor instead of leaving a hole in the graph.
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

const extractor = createRequire(__filename)(extractorPath) as { extractGraph(root: string): Graph };

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
    expect(message).toContain("src/missing.ts: './nowhere' no such production file");
    expect(message).toContain('src/dynamic.ts (emitted line');
    expect(message).toContain('load with a non-literal specifier: require(name)');
  });
});
