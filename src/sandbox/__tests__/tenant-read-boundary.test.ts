import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ensureClaudeTmpDir,
  type TenantReadBoundaryInput,
  tenantReadBoundary,
  throughLink,
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
const ungrantedSkill = mk('opt/svc/dev/plugins/envp/skills/deploy');
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
    installDir: install,
    codeRoot: install,
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

  it('the code is opened where the bot runs from, also when its configuration lives elsewhere', () => {
    const configDir = mk('etc/svc');
    const { denyRead, allowRead } = tenantReadBoundary(input({ installDir: configDir, codeRoot: install }));
    expect(denyRead).toEqual(expect.arrayContaining([configDir, install]));
    expect(allowRead).toEqual(expect.arrayContaining([dist, nodeModules]));
    expect(allowRead).not.toContain(path.join(configDir, 'dist'));
  });

  it('never re-opens a path denied on purpose: not the path, nothing inside it, nothing above it', () => {
    const { allowRead, exemptPaths } = tenantReadBoundary(
      input({ writeRoots: [session, userRoot, home], pluginPaths: [zwPlugin, envPlugin, ungrantedSkill] }),
    );
    // The environment plugin (denied without a grant) is a plugin root, yet stays closed.
    expect(allowRead).not.toContain(envPlugin);
    // A candidate inside it stays closed for both mechanisms.
    expect(allowRead).not.toContain(ungrantedSkill);
    expect(exemptPaths).not.toContain(ungrantedSkill);
    // A write root above a denied path (the home directory holds `.ssh`) is dropped, not re-opened.
    expect(allowRead).not.toContain(home);
    expect(exemptPaths).not.toContain(home);
  });

  it('a skill a grant opens is for the file tools only: the shell keeps the plugin closed', () => {
    const { allowRead, exemptPaths } = tenantReadBoundary(input());
    expect(exemptPaths).toContain(grantedSkill);
    expect(allowRead).not.toContain(grantedSkill);
  });

  it('a session folder replaced by a link to another user is not opened, and is reported', () => {
    const swapped = path.join(userRoot, 'session_swapped');
    fs.symlinkSync(otherRoot, swapped);
    const { allowRead, exemptPaths, redirected } = tenantReadBoundary(input({ writeRoots: [swapped, userRoot] }));
    expect(redirected).toEqual([swapped]);
    expect(allowRead).not.toContain(otherRoot);
    expect(exemptPaths).not.toContain(otherRoot);
    expect(exemptPaths).not.toContain(swapped);
    expect(allowRead).toContain(userRoot);
  });

  it('a granted skill directory that is a link is not opened', () => {
    const linkedSkill = path.join(envPlugin, 'skills', 'linked');
    fs.symlinkSync(dataDir, linkedSkill);
    const { exemptPaths } = tenantReadBoundary(input({ grantedSkillDirs: [grantedSkill, linkedSkill] }));
    expect(exemptPaths).toContain(grantedSkill);
    expect(exemptPaths).not.toContain(linkedSkill);
    expect(exemptPaths).not.toContain(dataDir);
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

  it('macOS: real paths for the shell, both /tmp spellings for the file tools, Homebrew by runtime directory', () => {
    const fileSystem = {
      exists: () => true,
      realpath: (p: string) => (p === '/tmp' || p.startsWith('/tmp/') ? `/private${p}` : p),
    };
    const { denyRead, allowRead, exemptPaths, redirected } = tenantReadBoundary({
      platform: 'darwin',
      home: '/Users/svc',
      tmpdir: '/var/folders/ab/T',
      writeRoots: ['/tmp/U1/session_1', '/tmp/U1'],
      installDir: '/opt/svc/dev',
      codeRoot: '/opt/svc/dev',
      dataDir: '/opt/svc/dev/data',
      ownDataDir: '/opt/svc/dev/data/U1',
      claudeConfigDir: '/opt/svc/dev/.claude',
      pluginPaths: ['/tmp/U1/plugin-copy'],
      grantedSkillDirs: [],
      denied: ['/opt/svc/dev/secrets'],
      fileSystem,
    });
    expect(denyRead).toEqual(
      expect.arrayContaining(['/Users', '/opt', '/private/tmp', '/private/var/folders', '/private/var/tmp']),
    );
    // `/tmp` itself is a link: denying it would close every `/tmp/...` spelling, the user's root included.
    expect(denyRead).not.toContain('/tmp');
    // The OS's own `/tmp` link is not a planted one.
    expect(redirected).toEqual([]);
    expect(allowRead).toEqual(
      expect.arrayContaining([
        '/private/tmp/U1',
        '/private/tmp/U1/session_1',
        '/opt/homebrew/bin',
        '/opt/homebrew/Cellar',
        '/opt/homebrew/etc/openssl@3',
      ]),
    );
    for (const closed of ['/opt/homebrew', '/opt/homebrew/var', '/opt/homebrew/etc']) {
      expect(allowRead, closed).not.toContain(closed);
    }
    expect(exemptPaths).toEqual(expect.arrayContaining(['/tmp/U1/plugin-copy', '/private/tmp/U1/plugin-copy']));
  });
});

describe('throughLink', () => {
  it('a path through a planted link is; the macOS root links and missing paths are not', () => {
    const target = mk('tl/target');
    const link = path.join(ROOT, 'tl', 'link');
    fs.symlinkSync(target, link);
    expect(throughLink(link, process.platform)).toBe(true);
    expect(throughLink(path.join(link, 'below'), process.platform)).toBe(false); // not there
    expect(throughLink(target, process.platform)).toBe(false);
    const darwin = { exists: () => true, realpath: (p: string) => `/private${p}` };
    expect(throughLink('/tmp/U1/session_1', 'darwin', darwin)).toBe(false);
    expect(throughLink('/var/folders/x', 'darwin', darwin)).toBe(false);
    expect(throughLink('/tmp/U1/session_1', 'linux', darwin)).toBe(true);
  });
});

describe('ensureClaudeTmpDir', () => {
  it('makes a private directory per user under a private parent the bot owns', () => {
    const root = path.join(ROOT, 'ct-a');
    const dir = ensureClaudeTmpDir('U1', root);
    expect(dir).toBe(path.join(root, 'U1'));
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(dir as string).mode & 0o777).toBe(0o700);
    // Again: the same directory, still private.
    expect(ensureClaudeTmpDir('U1', root)).toBe(dir);
  });

  it('refuses a link standing in place of the directory or the parent, and never follows it', () => {
    const target = mk('ct-b-target');
    fs.chmodSync(target, 0o755);
    const root = mk('ct-b');
    fs.symlinkSync(target, path.join(root, 'U1'));
    expect(ensureClaudeTmpDir('U1', root)).toBeUndefined();
    const linkedRoot = path.join(ROOT, 'ct-b-linked');
    fs.symlinkSync(target, linkedRoot);
    expect(ensureClaudeTmpDir('U2', linkedRoot)).toBeUndefined();
    // The link was never followed: its target keeps its mode.
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it('tightens the mode of a directory already there', () => {
    const root = mk('ct-c');
    fs.mkdirSync(path.join(root, 'U1'), { mode: 0o755 });
    fs.chmodSync(path.join(root, 'U1'), 0o755);
    const dir = ensureClaudeTmpDir('U1', root) as string;
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses a user id that is not one path segment', () => {
    expect(ensureClaudeTmpDir('../x', path.join(ROOT, 'ct-d'))).toBeUndefined();
    expect(ensureClaudeTmpDir('', path.join(ROOT, 'ct-d'))).toBeUndefined();
  });
});
