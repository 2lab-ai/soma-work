/**
 * `somawork-manifest.json` — the one document a formula renderer is allowed to
 * read.
 *
 * ## What this is for
 *
 * The tap's renderer turns a release into three Homebrew formulae. It must not
 * guess a URL, re-derive a version from a filename, or ask GitHub what the tag
 * points at: everything it needs is here, and everything here is checked before
 * it is written. A manifest that passes {@link renderManifest} states, for one
 * immutable release:
 *
 * - which channel and tag it belongs to, and which source commit built it;
 * - the runtime layout version the archives carry, so a consumer can refuse a
 *   payload shape it does not understand;
 * - the minimum Node the controller was compiled for;
 * - and for each of the three assets: its package name, its runtime profile
 *   (`null` for the controller), its filename, its immutable URL, its SHA-256,
 *   and its byte count.
 *
 * ## Rules that are not negotiable here
 *
 * **Nothing is looked up.** No network call, no `git`, no `gh`, no reading of
 * the repository. Every value arrives as an argument; the only file this module
 * touches is an asset whose path was passed in, and only to hash it. A renderer
 * that could reach the network could produce a manifest describing a release
 * that does not exist.
 *
 * **No license field.** The repository is ISC and every archive carries the
 * grant as a `LICENSE` file at its root, verified byte-for-byte against the
 * repository's own copy by `scripts/smoke/package-archives.js`. That makes the
 * license fixed repository metadata rather than release-varying authority: it
 * cannot differ between two releases the way a version, a sha or an asset URL
 * can, so a schema-1 manifest has nothing to tell a consumer that the artifact
 * does not already carry.
 *
 * Nothing downstream reads a `license` key out of this document. The public
 * archives carry the grant themselves and declare ISC in their own package
 * manifests, and the tap pins ISC in its formula templates from the
 * repository's legal facts, independently of any release. Publishing the
 * identifier here would therefore be a schema change with no reader, and a
 * second place for one fact to drift from itself.
 *
 * **Filenames are derived, not accepted.** The asset name is
 * `<package>-<version>-<platform>.tar.gz`, computed here and compared against
 * what the caller passed. A packaging script that renamed one archive would
 * otherwise publish a manifest pointing at a URL that 404s.
 *
 * ## Usage
 *
 *   npx tsx scripts/release/render-manifest.ts \
 *     --version 1.2.3 --channel preview --tag somawork-preview-v1.2.3 \
 *     --source-sha <40-hex> --base-url https://github.com/.../download/<tag> \
 *     --asset package=somawork-cli,profile=none,file=<path> \
 *     --asset package=somawork,profile=production,file=<path> \
 *     --asset package=somawork-preview,profile=preview,file=<path> \
 *     [--out somawork-manifest.json]
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Every rejection from this module. The message names the field, never a secret. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

export type ReleaseChannel = 'preview' | 'stable';
export type RuntimeProfile = 'preview' | 'production';

export interface ManifestAssetInput {
  package: string;
  profile: RuntimeProfile | null;
  filename: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface ManifestInput {
  version: string;
  channel: ReleaseChannel;
  tag: string;
  sourceSha: string;
  platform: string;
  minimumNode: string;
  layoutVersion: number;
  /** Every asset URL must be exactly `${baseUrl}/${filename}`, and this must end in the tag. */
  baseUrl: string;
  layout: ManifestLayout;
  assets: ManifestAssetInput[];
}

/** Bumped when a consumer would have to change to read this document. */
export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * The runtime tree shape the archives carry, as pinned by
 * `scripts/smoke/setup-package.js`. A consumer that knows only layout 1 must
 * refuse layout 2 rather than install a tree it will look for files in the
 * wrong place of.
 */
export const RUNTIME_LAYOUT_VERSION = 1;

/**
 * The CI floor, not the README's aspiration.
 *
 * `.github/workflows/ci.yml` runs Node 20 and the controller bundle is compiled
 * for `node20`; the README advertises 22+. Publishing 22 would refuse installs
 * on the exact runtime this package is verified on.
 */
export const MINIMUM_NODE = '20.0.0';

export const PLATFORM = 'darwin-arm64';

/**
 * The one origin a somawork release can come from.
 *
 * `baseUrl` used to be checked only as "https, and ends in `/<tag>`". That let
 * `https://evil.example.com/releases/download/<tag>` through — the tag suffix is
 * trivially reproducible on any host — so the manifest could name a mirror the
 * project does not control. The per-asset sha256 pin bounds what a consumer
 * would *install*, but a formula renderer following those URLs is still being
 * pointed somewhere else, and the document would be lying about where its bytes
 * live.
 *
 * The repository is fixed public project identity, so the check can be exact
 * equality rather than a pattern. It is deliberately NOT a manifest field: the
 * tap renderer must not be able to be told which host to trust by the document
 * it is validating.
 */
export const RELEASE_ORIGIN = 'https://github.com';
export const SOURCE_REPOSITORY = '2lab-ai/soma-work';

/** The only acceptable asset base for a release tag. */
export function releaseBaseUrl(tag: string): string {
  return `${RELEASE_ORIGIN}/${SOURCE_REPOSITORY}/releases/download/${tag}`;
}

/**
 * The layout facts a formula cannot install correctly without.
 *
 * The tap renderer is specified to consume **only** this manifest. Until now it
 * carried an opaque `layoutVersion: 1` and nothing else about shape, so Task 2
 * would have had to hardcode `libexec/bin/somawork` and the
 * `prefix.install Dir["*"]` + `bin.install_symlink` pattern, with no way for a
 * later layout change to tell it.
 *
 * `install: "prefix"` means: extract the archive at the formula prefix root.
 * That is not cosmetic for the controller — `readControllerVersion` resolves
 * `__dirname/../../package.json`, so the entry must stay exactly two directories
 * below the tree root that carries the manifest, and {@link renderManifest}
 * enforces that depth rather than trusting the string.
 */
export const CONTROLLER_LAYOUT = {
  entry: 'libexec/bin/somawork',
  manifest: 'package.json',
} as const;

/**
 * Runtime-root-relative paths both runtime archives carry.
 *
 * `marker` is the per-archive receipt that names which package and profile an
 * extracted tree is; it is how a consumer tells a preview runtime root from a
 * production one without parsing a directory name.
 */
export const RUNTIME_LAYOUT = {
  marker: '.somawork-package.json',
  manifest: 'package.json',
  controllerEntry: 'dist/cli/index.js',
  supervisor: 'dist/run-with-rotating-logs.js',
  daemon: 'dist/index.js',
} as const;

export interface ManifestLayout {
  install: 'prefix';
  controller: { entry: string; manifest: string };
  runtime: {
    marker: string;
    manifest: string;
    controllerEntry: string;
    supervisor: string;
    daemon: string;
  };
}

export const DEFAULT_LAYOUT: ManifestLayout = {
  install: 'prefix',
  controller: { ...CONTROLLER_LAYOUT },
  runtime: { ...RUNTIME_LAYOUT },
};

/**
 * The three assets, in order, with the profile each one installs.
 *
 * A list rather than a set: the manifest's asset order is part of the document,
 * so two runs over the same release produce the same bytes.
 */
export const EXPECTED_ASSETS: readonly { package: string; profile: RuntimeProfile | null }[] = [
  { package: 'somawork-cli', profile: null },
  { package: 'somawork', profile: 'production' },
  { package: 'somawork-preview', profile: 'preview' },
];

/**
 * Exactly three numeric components.
 *
 * The tap renders a formula version of `<version>.<run id>` and leans on
 * Homebrew's component-wise comparison being monotone. That holds within a fixed
 * component count and breaks across a change of it: `1.0` + run 12345 renders
 * `1.0.12345`, and a later `1.0.1` + run 12346 renders `1.0.1.12346`, which
 * sorts BELOW it (12345 vs 1 at position 3). Pinning the count here, in the
 * workflow and in the packaging script keeps the guarantee unconditional.
 */
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SOURCE_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PLATFORM_RE = /^[a-z0-9]+-[a-z0-9]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * A layout path a consumer will join onto an install prefix.
 *
 * Relative, already normalized, no `..`, no backslash, no control character —
 * anything else is a path a formula would resolve outside the prefix it just
 * created.
 */
const LAYOUT_PATH_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._][A-Za-z0-9._-]*)*$/;

function requireLayoutPath(value: unknown, field: string, depth?: number): string {
  // `path.posix.normalize` equality, not just a `..` scan. `libexec/./somawork`
  // passed the old check — three string segments, so it satisfied the depth rule
  // — and normalizes to depth 2, which is exactly the `--version → unknown`
  // failure the depth rule exists to prevent. Our own CLI only ever emits
  // `DEFAULT_LAYOUT`, but a hand-written manifest is what the tap consumes.
  if (
    typeof value !== 'string' ||
    !LAYOUT_PATH_RE.test(value) ||
    value.split('/').includes('..') ||
    value.split('/').includes('.') ||
    path.posix.normalize(value) !== value
  ) {
    throw new ManifestError(`manifest layout ${field} is not a safe, normalized relative path`);
  }
  if (depth !== undefined && value.split('/').length !== depth) {
    throw new ManifestError(`manifest layout ${field} must be ${depth} path segments deep`);
  }
  return value;
}

function requireMatch(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new ManifestError(`manifest ${field} is not a valid ${field}`);
  }
  return value;
}

/** The canonical asset filename. Derived here so nothing else may invent one. */
export function assetFilename(packageName: string, version: string, platform: string): string {
  return `${packageName}-${version}-${platform}.tar.gz`;
}

/**
 * Validate one release description and render it as JSON.
 *
 * Pure: same input, same bytes, no I/O. The key order below is the document's
 * order — `JSON.stringify` preserves insertion order for string keys, which is
 * what makes a re-render byte-identical.
 */
export function renderManifest(input: ManifestInput): string {
  const version = requireMatch(input.version, VERSION_RE, 'version');
  const tag = requireMatch(input.tag, TAG_RE, 'tag');
  const sourceSha = requireMatch(input.sourceSha, SOURCE_SHA_RE, 'sourceSha');
  const platform = requireMatch(input.platform, PLATFORM_RE, 'platform');
  const minimumNode = requireMatch(input.minimumNode, SEMVER_RE, 'minimumNode');

  if (input.channel !== 'preview' && input.channel !== 'stable') {
    throw new ManifestError('manifest channel must be "preview" or "stable"');
  }
  if (!Number.isInteger(input.layoutVersion) || input.layoutVersion < 1) {
    throw new ManifestError('manifest layoutVersion must be a positive integer');
  }
  if (!Array.isArray(input.assets) || input.assets.length !== EXPECTED_ASSETS.length) {
    throw new ManifestError(`manifest must describe exactly ${EXPECTED_ASSETS.length} assets`);
  }

  // Asset URLs are bound to this release, not merely to "an https URL that ends
  // in the right filename". Without this, a manifest could point every asset at
  // another host, or at a different tag of this repository, and still validate —
  // the sha256 pin bounds the damage but the document would be lying about where
  // its bytes live.
  if (typeof input.baseUrl !== 'string') throw new ManifestError('manifest baseUrl must be a string');
  const baseUrl = input.baseUrl.replace(/\/+$/, '');
  // Exact equality with the canonical origin, not a suffix test: any host can
  // end a path in the tag.
  if (baseUrl !== releaseBaseUrl(tag)) {
    throw new ManifestError(`manifest baseUrl must be ${releaseBaseUrl(tag)}`);
  }

  const layout = validateLayout(input.layout);

  const assets = input.assets.map((asset, index) => {
    const expected = EXPECTED_ASSETS[index];
    if (asset.package !== expected.package) {
      throw new ManifestError(`manifest asset ${index} must be "${expected.package}"`);
    }
    if ((asset.profile ?? null) !== expected.profile) {
      throw new ManifestError(`manifest asset "${expected.package}" must install profile ${String(expected.profile)}`);
    }
    const filename = assetFilename(expected.package, version, platform);
    if (asset.filename !== filename) {
      throw new ManifestError(`manifest asset "${expected.package}" filename must be ${filename}`);
    }
    const sha256 = requireMatch(asset.sha256, SHA256_RE, 'sha256');
    if (asset.url !== `${baseUrl}/${filename}`) {
      throw new ManifestError(`manifest asset "${expected.package}" url must be ${baseUrl}/${filename}`);
    }
    if (!Number.isInteger(asset.bytes) || asset.bytes <= 0) {
      throw new ManifestError(`manifest asset "${expected.package}" bytes must be a positive integer`);
    }
    return {
      package: expected.package,
      profile: expected.profile,
      filename,
      url: asset.url,
      sha256,
      bytes: asset.bytes,
    };
  });

  const document = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    layoutVersion: input.layoutVersion,
    channel: input.channel,
    version,
    tag,
    sourceSha,
    platform,
    minimumNode,
    baseUrl,
    layout,
    assets,
  };

  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Validate the layout block, path by path.
 *
 * The controller entry's *depth* is checked, not just its shape: three segments
 * (`libexec/bin/somawork`) is what makes `__dirname/../../package.json` resolve
 * to the manifest at the tree root. A two-segment entry would install fine and
 * then print `unknown` for `--version`, which is exactly the counterfactual this
 * layout exists to avoid.
 */
function validateLayout(layout: unknown): ManifestLayout {
  if (layout === null || typeof layout !== 'object') throw new ManifestError('manifest layout is missing');
  const value = layout as Partial<ManifestLayout>;
  if (value.install !== 'prefix') throw new ManifestError('manifest layout install mode must be "prefix"');
  if (value.controller === null || typeof value.controller !== 'object') {
    throw new ManifestError('manifest layout controller is missing');
  }
  if (value.runtime === null || typeof value.runtime !== 'object') {
    throw new ManifestError('manifest layout runtime is missing');
  }
  return {
    install: 'prefix',
    controller: {
      entry: requireLayoutPath(value.controller.entry, 'controller.entry', 3),
      manifest: requireLayoutPath(value.controller.manifest, 'controller.manifest', 1),
    },
    runtime: {
      marker: requireLayoutPath(value.runtime.marker, 'runtime.marker', 1),
      manifest: requireLayoutPath(value.runtime.manifest, 'runtime.manifest', 1),
      controllerEntry: requireLayoutPath(value.runtime.controllerEntry, 'runtime.controllerEntry'),
      supervisor: requireLayoutPath(value.runtime.supervisor, 'runtime.supervisor'),
      daemon: requireLayoutPath(value.runtime.daemon, 'runtime.daemon'),
    },
  };
}

/** Hash and measure one built asset. The only file this module reads. */
export function describeAsset(file: string): { sha256: string; bytes: number } {
  const bytes = fs.statSync(file).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return { sha256, bytes };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface AssetArgument {
  package: string;
  profile: RuntimeProfile | null;
  file: string;
}

function parseAssetArgument(raw: string): AssetArgument {
  const fields = new Map<string, string>();
  for (const part of raw.split(',')) {
    const at = part.indexOf('=');
    if (at <= 0) throw new ManifestError('--asset takes package=<name>,profile=<none|preview|production>,file=<path>');
    fields.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  const packageName = fields.get('package');
  const profile = fields.get('profile');
  const file = fields.get('file');
  if (packageName === undefined || profile === undefined || file === undefined) {
    throw new ManifestError('--asset takes package=<name>,profile=<none|preview|production>,file=<path>');
  }
  if (profile !== 'none' && profile !== 'preview' && profile !== 'production') {
    throw new ManifestError('--asset profile must be none, preview, or production');
  }
  return { package: packageName, profile: profile === 'none' ? null : profile, file };
}

function parseArgv(argv: string[]): { input: ManifestInput; out: string | null } {
  const values = new Map<string, string>();
  const assets: AssetArgument[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new ManifestError(`unexpected argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new ManifestError(`${flag} requires a value`);
    index += 1;
    if (flag === '--asset') assets.push(parseAssetArgument(value));
    else values.set(flag, value);
  }

  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw new ManifestError(`${flag} is required`);
    return value;
  };

  const version = required('--version');
  const platform = values.get('--platform') ?? PLATFORM;
  // Accepted for explicitness at the call site; `renderManifest` is what decides
  // whether it is the canonical base for this tag.
  const baseUrl = (values.get('--base-url') ?? releaseBaseUrl(required('--tag'))).replace(/\/+$/, '');

  const channel = required('--channel');
  if (channel !== 'preview' && channel !== 'stable') throw new ManifestError('--channel must be preview or stable');

  const described = assets.map((asset) => {
    const filename = assetFilename(asset.package, version, platform);
    if (path.basename(asset.file) !== filename) {
      throw new ManifestError(`asset file for "${asset.package}" must be named ${filename}`);
    }
    const { sha256, bytes } = describeAsset(asset.file);
    return { package: asset.package, profile: asset.profile, filename, url: `${baseUrl}/${filename}`, sha256, bytes };
  });

  return {
    input: {
      version,
      channel,
      tag: required('--tag'),
      sourceSha: required('--source-sha'),
      platform,
      minimumNode: values.get('--minimum-node') ?? MINIMUM_NODE,
      layoutVersion: Number(values.get('--layout-version') ?? RUNTIME_LAYOUT_VERSION),
      baseUrl,
      // The canonical layout lives here, next to the depth rule that constrains
      // it, so the packaging script cannot publish a shape nothing validated.
      layout: DEFAULT_LAYOUT,
      assets: described,
    },
    out: values.get('--out') ?? null,
  };
}

function main(argv: string[]): number {
  let rendered: string;
  let out: string | null;
  try {
    const parsed = parseArgv(argv);
    out = parsed.out;
    rendered = renderManifest(parsed.input);
  } catch (error) {
    process.stderr.write(`render-manifest: ${error instanceof ManifestError ? error.message : 'invalid input'}\n`);
    return 1;
  }
  if (out === null) process.stdout.write(rendered);
  else fs.writeFileSync(out, rendered);
  return 0;
}

/**
 * Run only when this file is the process entry.
 *
 * Matched on `process.argv[1]` rather than `require.main === module`: the
 * contract test imports {@link renderManifest} directly, and `require`/`module`
 * do not exist in that loader.
 */
if (process.argv[1] !== undefined && /render-manifest\.[cm]?[jt]s$/.test(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
