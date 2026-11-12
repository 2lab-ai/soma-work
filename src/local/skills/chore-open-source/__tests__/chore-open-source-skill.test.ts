import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * Contract between the chore-open-source SKILL.md and its engine (scripts/), plus one offline run
 * of the whole engine on a throwaway repository: recon -> rewrite -> swap -> clone migration.
 *
 *  - every `$ENGINE/<file>` the skill names ships and is executable; the engine parses;
 *  - each entry point refuses to run without OWNER/REPO and CHOS_WORK (no default target);
 *  - the engine carries no organisation of its own (targets come from arguments only);
 *  - end to end (needs git-filter-repo; skipped where it is not installed): a forbidden word in a
 *    file, a path name, a commit message, an author line and a tag is gone from the remote after
 *    the swap, and a clone with a local-only branch and an edited worktree is moved, edits kept.
 */

vi.setConfig({ testTimeout: 120_000 });

const SKILL_ROOT = resolve(__dirname, '..');
const SCRIPTS = resolve(SKILL_ROOT, 'scripts');
const md = readFileSync(resolve(SKILL_ROOT, 'SKILL.md'), 'utf8');
const scratch = mkdtempSync(join(tmpdir(), 'chos-skill-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const run = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd ?? scratch, env: opts.env ?? process.env, timeout: 100_000 });

const hasFilterRepo = run('git', ['filter-repo', '--version']).status === 0;

describe('local:chore-open-source — SKILL.md and its engine', () => {
  it('frontmatter: name, a when-only description with its trigger and the boundary to chore; the argument in the body', () => {
    const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    expect(fm).toMatch(/^name: chore-open-source$/m);
    const description = fm.match(/^description: "(.*)"$/m)?.[1] ?? '';
    expect(description).toMatch(/^Use when /);
    expect(description).toContain("'chore-open-source'");
    expect(description).toMatch(/Not for .*\(chore\)/);
    expect(md).toMatch(/^## Args\n\n`OWNER\/REPO` — the repository to clean \(required/m); // the argument lives in the body
  });

  it('every $ENGINE file the skill names ships in scripts/ and is executable', () => {
    const named = new Set([...md.matchAll(/\$ENGINE\/([\w.-]+)/g)].map((m) => m[1]));
    expect(named.size).toBeGreaterThanOrEqual(6);
    for (const f of named) {
      const p = resolve(SCRIPTS, f);
      expect(() => accessSync(p, constants.X_OK), f).not.toThrow();
    }
  });

  it('the engine parses: bash -n for shell, ast for python (callback bodies parse as they are)', () => {
    for (const f of readdirSync(SCRIPTS)) {
      const p = resolve(SCRIPTS, f);
      if (f.endsWith('.sh')) {
        expect(run('bash', ['-n', p]).status, f).toBe(0);
      } else if (f.endsWith('.py')) {
        const parse = `import ast; ast.parse(open(${JSON.stringify(p)}).read())`;
        expect(run('python3', ['-I', '-B', '-c', parse]).status, f).toBe(0);
      }
    }
  });

  it('each entry point refuses to run without OWNER/REPO, or without the run folder', () => {
    const env = { ...process.env };
    delete env.CHOS_WORK;
    for (const [cmd, file] of [
      ['bash', 'rewrite.sh'],
      ['bash', 'swap.sh'],
      ['bash', 'finalize.sh'],
      ['bash', 'find-clones.sh'],
      ['python3', 'recon.py'],
      ['python3', 'migrate-clone.py'],
    ] as const) {
      const noArgs = run(cmd, [resolve(SCRIPTS, file)], { env });
      expect(noArgs.status, file).not.toBe(0);
      expect(`${noArgs.stdout}${noArgs.stderr}`, file).toMatch(/usage|OWNER\/REPO/);
      if (file !== 'finalize.sh') {
        const noWork = run(
          cmd,
          [resolve(SCRIPTS, file), 'owner/repo', ...(file === 'migrate-clone.py' ? [scratch] : [])],
          { env },
        );
        expect(noWork.status, file).not.toBe(0);
        expect(`${noWork.stdout}${noWork.stderr}`, file).toMatch(/CHOS_WORK/);
      }
    }
  });

  // A stub gh: every command finalize.sh issues, with the rerun refused, accepted without a new attempt,
  // or accepted with one. The previous attempt's conclusion is always "success" — the stale result
  // finalize must not accept.
  const stubGh = (dir: string) => {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(
      join(dir, 'bin', 'gh'),
      `#!/usr/bin/env bash
case "$1 $2" in
  "secret set") cat >/dev/null ;;
  "workflow list") echo .github/workflows/sanitize-gate.yml ;;
  "api repos/o/r/commits/main") echo 0123456789abcdef0123456789abcdef01234567 ;;
  "run list") echo 42 ;;
  "run watch") ;;
  "run rerun") [ "$STUB_RERUN" = refuse ] && { echo "HTTP 403" >&2; exit 1; }
               [ "$STUB_RERUN" = attempt ] && echo 2 > "$STUB_STATE"; exit 0 ;;
  "run view") case "$*" in *conclusion*) echo success ;; *) cat "$STUB_STATE" 2>/dev/null || echo 1 ;; esac ;;
  *) echo "stub gh: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'patterns.txt'), 'secret-host-a\n');
    return {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      CHOS_WORK: dir,
      CHOS_POLL_TRIES: '2',
      CHOS_POLL_SECS: '0',
    };
  };

  it('finalize: a refused rerun, or one with no new attempt, fails instead of reusing the old success', () => {
    const refused = mkdtempSync(join(scratch, 'fin-refused-'));
    const r1 = run('bash', [resolve(SCRIPTS, 'finalize.sh'), 'o/r'], {
      env: { ...stubGh(refused), STUB_RERUN: 'refuse', STUB_STATE: join(refused, 'attempt') },
    });
    expect(r1.status, r1.stdout + r1.stderr).toBe(1);
    expect(r1.stderr).toMatch(/refused — the new list is untested/);

    const stale = mkdtempSync(join(scratch, 'fin-stale-'));
    const r2 = run('bash', [resolve(SCRIPTS, 'finalize.sh'), 'o/r'], {
      env: { ...stubGh(stale), STUB_RERUN: 'accept', STUB_STATE: join(stale, 'attempt') },
    });
    expect(r2.status, r2.stdout + r2.stderr).toBe(1);
    expect(r2.stderr).toMatch(/no new attempt — the new list is untested/);

    const fresh = mkdtempSync(join(scratch, 'fin-fresh-'));
    const r3 = run('bash', [resolve(SCRIPTS, 'finalize.sh'), 'o/r'], {
      env: { ...stubGh(fresh), STUB_RERUN: 'attempt', STUB_STATE: join(fresh, 'attempt') },
    });
    expect(r3.status, r3.stdout + r3.stderr).toBe(0);
    expect(r3.stdout).toMatch(/\(attempt 2\) -> success/);
  });

  it('recon: a path name hidden behind a shared blob is found, and failed GitHub reads make it incomplete', () => {
    const d = mkdtempSync(join(scratch, 'recon-'));
    const git = (...a: string[]) =>
      run('git', a, {
        cwd: d,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'a',
          GIT_AUTHOR_EMAIL: 'a@example.com',
          GIT_COMMITTER_NAME: 'a',
          GIT_COMMITTER_EMAIL: 'a@example.com',
        },
      });
    git('init', '-q', '--bare', '-b', 'main', 'remote.git');
    git('init', '-q', '-b', 'main', 'seed');
    // The same content at two paths: `rev-list --objects` names the blob once, by the first path.
    writeFileSync(join(d, 'seed', 'a.txt'), 'same\n');
    writeFileSync(join(d, 'seed', 'secret-host-a-copy.txt'), 'same\n');
    run('bash', ['-c', 'git add -A && git commit -q -m init && git push -q ../remote.git main'], {
      cwd: join(d, 'seed'),
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'a',
        GIT_AUTHOR_EMAIL: 'a@example.com',
        GIT_COMMITTER_NAME: 'a',
        GIT_COMMITTER_EMAIL: 'a@example.com',
      },
    });
    const env = { ...stubGh(d), CHOS_URL: join(d, 'remote.git') };
    const local = run('python3', ['-I', '-B', resolve(SCRIPTS, 'recon.py'), 'o/r', '--no-github'], { env });
    expect(local.status, local.stdout + local.stderr).toBe(0);
    expect(local.stdout).toMatch(/forbidden list\*\*: [1-9]/);
    expect(readFileSync(join(d, 'recon', 'r.md'), 'utf8')).toMatch(/at path names/);
    // The stub answers none of recon's GitHub reads: an incomplete inventory, not an empty one.
    const remote = run('python3', ['-I', '-B', resolve(SCRIPTS, 'recon.py'), 'o/r'], { env });
    expect(remote.status, remote.stdout + remote.stderr).toBe(3);
    expect(remote.stdout).toMatch(/INCOMPLETE — \d+ read\(s\) failed/);
  });

  it('recon: submitted review bodies are read, and a blob over CHOS_MAX_BLOB makes it incomplete', () => {
    const d = mkdtempSync(join(scratch, 'recon-gh-'));
    const genv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@example.com',
      GIT_COMMITTER_NAME: 'a',
      GIT_COMMITTER_EMAIL: 'a@example.com',
    };
    run(
      'bash',
      [
        '-c',
        'git init -q --bare -b main remote.git && git init -q -b main seed && cd seed && echo hello > a.txt && git add -A && git commit -q -m init && git push -q ../remote.git main',
      ],
      { cwd: d, env: genv },
    );
    mkdirSync(join(d, 'bin'));
    // Answers every read recon makes; the only private text is in a submitted review's body.
    writeFileSync(
      join(d, 'bin', 'gh'),
      `#!/usr/bin/env bash
case "$*" in
  "repo view"*) echo '{"visibility":"PUBLIC"}' ;;
  *"/actions/secrets"*) echo '{"secrets":[]}' ;;
  *"/actions/variables"*) echo '{"variables":[]}' ;;
  *"/issues?state=all"*) echo '[[{"number":7,"title":"t","body":"","pull_request":{}}]]' ;;
  *"/pulls/7/reviews"*) echo '[[{"id":9,"body":"approved on secret-host-a"}]]' ;;
  "api "*) echo '[[]]' ;;
  *) echo "stub gh: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    mkdirSync(join(d, 'config'));
    writeFileSync(join(d, 'config', 'patterns.txt'), 'secret-host-a\n');
    const env = {
      ...process.env,
      PATH: `${join(d, 'bin')}:${process.env.PATH}`,
      CHOS_WORK: d,
      CHOS_URL: join(d, 'remote.git'),
    };
    const r = run('python3', ['-I', '-B', resolve(SCRIPTS, 'recon.py'), 'o/r'], { env });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(join(d, 'recon', 'r.md'), 'utf8')).toMatch(/at github review on #7/);
    const big = run('python3', ['-I', '-B', resolve(SCRIPTS, 'recon.py'), 'o/r', '--no-github'], {
      env: { ...env, CHOS_MAX_BLOB: '2' },
    });
    expect(big.status, big.stdout + big.stderr).toBe(3);
    expect(big.stdout).toMatch(/a\.txt \(blob [0-9a-f]+, 6 bytes\) is over CHOS_MAX_BLOB/);
  });

  it('recon: POSIX bracket classes match as in the gate; archive member paths and unread media count', () => {
    const d = mkdtempSync(join(scratch, 'recon-media-'));
    const genv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@example.com',
      GIT_COMMITTER_NAME: 'a',
      GIT_COMMITTER_EMAIL: 'a@example.com',
    };
    run(
      'bash',
      [
        '-c',
        `set -e
      git init -q --bare -b main remote.git && git init -q -b main seed && cd seed
      printf 'runs on secret-host-b\\nanchored-word\\n' > a.txt && printf '\\000\\001secret-host-e\\000' > bin.dat && printf '\\x89PNG\\r\\n\\x1a\\n' > img.png
      git add -A && git commit -q -m init && git push -q ../remote.git main && cd ..
      mkdir -p pkg/docs && echo x > pkg/docs/secret-host-c.txt && tar -czf pkg.tar.gz -C pkg docs
      python3 -I -c "import io,tarfile;b=b'built on secret-host-f';t=tarfile.open('pkg2.tar.xz','w:xz');i=tarfile.TarInfo('notes.txt');i.size=len(b);t.addfile(i,io.BytesIO(b));t.close()"
      printf '7z\\274\\257\\047\\034rest' > blob.7z
      python3 -I -c "import zipfile;z=zipfile.ZipFile('bundle.zip','w');z.writestr('inner.7z',b'7z\\xbc\\xaf\\x27\\x1crest');z.close()"`,
      ],
      { cwd: d, env: genv },
    );
    mkdirSync(join(d, 'bin'));
    writeFileSync(
      join(d, 'bin', 'gh'),
      `#!/usr/bin/env bash
case "$*" in
  "repo view"*) echo '{"visibility":"PUBLIC"}' ;;
  *"/actions/secrets"*) echo '{"secrets":[]}' ;;
  *"/actions/variables"*) echo '{"variables":[]}' ;;
  *"releases/assets/5"*) cat "${join(d, 'pkg.tar.gz')}" ;;
  *"releases/assets/6"*) echo x ;;
  *"releases/assets/7"*) cat "${join(d, 'pkg2.tar.xz')}" ;;
  *"releases/assets/8"*) cat "${join(d, 'blob.7z')}" ;;
  *"releases/assets/9"*) cat "${join(d, 'bundle.zip')}" ;;
  *"/releases"*) echo '[[{"tag_name":"v1","name":"v1","body":"","assets":[{"id":5,"name":"pkg.tar.gz"},{"id":6,"name":"notes-secret-host-d.txt"},{"id":7,"name":"pkg2.tar.xz"},{"id":8,"name":"blob.7z"},{"id":9,"name":"bundle.zip"}]}]]' ;;
  "api "*) echo '[[]]' ;;
  *) echo "stub gh: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    mkdirSync(join(d, 'config'));
    // [[:alpha:]] is a POSIX class to the gate's grep -E; Python's re would read it as a set + "]".
    writeFileSync(join(d, 'config', 'patterns.txt'), 'secret-host-[[:alpha:]]\n^anchored-word$\n');
    const env = {
      ...process.env,
      PATH: `${join(d, 'bin')}:${process.env.PATH}`,
      CHOS_WORK: d,
      CHOS_URL: join(d, 'remote.git'),
    };
    const r = run('python3', ['-I', '-B', resolve(SCRIPTS, 'recon.py'), 'o/r'], { env });
    expect(r.status, r.stdout + r.stderr).toBe(3); // img.png was not OCR-read: unread, not clean
    const report = readFileSync(join(d, 'recon', 'r.md'), 'utf8');
    expect(report).toMatch(/at a\.txt \(blob/);
    expect(report).toMatch(/release asset v1\/pkg\.tar\.gz \(member path\)/);
    expect(report).toMatch(/1 image\/video\/PDF blob\(s\) in history were not OCR-read/);
    expect(report).toContain('`anchored-word`'); // ^…$ anchor per line, as grep does
    expect(report).toMatch(/at bin\.dat \(blob/); // a binary is read byte for byte, like grep -a
    expect(report).toMatch(/release asset v1\/notes-secret-host-d\.txt \(name\)/);
    expect(report).toMatch(/at release asset v1\/pkg2\.tar\.xz$/m); // unpacked by content, not by name
    expect(report).toMatch(/blob\.7z blob\.7z is 7z, which recon cannot open — not examined/);
    expect(report).toMatch(/bundle\.zip inner\.7z is 7z, which recon cannot open — not examined/); // nested too
  });

  it('swap keeps branch names out of program text (sed/awk scripts)', () => {
    const swap = readFileSync(resolve(SCRIPTS, 'swap.sh'), 'utf8');
    expect(swap).not.toMatch(/sed [^\n]*\$MAIN/);
    expect(swap).not.toMatch(/awk [^\n]*\$MAIN/);
  });

  it('the engine carries no organisation of its own', () => {
    for (const f of readdirSync(SCRIPTS).filter((n) => /\.(sh|py)$/.test(n))) {
      expect(readFileSync(resolve(SCRIPTS, f), 'utf8'), f).not.toMatch(/2lab-ai/);
    }
  });
});

describe.skipIf(!hasFilterRepo)('local:chore-open-source — offline run of the whole engine', () => {
  // The repository's own gate script is the trusted scanner the fixture runs (W/config/sanitize-scan.sh).
  const TRUSTED_SCAN = resolve(__dirname, '../../../../../scripts/sanitize-scan.sh');
  const W = 'secret-host-a';
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Dev',
    GIT_COMMITTER_NAME: 'Dev',
    GIT_AUTHOR_EMAIL: `dev@${W}.lan`,
    GIT_COMMITTER_EMAIL: `dev@${W}.lan`,
  };
  const T = mkdtempSync(join(scratch, 'e2e-'));
  const shAt = (script: string, extra: NodeJS.ProcessEnv = {}) =>
    run('bash', ['-c', script], { cwd: T, env: { ...env, ...extra } });
  const sh = (script: string, extra: NodeJS.ProcessEnv = {}) => {
    const r = shAt(script, extra);
    expect(r.status, `${script}\n${r.stdout}\n${r.stderr}`).toBe(0);
    return r.stdout;
  };
  const workDir = (name: string, patterns: string, remote = 'remote.git') => {
    const work = join(T, name);
    mkdirSync(join(work, 'config'), { recursive: true });
    writeFileSync(join(work, 'config', 'replace.txt'), `regex:${W}==>shared-host\n`);
    writeFileSync(join(work, 'config', 'patterns.txt'), patterns);
    writeFileSync(join(work, 'config', 'mailmap'), `Dev <dev@example.com> <dev@${W}.lan>\n`);
    writeFileSync(join(work, 'config', 'sanitize-scan.sh'), readFileSync(TRUSTED_SCAN));
    return { CHOS_WORK: work, CHOS_URL: join(T, remote), SWAP_URL: join(T, remote) };
  };

  it('setup: a remote with the word in a file, a path, messages, an author line and a tag; two clones', () => {
    sh(`set -e
      git init -q --bare -b main remote.git
      git init -q -b main seed && cd seed
      echo "connect to ${W}:22" > app.conf && mkdir -p docs && echo "runs on ${W}" > "docs/${W}.md"
      git add -A && git commit -q -m "init on ${W}"
      echo plain > b.txt && git add -A && git commit -q -m "plain commit"
      git tag -a v1 -m "release built on ${W}"
      git checkout -q -b feature && echo more >> b.txt && git commit -qam "feature work" && git checkout -q main
      F=$(git rev-parse --short=10 feature)
      echo note > n.txt && git add -A && git commit -q -m "follow-up to $F"
      git push -q ../remote.git main feature v1
      cd .. && git clone -q remote.git clone && cd clone
      git checkout -q -b local-only origin/feature && echo "local ${W} note" > l.txt && git add -A
      git commit -qm "local only on ${W}" && git checkout -q main
      git worktree add -q ../wt feature
      echo staged >> ../wt/b.txt && git -C ../wt add b.txt && echo unstaged >> ../wt/b.txt
      git worktree add -q --detach ../wt-detached main~1
      cd .. && git clone -q remote.git clone2 && git -C clone2 branch -q edit-host origin/main
      git -C clone2 worktree add -q ../wt-conflict edit-host
      sed -i.bak "s/:22/:2222/" wt-conflict/app.conf && rm wt-conflict/app.conf.bak
      git clone -q remote.git clone3 && cd clone3 && git checkout -q -b merged origin/feature
      git merge -q --no-ff --no-commit origin/main && echo "leakword" > resolved.txt && git add -A
      git commit -q -m "merge main" && cd ..
      git init -q --bare -b main remote-sym.git && git init -q -b main sym && cd sym
      mkdir scripts && printf '# list\\n%s  #1\\n' 0123456789012345678901234567890123456789 > scripts/sanitize-known-leaks.txt
      echo "victim" > "${T}/victim.txt" && ln -s "${T}/victim.txt" scripts/sanitize-known-leaks.txt.new
      echo "on ${W}" > app.conf && git add -A && git commit -q -m init && git push -q ../remote-sym.git main && cd ..
      git init -q --bare -b main remote-tag.git && git init -q -b main tagseed
      # Clean author and tagger: the tag message is the only private text, so no commit changes.
      ( cd tagseed && export GIT_AUTHOR_EMAIL=dev@example.com GIT_COMMITTER_EMAIL=dev@example.com
        echo plain > p.txt && git add -A && git commit -q -m init && git tag -a v1 -m "cut on ${W}"
        git push -q ../remote-tag.git main v1 )
      git clone -q remote-tag.git clonetag
      git clone -q remote.git clone5 && git -C clone5 worktree add -q --detach ../wt-ign main
      echo "docs/shared-host.md" >> clone5/.git/info/exclude && echo precious > wt-ign/docs/shared-host.md
      git init -q --bare -b main remote-ref.git && git init -q -b main refseed
      # Clean author: only ref names hold the word, so no commit changes.
      ( cd refseed && export GIT_AUTHOR_EMAIL=dev@example.com GIT_COMMITTER_EMAIL=dev@example.com
        echo clean > c.txt && git add -A && git commit -q -m init && git branch "wip-${W}"
        git branch main-rewritten/keep && git tag -a "rel-${W}" -m release
        git push -q ../remote-ref.git main "wip-${W}" main-rewritten/keep "rel-${W}" )
      git clone -q remote-ref.git cloneref && git -C cloneref branch -q "wip-${W}" "origin/wip-${W}"
      git init -q --bare -b main remote-adv.git && git init -q -b main advseed
      ( cd advseed && echo base > b.txt && git add -A && git commit -q -m "base on ${W}" && git push -q ../remote-adv.git main )
      git clone -q remote.git clone6 && cd clone6
      git checkout -q -b bin-only origin/main && printf '\\000leakbin\\000' > bin.dat && git add -A && git commit -q -m bin
      git checkout -q -b anchor-only origin/main && printf 'x\\nanchorword\\n' > anc.txt && git add -A && git commit -q -m anc
      git checkout -q -b path-only origin/main && echo clean > leakpath.txt && git add -A && git commit -q -m path
      git checkout -q -b "loc-${W}" origin/main && echo fine > fine.txt && git add -A && git commit -q -m fine
      git checkout -q main && cd ..
      git clone -q remote.git clone8 && git -C clone8 worktree add -q --detach ../wt-igndir main
      echo "docs/shared-host.md/" >> clone8/.git/info/exclude
      mkdir -p wt-igndir/docs/shared-host.md && echo precious > wt-igndir/docs/shared-host.md/keep.txt
      git clone -q remote.git clone4 && git -C clone4 branch -q nl origin/feature
      git -C clone4 worktree add -q "$(printf '%s/wt\\nnl' "$PWD")" nl`);
  });

  it('a rewrite that leaves a pattern exits 1 and the swap refuses it', () => {
    const bad = workDir('work-bad', `${W}\nplain\n`); // "plain" is in a file and a message; no rule replaces it
    const r = shAt(`"${SCRIPTS}/rewrite.sh" o/r`, bad);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/scan: FAILED/);
    const s = shAt(`"${SCRIPTS}/swap.sh" o/r`, bad);
    expect(s.status).not.toBe(0);
    expect(s.stderr).toMatch(/nothing pushed/);
    expect(sh('git -C remote.git log --all --format=%B')).toContain(W); // remote untouched
  });

  it('rewrites with a clean gate scan, swaps, and the word is gone from the remote', () => {
    const chos = workDir('work', `${W}\n`);
    expect(sh(`python3 -I -B "${SCRIPTS}/recon.py" o/r --no-github`, chos)).toMatch(/forbidden list\*\*: [1-9]/);
    const verify = sh(`"${SCRIPTS}/rewrite.sh" o/r`, chos);
    expect(verify).toMatch(/pattern hits — messages\+authors: 0, tags: 0, ref names: 0, paths: 0, contents: 0/);
    expect(verify).toMatch(/commit counts: identical/);
    expect(verify).toMatch(/^scan: clean$/m);
    expect(sh(`"${SCRIPTS}/swap.sh" o/r`, chos)).toMatch(/remote matches the rewritten repo \(3 refs\)/);
    const remoteText = sh(
      "git -C remote.git log --all -p --format='%B%an %ae%n%cn %ce'; git -C remote.git for-each-ref --format='%(contents)' refs/tags; git -C remote.git rev-list --objects --all",
    );
    expect(remoteText).not.toContain(W);
    expect(remoteText).toContain('shared-host');
    // A second run resumes instead of rewriting the rewritten remote (the commit map must survive).
    expect(sh(`"${SCRIPTS}/swap.sh" o/r`, chos)).toMatch(/resuming/);
  });

  it('migrates a clone: pushed ancestor ids, staged/unstaged edits, detached HEAD, local-only branch', () => {
    const chos = workDir('work', `${W}\n`);
    expect(sh(`python3 -I -B "${SCRIPTS}/migrate-clone.py" o/r "${join(T, 'clone')}" --apply`, chos)).toMatch(
      /refs on the old history 0; pattern lines in local-only commits 0/,
    );
    expect(sh(`python3 -I -B "${SCRIPTS}/migrate-clone.py" o/r "${join(T, 'clone')}" --check`, chos)).toMatch(
      /history 0/,
    );
    expect(sh('git -C clone rev-parse local-only^')).toBe(sh('git -C remote.git rev-parse feature'));
    expect(sh('git -C clone show local-only:l.txt')).toBe('local shared-host note\n');
    expect(sh('git -C wt diff --cached')).toMatch(/^\+staged$/m);
    expect(sh('git -C wt diff')).toMatch(/^\+unstaged$/m);
    // main = the rewrite's own top commit, so the old main~1 is the new main~2
    expect(sh('git -C wt-detached rev-parse HEAD')).toBe(sh('git -C remote.git rev-parse main~2'));
    expect(sh("git -C clone for-each-ref refs/pre-rewrite/heads --format='%(refname)'")).toContain(
      'refs/pre-rewrite/heads/local-only',
    );
  });

  it('rewrite never writes through a symlink planted beside the leak list', () => {
    const chos = workDir('work-sym', `${W}\n`, 'remote-sym.git');
    const out = sh(`"${SCRIPTS}/rewrite.sh" o/sym`, chos);
    expect(out).toMatch(/^scan: clean$/m);
    expect(readFileSync(join(T, 'victim.txt'), 'utf8')).toBe('victim\n');
    const list = sh(
      `git -C "${join(T, 'work-sym', 'out', 'sym', 'new.git')}" show main:scripts/sanitize-known-leaks.txt`,
    );
    expect(list).not.toMatch(/^[0-9a-f]{40}/m);
  });

  it('comment lines of the replace.txt template never become rules', () => {
    const chos = workDir('work-tmpl', `${W}\n`, 'remote-sym.git');
    const template = readFileSync(resolve(SKILL_ROOT, 'templates', 'replace.txt.example'), 'utf8');
    writeFileSync(join(chos.CHOS_WORK, 'config', 'replace.txt'), `${template}\nregex:${W}==>shared-host\n`);
    expect(sh(`"${SCRIPTS}/rewrite.sh" o/sym`, chos)).toMatch(/^scan: clean$/m);
    const list = sh(
      `git -C "${join(chos.CHOS_WORK, 'out', 'sym', 'new.git')}" show main:scripts/sanitize-known-leaks.txt`,
    );
    expect(list).toContain('# list'); // a bare "#" template line would have replaced every # in history
    expect(sh(`git -C "${join(chos.CHOS_WORK, 'out', 'sym', 'new.git')}" show main:app.conf`)).toBe('on shared-host\n');
  });

  it('a branch named after a private host is renamed, and the old name leaves the remote', () => {
    const chos = workDir('work-ref', `${W}\n`, 'remote-ref.git');
    expect(sh(`"${SCRIPTS}/rewrite.sh" o/ref`, chos)).toMatch(/^scan: clean$/m);
    expect(sh(`"${SCRIPTS}/swap.sh" o/ref`, chos)).toMatch(/deleting 2 ref\(s\) the rules renamed/);
    const refs = sh("git -C remote-ref.git for-each-ref --format='%(refname)'");
    expect(refs).not.toContain(W);
    expect(refs).toContain('refs/heads/wip-shared-host');
    expect(refs).toContain('refs/tags/rel-shared-host');
    expect(refs).toContain('refs/heads/main-rewritten/keep'); // only the exact review branch is ever dropped
  });

  it('a clone whose refs differ only by name is reported, then renamed', () => {
    const chos = workDir('work-ref', `${W}\n`, 'remote-ref.git');
    const check = shAt(`python3 -I -B "${SCRIPTS}/migrate-clone.py" o/ref "${join(T, 'cloneref')}" --check`, chos);
    expect(check.status, check.stdout + check.stderr).toBe(1);
    expect(check.stdout).toMatch(/refs on the old history [2-9]/);
    const r = shAt(`python3 -I -B "${SCRIPTS}/migrate-clone.py" o/ref "${join(T, 'cloneref')}" --apply`, chos);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(sh("git -C cloneref for-each-ref --format='%(refname)' refs/heads refs/tags refs/remotes")).not.toContain(W);
  });

  it('a relative CHOS_WORK works (the run folder is resolved before any cd)', () => {
    workDir('work-rel', `${W}\n`, 'remote-sym.git');
    const r = shAt(`"${SCRIPTS}/rewrite.sh" o/sym`, { CHOS_WORK: 'work-rel', CHOS_URL: join(T, 'remote-sym.git') });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^scan: clean$/m);
  });

  it('find-clones reaches a repository through a linked worktree alone (.git file)', () => {
    sh(`set -e
      mkdir -p gh/o fc-root outside
      git clone -q --bare remote.git gh/o/r.git
      git clone -q gh/o/r.git outside/r
      git -C outside/r worktree add -q "${join(T, 'fc-root', 'wt-r')}" -b wt-only`);
    const out = shAt(`"${SCRIPTS}/find-clones.sh" o/r "${join(T, 'fc-root')}"`, workDir('work', `${W}\n`)).stdout;
    expect(out).toMatch(/clones of o\/r: 1,/);
  });

  it('a local-only merge whose resolution adds a forbidden word is refused, not rebuilt', () => {
    const chos = workDir('work', `${W}\nleakword\n`);
    const r = shAt(`python3 -I -B "${SCRIPTS}/migrate-clone.py" o/r "${join(T, 'clone3')}" --apply`, chos);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/merged: rebuild REFUSED/);
  });

  it('a worktree whose path holds a newline moves with its branch', () => {
    const chos = workDir('work', `${W}\n`);
    const wt = join(T, 'wt\nnl');
    expect(sh(`python3 -I -B "${SCRIPTS}/migrate-clone.py" o/r "${join(T, 'clone4')}" --apply`, chos)).toMatch(
      /history 0;/,
    );
    expect(run('git', ['-C', wt, 'status', '--porcelain'], { env }).stdout).toBe('');
    expect(run('git', ['-C', wt, 'rev-parse', 'HEAD'], { env }).stdout).toBe(sh('git -C remote.git rev-parse feature'));
  });

  it('an ignored file where the rewritten commit tracks a file is not overwritten', () => {
    const chos = workDir('work', `${W}\n`);
    const r = shAt(`python3 -I -B "${SCRIPTS}/migrate-clone.py" o/r "${join(T, 'clone5')}" --apply`, chos);
    expect(r.stdout).toMatch(/has ignored files where the rewritten commit tracks files/);
    expect(readFileSync(join(T, 'wt-ign', 'docs', 'shared-host.md'), 'utf8')).toBe('precious\n');
  });

  it('local-only commits are checked blob by blob: a binary and a line-anchored leak are refused', () => {
    const chos = workDir('work', `${W}\nleakbin\n^anchorword$\nleakpath\n`);
    const r = shAt(`python3 -I -B "${SCRIPTS}/migrate-clone.py" o/r "${join(T, 'clone6')}" --apply`, chos);
    expect(r.stderr).not.toMatch(/Traceback/);
    expect(r.stdout).toMatch(/bin-only: rebuild REFUSED/);
    expect(r.stdout).toMatch(/anchor-only: rebuild REFUSED/);
    expect(r.stdout).toMatch(/path-only: rebuild REFUSED/); // a path name counts like file text
    expect(r.stdout).toMatch(/renamed to heads\/loc-shared-host/); // rebuilt by commit id, then renamed
  });

  it('an ignored folder where the rewritten commit tracks a file is not removed', () => {
    const chos = workDir('work', `${W}\n`);
    const r = shAt(`python3 -I -B "${SCRIPTS}/migrate-clone.py" o/r "${join(T, 'clone8')}" --apply`, chos);
    expect(r.stdout).toMatch(/has ignored files where the rewritten commit tracks files/);
    expect(readFileSync(join(T, 'wt-igndir', 'docs', 'shared-host.md', 'keep.txt'), 'utf8')).toBe('precious\n');
  });

  it('a worktree whose edits conflict with the rewrite is left exactly as it was', () => {
    const chos = workDir('work', `${W}\n`);
    const before = sh(
      'git -C wt-conflict rev-parse HEAD; git -C wt-conflict status --porcelain; cat wt-conflict/app.conf; git -C wt-conflict diff --cached',
    );
    const r = shAt(`python3 -I -B "${SCRIPTS}/migrate-clone.py" o/r "${join(T, 'clone2')}" --apply`, chos);
    expect(r.status).toBe(1); // that branch stays on the old history, and the report says so
    expect(r.stdout).toMatch(/left exactly as it was/);
    expect(
      sh(
        'git -C wt-conflict rev-parse HEAD; git -C wt-conflict status --porcelain; cat wt-conflict/app.conf; git -C wt-conflict diff --cached',
      ),
    ).toBe(before);
  });

  it('a resumed swap accepts a main that moved on after the replacement (runs last: it moves main)', () => {
    sh(`set -e
      git clone -q remote.git after && cd after && echo next > next.txt && git add -A && git commit -q -m "after the swap"
      git push -q origin main`);
    const r = shAt(`"${SCRIPTS}/swap.sh" o/r`, workDir('work', `${W}\n`));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/main already contains it/);
    expect(r.stdout).toMatch(/1 ref\(s\) moved or appeared since, all on the new history/);
  });

  it('a landed swap is recognised after refs moved on, even without its marker', () => {
    const chos = workDir('work', `${W}\n`);
    rmSync(join(chos.CHOS_WORK, 'out', 'r', 'swapped'));
    const r = shAt(`"${SCRIPTS}/swap.sh" o/r`, chos);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/already holds this rewrite \(an earlier push completed\): resuming/);
    expect(r.stdout).not.toMatch(/rewriting again/);
  });

  it('a ref pushed back with commits of the original history fails the swap verification', () => {
    const chos = workDir('work', `${W}\n`);
    // A new commit on top of the original history: the ref's own object is new, its ancestors are not.
    sh(`set -e
      git clone -q "${join(chos.CHOS_WORK, 'out', 'r', 'orig.git')}" old-again && cd old-again
      echo again > again.txt && git add -A && git commit -q -m "on the old history"
      git push -q "${join(T, 'remote.git')}" HEAD:refs/heads/old-again`);
    const r = shAt(`"${SCRIPTS}/swap.sh" o/r`, chos);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/refs\/heads\/old-again [0-9a-f]+ carries \d+ commit\(s\) of the original history/);
  });

  it('a tag-only rewrite gets its own top commit, and a resumed swap still pushes the tag', () => {
    const chos = workDir('work-tag', `${W}\n`, 'remote-tag.git');
    const v = sh(`"${SCRIPTS}/rewrite.sh" o/tag`, chos);
    const [, p1, p2] = v.match(/main \(push 1\): ([0-9a-f]+)\s+top commit \(push 2\): ([0-9a-f]+)/) ?? [];
    expect(p1 && p2 && p1 !== p2, v).toBe(true);
    sh('git -C tagseed push -q ../remote-tag.git main:refs/heads/side'); // the remote moves after the snapshot
    const r = shAt(`"${SCRIPTS}/swap.sh" o/tag`, chos);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/already holds this rewrite/); // main unchanged proves nothing
    expect(sh("git -C remote-tag.git for-each-ref --format='%(contents)' refs/tags")).not.toContain(W);
  });

  it('a clone whose only old ref is an annotated tag is reported, then migrated', () => {
    const chos = workDir('work-tag', `${W}\n`, 'remote-tag.git');
    const check = shAt(`python3 -I -B "${SCRIPTS}/migrate-clone.py" o/tag "${join(T, 'clonetag')}" --check`, chos);
    expect(check.status, check.stdout + check.stderr).toBe(1);
    expect(check.stdout).toMatch(/refs on the old history 1;/);
    expect(sh(`python3 -I -B "${SCRIPTS}/migrate-clone.py" o/tag "${join(T, 'clonetag')}" --apply`, chos)).toMatch(
      /history 0;/,
    );
    expect(sh("git -C clonetag for-each-ref --format='%(contents)' refs/tags")).not.toContain(W);
  });

  it('an original annotated tag pushed back fails the swap verification', () => {
    const chos = workDir('work-tag', `${W}\n`, 'remote-tag.git');
    sh(
      `git -C "${join(chos.CHOS_WORK, 'out', 'tag', 'orig.git')}" push -q "${join(T, 'remote-tag.git')}" refs/tags/v1:refs/tags/v1-old`,
    );
    const r = shAt(`"${SCRIPTS}/swap.sh" o/tag`, chos);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/refs\/tags\/v1-old [0-9a-f]+ is an object of the original history/);
  });

  it('a main that moved on from the list commit gets the top commit re-applied, not a failed push', () => {
    const chos = workDir('work-adv', `${W}\n`, 'remote-adv.git');
    writeFileSync(
      join(chos.CHOS_WORK, 'config', 'post-rewrite.sh'),
      '#!/bin/sh\necho "history rewritten" > NOTE.md\n',
      { mode: 0o755 },
    );
    sh(`"${SCRIPTS}/rewrite.sh" o/adv`, chos);
    const out = join(chos.CHOS_WORK, 'out', 'adv');
    // As if the atomic push landed and someone pushed on the list commit before the second push.
    sh(`set -e
      git -C "${out}/new.git" push -q --force "${join(T, 'remote-adv.git')}" 'refs/heads/*:refs/heads/*'
      date > "${out}/swapped"
      git clone -q remote-adv.git advafter && cd advafter && echo more > more.txt && git add -A
      git commit -q -m "on the list commit" && git push -q origin main`);
    const r = shAt(`"${SCRIPTS}/swap.sh" o/adv`, chos);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/moved on from the list commit; the top commit was re-applied on it/);
    expect(sh('git -C remote-adv.git show main:NOTE.md')).toBe('history rewritten\n');
    expect(sh('git -C remote-adv.git log --format=%s main')).toContain('on the list commit');
  });
});
