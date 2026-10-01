import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { normalizeTmpPath } from '../path-utils';
import {
  checkBashSensitivePaths,
  checkSensitiveGlob,
  checkSensitivePath,
  getSensitiveReadDenyPaths,
} from '../sensitive-path-filter';

const HOME = os.homedir();
/** The HOME the module uses: `os.homedir()` resolved, with /private/tmp written /tmp. */
const MODULE_HOME = normalizeTmpPath(path.resolve(HOME));
/** HOME with its ASCII letters in upper case. */
const UPPER_HOME = HOME.replace(/[a-z]/g, (c) => c.toUpperCase());

describe('checkSensitivePath', () => {
  describe('blocks sensitive directories', () => {
    it.each([
      [`${HOME}/.ssh/id_ed25519`, '.ssh private key'],
      [`${HOME}/.ssh/id_rsa`, '.ssh RSA key'],
      [`${HOME}/.ssh/config`, '.ssh config'],
      [`${HOME}/.ssh/known_hosts`, '.ssh known hosts'],
      [`${HOME}/.ssh`, '.ssh directory itself'],
      [`${HOME}/.gnupg/private-keys-v1.d`, '.gnupg private keys'],
      [`${HOME}/.config/gh/hosts.yml`, 'GitHub CLI credentials'],
      [`${HOME}/.aws/credentials`, 'AWS credentials'],
      [`${HOME}/.docker/config.json`, 'Docker config'],
      [`${HOME}/Library/Keychains/login.keychain-db`, 'macOS keychain'],
    ])('blocks: %s (%s)', (filePath) => {
      const result = checkSensitivePath(filePath);
      expect(result.isSensitive).toBe(true);
      expect(result.reason).toBeDefined();
    });
  });

  describe('blocks sensitive exact files', () => {
    it.each([
      [`${HOME}/.gitconfig`, '.gitconfig'],
      [`${HOME}/.netrc`, '.netrc'],
      [`${HOME}/.npmrc`, '.npmrc'],
      [`${HOME}/.claude/credentials.json`, 'Claude credentials'],
    ])('blocks: %s (%s)', (filePath) => {
      const result = checkSensitivePath(filePath);
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('blocks sensitive basenames', () => {
    it.each([
      ['/opt/soma-work/dev/.env', '.env in service dir'],
      ['/some/project/.env', '.env in project'],
      ['/app/.env.local', '.env.local'],
      ['/app/.env.production', '.env.production'],
      ['/app/.env.staging', '.env.staging'],
      ['/app/.env.development', '.env.development'],
    ])('blocks: %s (%s)', (filePath) => {
      const result = checkSensitivePath(filePath);
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('blocks sensitive basename patterns', () => {
    it.each([
      ['/app/credentials.json', 'credentials.json'],
      ['/app/secrets.json', 'secrets.json'],
      ['/app/secret.yaml', 'secret.yaml'],
      ['/app/secrets.toml', 'secrets.toml'],
    ])('blocks: %s (%s)', (filePath) => {
      const result = checkSensitivePath(filePath);
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('blocks service config files', () => {
    it.each([
      ['/opt/soma-work/dev/config.json', 'soma-work dev config'],
      ['/opt/soma-work/prod/config.json', 'soma-work prod config'],
      ['/opt/soma-work/dev/.env', 'soma-work dev env'],
      ['/opt/soma/dev/.env', 'soma dev env'],
    ])('blocks: %s (%s)', (filePath) => {
      const result = checkSensitivePath(filePath);
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('allows safe paths', () => {
    it.each([
      ['/tmp/U094E5L4A15/soma-work_123/src/index.ts', 'user workspace file'],
      ['/tmp/U094E5L4A15/soma-work_123/package.json', 'package.json in workspace'],
      [`${HOME}/projects/my-app/src/config.ts`, 'source code file'],
      ['/usr/local/bin/node', 'system binary'],
      ['/tmp/U094E5L4A15/test.txt', 'user tmp file'],
    ])('allows: %s (%s)', (filePath) => {
      const result = checkSensitivePath(filePath);
      expect(result.isSensitive).toBe(false);
    });
  });

  describe('handles tilde expansion', () => {
    it('blocks ~/.ssh/id_rsa', () => {
      const result = checkSensitivePath('~/.ssh/id_rsa');
      expect(result.isSensitive).toBe(true);
    });

    it('blocks ~/.config/gh/hosts.yml', () => {
      const result = checkSensitivePath('~/.config/gh/hosts.yml');
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('handles edge cases', () => {
    it('returns false for empty path', () => {
      expect(checkSensitivePath('').isSensitive).toBe(false);
    });

    it('handles /private/tmp normalization', () => {
      const result = checkSensitivePath('/private/tmp/U094E5L4A15/test.txt');
      expect(result.isSensitive).toBe(false);
    });
  });

  // Regression: `.`, `..` and empty segments used to reach the checks unresolved, so any such
  // spelling of a sensitive path was allowed; `$HOME` and `${HOME}` were not expanded like `~`.
  describe('checks every spelling of a sensitive path', () => {
    it.each([
      [`${HOME}/work/../.ssh/id_rsa`, 'parent segment'],
      [`${HOME}/./.ssh/id_rsa`, 'current-directory segment'],
      [`${HOME}//.ssh/id_rsa`, 'empty segment'],
      [`/tmp/..${HOME}/.aws/credentials`, 'parent segment above home'],
      ['/../etc/shadow', 'parent segment at the root'],
      ['/etc//shadow', 'empty segment outside home'],
      ['/opt/soma-work/./dev/config.json', 'current-directory segment in a service config'],
      ['$HOME/.ssh/id_rsa', '$HOME'],
      [`\${HOME}/.aws/credentials`, `\${HOME}`],
    ])('blocks: %s (%s)', (filePath) => {
      const result = checkSensitivePath(filePath);
      expect(result.isSensitive).toBe(true);
    });

    it('allows a sibling that only shares a name prefix with a sensitive directory', () => {
      expect(checkSensitivePath(`${HOME}/.sshx/key`).isSensitive).toBe(false);
    });
  });

  // Regression: `..` after a symbolic link climbs from the link's target, not from where the text
  // says (`.aws/link -> .aws/deep/nested` makes `.aws/link/../../credentials` read
  // `.aws/credentials`), so a walk that enters a sensitive directory is treated as reaching it.
  describe('treats a walk through a sensitive directory as reaching it', () => {
    it.each([
      [`${HOME}/.aws/link/../../credentials`, 'parent segments after a link in .aws'],
      ['~/.aws/link/../../credentials', 'the same with ~'],
      [`${HOME}/.ssh/..`, 'back out of .ssh'],
      [`${HOME}/.ssh/../safe`, 'through .ssh to a sibling'],
      ['/etc/shadow/../passwd', 'through /etc/shadow'],
    ])('blocks: %s (%s)', (filePath) => {
      expect(checkSensitivePath(filePath).isSensitive).toBe(true);
    });

    it('allows a walk that never enters a sensitive directory', () => {
      expect(checkSensitivePath(`${HOME}/work/../safe`).isSensitive).toBe(false);
    });
  });

  // Regression: APFS, the macOS default, compares names with Unicode case folding: every spelling
  // below opens the sensitive file. U+017F folds to s, U+212A (Kelvin sign) to k, U+00DF and
  // U+1E9E to ss, and U+FB01 to fi.
  describe('compares paths case-insensitively', () => {
    it.each([
      [`${HOME}/.SSH/id_rsa`, '.SSH'],
      [`${UPPER_HOME}/.ssh/id_rsa`, 'HOME in upper case'],
      ['/etc/SHADOW', '/etc/SHADOW'],
      ['/app/.ENV', '.ENV'],
      ['/opt/soma-work/dev/CONFIG.json', 'service config'],
      [`${HOME}/.GITCONFIG`, 'exact file'],
      [`${HOME}/.\u017Fsh/id_rsa`, 'long s'],
      [`${HOME}/.doc\u212Aer/config.json`, 'Kelvin sign'],
      [`${HOME}/.\u00DFh/id_rsa`, 'sharp s'],
      [`${HOME}/.\u1E9Eh/id_rsa`, 'capital sharp s'],
      [`${HOME}/.gitcon\uFB01g`, 'fi ligature'],
      ['/opt/soma-work/dev/con\uFB01g.json', 'fi ligature in a service config'],
    ])('blocks: %s (%s)', (filePath) => {
      expect(checkSensitivePath(filePath).isSensitive).toBe(true);
    });

    it('allows a sibling that only shares a name prefix, in any case', () => {
      expect(checkSensitivePath(`${HOME}/.SSHX/key`).isSensitive).toBe(false);
    });
  });
});

describe('checkBashSensitivePaths', () => {
  describe('blocks reading sensitive files', () => {
    it.each([
      [`cat ${HOME}/.ssh/id_ed25519`, 'cat SSH key'],
      [`head -1 ${HOME}/.ssh/config`, 'head SSH config'],
      [`tail ${HOME}/.gitconfig`, 'tail gitconfig'],
      [`cat /opt/soma-work/dev/.env`, 'cat service env'],
      [`less ${HOME}/.ssh/id_rsa`, 'less SSH key'],
      [`base64 ${HOME}/.ssh/id_ed25519`, 'base64 encode SSH key'],
      [`strings ${HOME}/.ssh/id_rsa`, 'strings SSH key'],
      [`cat ${HOME}/.config/gh/hosts.yml`, 'cat GitHub token'],
    ])('blocks: %s (%s)', (command) => {
      const result = checkBashSensitivePaths(command);
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('blocks copy from sensitive sources', () => {
    it.each([
      [`cp ${HOME}/.ssh/id_ed25519 /tmp/stolen`, 'cp SSH key'],
      [`cp ${HOME}/.gitconfig /tmp/leak`, 'cp gitconfig'],
    ])('blocks: %s (%s)', (command) => {
      const result = checkBashSensitivePaths(command);
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('allows safe commands', () => {
    it.each([
      ['ls /tmp/U094E5L4A15/', 'ls user tmp'],
      ['cat /tmp/U094E5L4A15/soma-work/src/index.ts', 'cat workspace file'],
      ['git status', 'git status'],
      ['npm install', 'npm install'],
      ['echo hello', 'echo'],
      ['pwd', 'pwd'],
    ])('allows: %s (%s)', (command) => {
      const result = checkBashSensitivePaths(command);
      expect(result.isSensitive).toBe(false);
    });
  });

  // Regression: the extraction regexes only captured paths starting with `/`, so a home-relative
  // path lost its `~` and was checked as `/.ssh/...`; dot segments were never resolved.
  describe('blocks home-relative and dot-segment spellings', () => {
    it.each([
      ['cat ~/.ssh/id_rsa', 'cat with ~'],
      ['cat $HOME/.ssh/id_rsa', 'cat with $HOME'],
      [`cat \${HOME}/.aws/credentials`, `cat with \${HOME}`],
      ['head -1 ~/.netrc', 'head with ~'],
      [`cat ${HOME}/proj/../.ssh/id_rsa`, 'cat with a parent segment'],
      ['cat < ~/.ssh/id_rsa', 'input redirect after a read command'],
      ['wc -c < ~/.ssh/id_rsa', 'input redirect without a read command'],
      ['cp ~/.ssh/id_rsa /tmp/x ', 'cp with ~'],
      ['source ~/.env', 'source with ~'],
    ])('blocks: %s (%s)', (command) => {
      const result = checkBashSensitivePaths(command);
      expect(result.isSensitive).toBe(true);
    });

    it('allows a home-relative path that is not sensitive', () => {
      expect(checkBashSensitivePaths('cat ~/project/README.md').isSensitive).toBe(false);
    });
  });

  // Regression: `.` was only seen after a word character, a read command's arguments after the
  // first path were never checked, `cd` was not checked at all, and a double-quoted `$HOME` kept
  // its quotes, so the path was checked as `/.ssh/...`.
  describe('blocks dot-source, every argument, cd and quoted $HOME', () => {
    it.each([
      ['. ~/.env', 'dot-source at the start'],
      ['. /opt/soma-work/dev/.env', 'dot-source of a service env'],
      ['cd /tmp && . ~/.env', 'dot-source after &&'],
      ['if true; then . ~/.env; fi', 'dot-source after then'],
      ['cat /tmp/a ~/.ssh/id_rsa', 'second argument'],
      ['head -n 5 /tmp/a /tmp/b /opt/soma-work/prod/config.json', 'third argument'],
      ['cd ~/.ssh && cat id_rsa', 'cd into .ssh'],
      ['pushd ~/.aws', 'pushd into .aws'],
      ['cat "$HOME"/.ssh/id_rsa', 'quoted $HOME'],
      [`cat "\${HOME}"/.aws/credentials`, `quoted \${HOME}`],
      ['cp "$HOME"/.ssh/id_rsa /tmp/x ', 'cp with quoted $HOME'],
      ['wc -c < "$HOME"/.netrc', 'redirect with quoted $HOME'],
      [`source "\${HOME}"/.env`, `source with quoted \${HOME}`],
    ])('blocks: %s (%s)', (command) => {
      const result = checkBashSensitivePaths(command);
      expect(result.isSensitive).toBe(true);
    });

    it.each([
      ['cat /tmp/a /tmp/b', 'several safe arguments'],
      ['cd /tmp/U094E5L4A15/soma-work && npm test', 'cd into a workspace'],
      ['cat "$HOME"/project/README.md', 'quoted $HOME, safe path'],
      ['. /tmp/U094E5L4A15/setup.sh', 'dot-source of a safe script'],
    ])('allows: %s (%s)', (command) => {
      const result = checkBashSensitivePaths(command);
      expect(result.isSensitive).toBe(false);
    });
  });

  // Regression: a path could not cross `//`, so the alias or directory before it was dropped;
  // copy commands had only their first path checked, and it had to be followed by a space;
  // quotes and backslashes inside a word hid the name the shell reads; `..` was resolved
  // before the check, so a walk through a sensitive directory was lost; case was compared.
  describe('blocks empty segments, every copy source, quoting, walks and case', () => {
    it.each([
      ['cat ~//.ssh/id_rsa', '~ then //'],
      ['cat $HOME//.ssh/id_rsa', '$HOME then //'],
      ['cat "$HOME"//.ssh/id_rsa', 'quoted $HOME then //'],
      ['head ~//.netrc', 'head, //'],
      ['source ~//.env', 'source, //'],
      ['. ~//.env', 'dot-source, //'],
      ['cd ~//.ssh', 'cd, //'],
      ['cp ~//.ssh/id_rsa /tmp/x ', 'cp, //'],
      ['wc -c < ~//.ssh/id_rsa', 'redirect, //'],
      ['cat /etc//shadow', '// outside home'],
      [`cat ${HOME}//.ssh/id_rsa`, '// after an absolute HOME'],
      ['cp -r ~/.ssh/ /tmp/x', 'cp of a directory with a trailing slash'],
      ['rsync -a ~/.ssh/ /tmp/x/', 'rsync with a trailing slash'],
      ['cp /tmp/a ~/.ssh/id_rsa /tmp/x', 'second cp source'],
      ['rsync -a /tmp/a ~/.aws/credentials /tmp/x', 'second rsync source'],
      ['cat $HOME/.s""sh/id_rsa', 'empty double quotes inside a name'],
      ["cat ~/.s''sh/id_rsa", 'empty single quotes inside a name'],
      ['cat ~/.s\\sh/id_rsa', 'backslash inside a name'],
      ['cat $HOME/.a""ws/credentials', 'empty quotes inside .aws'],
      ['. "$HOME/.env"', 'dot-source of a quoted path'],
      ['source "$HOME/.env"', 'source of a quoted path'],
      ['wc -c < "$HOME/.netrc"', 'redirect from a quoted path'],
      ['cat "$HOME/.aws/credentials"', 'quoted path'],
      ['cat ~/.aws/link/../../credentials', 'walk through .aws'],
      ['cat $HOME/.aws/link/../../credentials', 'walk through .aws with $HOME'],
      ['cat ~/.SSH/id_rsa', 'upper-case .SSH'],
    ])('blocks: %s (%s)', (command) => {
      expect(checkBashSensitivePaths(command).isSensitive).toBe(true);
    });
  });

  // Regression: quote removal glued a `$'...'` escape onto the path (`$'/etc/shadow\x00'` was
  // checked as /etc/shadowx00), and escapes were never decoded. A NUL ends the `$'...'` in bash
  // (`$'/etc/sha\0'dow` opens /etc/shadow) and the whole word in zsh (`$'/etc/shadow\0'junk` does).
  describe("reads $'...' as the shell decodes it", () => {
    it.each([
      [String.raw`cat $'/etc/shadow\x00'`, 'NUL written \\x00'],
      [String.raw`head $'/opt/soma-work/dev/.env\0'`, 'NUL written \\0'],
      [String.raw`cat < $'/etc/shadow\000'`, 'NUL written \\000, redirect'],
      [String.raw`cat $'/etc/sha\x64ow'`, 'hex escape inside a name'],
      [String.raw`cat $'/etc/shadow\x00junk'`, 'text after the NUL'],
      [String.raw`source $'/opt/soma/prod/.env\0'`, 'source'],
      [String.raw`cat $'/etc/sha\0'dow`, 'bash: the word goes on after the NUL'],
      [String.raw`cat $'/etc/shadow\0'junk`, 'zsh: the NUL ends the word'],
      [String.raw`source $'\x7e/.env'`, 'a decoded ~ is a directory named ~, and .env is sensitive anywhere'],
    ])('blocks: %s (%s)', (command) => {
      expect(checkBashSensitivePaths(command).isSensitive).toBe(true);
    });

    it.each([
      [String.raw`cat $'\x7e/.ssh/id_rsa'`, 'a decoded ~ is not expanded: bash opens ./~/.ssh/id_rsa'],
      [String.raw`cat $'/tmp/x\x00'`, 'a safe path before a NUL'],
      [String.raw`cat "$'/etc/sha\x64ow'"`, "$'...' inside double quotes is literal"],
    ])('allows: %s (%s)', (command) => {
      expect(checkBashSensitivePaths(command).isSensitive).toBe(false);
    });
  });
});

describe('checkSensitiveGlob', () => {
  it('blocks glob in .ssh directory', () => {
    const result = checkSensitiveGlob('*', `${HOME}/.ssh`);
    expect(result.isSensitive).toBe(true);
  });

  it('blocks glob pattern targeting .ssh', () => {
    const result = checkSensitiveGlob(`${HOME}/.ssh/*`);
    expect(result.isSensitive).toBe(true);
  });

  it('blocks glob in .config/gh', () => {
    const result = checkSensitiveGlob('*.yml', `${HOME}/.config/gh`);
    expect(result.isSensitive).toBe(true);
  });

  it('allows glob in user workspace', () => {
    const result = checkSensitiveGlob('**/*.ts', '/tmp/U094E5L4A15/soma-work');
    expect(result.isSensitive).toBe(false);
  });

  it('blocks a pattern whose concrete prefix reaches .ssh through a parent segment', () => {
    const result = checkSensitiveGlob(`${HOME}/work/../.ssh/*`);
    expect(result.isSensitive).toBe(true);
  });

  // Regression: a partial segment before the metacharacter (`..*`) is a pattern, not a
  // directory, so these list .ssh (the glob matches `.ssh/..canary`); and path.resolve
  // collapsed a `..` that a symbolic link in the base would climb from elsewhere.
  it.each([
    [`${HOME}/.ssh/..*`, undefined],
    ['..*', `${HOME}/.ssh`],
    ['../../credentials*', `${HOME}/.aws/link`],
  ])('blocks the directory a glob lists: %s in %s', (pattern, basePath) => {
    expect(checkSensitiveGlob(pattern, basePath).isSensitive).toBe(true);
  });

  it('allows a glob over the files directly in HOME', () => {
    expect(checkSensitiveGlob(`${HOME}/*.txt`).isSensitive).toBe(false);
  });
});

// Regression: checked paths have /private/tmp rewritten to /tmp, but the tables were built from
// HOME as os.homedir() returned it, so under a HOME in /private/tmp no path ever matched them.
describe('with HOME under /private/tmp', () => {
  it.each([
    ['~/.ssh/id_rsa', '~'],
    ['/private/tmp/soma-home/.ssh/id_rsa', '/private/tmp spelling'],
    ['/tmp/soma-home/.ssh/id_rsa', '/tmp spelling'],
    ['/private/tmp/soma-home/.gitconfig', 'exact file'],
  ])('blocks: %s (%s)', async (filePath) => {
    vi.stubEnv('HOME', '/private/tmp/soma-home');
    vi.resetModules();
    try {
      const filter = await import('../sensitive-path-filter');
      expect(filter.checkSensitivePath(filePath).isSensitive).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

// Regression: os.homedir() returns $HOME as it is set; a relative HOME gave relative tables, so
// the absolute path of a file under it was not recognized.
describe('with a relative HOME', () => {
  it('blocks the absolute path of a file in its .ssh', async () => {
    vi.stubEnv('HOME', 'soma-relative-home');
    vi.resetModules();
    try {
      const filter = await import('../sensitive-path-filter');
      expect(filter.checkSensitivePath(path.resolve('soma-relative-home', '.ssh', 'id_rsa')).isSensitive).toBe(true);
      expect(filter.checkSensitivePath('~/.ssh/id_rsa').isSensitive).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('getSensitiveReadDenyPaths', () => {
  it('returns non-empty list', () => {
    const paths = getSensitiveReadDenyPaths();
    expect(paths.length).toBeGreaterThan(0);
  });

  it('includes .ssh directory', () => {
    const paths = getSensitiveReadDenyPaths();
    expect(paths).toContain(path.join(MODULE_HOME, '.ssh'));
  });

  it('includes service .env files', () => {
    const paths = getSensitiveReadDenyPaths();
    expect(paths).toContain('/opt/soma-work/dev/.env');
  });
});
