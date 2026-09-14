/**
 * The public release-asset contract.
 *
 * `scripts/deploy/stage-bundle.sh` + `scripts/smoke/setup-package.js` answer
 * "is the staged runtime tree a usable somawork runtime". This file answers the
 * next question: **are the three tar archives we would upload to a GitHub
 * release the right archives** — right members, right layout, right metadata,
 * nothing private in them, and byte-identical when built twice from identical
 * inputs.
 *
 * Everything here runs against *synthetic* staged inputs (a handful of files
 * standing in for the 798-file bundle and for `node_modules`) so the suite stays
 * a few seconds long. The exception is the controller, which is built for real:
 * `esbuild` bundles `src/cli/index.ts` in ~50 ms, and a controller archive whose
 * bundle was faked would prove nothing about the one artifact that has to run
 * from a fresh prefix with no source checkout.
 *
 * The full-fat receipt — the real staged tree, real production dependencies,
 * both runs, both SHA sets — is a manual packaging run, not a unit test.
 */

import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, ManifestError, releaseBaseUrl, renderManifest } from '../release/render-manifest';

// The gate's own tables and fixtures, not a second copy of them.
// `setup-package.js` is CommonJS on purpose (it is spawned by
// `stage-bundle.sh` with bare `node`). The Slack shapes are assembled there
// rather than spelled out, because a complete literal is what GitHub push
// protection blocks — see its SYNTHETIC_SLACK_TOKEN_SPECS.
const { BLOCKED_TERMS, SYNTHETIC_SLACK_TOKENS } = require('../smoke/setup-package.js') as {
  BLOCKED_TERMS: { name: string; text: string; re: RegExp }[];
  SYNTHETIC_SLACK_TOKENS: { bot: string; app: string; config: string };
};

/** The complete bot shape both mutation fixtures below plant. */
const LEAKED_BOT_TOKEN = SYNTHETIC_SLACK_TOKENS.bot;

/**
 * The prefix and first segment of that token — the shortest run whose
 * appearance in a leak report would already be a second copy of the credential.
 */
const LEAKED_BOT_TOKEN_HEAD = LEAKED_BOT_TOKEN.split('-').slice(0, 2).join('-');

const repoRoot = path.resolve(__dirname, '..', '..');
const packageScript = path.join(repoRoot, 'scripts', 'release', 'package-somawork.sh');
const archiveGate = path.join(repoRoot, 'scripts', 'smoke', 'package-archives.js');

// Dotted numeric, and the tag carries a run id: the packaging script enforces
// both, because a release tag without a monotonic suffix is not immutable.
const VERSION = '9.9.9';
const RUN_ID = '424242';
const SOURCE_SHA = '0d62a8c0d62a8c0d62a8c0d62a8c0d62a8c0d62a';
const EPOCH = '1600000000';
const VERSION_TAG = `somawork-preview-v${VERSION}-${RUN_ID}`;
const BASE_URL = `https://github.com/2lab-ai/soma-work/releases/download/${VERSION_TAG}`;

const CONTROLLER_ASSET = `somawork-cli-${VERSION}-darwin-arm64.tar.gz`;
const PRODUCTION_ASSET = `somawork-${VERSION}-darwin-arm64.tar.gz`;
const PREVIEW_ASSET = `somawork-preview-${VERSION}-darwin-arm64.tar.gz`;
const MANIFEST_ASSET = 'somawork-manifest.json';

/**
 * Timeout for anything that shells out to the packaging script.
 *
 * One run is `esbuild` + three tars + a full archive gate; two of them, on a
 * machine already running the rest of the suite, does not fit in vitest's 5 s
 * default. Generous rather than tuned: a timeout that is occasionally too small
 * is a flaky suite, which is worse than a slow one.
 */
const PACKAGING_TIMEOUT_MS = 300_000;

let scratch: string;

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * A minimal tree with the shape `stage-bundle.sh` produces.
 *
 * Only the paths the archive gate is contractually required to know about; the
 * real staged tree's other 790 files are the staging smoke's problem, not this
 * one's.
 */
function makeStagedRuntime(root: string): string {
  const write = (rel: string, body: string, mode?: number) => {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, mode === undefined ? undefined : { mode });
  };

  write(
    'package.json',
    `${JSON.stringify(
      {
        name: 'soma-work',
        version: VERSION,
        // The real staged tree's `package.json` is the repository root's, copied
        // by `stage-bundle.sh`, so it arrives already carrying the identifier.
        // The fixture states it for the same reason the gate pins it: a staging
        // change that dropped it must fail here, not in a release.
        license: 'ISC',
        bin: { somawork: 'dist/cli/index.js' },
        // The gate derives the workspace entry points it requires from these
        // patterns, the way `npm ci --workspaces` does.
        workspaces: ['somalib', 'packages/*'],
      },
      null,
      2,
    )}\n`,
  );
  // A workspace that declares an entry point, and one that compiles in place and
  // declares none — the gate must require the first and not invent the second.
  write(
    'packages/common/package.json',
    `${JSON.stringify({ name: '@soma/common', main: './dist/index.js' }, null, 2)}\n`,
  );
  write('packages/common/dist/index.js', 'module.exports = {};\n');
  write('somalib/package.json', `${JSON.stringify({ name: 'somalib' }, null, 2)}\n`);
  write('package-lock.json', '{"lockfileVersion":3}\n');
  // Executable and actually runnable: the gate now runs the runtime's controller
  // entry out of the extraction rather than only stat-ing it.
  write('dist/cli/index.js', `#!/usr/bin/env node\nconsole.log(${JSON.stringify(VERSION)});\n`, 0o755);
  write('dist/run-with-rotating-logs.js', 'module.exports = {};\n');
  write('dist/index.js', 'module.exports = {};\n');
  write('config.default.json', '{"conversation":{}}\n');
  write('.system.prompt.example', 'You are a helpful agent.\n');
  write(
    'infra/slack/slack-app-manifest.json',
    `${JSON.stringify({ display_information: {}, features: {}, oauth_config: {}, settings: { socket_mode_enabled: true } }, null, 2)}\n`,
  );
  // Upstream's a2t worker. `stage-bundle.sh` stages `services/` and the
  // packaging script `cp -R`s the staged tree, so a runtime archive carries it;
  // the gate requires it of the two runtime archives and not of the controller.
  write('services/a2t/worker.py', '#!/usr/bin/env python3\nprint("a2t worker")\n');
  write('services/a2t/requirements.txt', 'faster-whisper==1.0.3\n');
  write('scripts/service.sh', '#!/usr/bin/env bash\nexit 0\n', 0o755);
  write(
    'dist/local/skills/github-pr/scripts/extract-pr-data.js',
    '#!/usr/bin/env node\n// node local/skills/github-pr/scripts/extract-pr-data.js <type> <input> [output]\n',
  );
  return root;
}

/**
 * A stand-in for what `npm ci --omit=dev` leaves behind, overlaid on the payload
 * root.
 *
 * Two `node_modules`, not one: an install also writes a nested tree for a
 * workspace dependency it cannot hoist (in the real bundle,
 * `somalib/node_modules/soma-lib`). An overlay fixture with only the root tree
 * would not exercise the rule that dependency territory is any `node_modules`
 * segment.
 */
function makeDependencyOverlay(root: string): string {
  const modules = path.join(root, 'node_modules');
  fs.mkdirSync(path.join(modules, 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(modules, 'left-pad', 'index.js'), 'module.exports = () => {};\n');
  fs.writeFileSync(path.join(modules, 'left-pad', 'package.json'), '{"name":"left-pad","version":"1.0.0"}\n');
  fs.mkdirSync(path.join(modules, '@soma'), { recursive: true });
  fs.symlinkSync('../../packages/common', path.join(modules, '@soma', 'common'));

  const nested = path.join(root, 'somalib', 'node_modules', 'soma-lib', 'dist');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'index.js'), 'module.exports = {};\n');
  // A published package's own type declarations: forbidden first-party, ordinary
  // here, and the exact shape that failed before nested trees counted.
  fs.writeFileSync(path.join(nested, 'index.d.ts'), 'export {};\n');
  return root;
}

interface PackageRun {
  status: number | null;
  stdout: string;
  stderr: string;
  outDir: string;
}

function runPackaging(options: {
  outDir: string;
  stagedRuntime: string;
  dependencyOverlay: string;
  extraArgs?: string[];
  /** Defaults to the real packaging script; the license mutants pass a copy. */
  script?: string;
}): PackageRun {
  const result = spawnSync(
    'bash',
    [
      options.script ?? packageScript,
      '--out-dir',
      options.outDir,
      '--version',
      VERSION,
      '--channel',
      'preview',
      '--tag',
      VERSION_TAG,
      '--source-sha',
      SOURCE_SHA,
      '--source-date-epoch',
      EPOCH,
      '--release-base-url',
      BASE_URL,
      '--staged-runtime',
      options.stagedRuntime,
      '--dependency-overlay',
      options.dependencyOverlay,
      ...(options.extraArgs ?? []),
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 600_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    outDir: options.outDir,
  };
}

/** Member names of a tar archive, in archive order. */
function tarMembers(archive: string): string[] {
  const result = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`tar -tf failed for ${archive}: ${result.stderr}`);
  return (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** `mode name -> target` triples, so the exec bit and symlinks are assertable. */
function tarVerbose(archive: string): string[] {
  const result = spawnSync('tar', ['-tvf', archive], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`tar -tvf failed for ${archive}: ${result.stderr}`);
  return (result.stdout ?? '').split('\n').filter((line) => line.trim().length > 0);
}

function extract(archive: string, into: string): string {
  fs.mkdirSync(into, { recursive: true });
  const result = spawnSync('tar', ['-xf', archive, '-C', into], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`tar -xf failed for ${archive}: ${result.stderr}`);
  return into;
}

beforeAll(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'somawork-package-test-')));
});

afterAll(() => {
  if (scratch !== undefined) fs.rmSync(scratch, { recursive: true, force: true });
});

describe('release manifest schema', () => {
  const assets = [
    {
      package: 'somawork-cli',
      profile: null,
      filename: CONTROLLER_ASSET,
      url: `${BASE_URL}/${CONTROLLER_ASSET}`,
      sha256: 'a'.repeat(64),
      bytes: 1024,
    },
    {
      package: 'somawork',
      profile: 'production' as const,
      filename: PRODUCTION_ASSET,
      url: `${BASE_URL}/${PRODUCTION_ASSET}`,
      sha256: 'b'.repeat(64),
      bytes: 2048,
    },
    {
      package: 'somawork-preview',
      profile: 'preview' as const,
      filename: PREVIEW_ASSET,
      url: `${BASE_URL}/${PREVIEW_ASSET}`,
      sha256: 'c'.repeat(64),
      bytes: 4096,
    },
  ];

  const input = {
    version: VERSION,
    channel: 'preview' as const,
    tag: VERSION_TAG,
    sourceSha: SOURCE_SHA,
    platform: 'darwin-arm64',
    minimumNode: '20.0.0',
    layoutVersion: 1,
    baseUrl: BASE_URL,
    layout: DEFAULT_LAYOUT,
    assets,
  };

  it('renders every field the tap renderer consumes, and nothing it must not trust', () => {
    const document = JSON.parse(renderManifest(input));

    expect(document.schemaVersion).toBe(1);
    expect(document.layoutVersion).toBe(1);
    expect(document.channel).toBe('preview');
    expect(document.version).toBe(VERSION);
    expect(document.sourceSha).toBe(SOURCE_SHA);
    expect(document.minimumNode).toBe('20.0.0');
    expect(document.platform).toBe('darwin-arm64');
    expect(document.tag).toBe(VERSION_TAG);
    expect(document.baseUrl).toBe(BASE_URL);
    expect(document.assets).toHaveLength(3);

    // I-5: the layout facts a formula cannot install correctly without. Task 2
    // reads these instead of hardcoding `libexec/bin/somawork` and the
    // `prefix.install` + `bin.install_symlink` pattern.
    expect(document.layout.install).toBe('prefix');
    expect(document.layout.controller.entry).toBe('libexec/bin/somawork');
    expect(document.layout.controller.manifest).toBe('package.json');
    expect(document.layout.runtime.marker).toBe('.somawork-package.json');
    expect(document.layout.runtime.controllerEntry).toBe('dist/cli/index.js');
    expect(document.layout.runtime.supervisor).toBe('dist/run-with-rotating-logs.js');
    expect(document.layout.runtime.daemon).toBe('dist/index.js');
    for (const asset of document.assets) {
      expect(Object.keys(asset).sort()).toEqual(['bytes', 'filename', 'package', 'profile', 'sha256', 'url'].sort());
      expect(asset.url.endsWith(`/${asset.filename}`)).toBe(true);
    }
    // The manifest claims no license, and now for a reason rather than for want
    // of one. ISC is fixed repository metadata that every archive carries as a
    // root LICENSE file; it cannot differ between two releases the way a
    // version, a sha or an asset URL can, so schema 1 has nothing to tell a
    // consumer that the artifact does not already carry. The tap pins ISC from
    // the repository's own legal facts, independently of any release, so no
    // reader of this document is waiting for the key.
    expect(JSON.stringify(document).toLowerCase()).not.toContain('license');
  });

  it('is byte-stable for identical input', () => {
    expect(renderManifest(input)).toBe(renderManifest(structuredClone(input)));
    expect(renderManifest(input).endsWith('\n')).toBe(true);
  });

  it('refuses a manifest that would send a consumer somewhere unverifiable', () => {
    expect(() => renderManifest({ ...input, sourceSha: 'not-a-sha' })).toThrow(ManifestError);
    expect(() => renderManifest({ ...input, version: '' })).toThrow(ManifestError);
    expect(() => renderManifest({ ...input, assets: assets.slice(0, 2) })).toThrow(ManifestError);
    expect(() =>
      renderManifest({ ...input, assets: [{ ...assets[0], sha256: 'short' }, assets[1], assets[2]] }),
    ).toThrow(ManifestError);
    expect(() =>
      renderManifest({
        ...input,
        assets: [{ ...assets[0], url: 'http://example.com/x.tar.gz' }, assets[1], assets[2]],
      }),
    ).toThrow(ManifestError);
    expect(() => renderManifest({ ...input, assets: [{ ...assets[0], bytes: 0 }, assets[1], assets[2]] })).toThrow(
      ManifestError,
    );
    // The runtime profiles are not interchangeable: a manifest that labels the
    // production payload `preview` installs the wrong runtime root.
    expect(() =>
      renderManifest({ ...input, assets: [assets[0], { ...assets[1], profile: 'preview' }, assets[2]] }),
    ).toThrow(ManifestError);
  });

  it('binds every asset URL to this release, not merely to a matching filename', () => {
    // M-1: `https://` + ends-with-filename accepted another host entirely, and
    // accepted a different tag of this repository. The sha256 pin bounds the
    // damage, but the document would be lying about where its bytes live.
    const elsewhere = `https://evil.example.com/${CONTROLLER_ASSET}`;
    expect(() =>
      renderManifest({ ...input, assets: [{ ...assets[0], url: elsewhere }, assets[1], assets[2]] }),
    ).toThrow(ManifestError);

    const otherTag = BASE_URL.replace(RUN_ID, '424243');
    expect(() =>
      renderManifest({
        ...input,
        assets: [{ ...assets[0], url: `${otherTag}/${CONTROLLER_ASSET}` }, assets[1], assets[2]],
      }),
    ).toThrow(ManifestError);

    // …and the base itself must be the canonical origin for this exact tag.
    expect(() =>
      renderManifest({ ...input, baseUrl: 'https://github.com/2lab-ai/soma-work/releases/download/other' }),
    ).toThrow(ManifestError);
    expect(() => renderManifest({ ...input, baseUrl: `http://insecure.example.com/${input.tag}` })).toThrow(
      ManifestError,
    );
  });

  it('refuses any host but the project\u2019s own, however plausible the path', () => {
    // The suffix test this replaces accepted anything ending in `/<tag>`, which
    // any host can arrange. The repository is fixed public project identity, so
    // the check is exact equality — and it is deliberately not a manifest field,
    // because a document must not get to nominate the host that validates it.
    const hostile = [
      `https://evil.example.com/releases/download/${VERSION_TAG}`,
      `https://evil.example.com/2lab-ai/soma-work/releases/download/${VERSION_TAG}`,
      // Lookalikes: a subdomain, a userinfo trick, a near-miss host.
      `https://github.com.evil.example.com/2lab-ai/soma-work/releases/download/${VERSION_TAG}`,
      `https://github.com@evil.example.com/2lab-ai/soma-work/releases/download/${VERSION_TAG}`,
      `https://raw.github.com/2lab-ai/soma-work/releases/download/${VERSION_TAG}`,
      // Right host, wrong repository.
      `https://github.com/2lab-ai/soma-work-mirror/releases/download/${VERSION_TAG}`,
      `https://github.com/someone-else/soma-work/releases/download/${VERSION_TAG}`,
      // Right host and repository, wrong path.
      `https://github.com/2lab-ai/soma-work/archive/refs/tags/${VERSION_TAG}`,
    ];
    for (const baseUrl of hostile) {
      // Every asset URL is moved onto the hostile base too, so the ONLY thing
      // that can reject this document is the origin check. (A mismatched asset
      // URL would make the test pass for the wrong reason.)
      const consistent = assets.map((asset) => ({ ...asset, url: `${baseUrl}/${asset.filename}` }));
      expect(() => renderManifest({ ...input, baseUrl, assets: consistent }), baseUrl).toThrow(ManifestError);

      // …and the same host smuggled into a single asset while the base is honest.
      expect(
        () =>
          renderManifest({
            ...input,
            assets: [{ ...assets[0], url: `${baseUrl}/${CONTROLLER_ASSET}` }, assets[1], assets[2]],
          }),
        baseUrl,
      ).toThrow(ManifestError);
    }
    expect(() => renderManifest(input)).not.toThrow();
  });

  it('refuses a layout that would resolve outside the install prefix or break version lookup', () => {
    const layout = DEFAULT_LAYOUT;
    for (const entry of ['../escape/somawork', '/abs/somawork', 'libexec/../../somawork']) {
      expect(
        () => renderManifest({ ...input, layout: { ...layout, controller: { ...layout.controller, entry } } }),
        entry,
      ).toThrow(ManifestError);
    }
    // Depth is semantic, not cosmetic: `readControllerVersion` resolves
    // `__dirname/../../package.json`, so a two-segment entry installs fine and
    // then prints `unknown`.
    expect(() =>
      renderManifest({ ...input, layout: { ...layout, controller: { ...layout.controller, entry: 'bin/somawork' } } }),
    ).toThrow(ManifestError);
    // …and a `.` segment is that same failure wearing three segments:
    // `libexec/./somawork` satisfied the depth count and normalizes to depth 2.
    for (const sneaky of [
      'libexec/./somawork',
      './libexec/bin/somawork',
      'libexec/bin/./somawork',
      'libexec//bin/somawork',
    ]) {
      expect(
        () => renderManifest({ ...input, layout: { ...layout, controller: { ...layout.controller, entry: sneaky } } }),
        sneaky,
      ).toThrow(ManifestError);
    }
    expect(() => renderManifest({ ...input, layout: { ...layout, install: 'cellar' as unknown as 'prefix' } })).toThrow(
      ManifestError,
    );
    expect(() =>
      renderManifest({ ...input, layout: { ...layout, runtime: { ...layout.runtime, marker: 'a/b' } } }),
    ).toThrow(ManifestError);
  });
});

describe('packaged release assets', () => {
  let run: PackageRun;
  let outDir: string;
  let manifest: {
    version: string;
    channel: string;
    sourceSha: string;
    minimumNode: string;
    assets: { package: string; profile: string | null; filename: string; sha256: string; bytes: number }[];
  };

  beforeAll(() => {
    const staged = makeStagedRuntime(path.join(scratch, 'staged'));
    const modules = makeDependencyOverlay(path.join(scratch, 'prod-modules'));
    outDir = path.join(scratch, 'out-1');
    run = runPackaging({ outDir, stagedRuntime: staged, dependencyOverlay: modules });
    if (run.status !== 0) throw new Error(`packaging failed: ${run.stderr}\n${run.stdout}`);
    manifest = JSON.parse(fs.readFileSync(path.join(outDir, MANIFEST_ASSET), 'utf8'));
  }, PACKAGING_TIMEOUT_MS);

  it('produces exactly the four named release assets', () => {
    expect(fs.readdirSync(outDir).sort()).toEqual(
      [CONTROLLER_ASSET, PRODUCTION_ASSET, PREVIEW_ASSET, MANIFEST_ASSET].sort(),
    );
  });

  it('records each asset with the SHA-256 and byte count of the file on disk', () => {
    expect(manifest.version).toBe(VERSION);
    expect(manifest.channel).toBe('preview');
    expect(manifest.sourceSha).toBe(SOURCE_SHA);
    expect(manifest.minimumNode).toBe('20.0.0');
    for (const asset of manifest.assets) {
      const file = path.join(outDir, asset.filename);
      expect(fs.existsSync(file), asset.filename).toBe(true);
      expect(asset.sha256).toBe(sha256(file));
      expect(asset.bytes).toBe(fs.statSync(file).size);
    }
    expect(manifest.assets.map((asset) => `${asset.package}:${asset.profile}`)).toEqual([
      'somawork-cli:null',
      'somawork:production',
      'somawork-preview:preview',
    ]);
  });

  it('ships a controller archive of exactly the controller, and nothing runtime', () => {
    const members = tarMembers(path.join(outDir, CONTROLLER_ASSET));
    expect(members.filter((member) => !member.endsWith('/')).sort()).toEqual(
      ['.somawork-package.json', 'LICENSE', 'libexec/bin/somawork', 'package.json'].sort(),
    );
    for (const forbidden of ['dist/', 'node_modules/', 'src/', 'scripts/', 'infra/', 'config.default.json']) {
      expect(
        members.some((member) => member.startsWith(forbidden)),
        forbidden,
      ).toBe(false);
    }
    expect(
      tarVerbose(path.join(outDir, CONTROLLER_ASSET)).some((line) => /^-rwxr-xr-x.*libexec\/bin\/somawork$/.test(line)),
    ).toBe(true);
  });

  it('ships a controller bundle with no daemon supervisor compiled into it', () => {
    const root = extract(path.join(outDir, CONTROLLER_ASSET), path.join(scratch, 'x-controller'));
    const bundle = fs.readFileSync(path.join(root, 'libexec', 'bin', 'somawork'), 'utf8');

    // `esbuild` folds every ES module into one CommonJS file, so EVERY original
    // `require.main === module` guard resolves against the bundle's own module.
    // While `src/cli/service.ts` imported two constants from the supervisor,
    // the supervisor's entrypoint guard was true inside the controller: `somawork
    // profile list` spawned a daemon child and exited 1 with no output.
    expect(bundle.match(/require\.main === module/g) ?? []).toHaveLength(1);
    expect(bundle).not.toContain('rotating-file-stream');
    // `esbuild` keys every bundled module by its source path. The bare string
    // `run-with-rotating-logs` is NOT the marker: `src/cli/service.ts` names
    // `dist/run-with-rotating-logs.js` as the file the LaunchAgent execs.
    expect(bundle).not.toContain('"src/run-with-rotating-logs.ts"');
  });

  it(
    'runs from its own extraction with no source checkout on the path',
    () => {
      const root = path.join(scratch, 'x-controller');
      const home = path.join(scratch, 'controller-home');
      const bin = path.join(scratch, 'fake-bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'brew'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

      const invoke = (args: string[]) =>
        spawnSync(process.execPath, [path.join(root, 'libexec', 'bin', 'somawork'), ...args], {
          cwd: scratch,
          env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, SOMAWORK_HOME: home },
          encoding: 'utf8',
        });

      const version = invoke(['--version']);
      expect(version.status, version.stderr).toBe(0);
      // Resolved out of the archive's own `package.json`, two directories above
      // the executable. A flat `bin/somawork` would print `unknown` here.
      expect(version.stdout.trim()).toBe(VERSION);

      const help = invoke(['--help']);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain('somawork setup');
      expect(help.stdout).not.toContain('_capture-slack-auth');

      const profiles = invoke(['profile', 'list', '--json']);
      expect(profiles.status, profiles.stderr).toBe(0);
      expect(JSON.parse(profiles.stdout)).toEqual([]);
    },
    PACKAGING_TIMEOUT_MS,
  );

  it('ships runtime archives with the staged layout, production dependencies, and no instance state', () => {
    for (const asset of [PRODUCTION_ASSET, PREVIEW_ASSET]) {
      const members = tarMembers(path.join(outDir, asset));
      for (const required of [
        'package.json',
        'dist/cli/index.js',
        'dist/run-with-rotating-logs.js',
        'dist/index.js',
        'config.default.json',
        '.system.prompt.example',
        'infra/slack/slack-app-manifest.json',
        'services/a2t/worker.py',
        'services/a2t/requirements.txt',
        '.somawork-package.json',
        // Not in the staged tree: `stage-bundle.sh` copies an allowlist of root
        // files for a fleet deploy onto machines that already have the
        // repository. A public archive has no checkout behind it, so the
        // packaging script adds the grant to the payload root.
        'LICENSE',
        'node_modules/left-pad/index.js',
        // A workspace dependency npm could not hoist. The archive is an
        // incomplete install without it.
        'somalib/node_modules/soma-lib/dist/index.js',
      ]) {
        expect(members, `${asset} -> ${required}`).toContain(required);
      }
      for (const forbidden of ['.env', 'secrets.env', 'config.json', '.system.prompt', 'setup-state.json']) {
        expect(members.includes(forbidden), `${asset} -> ${forbidden}`).toBe(false);
      }
      for (const prefix of ['data/', 'logs/', '.claude/', 'src/']) {
        expect(
          members.some((member) => member.startsWith(prefix)),
          `${asset} -> ${prefix}`,
        ).toBe(false);
      }
      const firstParty = members.filter((member) => !member.split('/').includes('node_modules'));
      expect(firstParty.filter((member) => /\.(map|ts|tsx)$/.test(member))).toEqual([]);
      expect(firstParty.filter((member) => /__tests__|\.test\.[cm]?[jt]s$/.test(member))).toEqual([]);
      // No linked controller: the runtime formulae must not both want `somawork`.
      expect(members.some((member) => member === 'bin/somawork' || member.endsWith('/bin/somawork'))).toBe(false);
    }
  });

  it('distinguishes the two runtime archives only by their package metadata', () => {
    const production = extract(path.join(outDir, PRODUCTION_ASSET), path.join(scratch, 'x-production'));
    const preview = extract(path.join(outDir, PREVIEW_ASSET), path.join(scratch, 'x-preview'));

    const productionMeta = JSON.parse(fs.readFileSync(path.join(production, '.somawork-package.json'), 'utf8'));
    const previewMeta = JSON.parse(fs.readFileSync(path.join(preview, '.somawork-package.json'), 'utf8'));

    expect(productionMeta.package).toBe('somawork');
    expect(productionMeta.profile).toBe('production');
    expect(previewMeta.package).toBe('somawork-preview');
    expect(previewMeta.profile).toBe('preview');
    for (const meta of [productionMeta, previewMeta]) {
      expect(meta.version).toBe(VERSION);
      expect(meta.sourceSha).toBe(SOURCE_SHA);
      expect(meta.channel).toBe('preview');
    }

    expect(tarMembers(path.join(outDir, PRODUCTION_ASSET))).toEqual(tarMembers(path.join(outDir, PREVIEW_ASSET)));
    expect(sha256(path.join(production, 'dist/cli/index.js'))).toBe(sha256(path.join(preview, 'dist/cli/index.js')));
  });

  it('ships the repository grant and identifier in every archive', () => {
    const canonicalLicense = path.join(repoRoot, 'LICENSE');
    const canonicalSha = sha256(canonicalLicense);
    for (const [asset, into] of [
      [CONTROLLER_ASSET, 'x-controller'],
      [PRODUCTION_ASSET, 'x-production'],
      [PREVIEW_ASSET, 'x-preview'],
    ] as [string, string][]) {
      const root = extract(path.join(outDir, asset), path.join(scratch, into));
      // Byte-identical, not merely "an ISC-looking file". A reworded grant is a
      // different license, and the archive is what the user actually receives —
      // the repository copy they never see cannot speak for it.
      expect(sha256(path.join(root, 'LICENSE')), asset).toBe(canonicalSha);
      // The identifier in the archive's own manifest, which must agree with the
      // repository's. The controller's is written by the packaging script from
      // the root manifest; the runtimes' is the root manifest itself, carried
      // through staging. Two routes, one answer.
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { license?: string };
      expect(pkg.license, asset).toBe('ISC');
    }
    expect(read('LICENSE').split('\n')[0]).toBe('ISC License');
  });

  it('normalizes ownership and timestamps so the archives carry no build-host identity', () => {
    for (const asset of [CONTROLLER_ASSET, PRODUCTION_ASSET, PREVIEW_ASSET]) {
      for (const line of tarVerbose(path.join(outDir, asset))) {
        expect(line, `${asset}: ${line}`).toMatch(/\s0\s+0\s/);
        expect(line, `${asset}: ${line}`).toContain('2020');
      }
    }
  });

  it(
    'reports every asset even when one of them cannot be opened',
    () => {
      // The `try` used to wrap the whole per-asset loop, so a throw on the first
      // archive ended the run before the other two were examined. Still
      // fail-closed, but one run then said nothing about the assets it never
      // opened — and "which archives are bad" is the question this gate exists
      // to answer.
      const corrupted = path.join(scratch, 'corrupt-out');
      fs.mkdirSync(corrupted, { recursive: true });
      for (const name of fs.readdirSync(outDir)) {
        fs.copyFileSync(path.join(outDir, name), path.join(corrupted, name));
      }
      // The controller is asset 1 in the manifest's fixed order.
      fs.writeFileSync(path.join(corrupted, CONTROLLER_ASSET), 'not a tar at all\n');

      const gate = spawnSync(process.execPath, [archiveGate, '--manifest', path.join(corrupted, MANIFEST_ASSET)], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 600_000,
      });
      const output = `${gate.stdout}${gate.stderr}`;

      expect(gate.status).not.toBe(0);
      expect(output).toContain(CONTROLLER_ASSET);
      // …and both runtime archives were still opened and checked.
      for (const asset of [PRODUCTION_ASSET, PREVIEW_ASSET]) {
        expect(output, asset).toContain(`${asset}: carries the unhoistable workspace dependency`);
        expect(output, asset).toContain(`${asset}: the runtime's controller entry runs from the extraction`);
      }
    },
    PACKAGING_TIMEOUT_MS,
  );

  it(
    'passes its own archive gate',
    () => {
      const gate = spawnSync(process.execPath, [archiveGate, '--manifest', path.join(outDir, MANIFEST_ASSET)], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 600_000,
      });
      expect(gate.status, `${gate.stdout}\n${gate.stderr}`).toBe(0);
      const output = `${gate.stdout}`;
      for (const expected of [
        'recorded sha256 matches the file on disk',
        'contains no forbidden path shape',
        'contains no credential bytes',
        'contains no private operator identity or topology string',
        'contains no symlink outside node_modules',
        'controller archive runs `--version` from a fresh extraction',
      ]) {
        expect(output, expected).toContain(expected);
      }
    },
    PACKAGING_TIMEOUT_MS,
  );
});

describe('the a2t payload, when staging stops shipping it', () => {
  // Both halves, one per packaging run: the worker is the program and
  // `requirements.txt` is what the target builds its interpreter environment
  // from, so an archive with either one missing installs a runtime whose python
  // side cannot run. `slug` only keeps the fixture directories apart.
  const members = [
    { rel: 'services/a2t/worker.py', slug: 'worker' },
    { rel: 'services/a2t/requirements.txt', slug: 'requirements' },
  ];

  it.each(members)(
    'fails packaging by name for both runtime archives when $rel is missing, and asks nothing of the controller',
    ({ rel, slug }) => {
      const staged = makeStagedRuntime(path.join(scratch, `staged-no-${slug}`));
      fs.rmSync(path.join(staged, rel));
      const modules = makeDependencyOverlay(path.join(scratch, `prod-modules-no-${slug}`));
      const run = runPackaging({
        outDir: path.join(scratch, `out-no-${slug}`),
        stagedRuntime: staged,
        dependencyOverlay: modules,
      });
      const output = `${run.stdout}${run.stderr}`;

      // The packaging script runs the archive gate itself, so this is the
      // release path refusing, not a separate check that could be skipped.
      expect(run.status, output).not.toBe(0);
      for (const asset of [PRODUCTION_ASSET, PREVIEW_ASSET]) {
        expect(output, asset).toContain(`${asset}: carries ${rel}`);
      }
      // The controller archive is the bundled executable and nothing runtime;
      // requiring the a2t payload of it would be a false failure.
      expect(output).not.toContain(`${CONTROLLER_ASSET}: carries ${rel}`);
    },
    PACKAGING_TIMEOUT_MS,
  );
});

describe('deterministic packaging', () => {
  it(
    'produces byte-identical archives for identical inputs',
    () => {
      const staged = makeStagedRuntime(path.join(scratch, 'det-staged'));
      const modules = makeDependencyOverlay(path.join(scratch, 'det-modules'));

      const first = runPackaging({
        outDir: path.join(scratch, 'det-1'),
        stagedRuntime: staged,
        dependencyOverlay: modules,
      });
      expect(first.status, first.stderr).toBe(0);
      const second = runPackaging({
        outDir: path.join(scratch, 'det-2'),
        stagedRuntime: staged,
        dependencyOverlay: modules,
      });
      expect(second.status, second.stderr).toBe(0);

      for (const asset of [CONTROLLER_ASSET, PRODUCTION_ASSET, PREVIEW_ASSET, MANIFEST_ASSET]) {
        expect(sha256(path.join(first.outDir, asset)), asset).toBe(sha256(path.join(second.outDir, asset)));
      }
    },
    PACKAGING_TIMEOUT_MS,
  );
});

describe('publication gates', () => {
  function packageMutated(name: string, mutate: (stagedRoot: string) => void): PackageRun {
    const staged = makeStagedRuntime(path.join(scratch, `mutant-${name}`));
    mutate(staged);
    return runPackaging({
      outDir: path.join(scratch, `mutant-out-${name}`),
      stagedRuntime: staged,
      dependencyOverlay: makeDependencyOverlay(path.join(scratch, `mutant-modules-${name}`)),
    });
  }

  it(
    'refuses to package any private identity, machine, customer-codebase or deployment-history string',
    () => {
      // One packaging run, four poisoned files, four families. The gate lists
      // every offending path, so merging these costs no coverage and keeps the
      // suite from spawning a full package build per family — `npm test` runs
      // this file alongside 488 others.
      const run = packageMutated('private-strings', (root) => {
        fs.writeFileSync(path.join(root, 'dist/leaky-host.js'), '// observed on oudwood-512 during a deploy\n');
        fs.writeFileSync(
          path.join(root, 'dist/leaky-report.js'),
          '// root cause at SnapshotServer.Protein.Receive.cs:689, SettlementService never notified\n',
        );
        fs.writeFileSync(path.join(root, 'dist/leaky-history.js'), '// merged to deploy/dev2 as PR #1470\n');
        fs.writeFileSync(path.join(root, 'dist/leaky-reviewer.js'), '// review requested from osun50s\n');
      });
      expect(run.status).not.toBe(0);
      const output = `${run.stdout}${run.stderr}`;
      for (const named of [
        'dist/leaky-host.js',
        'dist/leaky-report.js',
        'dist/leaky-history.js',
        'dist/leaky-reviewer.js',
      ]) {
        expect(output, named).toContain(named);
      }
      // A leak report that quotes the leak is a second copy of it.
      expect(output).not.toContain('Protein.Receive');
      expect(output).not.toContain('osun50s');
    },
    PACKAGING_TIMEOUT_MS,
  );

  it(
    'still packages a dependency that legitimately owns a SnapshotServer class',
    () => {
      // `playwright-core` ships one. The customer-codebase patterns match the
      // file-name form precisely so a correct archive is not refused.
      const staged = makeStagedRuntime(path.join(scratch, 'mutant-lookalike'));
      const modules = makeDependencyOverlay(path.join(scratch, 'mutant-lookalike-modules'));
      fs.writeFileSync(
        path.join(modules, 'node_modules', 'left-pad', 'snapshot-server.js'),
        'class SnapshotServer {}\nmodule.exports = { SnapshotServer };\n',
      );
      const run = runPackaging({
        outDir: path.join(scratch, 'mutant-out-lookalike'),
        stagedRuntime: staged,
        dependencyOverlay: modules,
      });
      expect(run.status, run.stderr).toBe(0);
    },
    PACKAGING_TIMEOUT_MS,
  );

  it(
    'refuses to package credential bytes',
    () => {
      const run = packageMutated('credential', (root) => {
        fs.writeFileSync(path.join(root, 'dist/leaky-token.js'), `module.exports = "${LEAKED_BOT_TOKEN}";\n`);
      });
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain('dist/leaky-token.js');
      expect(`${run.stdout}${run.stderr}`).not.toContain(LEAKED_BOT_TOKEN_HEAD);
    },
    PACKAGING_TIMEOUT_MS,
  );

  it(
    'refuses to package a symlink outside node_modules',
    () => {
      const run = packageMutated('symlink', (root) => {
        fs.symlinkSync('/etc/hosts', path.join(root, 'dist', 'hosts.js'));
      });
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain('dist/hosts.js');
    },
    PACKAGING_TIMEOUT_MS,
  );

  it(
    'refuses to package a dependency symlink that escapes the archive root',
    () => {
      const staged = makeStagedRuntime(path.join(scratch, 'mutant-escape'));
      const modules = makeDependencyOverlay(path.join(scratch, 'mutant-escape-modules'));
      fs.symlinkSync('../../../../etc', path.join(modules, 'node_modules', 'escape'));
      const run = runPackaging({
        outDir: path.join(scratch, 'mutant-out-escape'),
        stagedRuntime: staged,
        dependencyOverlay: modules,
      });
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain('node_modules/escape');
    },
    PACKAGING_TIMEOUT_MS,
  );

  it(
    'refuses to package profile state or a materialized config',
    () => {
      const run = packageMutated('state', (root) => {
        fs.writeFileSync(path.join(root, 'config.json'), '{}\n');
      });
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain('config.json');
    },
    PACKAGING_TIMEOUT_MS,
  );

  it(
    'classifies a vendored native binary by its magic bytes instead of calling it unscannable',
    () => {
      // `@anthropic-ai/claude-agent-sdk` vendors six extensionless `ripgrep`
      // binaries. There is no text in them to scan and the runtime cannot ship
      // without them, so the gate has to say what they are rather than fail on
      // them — while a NUL-bearing *text* file stays a failure.
      const staged = makeStagedRuntime(path.join(scratch, 'mutant-native'));
      const modules = makeDependencyOverlay(path.join(scratch, 'mutant-native-modules'));
      fs.mkdirSync(path.join(modules, 'node_modules', 'vendor'), { recursive: true });
      fs.writeFileSync(
        path.join(modules, 'node_modules', 'vendor', 'rg'),
        Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from([0, 1, 2, 0]), Buffer.from('machine code')]),
      );
      const run = runPackaging({
        outDir: path.join(scratch, 'mutant-out-native'),
        stagedRuntime: staged,
        dependencyOverlay: modules,
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('classified native by header');
    },
    PACKAGING_TIMEOUT_MS,
  );

  it(
    'refuses a dependency file that fakes a PE header to dodge the byte scan',
    () => {
      // Deliberately an ordinary `.js` name: a `.bin` would be skipped by the
      // reviewed binary-extension list before the header check ever ran, which
      // proves nothing about the header check.
      const staged = makeStagedRuntime(path.join(scratch, 'mutant-fakepe'));
      const modules = makeDependencyOverlay(path.join(scratch, 'mutant-fakepe-modules'));
      fs.writeFileSync(
        path.join(modules, 'node_modules', 'left-pad', 'fake-pe.js'),
        Buffer.concat([Buffer.from('MZ'), Buffer.from([0]), Buffer.from(`// ${LEAKED_BOT_TOKEN}\n`)]),
      );
      const run = runPackaging({
        outDir: path.join(scratch, 'mutant-out-fakepe'),
        stagedRuntime: staged,
        dependencyOverlay: modules,
      });
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain('node_modules/left-pad/fake-pe.js');
    },
    PACKAGING_TIMEOUT_MS,
  );

  it(
    'still refuses a dependency file that merely hides a NUL byte',
    () => {
      const staged = makeStagedRuntime(path.join(scratch, 'mutant-nul'));
      const modules = makeDependencyOverlay(path.join(scratch, 'mutant-nul-modules'));
      fs.writeFileSync(
        path.join(modules, 'node_modules', 'left-pad', 'sneaky.js'),
        Buffer.concat([Buffer.from('const z="'), Buffer.from([0]), Buffer.from('";\n')]),
      );
      const run = runPackaging({
        outDir: path.join(scratch, 'mutant-out-nul'),
        stagedRuntime: staged,
        dependencyOverlay: modules,
      });
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain('node_modules/left-pad/sneaky.js');
    },
    PACKAGING_TIMEOUT_MS,
  );

  it(
    'refuses to package a skill script that advertises an invocation the runtime cannot run',
    () => {
      const run = packageMutated('tsx-banner', (root) => {
        fs.writeFileSync(
          path.join(root, 'dist/local/skills/github-pr/scripts/extract-pr-data.js'),
          '#!/usr/bin/env npx tsx\n// npx tsx extract-pr-data.ts <type> <input> [output]\n',
        );
      });
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain('extract-pr-data.js');
    },
    PACKAGING_TIMEOUT_MS,
  );
});

describe('license, when the packaging script stops shipping it', () => {
  /**
   * A repository root assembled in this suite's scratch directory.
   *
   * `package-somawork.sh` resolves `REPO_ROOT` from its own location, so a
   * script under test has to sit inside a tree shaped like this repository.
   * Dropping a mutant copy next to the real script would do that, but a run
   * that crashed between writing and deleting it would leave an untracked `.sh`
   * in `scripts/release/` — residue the sanitize gate in this same file would
   * then trip over. This leaves nothing in the repository at all: every path
   * the script reaches for is symlinked to the real one, except the two a
   * caller wants to control.
   *
   * The symlinks are load-bearing in a second way. `package-archives.js`
   * resolves its own `repoRoot` from `__dirname`, and node realpaths that, so
   * the gate still reads the REAL repository's LICENSE and root manifest. A
   * mismatch reported below is therefore a mismatch with the repository, not
   * with a fixture agreeing with itself.
   */
  function fakeRepoRoot(name: string, overrides: { script?: string; packageJson?: string }): string {
    const root = path.join(scratch, `fake-repo-${name}`);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'scripts', 'release'), { recursive: true });
    for (const entry of ['LICENSE', 'node_modules', 'src']) {
      fs.symlinkSync(path.join(repoRoot, entry), path.join(root, entry));
    }
    for (const entry of ['smoke', 'deploy']) {
      fs.symlinkSync(path.join(repoRoot, 'scripts', entry), path.join(root, 'scripts', entry));
    }
    for (const entry of ['payload-tools.js', 'render-manifest.ts']) {
      fs.symlinkSync(path.join(repoRoot, 'scripts', 'release', entry), path.join(root, 'scripts', 'release', entry));
    }
    if (overrides.packageJson === undefined) {
      fs.symlinkSync(path.join(repoRoot, 'package.json'), path.join(root, 'package.json'));
    } else {
      fs.writeFileSync(path.join(root, 'package.json'), overrides.packageJson);
    }
    const script = path.join(root, 'scripts', 'release', 'package-somawork.sh');
    fs.writeFileSync(script, overrides.script ?? read('scripts/release/package-somawork.sh'), { mode: 0o755 });
    return script;
  }

  function packageFrom(name: string, overrides: { script?: string; packageJson?: string }): PackageRun {
    return runPackaging({
      outDir: path.join(scratch, `license-out-${name}`),
      stagedRuntime: makeStagedRuntime(path.join(scratch, `license-staged-${name}`)),
      dependencyOverlay: makeDependencyOverlay(path.join(scratch, `license-modules-${name}`)),
      script: fakeRepoRoot(name, overrides),
    });
  }

  /**
   * Package with lines removed from the real script's own text.
   *
   * The license copy and the identifier it writes live in the script, not in
   * the payload, so no staged-tree mutation can delete them — and a contract
   * nothing can violate is a contract nothing is testing.
   */
  function packageWithout(name: string, drops: string[]): PackageRun {
    let source = read('scripts/release/package-somawork.sh');
    for (const drop of drops) {
      expect(source.includes(drop), `the packaging script no longer contains ${JSON.stringify(drop)}`).toBe(true);
      source = source.split(drop).join('');
    }
    return packageFrom(name, { script: source });
  }

  /** Package against a root manifest this test wrote, the script unmodified. */
  function packageWithRootManifest(name: string, mutate: (manifest: Record<string, unknown>) => void): PackageRun {
    const manifest = JSON.parse(read('package.json')) as Record<string, unknown>;
    mutate(manifest);
    return packageFrom(name, { packageJson: `${JSON.stringify(manifest, null, 2)}\n` });
  }

  it(
    'refuses every archive that lost the grant',
    () => {
      const run = packageWithout('no-copy', ['copy_license "$CONTROLLER"\n', 'copy_license "$RUNTIME"\n']);
      expect(run.status).not.toBe(0);
      const output = `${run.stdout}${run.stderr}`;
      // Named per asset, so one missing copy cannot hide behind another's
      // failure — the controller and the two runtimes are three separate
      // payload assemblies.
      for (const asset of [CONTROLLER_ASSET, PRODUCTION_ASSET, PREVIEW_ASSET]) {
        expect(output, asset).toContain(`${asset}: carries LICENSE`);
      }
    },
    PACKAGING_TIMEOUT_MS,
  );

  it(
    'refuses a controller manifest that stopped naming the license',
    () => {
      const run = packageWithout('no-identifier', ['  license: env.SOMAWORK_PKG_LICENSE,\n']);
      expect(run.status).not.toBe(0);
      // The grant is still in the payload: this is the other half failing on its
      // own, which is what makes the two checks independent rather than one
      // check reported twice.
      expect(`${run.stdout}${run.stderr}`).toContain("package.json declares the repository's license");
    },
    PACKAGING_TIMEOUT_MS,
  );

  it(
    'refuses a root manifest whose license is not a usable identifier, before it builds anything',
    () => {
      // Every one of these was accepted by the first version of the preflight,
      // which asked bash whether `node -p`'s OUTPUT was non-empty and not the
      // four letters `undefined`. `node -p` prints `null` for a null, `[object
      // Object]` for an object and `ISC` for `['ISC']`, so three of these five
      // would have become the literal `"license"` string of a public archive.
      const hostile: [string, (manifest: Record<string, unknown>) => void][] = [
        [
          'null',
          (manifest) => {
            manifest.license = null;
          },
        ],
        [
          'missing',
          (manifest) => {
            delete manifest.license;
          },
        ],
        [
          'object',
          (manifest) => {
            manifest.license = { type: 'ISC', url: 'https://example.invalid/isc' };
          },
        ],
        [
          'array',
          (manifest) => {
            manifest.license = ['ISC'];
          },
        ],
        [
          'blank',
          (manifest) => {
            manifest.license = '   ';
          },
        ],
      ];
      for (const [label, mutate] of hostile) {
        const run = packageWithRootManifest(`hostile-${label}`, mutate);
        expect(run.status, `${label}: ${run.stdout}${run.stderr}`).not.toBe(0);
        expect(`${run.stdout}${run.stderr}`, label).toContain('package.json must declare a non-empty string license');
        // Refused in preflight: nothing was bundled and the output directory was
        // never created, so a broken identifier cannot leave half a release
        // behind for someone to publish.
        expect(run.stdout, label).not.toContain('==> controller bundle');
        expect(fs.existsSync(run.outDir), label).toBe(false);
      }
    },
    PACKAGING_TIMEOUT_MS,
  );

  it(
    'escapes a hostile identifier into valid JSON rather than letting it write the manifest',
    () => {
      // A value that closes the JSON string and opens a field of its own. Under
      // the heredoc this replaced, it produced exactly that: a `name` the
      // packaging script never declared, in a manifest `readControllerVersion`
      // may or may not still parse. The trailing backslash is the second half —
      // an escape that would swallow the closing quote.
      const hostile = 'ISC" , "name": "not-somawork\\';
      const run = packageWithRootManifest('hostile-json', (manifest) => {
        manifest.license = hostile;
      });

      // Refused, because the controller manifest now disagrees with the real
      // repository — which is the whole point of checking it against the root
      // manifest rather than against a constant.
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain("package.json declares the repository's license");

      // …and the bytes it refused are still well-formed JSON carrying exactly
      // the value it was handed, with the injected field nowhere in it. The gate
      // leaves the assets on disk precisely so they can be read like this.
      const root = extract(path.join(run.outDir, CONTROLLER_ASSET), path.join(scratch, 'x-hostile-json'));
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
        name: string;
        license: string;
        version: string;
      };
      expect(pkg.license).toBe(hostile);
      expect(pkg.name).toBe('somawork-cli');
      expect(pkg.version).toBe(VERSION);
    },
    PACKAGING_TIMEOUT_MS,
  );
});

describe('archive gate internals', () => {
  const gate = require('../smoke/package-archives.js') as {
    isNativeExecutable: (file: string) => boolean;
    walk: (root: string) => { rel: string }[];
    archiveWorkspaceEntries: (root: string) => { entries: string[]; unsupported: string[] };
  };

  it('classifies a real PE through its header chain, not through two bytes', () => {
    const dir = path.join(scratch, 'magic');
    fs.mkdirSync(dir, { recursive: true });

    // A genuine PE: `MZ`, the NT-header offset at 0x3c, `PE\0\0` there.
    const realPe = Buffer.alloc(256);
    realPe.write('MZ', 0, 'latin1');
    realPe.writeUInt32LE(0x80, 0x3c);
    realPe.write('PE', 0x80, 'latin1');
    const realPath = path.join(dir, 'real.exe');
    fs.writeFileSync(realPath, realPe);
    expect(gate.isNativeExecutable(realPath)).toBe(true);

    // `MZ` and nothing else. Before the header check this was counted native and
    // excused from the credential scan — a free pass any file could claim.
    const fake = path.join(dir, 'fake.bin');
    fs.writeFileSync(fake, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]));
    expect(gate.isNativeExecutable(fake)).toBe(false);

    const macho = path.join(dir, 'macho');
    fs.writeFileSync(macho, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 1, 2, 3]));
    expect(gate.isNativeExecutable(macho)).toBe(true);
  });

  it('throws rather than silently skipping a directory it cannot read', () => {
    // Fail-open inside a gate is the one outcome its whole discipline forbids:
    // a swallowed `readdir` dropped an entire subtree from the symlink, shape
    // and byte scans at once.
    const root = path.join(scratch, 'unreadable');
    const hidden = path.join(root, 'locked');
    fs.mkdirSync(hidden, { recursive: true });
    fs.writeFileSync(path.join(hidden, 'secret.js'), 'module.exports = 1;\n');
    fs.chmodSync(hidden, 0o000);
    try {
      expect(() => gate.walk(root)).toThrow(/unreadable directory in the extraction: locked/);
    } finally {
      fs.chmodSync(hidden, 0o755);
    }
  });

  it('derives required workspace entry points from the archive\u2019s own manifest', () => {
    const root = makeStagedRuntime(path.join(scratch, 'workspace-derive'));
    const derived = gate.archiveWorkspaceEntries(root);
    expect(derived.unsupported).toEqual([]);
    // `@soma/common` declares `main`; `somalib` declares none and must not
    // manufacture a requirement.
    expect(derived.entries).toContain('packages/common/dist/index.js');
    expect(derived.entries.some((entry) => entry.startsWith('somalib/'))).toBe(false);
  });
});

describe('release identity is supplied, not invented', () => {
  /** Run the packaging script with a deliberately incomplete identity. */
  function refuse(extra: string[], outDir: string): { status: number | null; output: string; created: boolean } {
    const target = path.join(scratch, outDir);
    const result = spawnSync(
      'bash',
      [
        packageScript,
        '--out-dir',
        target,
        '--version',
        VERSION,
        '--channel',
        'preview',
        '--source-sha',
        SOURCE_SHA,
        '--source-date-epoch',
        EPOCH,
        ...extra,
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
    );
    return {
      status: result.status,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      // Refusing after creating the output directory would already have mutated
      // the caller's filesystem.
      created: fs.existsSync(target),
    };
  }

  it('requires an explicit tag, and refuses before touching the output directory', () => {
    // The old default was `somawork-<channel>-v<version>` — no run id, so two
    // packaging runs of the same version produced the SAME tag. A release tag
    // that repeats is neither immutable nor orderable.
    const run = refuse([], 'identity-no-tag');
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('--tag is required');
    expect(run.output).toContain(`somawork-preview-v${VERSION}-<run id>`);
    expect(run.created).toBe(false);
  });

  it('requires an explicit release base URL, and refuses before any output', () => {
    const run = refuse(['--tag', VERSION_TAG], 'identity-no-base');
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('--release-base-url is required');
    expect(run.created).toBe(false);
  });

  it('enforces the channel-specific tag grammar', () => {
    const cases: { tag: string; why: string }[] = [
      { tag: `somawork-v${VERSION}-${RUN_ID}`, why: 'stable form on the preview channel' },
      { tag: `somawork-preview-v${VERSION}`, why: 'no run id' },
      { tag: `somawork-preview-v${VERSION}-0`, why: 'zero run id' },
      { tag: `somawork-preview-v${VERSION}-007`, why: 'leading zero' },
      { tag: `somawork-preview-v${VERSION}-x1`, why: 'non-numeric run id' },
      { tag: `somawork-preview-v9.9.8-${RUN_ID}`, why: 'a different version' },
    ];
    for (const { tag, why } of cases) {
      const run = refuse(
        ['--tag', tag, '--release-base-url', `https://github.com/2lab-ai/soma-work/releases/download/${tag}`],
        `identity-${tag.replace(/[^A-Za-z0-9]/g, '_')}`,
      );
      expect(run.status, why).not.toBe(0);
      expect(run.output, why).toMatch(/--tag must (start with|end in)/);
      expect(run.created, why).toBe(false);
    }
  });

  it('refuses a version the tag grammar cannot be built from', () => {
    const result = spawnSync(
      'bash',
      [
        packageScript,
        '--out-dir',
        path.join(scratch, 'identity-bad-version'),
        '--version',
        '9.9.9-rc1',
        '--channel',
        'preview',
        '--tag',
        'somawork-preview-v9.9.9-rc1-1',
        '--release-base-url',
        'https://github.com/2lab-ai/soma-work/releases/download/somawork-preview-v9.9.9-rc1-1',
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('--version must be exactly three numeric components');
  });

  it('refuses a base URL that is not this tag\u2019s canonical download base', () => {
    const run = refuse(
      ['--tag', VERSION_TAG, '--release-base-url', `https://evil.example.com/releases/download/${VERSION_TAG}`],
      'identity-bad-base',
    );
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('--release-base-url must be');
    expect(run.created).toBe(false);
  });

  it('keeps the shell\u2019s canonical base in step with the renderer that owns it', () => {
    // Two copies of the origin would drift; the shell copy exists only so the
    // refusal happens before output is written.
    const script = read('scripts/release/package-somawork.sh');
    // `${TAG}` is a shell expansion, built here so this file has no literal one.
    const shellTag = `\${${'TAG'}}`;
    expect(script).toContain(releaseBaseUrl(shellTag));
  });

  it('documents both channels, and ships no stable workflow', () => {
    const script = read('scripts/release/package-somawork.sh');
    const shellVersion = `\${${'VERSION'}}`;
    expect(script).toContain(`somawork-preview-v${shellVersion}-`);
    expect(script).toContain(`somawork-v${shellVersion}-`);
    // Stable release remains a separate, user-gated decision with no automation.
    expect(fs.existsSync(path.join(repoRoot, '.github/workflows/release-stable.yml'))).toBe(false);
    const workflows = fs.readdirSync(path.join(repoRoot, '.github/workflows'));
    expect(workflows.filter((name) => name.includes('stable'))).toEqual([]);
  });
});

describe('tar member list construction', () => {
  const payloadTools = path.join(repoRoot, 'scripts', 'release', 'payload-tools.js');
  const NEWLINE_NAME = `weird${String.fromCharCode(10)}name.txt`;

  /**
   * The tree that broke the old guard.
   *
   * `weird\nname.txt` alongside siblings literally named `weird` and `name.txt`:
   * the previous `find | sed | sort` list split the newline-bearing name into
   * two lines that both happened to name real files, so `tar` exited 0, dropped
   * the real file, and duplicated the other two. `wc -l` could not see it,
   * because a newline in a path increments both sides of that comparison.
   */
  function hostilePayload(root: string): string {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'normal.txt'), 'a\n');
    fs.writeFileSync(path.join(root, 'weird'), 'b\n');
    fs.writeFileSync(path.join(root, 'name.txt'), 'c\n');
    fs.writeFileSync(path.join(root, NEWLINE_NAME), 'd\n');
    return root;
  }

  it('refuses a member name carrying a control character, before tar runs', () => {
    const payload = hostilePayload(path.join(scratch, 'tar-hostile'));
    const list = path.join(scratch, 'tar-hostile.list');
    const result = spawnSync(process.execPath, [payloadTools, 'tar-list', payload, list], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('control character');
    // The offending name is rendered, never emitted raw.
    expect(result.stderr).not.toContain(NEWLINE_NAME);
    expect(fs.existsSync(list)).toBe(false);
  });

  it('sees every sibling, so the refusal cannot be dodged by a collision', () => {
    // The construction itself is faithful: four entries, no drop, no duplicate.
    // (The refusal above is policy; this is the property the policy rests on.)
    const { collectEntries } = require('../release/payload-tools.js') as {
      collectEntries: (root: string) => string[];
    };
    const payload = hostilePayload(path.join(scratch, 'tar-hostile-2'));
    const entries = collectEntries(payload);
    expect(entries).toHaveLength(4);
    expect(new Set(entries).size).toBe(4);
    expect(entries).toContain(NEWLINE_NAME);
    expect(entries).toContain('weird');
    expect(entries).toContain('name.txt');
  });

  it('emits a NUL-delimited, byte-sorted list for an ordinary payload', () => {
    const payload = path.join(scratch, 'tar-ordinary');
    fs.mkdirSync(path.join(payload, 'dist', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(payload, 'dist', 'cli', 'index.js'), '\n');
    fs.writeFileSync(path.join(payload, 'package.json'), '{}\n');
    const list = path.join(scratch, 'tar-ordinary.list');
    const result = spawnSync(process.execPath, [payloadTools, 'tar-list', payload, list], { encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    const raw = fs.readFileSync(list);
    expect(raw[raw.length - 1]).toBe(0);
    const members = raw
      .toString('utf8')
      .split(String.fromCharCode(0))
      .filter((entry) => entry.length > 0);
    expect(members).toEqual([...members].sort());
    expect(members).toContain('dist/cli/index.js');
    expect(members).toContain('package.json');
    expect(result.stdout.trim()).toBe(String(members.length));
  });

  it('is what the packaging script actually calls', () => {
    const script = read('scripts/release/package-somawork.sh');
    expect(script).toContain('payload-tools.js');
    expect(script).toContain('tar-list');
    expect(script).toContain('--null');
    // The guard that never fired is gone.
    expect(script).not.toContain('wc -l < "$list"');
  });

  it(
    'refuses such a payload end to end, from the packaging script',
    () => {
      const staged = makeStagedRuntime(path.join(scratch, 'tar-refuse-staged'));
      fs.writeFileSync(path.join(staged, NEWLINE_NAME), 'd\n');
      fs.writeFileSync(path.join(staged, 'weird'), 'b\n');
      fs.writeFileSync(path.join(staged, 'name.txt'), 'c\n');
      const run = runPackaging({
        outDir: path.join(scratch, 'tar-refuse-out'),
        stagedRuntime: staged,
        dependencyOverlay: makeDependencyOverlay(path.join(scratch, 'tar-refuse-modules')),
      });
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain('control character');
    },
    PACKAGING_TIMEOUT_MS,
  );
});

describe('sanitize contract across the repository', () => {
  /**
   * The authoritative superset: every tracked file plus every non-ignored
   * untracked one, straight from git.
   *
   * Two earlier shapes of this gate were both wrong. A hand-kept ownership list
   * stops covering the next file somebody adds. Deriving from `git status` was
   * worse in a quieter way: it covered whatever happened to be uncommitted, so
   * the moment this work was committed the gate went from scanning 25 files to
   * scanning 3 and had no way to notice. `ls-files --cached --others
   * --exclude-standard` has neither failure mode — it is the whole repository,
   * and it excludes gitignored trees (`.deploy-bundle`, the SDD scratch) for
   * free, because those are exactly the things git already knows not to track.
   */
  function repositoryFiles(): string[] {
    const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    return (result.stdout ?? '')
      .split(String.fromCharCode(0))
      .filter((rel) => rel.length > 0)
      .filter((rel) => {
        // Regular files only: a directory entry cannot appear here, but a
        // symlink can, and following one would scan something twice or escape
        // the repository.
        try {
          return fs.lstatSync(path.join(repoRoot, rel)).isFile();
        } catch {
          return false;
        }
      });
  }

  /**
   * Raw bytes, case-insensitively, in bounded chunks — never a UTF-8 decode.
   *
   * The repository tracks 10 MB fonts and PNGs. `readFileSync(file, 'utf8')`
   * over those is both wasteful and a decode this gate has no business
   * performing; `latin1` is a 1:1 byte-to-char mapping that cannot throw, and
   * every term is ASCII so lowercasing is exact. Chunks carry `longest - 1`
   * characters forward so a term straddling a boundary is still found.
   *
   * A file that cannot be opened is reported, not skipped: "we could not look"
   * is never "we looked and it was clean".
   */
  function findBlockedTerm(file: string): string | null {
    const needles = BLOCKED_TERMS.map((term) => ({ name: term.name, needle: term.text.toLowerCase() }));
    const overlap = Math.max(...needles.map((entry) => entry.needle.length)) - 1;
    const chunkBytes = 1024 * 1024;

    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return 'unreadable file';
    }
    try {
      const buffer = Buffer.alloc(chunkBytes);
      let carry = '';
      let offset = 0;
      for (;;) {
        const read = fs.readSync(fd, buffer, 0, chunkBytes, offset);
        if (read === 0) return null;
        offset += read;
        const window = carry + buffer.subarray(0, read).toString('latin1').toLowerCase();
        for (const entry of needles) {
          if (window.includes(entry.needle)) return entry.name;
        }
        carry = overlap > 0 ? window.slice(-overlap) : '';
      }
    } catch {
      return 'unreadable file';
    } finally {
      fs.closeSync(fd);
    }
  }

  it('assembles the three permanently prohibited terms instead of writing them', () => {
    expect(BLOCKED_TERMS).toHaveLength(3);
    for (const term of BLOCKED_TERMS) {
      // Assembly must not have weakened the scan: the regex still matches the
      // real string, in context, case-insensitively.
      expect(term.re.test(`prefix ${term.text} suffix`), term.name).toBe(true);
      expect(term.re.test(`PREFIX ${term.text.toUpperCase()} SUFFIX`), term.name).toBe(true);
      expect(term.text.length).toBeGreaterThan(4);
    }
  });

  it('scans the whole repository, not a curated slice of it', () => {
    const files = repositoryFiles();
    // A floor, so a gate that silently stopped finding files fails instead of
    // passing. The repository is ~1,780 files; this is not a tight bound.
    expect(files.length).toBeGreaterThan(1000);
    // The surfaces this workstream is responsible for are definitely in it.
    for (const key of [
      '.github/workflows/release-preview.yml',
      'scripts/__tests__/package-somawork.test.ts',
      'scripts/release/package-somawork.sh',
      'scripts/release/render-manifest.ts',
      'scripts/smoke/package-archives.js',
      'scripts/smoke/setup-package.js',
    ]) {
      expect(files, key).toContain(key);
    }
    // …and the gitignored trees are not, because git already excludes them.
    expect(files.some((rel) => rel.startsWith('.deploy-bundle/'))).toBe(false);
    expect(files.some((rel) => rel.startsWith('.superpowers/sdd/'))).toBe(false);
  });

  it('finds none of the prohibited terms anywhere in the repository', () => {
    const offenders = repositoryFiles()
      .map((rel) => ({ rel, found: findBlockedTerm(path.join(repoRoot, rel)) }))
      .filter((entry) => entry.found !== null)
      // The report names the file and the family, never the term itself.
      .map((entry) => `${entry.rel} (${entry.found})`);
    expect(offenders).toEqual([]);
  });

  it('catches a prohibited term in a file nobody has tracked yet', () => {
    // The load-bearing half. An untracked, non-ignored file is exactly how a new
    // violation arrives, and it is the case a tracked-files-only scan misses.
    const probe = 'somawork-sanitize-probe.generated.txt';
    const absolute = path.join(repoRoot, probe);
    try {
      // Assembled here too: this file may not contain the term either.
      fs.writeFileSync(absolute, `a note that happens to mention ${BLOCKED_TERMS[0].text} in passing\n`);
      expect(repositoryFiles(), 'the probe must be visible to the superset').toContain(probe);
      expect(findBlockedTerm(absolute)).toBe(BLOCKED_TERMS[0].name);
      // Upper-case is the same violation.
      fs.writeFileSync(absolute, `NOTE: ${BLOCKED_TERMS[2].text.toUpperCase()}\n`);
      expect(findBlockedTerm(absolute)).toBe(BLOCKED_TERMS[2].name);
      // A term split across a chunk boundary is still found.
      const term = BLOCKED_TERMS[1].text;
      const head = Buffer.alloc(1024 * 1024 - Math.floor(term.length / 2), 0x78);
      fs.writeFileSync(absolute, Buffer.concat([head, Buffer.from(term, 'latin1'), Buffer.from('\n')]));
      expect(findBlockedTerm(absolute)).toBe(BLOCKED_TERMS[1].name);
    } finally {
      fs.rmSync(absolute, { force: true });
    }
    expect(fs.existsSync(absolute)).toBe(false);
  });

  it('reports a file it cannot read rather than passing over it', () => {
    const unreadable = path.join(scratch, 'unreadable-probe.txt');
    fs.writeFileSync(unreadable, 'anything\n');
    fs.chmodSync(unreadable, 0o000);
    try {
      expect(findBlockedTerm(unreadable)).toBe('unreadable file');
    } finally {
      fs.chmodSync(unreadable, 0o644);
    }
  });
});

describe('shipped skill references', () => {
  const examples = [
    'src/local/skills/es/reference/executive-summary-example.md',
    'src/local/skills/z/reference/executive-summary-example.md',
    'src/local/skills/es/reference/executive-summary-template.md',
    'src/local/skills/z/reference/executive-summary-template.md',
  ];

  it('are synthetic, not a real report from somebody else\u2019s codebase', () => {
    for (const rel of examples) {
      const body = read(rel);
      expect(body, rel).toContain('**Synthetic example.**');
      for (const leaked of [
        'SnapshotServer.Protein.Receive.cs',
        'SnapshotServer.Impl.SubscribeServer.cs',
        'SettlementService',
        'SettleFixture',
        'BigWinPublisher',
        'BigWinFeed',
        'vsports',
        'settlements_service',
        'deploy/dev2',
        'osun50s',
        'PROJ-3231',
        'projalpha',
      ]) {
        expect(body.toLowerCase(), `${rel} -> ${leaked}`).not.toContain(leaked.toLowerCase());
      }
    }
  });

  it('are mirrored byte-for-byte, because the two skills each ship their own copy', () => {
    // There is no shared-reference mechanism between skills and the bundle
    // forbids symlinks outright, so the copies must be kept identical by hand.
    expect(read(examples[0])).toBe(read(examples[1]));
    expect(read(examples[2])).toBe(read(examples[3]));
  });
});

describe('shipped extract-pr-data invocation', () => {
  it('names the compiled script and an interpreter an installed runtime has', () => {
    const source = read('src/local/skills/github-pr/scripts/extract-pr-data.ts');
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(source).toContain('node local/skills/github-pr/scripts/extract-pr-data.js <type> <input> [output]');
    // `tsx` is a devDependency and the `.ts` is pruned from the bundle, so the
    // shipped script must not name either.
    expect(source).not.toContain('extract-pr-data.ts');
    expect(source).not.toContain('npx tsx');
  });
});

describe('preview release workflow', () => {
  const workflowPath = '.github/workflows/release-preview.yml';

  it('exists as its own workflow rather than a mode of the fleet deploy', () => {
    expect(fs.existsSync(path.join(repoRoot, workflowPath))).toBe(true);
    const deploy = read('.github/workflows/deploy.yml');
    expect(deploy).not.toContain('somawork-manifest.json');
    expect(deploy).not.toContain('package-somawork.sh');
    // The fleet deploy's own contract, unchanged.
    expect(deploy).toContain('bash scripts/deploy/stage-bundle.sh');
    expect(deploy).toContain('npm run smoke:deploy-bundle');
    expect(deploy).toContain('scripts/deploy/install-target.sh');
  });

  /** Every `run:` body in the workflow, keyed by step name. */
  function runBlocks(): { name: string; body: string }[] {
    const workflow = read(workflowPath);
    const blocks: { name: string; body: string }[] = [];
    // Deliberately a text scan rather than a YAML parse: what matters is the
    // literal text GitHub substitutes into, and a parser would normalise it.
    const stepRe = /^ {6}- name: (.+)$/gm;
    const marks: { name: string; at: number }[] = [];
    for (const match of workflow.matchAll(stepRe)) marks.push({ name: match[1], at: match.index ?? 0 });
    for (let index = 0; index < marks.length; index += 1) {
      const slice = workflow.slice(marks[index].at, marks[index + 1]?.at ?? workflow.length);
      const runAt = slice.indexOf('\n        run:');
      if (runAt >= 0) blocks.push({ name: marks[index].name, body: slice.slice(runAt) });
    }
    return blocks;
  }

  it('never interpolates a dispatch input into a shell body', () => {
    // `${{ … }}` is substituted textually before the shell parses the line, so a
    // value containing a quote closes the quoting and the remainder executes —
    // on a persistent self-hosted runner with `contents: write`, defeating the
    // confirmation gate this workflow is built around. Inputs may reach a step
    // only through `env:`.
    const blocks = runBlocks();
    expect(blocks.length).toBeGreaterThan(8);
    for (const block of blocks) {
      expect(block.body.includes('${{ inputs.'), `${block.name} interpolates a dispatch input`).toBe(false);
      expect(block.body.includes('${{ github.event'), `${block.name} interpolates event data`).toBe(false);
      expect(block.body.includes('${{ secrets.'), `${block.name} interpolates a secret`).toBe(false);
    }
    // …and the values are consumed as quoted shell variables.
    const workflow = read(workflowPath);
    expect(workflow).toMatch(/CONFIRM:\s*\$\{\{\s*inputs\.confirm\s*\}\}/);
    expect(workflow).toContain('"$CONFIRM"');
  });

  it('takes no tag input at all — the tag is generated, never chosen', () => {
    // An operator-supplied tag was an override on the one identifier the whole
    // release is keyed by: the tap payload, every asset URL, and the rollback's
    // ownership check all quote it. It also had no monotonicity — two dispatches
    // could sort backwards or collide.
    const workflow = read(workflowPath);
    const dispatch = workflow.slice(workflow.indexOf('workflow_dispatch:'), workflow.indexOf('concurrency:'));
    expect(dispatch).toContain('confirm:');
    expect(dispatch).not.toContain('tag:');
    expect(workflow).not.toContain('inputs.tag');
    expect(workflow).not.toContain('REQUESTED_TAG');
    // Composed from the version and the run id, nothing else.
    expect(workflow).toMatch(/TAG="somawork-preview-v\$\{VERSION\}-\$\{RUN_ID\}"/);
  });

  it('validates both tag inputs and the recomposed tag before anything uses it', () => {
    const workflow = read(workflowPath);
    // Exactly three components — see the monotonicity note in render-manifest.ts.
    const versionRe = /^[0-9]+\.[0-9]+\.[0-9]+$/;
    const runIdRe = /^[1-9][0-9]*$/;
    const tagRe = /^somawork-preview-v[0-9]+\.[0-9]+\.[0-9]+-[1-9][0-9]*$/;

    // All three grammars are enforced in the workflow, not merely assumed.
    expect(workflow).toContain('^[0-9]+\\.[0-9]+\\.[0-9]+$');
    expect(workflow).toContain('^[1-9][0-9]*$');
    expect(workflow).toContain('^somawork-preview-v[0-9]+\\.[0-9]+\\.[0-9]+-[1-9][0-9]*$');
    // …and before the tag reaches packaging.
    expect(workflow.indexOf('Recomposed tag does not match')).toBeLessThan(workflow.indexOf('package-somawork.sh'));

    for (const bad of ['1.0.0-rc1', 'v1.0.0', '1.0.0 ', "1.0.0'; id #", '', 'latest', '1.0', '1', '1.0.0.1']) {
      expect(versionRe.test(bad), bad).toBe(false);
    }
    expect(versionRe.test('1.0.0')).toBe(true);
    for (const bad of ['0', '007', '-1', '1x', '', '1 2']) {
      expect(runIdRe.test(bad), bad).toBe(false);
    }
    for (const bad of [
      'somawork-preview-v1.0.0',
      'somawork-preview-v1.0.0-0',
      'somawork-v1.0.0-7',
      // Component-count drift is what breaks Homebrew's monotone ordering.
      'somawork-preview-v1.0-7',
      'somawork-preview-v1.0.0.1-7',
      "somawork-preview-v1.0.0-7'; rm -rf / #",
      'somawork-preview-v1.0.0-7 extra',
    ]) {
      expect(tagRe.test(bad), bad).toBe(false);
    }
    expect(tagRe.test('somawork-preview-v1.0.0-424242')).toBe(true);
    // The confirmation is still an exact match, not a pattern.
    expect(workflow).toContain("!= 'release-preview'");
    expect(workflow).not.toMatch(/confirm.*=~/);
  });

  it('publishes through a draft and can undo everything before the commit point', () => {
    const workflow = read(workflowPath);
    // From the steps, not the header: the header describes this order in prose,
    // and matching prose would make the assertion vacuous.
    const steps = workflow.slice(workflow.indexOf('    steps:'));
    const order = [
      'Require the tap dispatch credential',
      'gh release create',
      'Upload the manifest-named assets to the draft',
      'gh release download',
      'scripts/smoke/package-archives.js --manifest dist-release-verify',
      'gh release edit',
      '--draft=false',
      'repository_dispatch',
    ];
    let cursor = -1;
    for (const step of order) {
      const at = steps.indexOf(step);
      expect(at, `${step} missing or out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }

    // The credential check precedes the first thing that creates anything.
    expect(steps.indexOf('TAP_DISPATCH_TOKEN is not configured')).toBeLessThan(steps.indexOf('gh release create'));

    // Every `gh release create` in this workflow creates a draft. Without this,
    // a failed upload or a failed revalidation leaves a public prerelease with
    // partial assets and no way back.
    const creates = runBlocks().filter((block) => block.body.includes('gh release create'));
    expect(creates).toHaveLength(1);
    expect(creates[0].body).toContain('--draft');
    expect(creates[0].body).toContain('--prerelease');
  });

  it('rolls back its own release when the tap dispatch fails, with ownership proved', () => {
    // The honest hole in the first draft-then-publish fix: publication precedes
    // the dispatch (it must — the manifest URL 404s for an anonymous fetch while
    // the release is a draft), and the draft cleanup refuses to touch a
    // published release. So a dispatch failure left assets up and the tap
    // untold, which is precisely the state this workflow says it will not leave.
    const workflow = read(workflowPath);

    expect(workflow).toContain("if: (failure() || cancelled()) && steps.publish.outcome == 'success'");
    // Ownership, not just "a release exists under this tag".
    expect(workflow).toContain('--json id,isDraft,isPrerelease,tagName,targetCommitish');
    expect(workflow).toContain('"$FOUND_ID" != "$RELEASE_ID"');
    expect(workflow).toContain('"$TAG_NAME" != "$TAG"');
    expect(workflow).toContain('"$IS_DRAFT" != \'false\'');
    expect(workflow).toContain('"$IS_PRERELEASE" != \'true\'');
    expect(workflow).toContain('"$TARGET" != "$SOURCE_SHA"');
    expect(workflow).toContain('Refusing to roll back');

    // The id compared against is read back at creation, not re-derived later.
    expect(workflow).toContain('release_id=%s');

    // …and `created=true` is emitted BEFORE the read-back. Anything between the
    // create and that line is a window where a transient failure — or a cancel —
    // leaves a draft that no cleanup step will ever look at, because both are
    // gated on `created`.
    const createStep = workflow.slice(
      workflow.indexOf('Create the draft release'),
      workflow.indexOf('Upload the manifest-named assets'),
    );
    const readBack = '--json id --jq .id';
    expect(createStep.indexOf('gh release create')).toBeLessThan(createStep.indexOf('created=true'));
    expect(createStep.indexOf('created=true')).toBeLessThan(createStep.indexOf(readBack));
    expect(createStep.indexOf(readBack)).toBeLessThan(createStep.indexOf('release_id=%s'));
    expect(workflow).toMatch(/RELEASE_ID:\s*\$\{\{\s*steps\.draft\.outputs\.release_id\s*\}\}/);

    // The delete happens only after the checks, and the step still fails the run.
    const rollbackAt = workflow.indexOf('Roll back this run');
    const rollback = workflow.slice(rollbackAt);
    expect(rollback.indexOf('--json id,isDraft')).toBeLessThan(rollback.indexOf('gh release delete'));
    expect(rollback).toContain('exit 1');
  });

  it('routes cancellation to cleanup, not only failure', () => {
    // A user cancel — or a `timeout-minutes` expiry — is `cancelled()`, not
    // `failure()`. On `failure()` alone neither cleanup ran, so a cancel taken
    // between publication and the tap dispatch left assets public with the tap
    // untold: the exact end state the design exists to prevent. This job is long
    // enough (two `npm ci`s, a serial suite, two 62 MB tars, a ~124 MB upload)
    // that landing there is realistic rather than theoretical.
    const workflow = read(workflowPath);
    const conditions = (workflow.match(/^\s*if: .*$/gm) ?? []).map((line) => line.trim());
    expect(conditions).toHaveLength(2);
    for (const condition of conditions) {
      expect(condition, condition).toContain('(failure() || cancelled())');
      expect(condition, condition).not.toMatch(/if: failure\(\) &&/);
    }
  });

  it('makes the two cleanup paths disjoint, so neither can run over the other', () => {
    const workflow = read(workflowPath);
    // Pre-publication → delete the draft. Post-publication → roll back. The two
    // `steps.publish.outcome` tests are complements, so exactly one can hold.
    expect(workflow).toContain(
      "if: (failure() || cancelled()) && steps.draft.outputs.created == 'true' && steps.publish.outcome != 'success'",
    );
    expect(workflow).toContain("if: (failure() || cancelled()) && steps.publish.outcome == 'success'");
  });

  it('refuses, and says why, when no release id was ever recorded', () => {
    // `created=true` is emitted before the id read-back, so cleanup now RUNS
    // when the read-back fails — but `RELEASE_ID` is empty in exactly that case.
    // Without an explicit branch it falls into the generic comparison and blames
    // "not the one this run created", which is a different situation and sends
    // the operator looking for a competing run that does not exist.
    const workflow = read(workflowPath);
    const draftStep = workflow.slice(
      workflow.indexOf("Delete this run's draft"),
      workflow.indexOf("Roll back this run's release"),
    );

    const emptyIdBranch = draftStep.indexOf('if [[ -z "$RELEASE_ID" ]]; then');
    const genericMismatch = draftStep.indexOf('"$FOUND_ID" != "$RELEASE_ID"');
    expect(emptyIdBranch).toBeGreaterThan(-1);
    // Before the generic mismatch, or it can never be reached.
    expect(emptyIdBranch).toBeLessThan(genericMismatch);

    // The message names the cause, the exact run-qualified tag, and the manual
    // step — it does not claim someone else owns the release.
    const branch = draftStep.slice(emptyIdBranch, genericMismatch);
    expect(branch).toContain('release id was never recorded');
    expect(branch).toContain('require manual cleanup');
    // The run-qualified tag, so the operator has the exact thing to look at.
    expect(branch).toMatch(/\$\{TAG\}/);
    expect(branch).not.toContain('not the one this run created');

    // Fail-closed: this path refuses, it does not delete on a weaker test.
    expect(branch).not.toContain('gh release delete');
    expect(branch).toContain('exit 0');
  });

  it('proves ownership on the draft path too, not just on the rollback', () => {
    // `--cleanup-tag` deletes a git ref either way. "A draft happens to exist
    // under this tag" was not proof that this run created it.
    const workflow = read(workflowPath);
    const draftStep = workflow.slice(
      workflow.indexOf("Delete this run's draft"),
      workflow.indexOf("Roll back this run's release"),
    );
    expect(draftStep).toContain('--json id,isDraft,tagName,targetCommitish');
    expect(draftStep).toContain('"$FOUND_ID" != "$RELEASE_ID"');
    expect(draftStep).toContain('"$TAG_NAME" != "$TAG"');
    expect(draftStep).toContain('"$TARGET" != "$SOURCE_SHA"');
    expect(draftStep).toContain('"$IS_DRAFT" != \'true\'');
    expect(draftStep.indexOf('--json id,isDraft')).toBeLessThan(draftStep.indexOf('gh release delete'));
  });

  it('says plainly which failure mode no cleanup can cover', () => {
    // Honesty about the boundary: GitHub cannot run a cleanup step on a runner
    // that no longer exists.
    const workflow = read(workflowPath);
    expect(workflow).toContain('hard runner loss');
    expect(workflow).toContain('no automatic recovery');
  });

  it('refuses to reuse a tag, which is what makes rolling the tag back safe', () => {
    const workflow = read(workflowPath);
    // `--cleanup-tag` deletes the git tag too. That is only defensible if this
    // run is the thing that created it.
    expect(workflow).toContain('Release tags are immutable; refusing to reuse one');
    expect(workflow).toContain('git ls-remote --exit-code --tags origin');
    const createAt = workflow.indexOf('gh release create');
    expect(workflow.indexOf('git ls-remote --exit-code --tags origin')).toBeLessThan(createAt);
  });

  it('does not claim the end-to-end sequence is atomic', () => {
    const workflow = read(workflowPath);
    // It is recoverable, not atomic: the rollback itself can fail, and the
    // assets are public for the seconds between publication and a failed
    // dispatch. Saying "atomic" here would be a claim the steps cannot keep.
    expect(workflow.toLowerCase()).not.toContain('is atomic');
    expect(workflow).toContain('recoverable');
    expect(workflow).toContain('rolls the published prerelease and its tag');
  });

  it('cleans up only its own draft, and never a published release', () => {
    const workflow = read(workflowPath);
    const draftStep = workflow.slice(
      workflow.indexOf("Delete this run's draft"),
      workflow.indexOf("Roll back this run's release"),
    );
    expect(draftStep).toContain(
      "if: (failure() || cancelled()) && steps.draft.outputs.created == 'true' && steps.publish.outcome != 'success'",
    );
    // A release that is no longer a draft is refused by this path — the rollback
    // owns that case, and only after its own five ownership checks.
    expect(draftStep).toContain('"$IS_DRAFT" != \'true\'');
    expect(draftStep).toContain('no longer a draft');
    expect(draftStep).toContain('gh release delete');
  });

  it('uploads exactly the assets the manifest names', () => {
    const workflow = read(workflowPath);
    // M-5: a glob would publish anything else that happened to be in the
    // directory, ungated.
    expect(workflow).not.toContain('dist-release/*.tar.gz');
    expect(workflow).toContain('somawork-manifest.json');
    expect(workflow).toContain('for (const asset of manifest.assets)');
    expect(workflow).toContain('upload-list.txt');
  });

  it('publishes only when a human explicitly dispatches it', () => {
    const workflow = read(workflowPath);
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^on:\s*$[\s\S]*?^\s{2}push:/m);
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).not.toContain('schedule:');
    expect(workflow).toContain('confirm:');
    expect(workflow).toContain("!= 'release-preview'");
  });

  it('builds, tests, gates, and only then publishes and dispatches the tap bump', () => {
    const workflow = read(workflowPath);
    const order = [
      'npm ci',
      'npm run build',
      'npm test',
      'bash scripts/deploy/stage-bundle.sh',
      'npm run smoke:setup-package',
      'scripts/release/package-somawork.sh',
      'scripts/smoke/package-archives.js',
      'gh release create',
      'repository_dispatch',
    ];
    let cursor = -1;
    for (const step of order) {
      const at = workflow.indexOf(step);
      expect(at, `${step} missing or out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('sends the tap an immutable tag, manifest URL, and manifest SHA, and never logs the token', () => {
    const workflow = read(workflowPath);
    expect(workflow).toContain('somawork-preview');
    expect(workflow).toContain('manifest_url');
    expect(workflow).toContain('manifest_sha256');
    expect(workflow).toContain('secrets.TAP_DISPATCH_TOKEN');
    // The token is passed through the environment, never interpolated into a
    // command line where `set -x`, an error message, or the run log would carry it.
    expect(workflow).not.toMatch(/\$\{\{\s*secrets\.TAP_DISPATCH_TOKEN\s*\}\}["']?\s*(?:\||>|&&|\))/);
    // This workflow sets no license anywhere, and that is the end state rather
    // than an unfinished one: the release manifest omits `license`, the public
    // archives carry the LICENSE file and declare ISC in their own package
    // manifests, and the tap pins ISC in its templates from the repository's
    // legal facts. Nothing needs to be handed along this path.
    expect(workflow).not.toMatch(/license\s*[:=]/);
  });
});

describe('packaging entry points', () => {
  it('is reachable through npm scripts, so the release path cannot drift from the tested one', () => {
    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.scripts['package:somawork']).toContain('scripts/release/package-somawork.sh');
    expect(pkg.scripts['smoke:package-archives']).toContain('scripts/smoke/package-archives.js');
    expect(pkg.devDependencies.esbuild).toBeTruthy();
  });
});

/**
 * The repository's own license — the fact three other release surfaces are
 * written against.
 *
 * `package.json` declared `"license": "ISC"` with no LICENSE file beside it: an
 * SPDX identifier in a manifest, with no grant text anywhere in the tree, is a
 * claim rather than a license — and it was the reason
 * `scripts/release/render-manifest.ts` and `scripts/smoke/package-archives.js`
 * both refused to let a release document name a license at all. This binds the
 * identifier and the text together so neither can move without the other
 * failing.
 */
describe('repository license', () => {
  /**
   * Present to git, not merely present on disk.
   *
   * `--cached --others --exclude-standard` is the same authoritative superset
   * the sanitize contract above uses: everything git already carries, plus
   * everything it would carry on the next `add`, minus what `.gitignore`
   * excludes. A LICENSE that `existsSync` finds but git ignores ships to
   * nobody, and a plain `--cached` check would fail on the very commit that
   * introduces the file.
   */
  function isRepositoryFile(relativePath: string): boolean {
    const result = spawnSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', relativePath],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return (result.stdout ?? '').split(String.fromCharCode(0)).includes(relativePath);
  }

  it('carries an ISC LICENSE whose text backs the identifier package.json declares', () => {
    expect(isRepositoryFile('LICENSE'), 'LICENSE must be a repository file, not an ignored local one').toBe(true);

    const pkg = JSON.parse(read('package.json')) as { license?: string };
    expect(pkg.license).toBe('ISC');

    const license = read('LICENSE');
    expect(license.split('\n')[0]).toBe('ISC License');
    expect(license).toContain('Copyright (c) 2026 2lab.ai');

    // The two clauses that make this the ISC license rather than a file titled
    // like one. Compared with runs of whitespace collapsed, so re-wrapping the
    // text is not a failure but rewording a clause is.
    const collapsed = license.replace(/\s+/g, ' ');
    expect(collapsed).toContain(
      'Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.',
    );
    expect(collapsed).toContain(
      'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS.',
    );
    expect(collapsed).toContain(
      'IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES',
    );
  });
});
