/**
 * The self-hosted workflows' own contract: who may run them, and what they run.
 *
 * Two workflows execute pull-request code on a persistent machine we own —
 * `.github/workflows/ci.yml` (the merge gate) and
 * `.github/workflows/sanitize-gate.yml` (the forbidden-pattern scan). The
 * repository is public and `pull_request` fires for forks, so each of them
 * carries a job-level `if` admitting pushes and same-repository PRs only.
 * They are asserted here independently, because a guard added to one and
 * forgotten on the other leaves the host just as reachable:
 *
 * 1. **Job-level matters.** The guard is evaluated before the job is dispatched,
 *    so an untrusted head commit is never checked out onto the host and no
 *    secret is ever materialised in a step environment. A step-level `if`, or a
 *    move to `pull_request_target`, would each look like a guard while removing
 *    the thing that makes it one.
 * 2. **The sanitize job is the sharper case.** Its step is handed
 *    `secrets.SANITIZE_PATTERNS` and runs `scripts/sanitize-scan.sh` — a file
 *    the pull request can rewrite. So the secret's path is pinned too: it
 *    reaches the step through `env:` only, no `run:` body interpolates it, and
 *    the script consumes it as a quoted shell variable.
 * 3. **CI's gate is the release gate.** `npm test` is threaded `vitest run` with
 *    a 5s timeout, and suites here swap process globals; PR #191's run
 *    32935347648 went red on exactly two `src/cli/__tests__/index.test.ts`
 *    status-json tests (a 5s teardown timeout, then a test reading concatenated
 *    JSON from the sinks that teardown never restored) on a file that passes
 *    114/114 under the release args. So CI runs `npm run test:release` — the
 *    same command `release-preview.yml` runs — and `test:release` keeps the
 *    exact args that make it deterministic.
 *
 * Assertions are text-and-structure scans of the workflows rather than a YAML
 * object graph, matching the precedent in `package-somawork.test.ts`: what
 * GitHub acts on is the literal text (`runs-on` labels, an expression string),
 * and a parser would normalise away the indentation and folding that decide
 * whether the expression GitHub receives is even well-formed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const CI_WORKFLOW = '.github/workflows/ci.yml';
const SANITIZE_WORKFLOW = '.github/workflows/sanitize-gate.yml';

/** The one expression both jobs must carry, as GitHub receives it: a single line. */
const SAME_REPO_GUARD =
  "github.event_name == 'push' || (github.event_name == 'pull_request' && " +
  'github.event.pull_request.head.repo.full_name == github.repository)';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/**
 * A job block — from its 2-space key to the next job key or end of file.
 * Scoping to the block is what makes "the guard is job-level, and it is above
 * every step" checkable at all.
 */
function jobBlock(workflowPath: string, jobName: string): string {
  const workflow = read(workflowPath);
  const start = workflow.indexOf(`\n  ${jobName}:\n`);
  expect(start, `${workflowPath} no longer defines a \`${jobName}\` job`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z_]/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** Every `run:` body in a job, keyed by the step name above it. */
function runSteps(workflowPath: string, jobName: string): { name: string; run: string }[] {
  const job = jobBlock(workflowPath, jobName);
  const steps: { name: string; run: string }[] = [];
  const marks: { name: string; at: number }[] = [];
  for (const match of job.matchAll(/^ {6}- name: (.+)$/gm)) marks.push({ name: match[1], at: match.index ?? 0 });
  for (let index = 0; index < marks.length; index += 1) {
    const slice = job.slice(marks[index].at, marks[index + 1]?.at ?? job.length);
    const run = slice.match(/\n {8}run: (.+)/);
    if (run) steps.push({ name: marks[index].name, run: run[1].trim() });
  }
  return steps;
}

/**
 * The shared guard assertion, applied to each self-hosted job independently.
 * Called from both suites below rather than looped over, so a failure names the
 * workflow that regressed.
 */
function expectSameRepoGuard(workflowPath: string, jobName: string): void {
  const job = jobBlock(workflowPath, jobName);
  const guard = job.match(/\n {4}if: >-\n((?: {6}.+\n)+)/);
  expect(guard, `the \`${jobName}\` job in ${workflowPath} has no job-level \`if:\` guard`).not.toBeNull();

  // Folded to exactly what GitHub must parse: one line, no embedded newline.
  // (A continuation line indented past the first is preserved verbatim by YAML
  // folding, which puts a raw newline inside the expression.)
  const expression = (guard?.[1] ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  expect(expression, `${workflowPath}:${jobName} guard expression`).toBe(SAME_REPO_GUARD);
  // The two load-bearing halves, by meaning as well as by shape: an allow-list
  // of events, and same-repository provenance of the head commit.
  expect(expression).toContain("github.event_name == 'push'");
  expect(expression).toContain('github.event.pull_request.head.repo.full_name == github.repository');

  // Job-level, i.e. above `steps:` and above the checkout — a guard placed on
  // steps still dispatches the job and still fetches the untrusted commit.
  const guardAt = job.indexOf('\n    if:');
  expect(guardAt).toBeGreaterThan(-1);
  expect(guardAt).toBeLessThan(job.indexOf('\n    steps:'));
  const checkoutAt = job.search(/\n {6}- uses: actions\/checkout/);
  expect(checkoutAt, `${workflowPath}:${jobName} has no checkout step`).toBeGreaterThan(-1);
  expect(guardAt).toBeLessThan(checkoutAt);

  // `pull_request_target` is the tempting "fix" that inverts the risk: it runs
  // with the base repo's secrets and write token. (Matched as a YAML key — both
  // workflow comments name it in prose to say it is not used.)
  expect(read(workflowPath)).not.toMatch(/^\s*pull_request_target:/m);
}

/**
 * The workflow's `GITHUB_TOKEN` scopes, asserted as a whole set rather than as a
 * substring: `contents: read` present tells you nothing if `packages: write`
 * sits on the next line. A job-level block would silently replace the top-level
 * one, so its absence is part of the assertion.
 */
function expectContentsReadOnly(workflowPath: string, jobNames: string[]): void {
  const workflow = read(workflowPath);
  const block = workflow.match(/^permissions:\n((?: {2}\S.*\n)+)/m);
  expect(block, `${workflowPath} has no top-level \`permissions:\` block`).not.toBeNull();

  const scopes = Object.fromEntries(
    (block?.[1] ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.trim().split(/:\s*/) as [string, string]),
  );
  expect(scopes, `${workflowPath} token scopes`).toEqual({ contents: 'read' });

  // Declared before the jobs it constrains, and not re-opened by any of them —
  // a job `permissions:` block replaces the top-level grant outright.
  expect(workflow.indexOf('\npermissions:')).toBeLessThan(workflow.indexOf('\njobs:'));
  for (const jobName of jobNames) {
    expect(
      jobBlock(workflowPath, jobName).match(/\n {4}permissions:/),
      `${workflowPath}:${jobName} overrides the top-level permissions`,
    ).toBeNull();
  }
}

describe('CI workflow contract', () => {
  it('still runs pull-request code on the self-hosted runner — the premise of the guard below', () => {
    // Not an aspiration: the org has no hosted-runner budget, so this is a
    // durable fact and the fork guard is not optional while it holds. If this
    // assertion ever fails because the job moved to a hosted runner, the guard
    // test below should be re-read as a policy choice rather than a necessity.
    expect(jobBlock(CI_WORKFLOW, 'quality-gates')).toContain('runs-on: [self-hosted, fable-m5max]');

    const workflow = read(CI_WORKFLOW);
    // …and it is still reachable from a pull request. A guard that works by
    // dropping the trigger would pass every check below while deleting the
    // merge gate itself.
    expect(workflow).toMatch(/^on:$/m);
    expect(workflow).toMatch(/^ {2}pull_request:$/m);
    expect(workflow).toMatch(/^ {2}push:$/m);
  });

  it('admits pushes and same-repository PRs only, before any step can run', () => {
    expectSameRepoGuard(CI_WORKFLOW, 'quality-gates');
  });

  it('gates merges with the same deterministic test command the release path uses', () => {
    const steps = runSteps(CI_WORKFLOW, 'quality-gates');
    const test = steps.find((step) => step.name === 'Test');
    expect(test, 'ci.yml has no step named `Test`').toBeDefined();
    expect(test?.run).toBe('npm run test:release');

    // No step may fall back to the threaded default — including a later one
    // added below the Test step.
    for (const step of steps) {
      expect(/(^|&&|;|\|\|)\s*npm test(\s|$)/.test(step.run), `${step.name} runs bare \`npm test\``).toBe(false);
    }

    // Same command as the release workflow: the point is that a merge and a
    // release are gated by one configuration, not two that can drift.
    expect(read('.github/workflows/release-preview.yml')).toContain('run: npm run test:release');
  });

  it('keeps the exact args that make `test:release` deterministic', () => {
    // Isolated forked workers are what stop one suite's process-global swap
    // from leaking into the next; the raised timeouts are what stop a slow
    // teardown from being reported as a failing test. Dropping any of them
    // silently returns CI to the PR #191 failure shape.
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts['test:release']).toBe(
      'vitest run --pool=forks --isolate --maxWorkers=1 --testTimeout=30000 --hookTimeout=120000',
    );
    expect(scripts.test).toBe('vitest run');
  });

  it('runs the gate with a read-only token', () => {
    // Nothing in this workflow publishes, and `npm ci` runs third-party install
    // scripts on a persistent host — a write-capable default token would be
    // reachable from any of them. The publishing workflows declare their own
    // `contents: write`; this one must not drift into matching them.
    expectContentsReadOnly(CI_WORKFLOW, ['quality-gates']);
  });
});

describe('sanitize gate workflow contract', () => {
  it('still runs pull-request code on the self-hosted runner, with a secret in scope', () => {
    const job = jobBlock(SANITIZE_WORKFLOW, 'scan');
    expect(job).toContain('runs-on: [self-hosted, fable-m5max]');
    expect(job).toContain('SANITIZE_PATTERNS');

    const workflow = read(SANITIZE_WORKFLOW);
    // The gate must keep firing on PRs — silencing the trigger would satisfy a
    // guard check while removing the scan that protects published history.
    expect(workflow).toMatch(/^on:$/m);
    expect(workflow).toMatch(/^ {2}pull_request:$/m);
    expect(workflow).toMatch(/^ {2}push:$/m);
  });

  it('admits pushes and same-repository PRs only, before any step can run', () => {
    // Asserted separately from ci.yml on purpose: this guard is the one standing
    // between a fork-authored `scripts/sanitize-scan.sh` and the secret.
    expectSameRepoGuard(SANITIZE_WORKFLOW, 'scan');
  });

  it('keeps the scan secret env-only and its command uninterpolated', () => {
    const workflow = read(SANITIZE_WORKFLOW);
    // `${{ … }}` is substituted textually before the shell parses the line, so a
    // secret reaching a `run:` body would be one quote away from executing —
    // and, on this runner, from being echoed into a public log.
    expect(workflow).toMatch(/\n {8}env:\n {10}SANITIZE_PATTERNS: \$\{\{ secrets\.SANITIZE_PATTERNS \}\}\n/);
    for (const step of runSteps(SANITIZE_WORKFLOW, 'scan')) {
      expect(step.run.includes('${{'), `${step.name} interpolates an expression into a shell body`).toBe(false);
    }

    // The command itself is unchanged: the trusted script, invoked with no
    // arguments derived from the event.
    const steps = runSteps(SANITIZE_WORKFLOW, 'scan');
    expect(steps.map((step) => step.run)).toEqual(['bash scripts/sanitize-scan.sh']);

    // …and the script reads the secret from the environment and quotes it, so
    // a pattern containing shell metacharacters stays one grep argument.
    const script = read('scripts/sanitize-scan.sh');
    // Regex, not a string literal: the literal form reads as an unterminated
    // JS template placeholder to Biome.
    expect(script).toMatch(/P="\$\{SANITIZE_PATTERNS:-\}"/);
    expect(script).toMatch(/-E "\$P"/);
  });

  it('runs the scan with a read-only token', () => {
    // A repository secret plus a write-capable token on a self-hosted runner is
    // the combination the same-repo guard exists to keep away from forks;
    // narrowing the token means the guard is not the only thing standing there.
    expectContentsReadOnly(SANITIZE_WORKFLOW, ['scan']);
  });
});
