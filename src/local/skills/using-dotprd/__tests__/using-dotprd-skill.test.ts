import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * Contract for the bundled tools of local:using-dotprd.
 *
 *  - The SKILL.md reaches every bundled file through
 *    `$CLAUDE_PLUGIN_ROOT/skills/using-dotprd/<path>`, and each such path exists.
 *  - loop-lint.py passes its own fixtures (run isolated, stdlib only).
 *  - parity-sheet.py composes REF over IMPL at a fixed width, whether the
 *    label flags come before or after the positionals.
 */

// Every test here spawns python3 (the loop-lint selftest also runs git); the 5 s default is too tight on a loaded runner.
vi.setConfig({ testTimeout: 60_000 });

const SKILL_ROOT = resolve(__dirname, '..');
const LOOP_LINT = resolve(SKILL_ROOT, 'scripts', 'loop-lint.py');
const PARITY_SHEET = resolve(SKILL_ROOT, 'scripts', 'parity-sheet.py');
const BUNDLED = ['scripts/loop-lint.py', 'scripts/parity-sheet.py', 'templates/loop.done.template.md'];
const md = () => readFileSync(resolve(SKILL_ROOT, 'SKILL.md'), 'utf8');
const hasPillow = spawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8' }).status === 0;
const scratch = mkdtempSync(join(tmpdir(), 'using-dotprd-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('local:using-dotprd — SKILL.md and its bundled files', () => {
  it('is named using-dotprd and describes WHEN + Args + NOT in one quoted line', () => {
    expect(md()).toMatch(/^name: using-dotprd$/m);
    const description = md().match(/^description: "(.*)"$/m)?.[1] ?? '';
    expect(description).toContain('/using-dotprd');
    expect(description).toContain('Args');
    expect(description).toContain('NOT for');
  });

  it('every $CLAUDE_PLUGIN_ROOT/skills/using-dotprd/ path it names exists in the skill folder', () => {
    const named = [...md().matchAll(/\$CLAUDE_PLUGIN_ROOT\/skills\/using-dotprd\/([A-Za-z0-9._/-]+)/g)].map((m) =>
      m[1].replace(/\.+$/, ''),
    );
    for (const rel of BUNDLED) expect(named, rel).toContain(rel);
    for (const rel of named) expect(existsSync(resolve(SKILL_ROOT, rel)), rel).toBe(true);
  });

  it('both scripts keep the executable bit', () => {
    for (const script of [LOOP_LINT, PARITY_SHEET]) {
      expect(statSync(script).mode & 0o111, script).not.toBe(0);
    }
  });

  it('both scripts byte-compile', () => {
    // py_compile with the .pyc in scratch, so no __pycache__ lands in the skill folder.
    const code = 'import py_compile, sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)';
    for (const [i, script] of [LOOP_LINT, PARITY_SHEET].entries()) {
      const r = spawnSync('python3', ['-I', '-c', code, script, join(scratch, `c${i}.pyc`)], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
  });
});

describe('local:using-dotprd — loop-lint.py', () => {
  it('passes its own fixtures', () => {
    const r = spawnSync('python3', ['-I', LOOP_LINT, '--selftest'], { encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^selftest: PASS /m);
  });
});

describe('local:using-dotprd — parity-sheet.py', () => {
  it.skipIf(!hasPillow)(
    'stacks REF over IMPL at 1800 px wide, with label flags before or after the positionals (needs Pillow; skipped when python3 cannot import PIL)',
    () => {
      const ref = join(scratch, 'ref.png');
      const impl = join(scratch, 'impl.png');
      const make = spawnSync(
        'python3',
        [
          '-c',
          [
            'import sys',
            'from PIL import Image',
            "Image.new('RGB', (100, 50), (200, 0, 0)).save(sys.argv[1])",
            "Image.new('RGB', (100, 100), (0, 0, 200)).save(sys.argv[2])",
          ].join('\n'),
          ref,
          impl,
        ],
        { encoding: 'utf8' },
      );
      expect(make.status, make.stderr).toBe(0);

      // 100x50 and 100x100 scale to 1800x900 and 1800x1800, plus two 44 px label bars.
      const runs: [string, string[]][] = [
        ['defaults.png', []],
        ['after.png', ['--label-ref', 'REF', '--label-impl', 'IMPL']],
        ['before.png', ['--label-ref', 'REF', '--label-impl', 'IMPL']],
      ];
      for (const [name, labels] of runs) {
        const out = join(scratch, name);
        const argv = name === 'before.png' ? [...labels, out, ref, impl] : [out, ref, impl, ...labels];
        const r = spawnSync('python3', [PARITY_SHEET, ...argv], { encoding: 'utf8' });
        expect(r.status, `${name}: ${r.stderr}`).toBe(0);
        expect(r.stdout).toContain(`parity sheet: ${out} (1800x2788)`);
        const size = spawnSync(
          'python3',
          ['-c', 'import sys\nfrom PIL import Image\nprint(Image.open(sys.argv[1]).size)', out],
          { encoding: 'utf8' },
        );
        expect(size.stdout.trim(), name).toBe('(1800, 2788)');
      }
    },
  );
});
