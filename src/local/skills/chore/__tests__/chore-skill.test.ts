import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * Contract between the chore SKILL.md and its bundled engine. Fast checks only (no network, no registry):
 * the full engine suites under __tests__/py run in .github/workflows/chore-engine.yml.
 *
 *  - every `$ENGINE/<file>` the skill names ships in scripts/, and every flag it passes is one the tool takes;
 *  - the engine parses (py_compile, bash -n) and `check-plan` accepts / rejects plan fixtures offline;
 *  - a repo command without CHORE_REPOS_MD is a usage error naming it (no default registry path);
 *  - the skill text carries no environment binding.
 */

// Every test here spawns python3 or bash; the 5 s default is too tight on a loaded runner.
vi.setConfig({ testTimeout: 60_000 });

const SKILL_ROOT = resolve(__dirname, '..');
const SCRIPTS = resolve(SKILL_ROOT, 'scripts');
const CHORE_SH = resolve(SCRIPTS, 'chore.sh');
const V4 = resolve(__dirname, 'fixtures', 'chore-v4');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const JUDGE_PROMPT = resolve(SKILL_ROOT, 'judge-prompt.md');
const md = readFileSync(SKILL_MD, 'utf8');
const scratch = mkdtempSync(join(tmpdir(), 'chore-skill-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The environment with no registry: the engine must not fall back to any path of its own. */
function envWithoutRegistry(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CHORE_REPOS_MD;
  delete env.CHORE_ENV_FILE;
  return env;
}

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = envWithoutRegistry()) =>
  spawnSync(cmd, args, { encoding: 'utf8', env, cwd: scratch, timeout: 30_000 });

/** `python3 -I -B`: isolated, and no __pycache__ written next to the engine. */
const py = (args: string[]) => run('python3', ['-I', '-B', ...args]);

/** Each inline code span that runs a bundled tool: [tool file, the span's text after it]. */
function engineCalls(): Array<[string, string]> {
  const calls: Array<[string, string]> = [];
  for (const span of md.match(/`[^`\n]*\$ENGINE\/[^`\n]*`/g) ?? []) {
    for (const m of span.matchAll(/\$ENGINE\/([\w.-]+)"?([^`]*)/g)) if (m[2].trim()) calls.push([m[1], m[2]]);
  }
  return calls;
}

describe('local:chore — SKILL.md names a bundled engine that exists', () => {
  it('frontmatter: name chore, a quoted one-line description with its args and the registry env', () => {
    const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    expect(fm).toMatch(/^name: chore$/m);
    const description = fm.match(/^description: "(.*)"$/m)?.[1] ?? '';
    expect(description).toContain("'/chore'");
    expect(description).toContain('CHORE_REPOS_MD');
    expect(description).toMatch(/Args — target repo \(required/);
    expect(description).toMatch(/NOT for /);
  });

  it('every $ENGINE/<file> it names is in scripts/, and judge-prompt.md sits next to SKILL.md', () => {
    const named = new Set([...md.matchAll(/\$ENGINE\/([\w.-]+)/g)].map((m) => m[1]));
    for (const f of ['chore.sh', 'chore-evidence.py', 'chore-judge.py', 'chore-render.py', 'chore-report.py']) {
      expect(named, f).toContain(f);
    }
    for (const f of named) expect(existsSync(resolve(SCRIPTS, f)), `scripts/${f}`).toBe(true);
    expect(md).toContain('[judge-prompt.md](judge-prompt.md)');
    expect(existsSync(JUDGE_PROMPT)).toBe(true);
  });

  it('resolves ENGINE through $CLAUDE_PLUGIN_ROOT and never assumes a shell variable survives a call', () => {
    const prose = md.replace(/\s+/g, ' ');
    expect(prose).toContain('ENGINE = `$CLAUDE_PLUGIN_ROOT/skills/chore/scripts`');
    expect(prose).toContain("two directories above this skill's base directory");
    expect(prose).toContain('shell state does not carry over');
    expect(prose).toContain('export ENGINE=<absolute path> CHORE_REPOS_MD=<registry>');
  });

  it('every chore.sh call sets the registry, and every python registry flag reads it', () => {
    const lines = md.split('\n');
    const shLines = lines.filter((l) => l.includes('"$ENGINE/chore.sh"'));
    expect(shLines.length).toBeGreaterThan(0);
    for (const l of shLines) expect(l, l).toMatch(/CHORE_REPOS_MD=<registry> "\$ENGINE\/chore\.sh"/);
    for (const l of lines.filter((x) => x.includes('--repos-md'))) {
      expect(l, l).toContain('--repos-md "$CHORE_REPOS_MD"');
    }
  });

  it('every flag a python command passes is one that tool (and its subcommand) accepts', () => {
    const calls = engineCalls().filter(([f]) => f.endsWith('.py'));
    expect(calls.length).toBeGreaterThan(0);
    const help = new Map<string, string>();
    const helpOf = (key: string, args: string[]) => {
      if (!help.has(key)) {
        const r = py(args);
        expect(r.status, `${key}: ${r.stderr}`).toBe(0);
        help.set(key, r.stdout);
      }
      return help.get(key) as string;
    };
    for (const [file, rest] of calls) {
      const tool = resolve(SCRIPTS, file);
      // The subcommand = the first bare word after the tool (`build`, `evidence`, `resolve`, `--site <site> search`).
      const sub = rest.split(/\s+/).find((t) => /^[a-z][a-z-]*$/.test(t));
      let accepted = helpOf(file, [tool, '--help']);
      if (sub && accepted.includes(sub)) accepted += helpOf(`${file} ${sub}`, [tool, sub, '--help']);
      for (const flag of rest.match(/--[a-z][a-z-]*/g) ?? []) {
        // Whole flag only: `--hold` must not pass on the strength of `--hold-area`.
        expect(accepted, `${file}${sub ? ` ${sub}` : ''} ${flag}`).toMatch(new RegExp(`${flag}(?![\\w-])`));
      }
    }
  });

  it('every flag a chore.sh command passes is in the usage line of that subcommand', () => {
    const header = readFileSync(CHORE_SH, 'utf8').split('\n');
    const calls = engineCalls().filter(([f]) => f === 'chore.sh');
    expect(calls.length).toBeGreaterThan(0);
    for (const [, rest] of calls) {
      const sub = rest.trim().split(/\s+/)[0];
      const usage = header.find((l) => new RegExp(`^#\\s+chore\\.sh ${sub}\\b`).test(l));
      expect(usage, `usage line for chore.sh ${sub}`).toBeDefined();
      for (const flag of rest.match(/--[a-z][a-z-]*/g) ?? []) {
        expect(usage, `${sub} ${flag}`).toMatch(new RegExp(`${flag}(?![\\w-])`));
      }
    }
  });
});

describe('local:chore — the engine parses and checks plans offline', () => {
  const pyFiles = readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.py'))
    .sort();

  it('ships python tools', () => {
    expect(pyFiles).toContain('chore_plan.py');
  });

  for (const f of pyFiles) {
    it(`py_compile ${f}`, () => {
      // cfile in the scratch dir: py_compile writes bytecode even under -B.
      const r = py([
        '-c',
        'import py_compile,sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)',
        resolve(SCRIPTS, f),
        join(scratch, `${f}c`),
      ]);
      expect(r.status, r.stderr).toBe(0);
    });
  }

  it('bash -n chore.sh', () => {
    const r = run('bash', ['-n', CHORE_SH]);
    expect(r.status, r.stderr).toBe(0);
  });

  it('check-plan accepts the valid v4 fixture without a registry', () => {
    const r = run('bash', [CHORE_SH, 'check-plan', '--plan', resolve(V4, 'valid.tsv')]);
    expect(r.status, r.stderr).toBe(0);
  });

  it('check-plan rejects an invalid v4 fixture', () => {
    const invalid = readdirSync(resolve(V4, 'invalid'))
      .filter((f) => f.endsWith('.tsv'))
      .sort();
    expect(invalid.length).toBeGreaterThan(0);
    const r = run('bash', [CHORE_SH, 'check-plan', '--plan', resolve(V4, 'invalid', invalid[0])]);
    expect(r.status, `${invalid[0]} was accepted`).not.toBe(0);
    expect(r.stderr).toMatch(/plan rejected/);
  });

  it('report without CHORE_REPOS_MD is a usage error naming it, and writes no plan', () => {
    const plan = join(scratch, 'no-registry', 'plan.tsv');
    const r = run('bash', [CHORE_SH, 'report', 'x', '--plan', plan]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('CHORE_REPOS_MD');
    expect(existsSync(plan)).toBe(false);
  });
});

describe('local:chore — no environment binding in the skill text', () => {
  // Environment-neutral markers only; private names are kept out of this public file and are caught by
  // the full-history sanitize gate (.github/workflows/sanitize-gate.yml). Character classes keep this
  // file itself clean under the same search.
  const MARKERS = new RegExp(
    ['/User[s]/', '192\\.168\\.', 'U0[9][A-Z0-9]{6}', 'fable-m5ma[x]', 'de[v]2', 'zbrai[n]', 'workflo[w]/'].join('|'),
    'i',
  );

  for (const [name, file] of [
    ['SKILL.md', SKILL_MD],
    ['judge-prompt.md', JUDGE_PROMPT],
  ] as const) {
    it(`${name} has no environment marker`, () => {
      const hits = readFileSync(file, 'utf8')
        .split('\n')
        .map((l, i) => [i + 1, l.match(MARKERS)?.[0]] as const)
        .filter(([, m]) => m)
        .map(([n, m]) => `${name}:${n}: ${m}`);
      expect(hits).toEqual([]);
    });
  }
});
