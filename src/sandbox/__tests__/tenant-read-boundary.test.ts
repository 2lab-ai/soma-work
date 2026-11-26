import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CLAUDE_TMP_DIR_NAME,
  ensureClaudeTmpDir,
  type TenantReadBoundaryInput,
  tenantReadBoundary,
} from '../tenant-read-boundary';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-read-')));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function mk(rel: string, file = false): string {
  const p = path.join(ROOT, rel);
  if (file) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
  } else {
    fs.mkdirSync(p, { recursive: true });
  }
  return p;
}

// A host in miniature: the service user's home, a deployment with its data, two users' roots.
const home = mk('home');
mk('home/.ssh');
mk('home/.config/llmux.json', true);
const gitconfig = mk('home/.gitconfig', true);
const cargoBin = mk('home/.cargo/bin');
const install = mk('opt/svc/dev');
const dist = mk('opt/svc/dev/dist');
const nodeModules = mk('opt/svc/dev/node_modules');
mk('opt/svc/dev/.env', true);
mk('opt/svc/dev/config.json', true);
const secrets = mk('opt/svc/dev/secrets');
const dataDir = mk('opt/svc/dev/data');
mk('opt/svc/dev/data/cct-store.json', true);
const ghDir = mk('opt/svc/dev/data/gh');
const ownData = mk('opt/svc/dev/data/U1');
const zwPlugin = mk('opt/svc/dev/plugins/zw');
const envPlugin = mk('opt/svc/dev/plugins/envp');
const grantedSkill = mk('opt/svc/dev/plugins/envp/skills/qa');
const claudeDir = mk('opt/svc/dev/.claude');
const snapshots = mk('opt/svc/dev/.claude/shell-snapshots');
const userRoot = mk('tmp/U1');
const session = mk('tmp/U1/session_1');
const otherRoot = mk('tmp/U2');
const grantRoot = mk('home/lane/qa');

function input(overrides: Partial<TenantReadBoundaryInput> = {}): TenantReadBoundaryInput {
  return {
    platform: 'linux',
    home,
    tmpdir: path.join(ROOT, 'tmp'),
    writeRoots: [session, userRoot],
    workingDirectory: session,
    installDir: install,
    dataDir,
    ownDataDir: ownData,
    claudeConfigDir: claudeDir,
    ghConfigDir: ghDir,
    pluginPaths: [zwPlugin, envPlugin],
    grantedSkillDirs: [grantedSkill],
    denied: [secrets, path.join(home, '.ssh'), envPlugin],
    ...overrides,
  };
}

describe('tenantReadBoundary', () => {
  it('closes the home directory, the deployment, its data, the CLI config and the shared temp directory', () => {
    const { denyRead } = tenantReadBoundary(input());
    expect(denyRead).toEqual(expect.arrayContaining([home, install, dataDir, claudeDir, path.join(ROOT, 'tmp')]));
  });

  it("re-opens the session's own roots and the code it runs, and nothing of the host's data", () => {
    const { allowRead } = tenantReadBoundary(input());
    expect(allowRead).toEqual(
      expect.arrayContaining([session, userRoot, dist, nodeModules, zwPlugin, ownData, gitconfig, cargoBin, snapshots]),
    );
    expect(allowRead).toContain(ghDir);
    for (const closed of [
      otherRoot,
      dataDir,
      path.join(dataDir, 'cct-store.json'),
      path.join(home, '.config'),
      path.join(home, '.ssh'),
      secrets,
      install,
      home,
    ]) {
      expect(allowRead, closed).not.toContain(closed);
    }
  });

  it('never re-opens a path denied on purpose: not the path, nothing inside it, nothing above it', () => {
    const { allowRead } = tenantReadBoundary(input({ writeRoots: [session, userRoot, home] }));
    // The environment plugin (denied without a grant) is a plugin root, yet stays closed.
    expect(allowRead).not.toContain(envPlugin);
    // A write root above a denied path (the home directory holds `.ssh`) is dropped, not re-opened.
    expect(allowRead).not.toContain(home);
    // The skill a grant opens is for the file tools only: the shell keeps the plugin closed.
    expect(allowRead).not.toContain(grantedSkill);
  });

  it('a grant root the session may write is readable by the shell and the file tools', () => {
    const { allowRead, exemptPaths } = tenantReadBoundary(input({ writeRoots: [session, userRoot, grantRoot] }));
    expect(allowRead).toContain(grantRoot);
    expect(exemptPaths).toContain(grantRoot);
  });

  it("lets the file tools through to the plugins, the speaker's own data and a granted skill, nothing else", () => {
    const { exemptPaths } = tenantReadBoundary(input());
    expect(exemptPaths).toEqual(expect.arrayContaining([dist, zwPlugin, ownData, grantedSkill]));
    for (const closed of [envPlugin, dataDir, ghDir, home, install, otherRoot, '/']) {
      expect(exemptPaths, closed).not.toContain(closed);
    }
  });

  it('skips what is not there', () => {
    const { allowRead, exemptPaths } = tenantReadBoundary(
      input({ ownDataDir: path.join(dataDir, 'U-none'), ghConfigDir: path.join(ROOT, 'nope') }),
    );
    expect(allowRead).not.toContain(path.join(dataDir, 'U-none'));
    expect(exemptPaths).not.toContain(path.join(dataDir, 'U-none'));
    expect(allowRead).not.toContain(path.join(ROOT, 'nope'));
    expect(allowRead).not.toContain(path.join(home, '.rustup'));
  });

  it('macOS: the shell lists use real paths, the file-tool exemptions both spellings of /tmp', () => {
    const fileSystem = {
      exists: () => true,
      realpath: (p: string) => (p === '/tmp' || p.startsWith('/tmp/') ? `/private${p}` : p),
    };
    const { denyRead, allowRead, exemptPaths } = tenantReadBoundary({
      platform: 'darwin',
      home: '/Users/svc',
      tmpdir: '/var/folders/ab/T',
      writeRoots: ['/tmp/U1/session_1', '/tmp/U1'],
      workingDirectory: '/tmp/U1/session_1',
      installDir: '/opt/svc/dev',
      dataDir: '/opt/svc/dev/data',
      ownDataDir: '/opt/svc/dev/data/U1',
      claudeConfigDir: '/opt/svc/dev/.claude',
      pluginPaths: ['/tmp/U1/plugin-copy'],
      grantedSkillDirs: [],
      denied: ['/opt/svc/dev/secrets'],
      fileSystem,
    });
    expect(denyRead).toEqual(expect.arrayContaining(['/Users', '/opt', '/private/tmp', '/private/var/folders']));
    // `/tmp` itself is a link: denying it would close every `/tmp/...` spelling, the user's root included.
    expect(denyRead).not.toContain('/tmp');
    expect(allowRead).toEqual(
      expect.arrayContaining(['/private/tmp/U1', '/private/tmp/U1/session_1', '/opt/homebrew']),
    );
    expect(exemptPaths).toEqual(expect.arrayContaining(['/tmp/U1/plugin-copy', '/private/tmp/U1/plugin-copy']));
  });
});

describe('ensureClaudeTmpDir', () => {
  it("makes a private directory in the user's root", () => {
    const root = mk('ct/a');
    const dir = ensureClaudeTmpDir(root);
    expect(dir).toBe(path.join(root, CLAUDE_TMP_DIR_NAME));
    expect(fs.statSync(dir as string).mode & 0o777).toBe(0o700);
  });

  it('moves aside a link the session planted, and makes a real directory', () => {
    const root = mk('ct/b');
    const target = mk('ct/b-target');
    fs.symlinkSync(target, path.join(root, CLAUDE_TMP_DIR_NAME));
    const dir = ensureClaudeTmpDir(root, () => 42) as string;
    expect(fs.lstatSync(dir).isDirectory()).toBe(true);
    expect(fs.lstatSync(dir).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(`${dir}.moved-42`).isSymbolicLink()).toBe(true);
  });

  it('tightens the mode of a directory already there', () => {
    const root = mk('ct/c');
    fs.mkdirSync(path.join(root, CLAUDE_TMP_DIR_NAME), { mode: 0o755 });
    fs.chmodSync(path.join(root, CLAUDE_TMP_DIR_NAME), 0o755);
    const dir = ensureClaudeTmpDir(root) as string;
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("does nothing while the user's root is not there", () => {
    expect(ensureClaudeTmpDir(path.join(ROOT, 'ct', 'missing'))).toBeUndefined();
    expect(fs.existsSync(path.join(ROOT, 'ct', 'missing'))).toBe(false);
  });
});
