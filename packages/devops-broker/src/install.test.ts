import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// install.sh / uninstall.sh in test mode: SOMA_DEVOPS_INSTALL_TEST=1 + --prefix <tmp> places every target under
// the prefix, and the shims in __fixtures__/install-shims stand in for dscl, dseditgroup, launchctl, chown, sudo,
// otool and curl (each logs its argv to $SHIM_LOG). Every test installs from its own copy of the checkout (the
// broker and process-shared builds, the scripts, a pins.txt for the test's fake release archives), so the checkout
// trust rules see files owned by the test user and not by the fake bot user. Build the devops packages first, as
// for cli.test.ts.

const WT = path.resolve(__dirname, '../../..');
const INSTALL_SRC = path.resolve(__dirname, '../install');
const README = path.join(INSTALL_SRC, 'README.md');
const REAL_PINS = path.join(INSTALL_SRC, 'pins.txt');
const SHIMS = path.join(__dirname, '__fixtures__/install-shims');
const SHIM_NAMES = ['dscl', 'dseditgroup', 'launchctl', 'chown', 'sudo', 'otool', 'curl'];
const BUILT = [
  'packages/devops-broker/dist/cli.js',
  'packages/process-shared/dist/devops/protocol.js',
  'packages/process-shared/dist/devops/gh-policy.js',
];

const LIBEXEC = '/usr/local/libexec/soma-devops';
const APP = `${LIBEXEC}/app/node_modules/@soma`;
const CLI = `${APP}/devops-broker/dist/cli.js`;
const DATA = '/usr/local/var/soma-devops';
const LOGS = '/usr/local/var/log/soma-devops';
const ARCHIVE_DIR = '/usr/local/var/soma-devops-archive';
const PLIST = '/Library/LaunchDaemons/ai.soma.devops-broker.plist';
const LABEL = 'ai.soma.devops-broker';
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
/** The dscl shim is seeded with UID 499 and GID 498 taken, so the installer must settle on 497. */
const BROKER_ID = '497';
/** The fake bot user; never the uid that owns the test's checkout copy. */
const BOT_UID = '9001';
const NODE_VERSION = '24.22.1';
/** Secrets the test policy (writePolicy) needs: one per gh account, one per Cloudflare env, the broker's Slack app. */
const SECRETS = [
  ['gh', 'member'],
  ['gh', 'org-admin'],
  ['cf', 'dev'],
  ['slack', 'broker-app'],
];
const ZERO_ID = '0'.repeat(32);
const ONE_ID = '1'.repeat(32);

const GH_VERSION = (() => {
  const text = fs.readFileSync(path.join(WT, 'packages/process-shared/dist/devops/gh-policy.js'), 'utf8');
  const match = /^exports\.GH_POLICY_GH_VERSION = '([0-9.]+)';$/m.exec(text);
  if (!match) throw new Error('GH_POLICY_GH_VERSION not found in the process-shared build');
  return match[1];
})();

/** The installer's architecture rule: Apple silicon (even under Rosetta) = arm64. */
const ARCH =
  spawnSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).stdout?.trim() === '1'
    ? 'arm64'
    : 'x64';

function nodeFile(arch: string, version = NODE_VERSION): string {
  return `node-v${version}-darwin-${arch}.tar.gz`;
}

function ghFile(arch: string, version = GH_VERSION): string {
  return `gh_${version}_macOS_${arch === 'x64' ? 'amd64' : 'arm64'}.zip`;
}

let fixtures: string;
let work: string;
let repo: string;
let prefix: string;
let shimDir: string;
let state: string;
let shimLog: string;

function writeExecutable(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o755);
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** A release archive holding one executable at <archive name minus extension>/bin/<tool>. */
function makeArchive(dir: string, name: string, tool: 'node' | 'gh', script: string): string {
  const top = name.replace(/\.tar\.gz$|\.zip$/, '');
  const build = fs.mkdtempSync(path.join(fixtures, 'build-'));
  writeExecutable(path.join(build, top, 'bin', tool), script);
  const archive = path.join(dir, name);
  const args = name.endsWith('.zip') ? ['--format', 'zip', '-cf', archive] : ['-czf', archive];
  const result = spawnSync('/usr/bin/tar', [...args, `${top}/bin/${tool}`], { cwd: build, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`);
  return archive;
}

/** Stand-in for the official node: reports the pinned version, otherwise runs the node running this test. */
function fakeNodeScript(version = NODE_VERSION): string {
  return `#!/bin/sh\nif [ "$1" = --version ]; then echo v${version}; exit 0; fi\nexec '${process.execPath}' "$@"\n`;
}

function fakeGhScript(version = GH_VERSION): string {
  return `#!/bin/sh\necho 'gh version ${version} (2026-09-30)'\necho 'https://github.com/cli/cli/releases'\n`;
}

interface Pin {
  tool: 'node' | 'gh';
  arch: string;
  version: string;
  sha: string;
  file: string;
}

/** The fake archives for both architectures, and the pins that accept them. */
function releaseFixtures(dir: string, nodeScript = fakeNodeScript(), ghScript = fakeGhScript()): Pin[] {
  fs.mkdirSync(dir, { recursive: true });
  const pins: Pin[] = [];
  for (const arch of ['arm64', 'x64']) {
    const node = makeArchive(dir, nodeFile(arch), 'node', nodeScript);
    pins.push({ tool: 'node', arch, version: NODE_VERSION, sha: sha256(node), file: nodeFile(arch) });
    const gh = makeArchive(dir, ghFile(arch), 'gh', ghScript);
    pins.push({ tool: 'gh', arch, version: GH_VERSION, sha: sha256(gh), file: ghFile(arch) });
  }
  return pins;
}

let defaultPins: Pin[];

function writePins(pins: Pin[]): void {
  const lines = pins.map((p) => `${p.tool} ${p.arch} ${p.version} ${p.sha} ${p.file}`);
  fs.writeFileSync(path.join(repo, 'packages/devops-broker/install/pins.txt'), `# test pins\n${lines.join('\n')}\n`);
}

function archive(tool: 'node' | 'gh'): string {
  return path.join(fixtures, 'release', tool === 'node' ? nodeFile(ARCH) : ghFile(ARCH));
}

function seedRecord(kind: 'Users' | 'Groups', name: string, attributes: Record<string, string>): void {
  const dir = path.join(state, kind, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [key, value] of Object.entries(attributes)) fs.writeFileSync(path.join(dir, key), `${value}\n`);
}

beforeAll(() => {
  for (const file of BUILT) {
    if (!fs.existsSync(path.join(WT, file))) throw new Error(`${file} is missing — build the devops packages first`);
  }
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devops-install-fixtures-')));
  defaultPins = releaseFixtures(path.join(fixtures, 'release'));
});

afterAll(() => {
  if (fixtures) fs.rmSync(fixtures, { recursive: true, force: true });
});

beforeEach(() => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devops-install-')));
  repo = path.join(work, 'repo');
  prefix = path.join(work, 'root');
  shimDir = path.join(work, 'shims');
  state = path.join(work, 'shim-state');
  shimLog = path.join(work, 'shim.log');
  for (const pkg of ['devops-broker', 'process-shared']) {
    for (const entry of ['package.json', 'dist']) {
      fs.cpSync(path.join(WT, 'packages', pkg, entry), path.join(repo, 'packages', pkg, entry), { recursive: true });
    }
  }
  for (const name of ['install.sh', 'uninstall.sh', 'ai.soma.devops-broker.plist.template']) {
    fs.cpSync(path.join(INSTALL_SRC, name), path.join(repo, 'packages/devops-broker/install', name));
  }
  writePins(defaultPins);
  fs.mkdirSync(prefix);
  fs.chmodSync(prefix, 0o755);
  fs.mkdirSync(shimDir);
  for (const name of SHIM_NAMES) {
    fs.copyFileSync(path.join(SHIMS, name), path.join(shimDir, name));
    fs.chmodSync(path.join(shimDir, name), 0o755);
  }
  fs.writeFileSync(shimLog, '');
  seedRecord('Users', 'root', { UniqueID: '0', PrimaryGroupID: '0' });
  seedRecord('Users', '_taken', { UniqueID: '499', PrimaryGroupID: '499' });
  seedRecord('Users', 'alice', { UniqueID: BOT_UID, PrimaryGroupID: '20', NFSHomeDirectory: '/Users/alice' });
  seedRecord('Groups', 'wheel', { PrimaryGroupID: '0' });
  seedRecord('Groups', 'staff', { PrimaryGroupID: '20' });
  seedRecord('Groups', '_taken', { PrimaryGroupID: '498' });
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  out: string;
}

function runScript(script: string, args: string[], env: Record<string, string> = {}): Run {
  const result = spawnSync('/bin/bash', [path.join(repo, 'packages/devops-broker/install', script), ...args], {
    encoding: 'utf8',
    timeout: 90_000,
    env: {
      PATH: `${shimDir}:${SYSTEM_PATH}`,
      HOME: work,
      TMPDIR: work,
      SHIM_LOG: shimLog,
      SHIM_STATE: state,
      SOMA_DEVOPS_INSTALL_TEST: '1',
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, out: result.stdout + result.stderr };
}

const WITH_ARCHIVES = (): string[] => ['--node-archive', archive('node'), '--gh-archive', archive('gh')];

function install(extra: string[] = WITH_ARCHIVES(), env: Record<string, string> = {}): Run {
  return runScript('install.sh', ['--prefix', prefix, '--bot-user', 'alice', ...extra], env);
}

function at(target: string): string {
  return path.join(prefix, target);
}

function mode(target: string): number {
  return fs.lstatSync(at(target)).mode & 0o7777;
}

function logLines(): string[] {
  return fs.readFileSync(shimLog, 'utf8').split('\n').filter(Boolean);
}

function fails(run: Run): string[] {
  return run.out.split('\n').filter((line) => line.startsWith('FAIL'));
}

function plist(target: string): Record<string, unknown> {
  const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', target], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

/** Every entry under the prefix: type, mode, relative path and, for files, a content hash. */
function snapshot(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const st = fs.lstatSync(file);
      const rel = path.relative(prefix, file);
      const bits = (st.mode & 0o7777).toString(8);
      if (st.isDirectory()) {
        out.push(`d ${bits} ${rel}`);
        walk(file);
      } else if (st.isFile()) {
        out.push(`f ${bits} ${rel} ${sha256(file)}`);
      } else {
        out.push(`? ${bits} ${rel}`);
      }
    }
  };
  walk(prefix);
  return out;
}

/** No code, no stage, no data tree, no directory records, no daemon. */
function expectNothingInstalled(): void {
  expect(fs.existsSync(at(LIBEXEC))).toBe(false);
  const libexec = at('/usr/local/libexec');
  if (fs.existsSync(libexec)) expect(fs.readdirSync(libexec)).toEqual([]);
  expect(fs.existsSync(at(DATA))).toBe(false);
  expect(logLines().filter((line) => /^dscl \. -create|^dseditgroup -o edit|^launchctl b/.test(line))).toEqual([]);
}

function readmeTemplate(): string {
  const readme = fs.readFileSync(README, 'utf8');
  const match = /<!-- policy-template:begin -->\n```json\n([\s\S]*?)```\n<!-- policy-template:end -->/.exec(readme);
  if (!match) throw new Error('README.md has no policy template block');
  return match[1];
}

function writePolicy(): void {
  const policy = {
    admins: ['U000ADMIN'],
    gh: {
      org: 'example-org',
      accounts: {
        member: { login: 'alice', class: 'member' },
        'org-admin': { login: 'alice-admin', class: 'org-admin' },
      },
      restWriteAllowlist: [],
    },
    cloudflare: {
      dev: {
        accountId: ZERO_ID,
        zones: { 'example.com': ONE_ID },
        permissionGroups: { read: ['dns-read-group'], edit: ['dns-edit-group'] },
        defaultTtl: '1h',
        maxTtl: '71h',
        ipCondition: false,
      },
    },
    approvalTimeout: '5m',
  };
  const file = at(`${DATA}/policy.json`);
  fs.writeFileSync(`${file}.new`, JSON.stringify(policy, null, 2));
  fs.renameSync(`${file}.new`, file);
}

function ingest(kind: string, name: string): void {
  const result = spawnSync(process.execPath, [at(CLI), 'ingest', kind, name, '--root', at(DATA)], {
    input: 'test-secret-0001\n',
    encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}

/** Install, fill the policy, ingest every secret, start the daemon. */
function installAndStart(): void {
  expect(install().status).toBe(3);
  writePolicy();
  for (const [kind, name] of SECRETS) ingest(kind, name);
  const started = install();
  expect(fails(started)).toEqual([]);
  expect(started.status).toBe(0);
}

/** One install run spawns a few hundred short processes; several runs per test. */
const SLOW = { timeout: 180_000 };

describe.skipIf(process.platform !== 'darwin')('devops-broker install.sh', SLOW, () => {
  it('installs verified release binaries, the code, data tree, LaunchDaemon and template policy, then stops', () => {
    const result = install();
    expect(fails(result)).toEqual([]);
    expect(result.out).not.toMatch(/stopped at line/);
    expect(result.status).toBe(3);
    expect(result.out).toMatch(/daemon NOT started/);
    expect(result.out).toMatch(/^ {2}\| check-policy exit 1$/m);

    // Binaries: the archive members, nothing from a PATH; checked on the staged copy; versions run as nobody.
    expect(fs.readFileSync(at(`${LIBEXEC}/node`), 'utf8')).toBe(fakeNodeScript());
    expect(fs.readFileSync(at(`${LIBEXEC}/gh`), 'utf8')).toBe(fakeGhScript());
    expect(mode(`${LIBEXEC}/node`)).toBe(0o755);
    expect(mode(`${LIBEXEC}/gh`)).toBe(0o755);
    const log = logLines();
    const stage = at('/usr/local/libexec/.soma-devops.new');
    expect(log).toContain(`otool -L ${stage}/node`);
    expect(log).toContain(`otool -L ${stage}/gh`);
    const probe = (tool: string) =>
      new RegExp(
        `^sudo -u nobody -- /usr/bin/env -i PATH=${SYSTEM_PATH} HOME=/var/empty .*${at('/usr/local/libexec')}/\\.soma-devops-probe\\.[A-Za-z0-9]+/${tool} --version$`,
      );
    expect(log.filter((line) => probe('node').test(line))).toHaveLength(1);
    expect(log.filter((line) => probe('gh').test(line))).toHaveLength(1);
    expect(log.filter((line) => line.startsWith('curl'))).toEqual([]);
    expect(fs.readdirSync(at('/usr/local/libexec'))).toEqual(['soma-devops']);

    // Code: copies (no symlinks), dirs 0755, files 0644, only the two packages.
    expect(fs.readdirSync(at(LIBEXEC)).sort()).toEqual(['app', 'gh', 'node']);
    expect(fs.readdirSync(at(`${LIBEXEC}/app/node_modules`))).toEqual(['@soma']);
    expect(fs.readdirSync(at(APP)).sort()).toEqual(['devops-broker', 'process-shared']);
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        const st = fs.lstatSync(file);
        expect(st.isSymbolicLink()).toBe(false);
        if (st.isDirectory()) {
          expect(st.mode & 0o7777).toBe(0o755);
          walk(file);
        } else if (name !== 'node' && name !== 'gh') {
          expect(st.mode & 0o7777).toBe(0o644);
        }
      }
    };
    walk(at(LIBEXEC));
    expect(mode(LIBEXEC)).toBe(0o755);
    expect(log).toContain(`chown -R root:wheel ${stage}`);

    // Data tree: the root is root:soma-devops; what lives inside it belongs to the broker.
    expect(mode(DATA)).toBe(0o750);
    for (const dir of ['secrets', 'secrets/gh', 'secrets/cf', 'secrets/slack', 'state']) {
      expect(mode(`${DATA}/${dir}`)).toBe(0o700);
    }
    expect(mode(`${DATA}/run`)).toBe(0o750);
    expect(mode(LOGS)).toBe(0o700);
    expect(mode(`${DATA}/policy.json`)).toBe(0o644);
    expect(fs.readFileSync(at(`${DATA}/policy.json`), 'utf8')).toBe(readmeTemplate());
    expect(log).toContain(`chown -h root:${BROKER_ID} ${at(DATA)}`);
    for (const dir of [`${DATA}/secrets`, `${DATA}/state`, `${DATA}/run`, LOGS]) {
      expect(log).toContain(`chown -h ${BROKER_ID}:${BROKER_ID} ${at(dir)}`);
    }
    // Inside a broker-owned directory root creates nothing and changes no owner: the broker user makes these.
    for (const kind of ['gh', 'cf', 'slack']) {
      expect(log).toContain(`sudo -u _somadevops -- /bin/mkdir -m 0700 ${at(`${DATA}/secrets/${kind}`)}`);
      expect(log.some((line) => line.startsWith('chown') && line.endsWith(`/secrets/${kind}`))).toBe(false);
    }
    expect(log).toContain(`chown -h root:wheel ${at(`${DATA}/policy.json`)}`);

    // LaunchDaemon: the production paths (the prefix only moves the files), root:wheel 0644; not bootstrapped.
    expect(mode(PLIST)).toBe(0o644);
    expect(plist(at(PLIST))).toEqual({
      Label: LABEL,
      UserName: '_somadevops',
      GroupName: 'soma-devops',
      ProgramArguments: [`${LIBEXEC}/node`, CLI, 'serve', '--gh', `${LIBEXEC}/gh`],
      EnvironmentVariables: { SOMA_DEVOPS_ROOT: DATA },
      WorkingDirectory: '/',
      Umask: 63,
      ExitTimeOut: 90,
      KeepAlive: true,
      RunAtLoad: true,
      ThrottleInterval: 10,
      StandardOutPath: `${LOGS}/broker.out.log`,
      StandardErrorPath: `${LOGS}/broker.err.log`,
    });
    expect(log).toContain(`dscl . -create /Groups/soma-devops PrimaryGroupID ${BROKER_ID}`);
    expect(log).toContain(`dscl . -create /Users/_somadevops UniqueID ${BROKER_ID}`);
    expect(log).toContain(`dscl . -create /Users/_somadevops PrimaryGroupID ${BROKER_ID}`);
    expect(log).toContain('dscl . -create /Users/_somadevops UserShell /usr/bin/false');
    expect(log).toContain('dscl . -create /Users/_somadevops NFSHomeDirectory /var/empty');
    expect(log).toContain('dseditgroup -o edit -a alice -t user soma-devops');
    expect(log.some((line) => line.startsWith('launchctl bootstrap'))).toBe(false);
    expect(log).toContain(
      `sudo -u _somadevops -- /usr/bin/env -i PATH=${SYSTEM_PATH} HOME=/var/empty ${at(`${LIBEXEC}/node`)} ${at(CLI)} check-policy --root ${at(DATA)}`,
    );

    expect(result.stdout).toMatch(new RegExp(`^OK +root:soma-devops 0750 +${at(DATA)}$`, 'm'));
    expect(result.stdout).toMatch(new RegExp(`^OK .*${at(`${DATA}/policy.json`)}$`, 'm'));
    expect(result.stdout).toMatch(new RegExp(`^OK .*${at(PLIST)}$`, 'm'));
    expect(result.stdout).toMatch(/^OK +members of soma-devops +alice$/m);
    expect(result.out).not.toMatch(/^WARN/m);
    expect(result.out).toMatch(/^alice was just added to soma-devops\.$/m);
    expect(result.out).toMatch(/^Restart the soma bot \(alice\)/m);
  });

  it('downloads the pinned archives over https when none are given', () => {
    const result = install([], { SHIM_DOWNLOADS: path.join(fixtures, 'release') });
    expect(fails(result)).toEqual([]);
    expect(result.status).toBe(3);
    const curl = logLines().filter((line) => line.startsWith('curl'));
    expect(curl).toHaveLength(2);
    for (const line of curl) expect(line).toMatch(/^curl --proto =https --tlsv1\.2 /);
    expect(curl[0]).toMatch(new RegExp(` https://nodejs\\.org/dist/v${NODE_VERSION}/${nodeFile(ARCH)}$`));
    expect(curl[1]).toMatch(
      new RegExp(` https://github\\.com/cli/cli/releases/download/v${GH_VERSION}/${ghFile(ARCH)}$`),
    );
    expect(fs.readFileSync(at(`${LIBEXEC}/node`), 'utf8')).toBe(fakeNodeScript());
  });

  it('refuses an archive whose sha256 is not the pinned one and installs nothing', () => {
    writePins(defaultPins.map((p) => (p.tool === 'node' ? { ...p, sha: 'f'.repeat(64) } : p)));
    const result = install();
    expect(result.status).toBe(1);
    expect(fails(result)).toEqual([
      expect.stringMatching(new RegExp(`^FAIL node archive ${nodeFile(ARCH)} has sha256 [0-9a-f]{64}; pins\\.txt`)),
    ]);
    expectNothingInstalled();
  });

  it('refuses a pins.txt whose gh version is not GH_POLICY_GH_VERSION', () => {
    writePins(
      defaultPins.map((p) => (p.tool === 'gh' ? { ...p, version: '2.101.0', file: ghFile(p.arch, '2.101.0') } : p)),
    );
    const result = install();
    expect(result.status).toBe(1);
    expect(result.out).toMatch(new RegExp(`^FAIL .*pins gh 2\\.101\\.0.*GH_POLICY_GH_VERSION is ${GH_VERSION}`, 'm'));
    expectNothingInstalled();
  });

  it('refuses a binary that reports another version (run as nobody) and installs nothing', () => {
    const other = path.join(work, 'other-release');
    writePins(releaseFixtures(other, fakeNodeScript(), fakeGhScript('2.101.0')));
    const result = install([
      '--node-archive',
      path.join(other, nodeFile(ARCH)),
      '--gh-archive',
      path.join(other, ghFile(ARCH)),
    ]);
    expect(result.status).toBe(1);
    expect(result.out).toMatch(
      new RegExp(`^FAIL gh .*reports "gh version 2\\.101\\.0.*expected gh version ${GH_VERSION}`, 'm'),
    );
    expectNothingInstalled();
  });

  it('refuses a node that loads libraries from outside the system (checked on the staged copy)', () => {
    const result = install(WITH_ARCHIVES(), { SHIM_OTOOL_EXTRA: '/opt/homebrew/opt/libuv/lib/libuv.1.dylib' });
    expect(result.status).toBe(1);
    expect(result.out).toMatch(
      /^FAIL node \S*\/\.soma-devops\.new\/node loads libraries from outside .*\/opt\/homebrew\/opt\/libuv\/lib\/libuv\.1\.dylib/m,
    );
    expectNothingInstalled();
  });

  it('refuses a broker build that loads anything but node: built-ins and @soma/process-shared', () => {
    fs.appendFileSync(
      path.join(repo, 'packages/devops-broker/dist/paths.js'),
      '\nrequire("left-pad");\nconst name = "fs";\nrequire(name);\n',
    );
    const result = install();
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/^FAIL .*paths\.js requires 'left-pad'/m);
    expect(result.out).toMatch(/^FAIL .*paths\.js calls require\(\) with something other than a string literal/m);
    expectNothingInstalled();
  });

  it('fails when the bot user owns the checkout', () => {
    seedRecord('Users', 'alice', { UniqueID: String(process.getuid?.() ?? 501) });
    const result = install();
    expect(result.status).toBe(1);
    expect(result.out).toMatch(
      new RegExp(`^FAIL ${repo}/packages/devops-broker/package\\.json .*owned by the bot user`, 'm'),
    );
    expect(result.out).toMatch(new RegExp(`^FAIL ${repo} .*owned by the bot user`, 'm'));
    expectNothingInstalled();
  });

  it('fails on a symlinked package.json and never copies what it points to', () => {
    const secret = path.join(work, 'secret.token');
    fs.writeFileSync(secret, 'zz-secret-marker-0001\n', { mode: 0o600 });
    const pkg = path.join(repo, 'packages/devops-broker/package.json');
    fs.rmSync(pkg);
    fs.symlinkSync(secret, pkg);
    const result = install();
    expect(result.status).toBe(1);
    expect(result.out).toMatch(new RegExp(`^FAIL ${pkg} is a symlink`, 'm'));
    expectNothingInstalled();
    const found = spawnSync('/usr/bin/grep', ['-rl', 'zz-secret-marker', prefix], { encoding: 'utf8' });
    expect(found.stdout).toBe('');
  });

  it('fails on a group-writable or hard-linked file in the checkout', () => {
    const shared = path.join(repo, 'packages/process-shared/dist/devops/protocol.js');
    fs.chmodSync(shared, 0o664);
    const writable = install();
    expect(writable.status).toBe(1);
    expect(writable.out).toMatch(new RegExp(`^FAIL ${shared} .*group- or other-writable`, 'm'));
    expectNothingInstalled();

    fs.chmodSync(shared, 0o644);
    const victim = path.join(work, 'victim');
    fs.writeFileSync(victim, 'zz-secret-marker-0002\n', { mode: 0o600 });
    const linked = path.join(repo, 'packages/devops-broker/dist/extra.js');
    fs.linkSync(victim, linked);
    const hardLinked = install();
    expect(hardLinked.status).toBe(1);
    expect(hardLinked.out).toMatch(new RegExp(`^FAIL ${linked} .*hard link`, 'm'));
    expectNothingInstalled();
  });

  it('refuses to run when SUDO_USER is the bot user', () => {
    const result = install(WITH_ARCHIVES(), { SUDO_USER: 'alice' });
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/^FAIL .*SUDO_USER.*alice.*or pass --operator-is-bot-user .*README "Operator account"/m);
    expectNothingInstalled();
  });

  it('runs from the bot user with --operator-is-bot-user and says so in a checklist WARN', () => {
    const accepted = install([...WITH_ARCHIVES(), '--operator-is-bot-user'], { SUDO_USER: 'alice' });
    expect(fails(accepted)).toEqual([]);
    expect(accepted.status).toBe(3);
    const checklist = accepted.stdout.slice(accepted.stdout.indexOf('== ownership and permissions'));
    expect(checklist).toMatch(/^WARN operator is the bot user \(alice\): .*README "Operator account"/m);

    // From another account the flag changes nothing.
    const other = install([...WITH_ARCHIVES(), '--operator-is-bot-user'], { SUDO_USER: 'operator' });
    expect(fails(other)).toEqual([]);
    expect(other.status).toBe(3);
    expect(other.out).not.toMatch(/^WARN/m);
  });

  it('refuses the removed --node/--gh path options', () => {
    const result = install(['--node', process.execPath]);
    expect(result.status).toBe(2);
    expect(result.out).toMatch(/--node was removed/);
  });

  it('refuses --prefix without SOMA_DEVOPS_INSTALL_TEST=1', () => {
    const result = install(WITH_ARCHIVES(), { SOMA_DEVOPS_INSTALL_TEST: '' });
    expect(result.status).toBe(2);
    expect(result.out).toMatch(/SOMA_DEVOPS_INSTALL_TEST=1/);
    expect(fs.readdirSync(prefix)).toEqual([]);
    expect(logLines()).toEqual([]);
  });

  it('fails on a group-writable ancestor of a target and installs no code', () => {
    fs.mkdirSync(at('/usr/local/libexec'), { recursive: true });
    fs.chmodSync(at('/usr/local/libexec'), 0o775);
    const result = install();
    expect(result.status).toBe(1);
    expect(result.out).toMatch(new RegExp(`^FAIL ${at('/usr/local/libexec')} `, 'm'));
    expectNothingInstalled();
  });

  it('fails while the bot user has a Slack CLI login, unless --accept-slack-cli-login (then a checklist WARN)', () => {
    const credentials = at('/Users/alice/.slack/credentials.json');
    fs.mkdirSync(path.dirname(credentials), { recursive: true });
    fs.writeFileSync(credentials, '{}\n');
    const refused = install();
    expect(refused.status).toBe(1);
    expect(fails(refused)).toEqual([
      expect.stringMatching(new RegExp(`^FAIL ${credentials} exists: .*--accept-slack-cli-login`)),
    ]);
    expectNothingInstalled();

    const accepted = install([...WITH_ARCHIVES(), '--accept-slack-cli-login']);
    expect(fails(accepted)).toEqual([]);
    expect(accepted.status).toBe(3);
    const checklist = accepted.stdout.slice(accepted.stdout.indexOf('== ownership and permissions'));
    expect(checklist).toMatch(new RegExp(`^WARN ${credentials} exists .*--accept-slack-cli-login`, 'm'));
  });

  it('starts the daemon only once policy.json is filled and every secret is in place, and lists the ingest commands', () => {
    expect(install().status).toBe(3);
    writePolicy();

    const missing = install();
    expect(fails(missing)).toEqual([]);
    expect(missing.status).toBe(3);
    for (const [kind, name] of SECRETS) {
      expect(missing.stdout).toContain(
        `  cd / && pbpaste | sudo -u _somadevops env -i PATH=/usr/bin:/bin HOME=/var/empty ${at(`${LIBEXEC}/node`)} ${at(CLI)} ingest ${kind} ${name} --root ${at(DATA)}; pbcopy </dev/null\n`,
      );
      ingest(kind, name);
    }
    expect(logLines().some((line) => line.startsWith('launchctl bootstrap'))).toBe(false);

    const ready = install();
    expect(fails(ready)).toEqual([]);
    expect(ready.status).toBe(0);
    expect(logLines()).toContain(`launchctl bootstrap system ${at(PLIST)}`);
    expect(ready.stdout).toMatch(/^OK .*secrets\/gh\/member\.token$/m);
    // The checklist runs before the bootstrap.
    expect(ready.stdout.indexOf('== ownership and permissions')).toBeLessThan(
      ready.stdout.indexOf('+ launchctl bootstrap'),
    );

    // Upgrade while loaded: boot out first, then bootstrap the new code.
    const before = logLines().length;
    expect(install().status).toBe(0);
    const upgrade = logLines().slice(before);
    const bootout = upgrade.indexOf(`launchctl bootout system/${LABEL}`);
    const bootstrap = upgrade.indexOf(`launchctl bootstrap system ${at(PLIST)}`);
    expect(bootout).toBeGreaterThanOrEqual(0);
    expect(bootstrap).toBeGreaterThan(bootout);
  });

  it('keeps a started daemon down when the checklist finds an ACL grant, a wrong code mode or owner, or a bad secret', () => {
    installAndStart();
    const uid = process.getuid?.() ?? 501;
    const app = at(`${LIBEXEC}/app`);
    /** One more run: it must fail, list exactly these FAIL lines, and leave the daemon unloaded. */
    const refused = (env: Record<string, string>, expected: RegExp[]): Run => {
      const mark = logLines().length;
      const result = install(WITH_ARCHIVES(), env);
      expect(fails(result)).toEqual(expected.map((re) => expect.stringMatching(re)));
      expect(result.status).toBe(1);
      expect(fs.existsSync(path.join(state, 'launchd', LABEL))).toBe(false);
      expect(
        logLines()
          .slice(mark)
          .filter((line) => line.startsWith('launchctl bootstrap')),
      ).toEqual([]);
      expect(result.stdout).toMatch(new RegExp(`^daemon NOT started: ${expected.length} check\\(s\\) failed$`, 'm'));
      return result;
    };

    // An ACL that lets someone else read a secret or rewrite the policy, with every mode still right: removed, and
    // reported, because whoever it named may already have used it.
    const token = at(`${DATA}/secrets/gh/member.token`);
    const policy = at(`${DATA}/policy.json`);
    for (const file of [token, policy]) {
      const acl = spawnSync('/bin/chmod', ['+a', 'user:nobody allow read,write', file], { encoding: 'utf8' });
      expect(acl.stderr).toBe('');
    }
    const mark = logLines().length;
    refused({}, [
      new RegExp(`^FAIL ${policy} had an ACL that granted access`),
      new RegExp(`^FAIL ${token} had an ACL that granted access`),
    ]);
    expect(logLines().slice(mark)).toContain(`launchctl bootout system/${LABEL}`);
    const left = spawnSync('/usr/bin/find', [at(DATA), '-acl'], { encoding: 'utf8' });
    expect(left.stdout).toBe('');

    // The code tree is checked entry by entry: a file mode, a directory mode, an owner.
    const cli = `${app}/node_modules/@soma/devops-broker/dist/cli.js`;
    refused({ SHIM_CHOWN_TAMPER: '0664:app/node_modules/@soma/devops-broker/dist/cli.js' }, [
      new RegExp(`^FAIL ${cli}: expected root:wheel, dirs 0755, files 0644, one link; found ${uid}:\\d+ 0664 `),
    ]);
    const devops = `${app}/node_modules/@soma/process-shared/dist/devops`;
    refused({ SHIM_CHOWN_TAMPER: '0775:app/node_modules/@soma/process-shared/dist/devops' }, [
      new RegExp(`^FAIL ${devops}: expected root:wheel, dirs 0755, files 0644, one link; found ${uid}:\\d+ 0775 `),
    ]);
    const owner = install(WITH_ARCHIVES(), { SOMA_DEVOPS_INSTALL_TEST_CODE_UID: String(uid + 1) });
    expect(owner.status).toBe(1);
    expect(owner.out).toMatch(
      new RegExp(`^FAIL ${app}: expected root:wheel, dirs 0755, files 0644, one link; found ${uid}:\\d+ 0755 `, 'm'),
    );
    expect(owner.stdout).toMatch(/^daemon NOT started: 1 check\(s\) failed$/m);

    // A secret file someone else left readable.
    fs.writeFileSync(at(`${DATA}/secrets/gh/stray.token`), 'test-secret-0001\n');
    fs.chmodSync(at(`${DATA}/secrets/gh/stray.token`), 0o644);
    refused({}, [
      new RegExp(`^FAIL ${at(`${DATA}/secrets/gh/stray.token`)}: expected _somadevops:soma-devops 0600 .* 0644$`),
    ]);
    fs.rmSync(at(`${DATA}/secrets/gh/stray.token`));

    // An ACL the broker user cannot remove stays a FAIL, named as still there.
    spawnSync('/bin/chmod', ['+a', 'user:nobody allow read', token]);
    const stuck = refused({ SHIM_SUDO_REFUSE: '/bin/chmod' }, [
      new RegExp(`^FAIL ${token} has an ACL that grants access`),
    ]);
    expect(stuck.out).toMatch(/^WARN the broker user could not remove every ACL/m);
  });

  it('is idempotent, and a re-run fails on an extra soma-devops member, a nested group, an unreadable NestedGroups or a hard-linked policy.json', () => {
    expect(install().status).toBe(3);
    const tree = snapshot();
    const before = logLines().length;

    const second = install();
    expect(fails(second)).toEqual([]);
    expect(second.status).toBe(3);
    expect(snapshot()).toEqual(tree);
    const rerun = logLines().slice(before);
    expect(rerun.filter((line) => line.startsWith('dscl . -create'))).toEqual([]);
    expect(rerun.filter((line) => line.startsWith('dseditgroup -o edit'))).toEqual([]);
    expect(rerun.filter((line) => line.includes('/bin/mkdir'))).toEqual([]);

    // Group soma-devops reaches the socket: anyone but the bot user in it fails the checklist.
    const membership = path.join(state, 'Groups/soma-devops/GroupMembership');
    fs.writeFileSync(membership, 'alice mallory\n');
    const member = install();
    expect(member.status).toBe(1);
    expect(fails(member)).toEqual([
      expect.stringMatching(/^FAIL group soma-devops has members other than alice: mallory/),
    ]);
    fs.writeFileSync(membership, 'alice\n');

    // A nested group would let its members in too. Real dscl prints "No such key" and exits 0 when the group has none;
    // the leading newline makes the shim print dscl's multi-line form ("NestedGroups:" then " <uuid>").
    const nested = path.join(state, 'Groups/soma-devops/NestedGroups');
    fs.writeFileSync(nested, '\n ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEF0C\n');
    const nestedMark = logLines().length;
    const nestedRun = install();
    expect(nestedRun.status).toBe(1);
    expect(fails(nestedRun)).toEqual([expect.stringMatching(/^FAIL group soma-devops has nested groups/)]);
    expect(nestedRun.stdout).toMatch(/^daemon NOT started: 1 check\(s\) failed$/m);
    expect(
      logLines()
        .slice(nestedMark)
        .filter((line) => line.startsWith('launchctl bootstrap')),
    ).toEqual([]);
    fs.rmSync(nested);

    // A NestedGroups query that fails is a FAIL, not "no nested groups", even with the bot user alone in the group.
    const unreadableMark = logLines().length;
    const unreadable = install(WITH_ARCHIVES(), { SHIM_DSCL_FAIL_READ: 'NestedGroups' });
    expect(unreadable.status).toBe(1);
    expect(fails(unreadable)).toEqual([
      expect.stringMatching(/^FAIL cannot read the nested groups of group soma-devops \(dscl exit 1\)/),
    ]);
    expect(unreadable.stdout).toMatch(/^daemon NOT started: 1 check\(s\) failed$/m);
    expect(
      logLines()
        .slice(unreadableMark)
        .filter((line) => line.startsWith('launchctl bootstrap')),
    ).toEqual([]);

    // A policy.json with a second name is never chowned or chmodded: that name could be any root-owned file.
    const victim = path.join(work, 'victim');
    fs.writeFileSync(victim, 'zz-secret-marker-0003\n', { mode: 0o600 });
    const policy = at(`${DATA}/policy.json`);
    fs.rmSync(policy);
    fs.linkSync(victim, policy);
    const mark = logLines().length;
    const linked = install();
    expect(linked.status).toBe(1);
    expect(linked.out).toMatch(new RegExp(`^FAIL ${policy} has 2 hard links`, 'm'));
    expect(fs.statSync(victim).mode & 0o777).toBe(0o600);
    expect(
      logLines()
        .slice(mark)
        .filter((line) => line.endsWith(` ${policy}`)),
    ).toEqual([]);
  });

  it('--dry-run prints the actions and changes nothing', () => {
    const result = install([...WITH_ARCHIVES(), '--dry-run']);
    expect(fails(result)).toEqual([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/dry run/);
    expect(result.stdout).toContain(`+ dscl . -create /Users/_somadevops UniqueID ${BROKER_ID}`);
    expect(fs.readdirSync(prefix)).toEqual([]);
    expect(logLines().filter((line) => / -create | -a |^chown |^launchctl b|^curl/.test(line))).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'darwin')('devops-broker uninstall.sh', SLOW, () => {
  function uninstall(extra: string[] = []): Run {
    return runScript('uninstall.sh', ['--prefix', prefix, ...extra]);
  }

  it('refuses --purge-user without --purge and --force-unrevoked without --purge', () => {
    const user = uninstall(['--purge-user']);
    expect(user.status).toBe(2);
    expect(user.out).toMatch(/--purge-user needs --purge/);
    const force = uninstall(['--force-unrevoked']);
    expect(force.status).toBe(2);
    expect(force.out).toMatch(/--force-unrevoked only applies to --purge/);
  });

  it('keeps data by default; --purge refuses on unrevoked leases, then archives the ledger and removes data', () => {
    installAndStart();
    fs.writeFileSync(at(`${DATA}/state/ledger.jsonl`), '{"event":"broker.start"}\n', { mode: 0o600 });
    const leases = {
      leases: {
        'lease-1': { leaseId: 'lease-1', state: 'active' },
        'lease-2': { leaseId: 'lease-2', state: 'revoke_failed' },
        'lease-3': { leaseId: 'lease-3', state: 'revoked' },
      },
    };
    fs.writeFileSync(at(`${DATA}/state/cf-leases.json`), JSON.stringify(leases, null, 2), { mode: 0o600 });

    const plain = uninstall();
    expect(fails(plain)).toEqual([]);
    expect(plain.status).toBe(0);
    expect(logLines()).toContain(`launchctl bootout system/${LABEL}`);
    expect(fs.existsSync(at(PLIST))).toBe(false);
    expect(fs.existsSync(at(LIBEXEC))).toBe(false);
    expect(fs.existsSync(at(`${DATA}/secrets/gh/member.token`))).toBe(true);
    expect(fs.existsSync(at(LOGS))).toBe(true);

    // A lease that may still hold a live Cloudflare token stops the purge before anything changes.
    const mark = logLines().length;
    const refused = uninstall(['--purge']);
    expect(refused.status).toBe(1);
    expect(refused.out).toMatch(/^FAIL 2 Cloudflare lease\(s\) in .*cf-leases\.json are not revoked/m);
    expect(fs.existsSync(at(DATA))).toBe(true);
    expect(fs.existsSync(at(ARCHIVE_DIR))).toBe(false);
    expect(logLines().slice(mark)).toEqual([]);

    const purge = uninstall(['--purge', '--force-unrevoked']);
    expect(fails(purge)).toEqual([]);
    expect(purge.status).toBe(0);
    expect(purge.out).toMatch(/^WARN 2 Cloudflare lease\(s\) are not revoked/m);
    expect(fs.existsSync(at(DATA))).toBe(false);
    expect(fs.existsSync(at(LOGS))).toBe(false);
    const archived = fs.readdirSync(at(ARCHIVE_DIR));
    expect(archived).toEqual([expect.stringMatching(/^ledger-\d{8}T\d{6}Z\.jsonl$/)]);
    expect(fs.readFileSync(at(`${ARCHIVE_DIR}/${archived[0]}`), 'utf8')).toBe('{"event":"broker.start"}\n');
    expect(mode(`${ARCHIVE_DIR}/${archived[0]}`)).toBe(0o600);
    expect(mode(ARCHIVE_DIR)).toBe(0o700);
    expect(logLines()).toContain(`chown root:wheel ${at(ARCHIVE_DIR)}`);
    expect(logLines().filter((line) => line.startsWith('dscl . -delete'))).toEqual([]);

    expect(uninstall(['--purge', '--purge-user']).status).toBe(0);
    expect(logLines()).toContain('dscl . -delete /Users/_somadevops');
    expect(logLines()).toContain('dscl . -delete /Groups/soma-devops');
  });
});

describe('devops-broker install scripts', SLOW, () => {
  it('pin official archives for both architectures, with the gh version the allowlist is written for', () => {
    const rows = fs
      .readFileSync(REAL_PINS, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'))
      .map((line) => line.trim().split(/\s+/));
    expect(rows.map((row) => `${row[0]} ${row[1]}`).sort()).toEqual(['gh arm64', 'gh x64', 'node arm64', 'node x64']);
    for (const [tool, arch, version, sha, file, ...rest] of rows) {
      expect(rest).toEqual([]);
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
      if (tool === 'gh') {
        expect(version).toBe(GH_VERSION);
        expect(file).toBe(ghFile(arch, version));
      } else {
        expect(Number(version.split('.')[0])).toBeGreaterThanOrEqual(22);
        expect(file).toBe(nodeFile(arch, version));
      }
    }
  });

  it('parse with bash -n', () => {
    for (const script of ['install.sh', 'uninstall.sh']) {
      const result = spawnSync('/bin/bash', ['-n', path.join(INSTALL_SRC, script)], { encoding: 'utf8' });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    }
  });

  const shellcheck = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' });
  it.skipIf(shellcheck.status !== 0)('pass shellcheck (skipped when shellcheck is not installed)', () => {
    const files = [
      path.join(INSTALL_SRC, 'install.sh'),
      path.join(INSTALL_SRC, 'uninstall.sh'),
      ...SHIM_NAMES.map((name) => path.join(SHIMS, name)),
    ];
    const result = spawnSync('shellcheck', files, { encoding: 'utf8' });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });
});
