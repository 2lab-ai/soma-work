import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * Contract between the dev-daily-report SKILL.md and its bundled engine. Offline only:
 *  - frontmatter names the skill with a quoted "Use when" description;
 *  - every `$SK/scripts/<file>` the skill names ships, compiles, and takes the flags the skill passes;
 *  - the engine's own suite (__tests__/py) passes — fixture store, no network, no gh;
 *  - the skill text carries no environment binding (host, org, channel).
 */

vi.setConfig({ testTimeout: 120_000 });

const SKILL_ROOT = resolve(__dirname, '..');
const SCRIPTS = resolve(SKILL_ROOT, 'scripts');
const md = readFileSync(resolve(SKILL_ROOT, 'SKILL.md'), 'utf8');
const py = (args: string[]) => spawnSync('python3', ['-B', ...args], { encoding: 'utf8', timeout: 110_000 });

/** Each `$SK/scripts/<file> …` the skill tells the model to run: [file, the rest of that code span]. */
function scriptCalls(): Array<[string, string]> {
  const calls: Array<[string, string]> = [];
  for (const span of md.match(/`[^`\n]*\$SK\/scripts\/[^`\n]*`/g) ?? []) {
    for (const m of span.matchAll(/\$SK\/scripts\/([\w.-]+)"?([^`]*)/g)) calls.push([m[1], m[2]]);
  }
  return calls;
}

describe('local:dev-daily-report — SKILL.md and its engine', () => {
  it('frontmatter: name and a quoted one-line when-only description with triggers', () => {
    const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    expect(fm).toMatch(/^name: dev-daily-report$/m);
    const description = fm.match(/^description: "(.*)"$/m)?.[1] ?? '';
    expect(description).toMatch(/^Use when /);
    expect(description).toContain("'dev-daily-report'");
    expect(description.length).toBeLessThanOrEqual(400);
  });

  it('names only scripts that ship, and every shipped script is named', () => {
    const named = new Set(scriptCalls().map(([file]) => file));
    const shipped = readdirSync(SCRIPTS).filter((f) => f.endsWith('.py') && f !== 'report_common.py');
    expect([...named].sort()).toEqual(shipped.sort());
  });

  it('every flag the skill passes is one the script accepts', () => {
    for (const [file, rest] of scriptCalls()) {
      const help = py([resolve(SCRIPTS, file), '--help']);
      expect(help.status, `${file} --help: ${help.stderr}`).toBe(0);
      for (const flag of rest.match(/--[a-z][\w-]*/g) ?? []) {
        expect(help.stdout, `${file} does not take ${flag}`).toContain(flag);
      }
    }
  });

  it('the engine compiles', () => {
    const files = readdirSync(SCRIPTS)
      .filter((f) => f.endsWith('.py'))
      .map((f) => resolve(SCRIPTS, f));
    const out = spawnSync(
      'python3',
      ['-B', '-c', 'import ast,sys\nfor p in sys.argv[1:]: ast.parse(open(p).read(), p)', ...files],
      {
        encoding: 'utf8',
      },
    );
    expect(out.status, out.stderr).toBe(0);
  });

  it('the offline engine suite passes', () => {
    const run = py([resolve(__dirname, 'py', 'dev_daily_report_test.py')]);
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stderr).toMatch(/\nOK/);
  });

  it('cron guidance states UTC evaluation (09:00 KST = 0 0 * * *)', () => {
    expect(md).toContain('evaluated in UTC');
    expect(md).toContain('`0 0 * * *`');
  });

  it('carries no environment binding', () => {
    expect(md).not.toMatch(/\/Users\/|\/opt\/review-of-legends|C0[A-Z0-9]{8,}|xox[bp]-/);
  });
});
