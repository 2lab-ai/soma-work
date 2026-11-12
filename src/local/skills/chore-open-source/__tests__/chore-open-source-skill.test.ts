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
  it('frontmatter: name, a quoted one-line description with its argument and the boundary to chore', () => {
    const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    expect(fm).toMatch(/^name: chore-open-source$/m);
    const description = fm.match(/^description: "(.*)"$/m)?.[1] ?? '';
    expect(description).toContain("'chore-open-source'");
    expect(description).toContain('OWNER/REPO');
    expect(description).toMatch(/NOT for/);
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
  const workDir = (name: string, patterns: string) => {
    const work = join(T, name);
    mkdirSync(join(work, 'config'), { recursive: true });
    writeFileSync(join(work, 'config', 'replace.txt'), `regex:${W}==>shared-host\n`);
    writeFileSync(join(work, 'config', 'patterns.txt'), patterns);
    writeFileSync(join(work, 'config', 'mailmap'), `Dev <dev@example.com> <dev@${W}.lan>\n`);
    writeFileSync(join(work, 'config', 'sanitize-scan.sh'), readFileSync(TRUSTED_SCAN));
    return { CHOS_WORK: work, CHOS_URL: join(T, 'remote.git'), SWAP_URL: join(T, 'remote.git') };
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
      sed -i.bak "s/:22/:2222/" wt-conflict/app.conf && rm wt-conflict/app.conf.bak`);
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
    expect(sh('git -C wt-detached rev-parse HEAD')).toBe(sh('git -C remote.git rev-parse main~1'));
    expect(sh("git -C clone for-each-ref refs/pre-rewrite/heads --format='%(refname)'")).toContain(
      'refs/pre-rewrite/heads/local-only',
    );
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
});
