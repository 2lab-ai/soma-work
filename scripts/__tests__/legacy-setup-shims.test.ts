import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The three legacy shell entrypoints and `provision-agent.ts` are compatibility
 * shims now. These tests pin the two halves of that: that they *route* to
 * `somawork setup`, and — the half that actually matters — that none of the
 * removed credential-collection machinery survived anywhere in them.
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

const SHELL_SHIMS = ['scripts/setup-wizard.sh', 'scripts/setup-wizard-macos.sh', 'scripts/new-deploy-setup.sh'];
const ALL_SHIMS = [...SHELL_SHIMS, 'scripts/provision-agent.ts'];

/**
 * Byte patterns from the deleted flows.
 *
 * `read -r`/`ask(` are the terminal credential prompts; the token names are the
 * variables they populated; the OAuth port and callback path are the local HTTP
 * server; `configurationToken` is the long-lived Slack credential the old
 * provisioner stored in a tracked `config.json`; `curl -fsSL` is the installer
 * pipeline; `/opt/soma-work` is the old materialization root.
 */
const REMOVED_MACHINERY: ReadonlyArray<[label: string, pattern: RegExp]> = [
  ['a terminal credential prompt', /\bread -r\b/],
  ['the provisioner prompt helper', /\bask\(/],
  ['SLACK_BOT_TOKEN collection', /SLACK_BOT_TOKEN\s*[:=]/],
  ['SLACK_APP_TOKEN collection', /SLACK_APP_TOKEN\s*[:=]/],
  ['SLACK_SIGNING_SECRET collection', /SLACK_SIGNING_SECRET\s*[:=]/],
  ['a manual xapp- paste', /Paste App-Level Token/i],
  ['the OAuth callback server', /oauth\/callback|createServer|OAUTH_CALLBACK_PORT/],
  ['a stored configuration token', /config\.configurationToken\s*=/],
  ['a curl installer', /curl\s+-fsSL/],
  ['/opt materialization', /\/opt\/soma-work/],
  ['a private state file', /\.new-deploy-state|\.setup-wizard-state/],
];

describe('legacy setup entrypoints', () => {
  it.each(SHELL_SHIMS)('%s prints one deprecation line and execs somawork setup', (relative) => {
    const body = read(relative);
    const deprecationLines = body.split('\n').filter((line) => /^\s*echo .*deprecated/.test(line));
    expect(deprecationLines).toHaveLength(1);
    expect(deprecationLines[0]).toContain('>&2');
    expect(body).toMatch(/exec somawork setup/);
  });

  it('new-deploy-setup.sh derives a profile only from the unambiguous historical env argument', () => {
    const body = read('scripts/new-deploy-setup.sh');
    expect(body).toContain('exec somawork setup --profile preview');
    expect(body).toContain('exec somawork setup --profile production');
    // Anything other than dev/main falls through to runtime discovery rather
    // than being guessed into a profile.
    expect(body).toMatch(/\*\)\s+exec somawork setup ;;/);
  });

  it('provision-agent.ts provisions nothing and exits nonzero', () => {
    const body = read('scripts/provision-agent.ts');
    expect(body).toContain('somawork setup');
    expect(body).toContain('process.exitCode = 1');
    expect(body).not.toMatch(/apps\.manifest\.create/);
  });

  it.each(ALL_SHIMS)('%s retains none of the removed credential machinery', (relative) => {
    const body = read(relative);
    for (const [label, pattern] of REMOVED_MACHINERY) {
      // The doc comments name what was removed; only *code* may not match, so
      // comment lines are stripped before the scan.
      const code = body
        .split('\n')
        .filter((line) => !/^\s*(#|\*|\/\/|\/\*)/.test(line))
        .join('\n');
      expect(pattern.test(code), `${relative} still contains ${label}`).toBe(false);
    }
  });

  it('every shim stays small enough that it cannot be hiding a second implementation', () => {
    for (const relative of ALL_SHIMS) {
      expect(read(relative).split('\n').length, relative).toBeLessThan(80);
    }
  });
});
