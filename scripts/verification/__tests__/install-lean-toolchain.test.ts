/**
 * Checks on `scripts/verification/install-lean-toolchain.sh`, which Lean Verify runs on a
 * GitHub-hosted runner before the gate: install elan (a pinned release), then the toolchain
 * `verification/lean/lean-toolchain` names, retrying transient download failures. The first
 * hosted run failed on one TLS error fetching the toolchain (2026-10-28), so a single network
 * blip must not fail the required check.
 *
 * `curl` and `elan` are stubs on PATH that fail a set number of times before succeeding and log
 * every call; the script runs against a scratch HOME so it never touches a real ~/.elan.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const script = path.join(repoRoot, 'scripts/verification/install-lean-toolchain.sh');
const toolchain = fs.readFileSync(path.join(repoRoot, 'verification/lean/lean-toolchain'), 'utf8').trim();
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A sandbox whose curl fails `curlFailures` times and whose elan fails `elanFailures` times. */
function sandbox(curlFailures: number, elanFailures: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-install-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  const log = path.join(dir, 'calls.log');
  // curl -o <file> <url>: writes an elan-init.sh that installs a stub elan into $HOME/.elan/bin.
  fs.writeFileSync(
    path.join(bin, 'curl'),
    `#!/bin/bash
echo "curl $*" >> "${log}"
n=$(grep -c '^curl ' "${log}")
[ "$n" -le ${curlFailures} ] && { echo "curl: (35) SSL connect error" >&2; exit 35; }
out=""; url=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; case "$1" in http*) url="$1";; esac; shift; done
case "$url" in *github.com/leanprover/lean4/releases/download/*) echo "release" > "$out"; exit 0;; esac
cat > "$out" <<'INIT'
mkdir -p "$HOME/.elan/bin"
cat > "$HOME/.elan/bin/elan" <<'ELAN'
#!/bin/bash
echo "elan $*" >> "$ELAN_LOG"
n=$(grep -c '^elan ' "$ELAN_LOG")
[ "$n" -le "$ELAN_FAILURES" ] && { echo "error: could not download file" >&2; exit 1; }
exit 0
ELAN
chmod +x "$HOME/.elan/bin/elan"
echo "init $*" >> "$ELAN_LOG"
INIT
`,
    { mode: 0o755 },
  );
  // tar -xf <archive> -C <dir> --strip-components=1: records the call and lays down bin/lean.
  fs.writeFileSync(
    path.join(bin, 'tar'),
    `#!/bin/bash
echo "tar $*" >> "${log}"
dir=""; while [ $# -gt 0 ]; do [ "$1" = -C ] && dir="$2"; shift; done
mkdir -p "$dir/bin" && printf '#!/bin/sh\\necho lean\\n' > "$dir/bin/lean" && chmod +x "$dir/bin/lean"
`,
    { mode: 0o755 },
  );
  const run = () =>
    spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        LEAN_INSTALL_PLATFORM: 'linux',
        HOME: home,
        ELAN_LOG: log,
        ELAN_FAILURES: String(elanFailures),
        LEAN_INSTALL_RETRY_DELAY: '0',
      },
    });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return { run, calls, home };
}

describe('install-lean-toolchain.sh', () => {
  it('installs elan from a pinned release tag, then the pinned toolchain', () => {
    const box = sandbox(0, 0);
    const result = box.run();
    expect(result.status, result.stderr).toBe(0);
    const calls = box.calls();
    expect(calls[0]).toMatch(
      /^curl .*https:\/\/raw\.githubusercontent\.com\/leanprover\/elan\/v\d+\.\d+\.\d+\/elan-init\.sh/,
    );
    expect(calls).toContain('init -y --default-toolchain none');
    expect(calls).toContain(`elan toolchain install ${toolchain}`);
  });

  it('retries a transient download failure of elan and of the toolchain', () => {
    const box = sandbox(2, 1);
    const result = box.run();
    expect(result.status, result.stderr).toBe(0);
    const calls = box.calls();
    expect(calls.filter((c) => c.startsWith('curl ')).length).toBe(3);
    expect(calls.filter((c) => c.startsWith('elan toolchain install')).length).toBe(2);
    expect(calls.some((c) => c.startsWith('tar '))).toBe(false);
  });

  it('falls back to the GitHub release when the Lean release server keeps failing', () => {
    // releases.lean-lang.org refused TLS on 2 of 10 hosted runs (2026-10-28); GitHub's own
    // release assets are on the same network as the runner.
    const box = sandbox(0, 99);
    const result = box.run();
    expect(result.status, result.stderr).toBe(0);
    const calls = box.calls();
    expect(calls.filter((c) => c.startsWith('elan toolchain install')).length).toBe(2);
    const version = toolchain.split(':')[1];
    expect(
      calls.some((c) =>
        c.includes(`github.com/leanprover/lean4/releases/download/${version}/lean-${version.slice(1)}-linux.tar.zst`),
      ),
    ).toBe(true);
    const dir = path.join(box.home, '.elan/toolchains', toolchain.replace('/', '--').replace(':', '---'));
    expect(fs.existsSync(path.join(dir, 'bin/lean'))).toBe(true);
  });
});
