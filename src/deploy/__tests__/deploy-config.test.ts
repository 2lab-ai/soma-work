import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('deploy config expectations', () => {
  it('deploy workflow routes main to dev targets and deploy/prod to the production target', () => {
    const workflow = read('.github/workflows/deploy.yml');

    expect(workflow).toContain('branches: [deploy/dev, deploy/prod]');
    // Topology moved out of the repo into Actions variables ({runner}:{target-dir}
    // line lists) — the workflow must route deploy/prod to the production list and
    // everything else to the preview list, and build the matrix from the lines.
    expect(workflow).toContain(
      "RAW: ${{ github.ref_name == 'deploy/prod' && vars.PRODUCTION_DEPLOY_TARGETS || vars.PREVIEW_DEPLOY_TARGETS }}",
    );
    expect(workflow).toContain("DEPLOY_ENV_NAME: ${{ github.ref_name == 'deploy/prod' && 'main' || 'dev' }}");
    expect(workflow).toContain('runner_label: $p[0]');
    expect(workflow).toContain('target_dir: ($p[1:] | join(":"))');
    expect(workflow).toContain('node dist/deploy/main-env-bootstrap.js');
    expect(workflow).toContain('/Users/dd/app.claude-code-slack-bot');
  });

  it('supporting setup scripts and docs use main as the default PR target and deploy/prod for production deploys', () => {
    const promptSetup = read('scripts/setup/05-system-prompt.sh');
    const deployDirs = read('scripts/setup/07-deploy-dirs.sh');
    const environments = read('scripts/setup/09-github-environments.sh');
    const deployDoc = read('docs/runbook/add-new-deploy.md');
    const prFixWorkflow = read('src/prompt/workflows/pr-fix-and-update.prompt');
    const versionBump = read('scripts/version-bump.sh');

    expect(promptSetup).toContain('Default PR target branch" "pr_target" "main"');
    expect(deployDirs).toContain('(branch: deploy/prod)');
    expect(deployDirs).toContain('(branch: main)');
    expect(environments).toContain('--field name="deploy/prod"');
    expect(environments).toContain('--field name="main"');
    // `scripts/new-deploy-setup.sh` no longer carries deploy topology: it is a
    // deprecation shim into `somawork setup`, whose contract lives in
    // `scripts/__tests__/legacy-setup-shims.test.ts`.
    expect(deployDoc).toContain('main 브랜치가 macmini와 oudwood-512의 `/opt/soma-work/dev`로 배포');
    expect(deployDoc).toContain('deploy/prod 브랜치는 macmini의 `/opt/soma-work/main`으로 배포');
    expect(prFixWorkflow).toContain('git rebase origin/main');
    expect(prFixWorkflow).toContain('origin/main...HEAD');
    expect(versionBump).toContain('deploy/prod');
    expect(versionBump).not.toMatch(/\borigin\/develop\b/);
  });

  it('deploy step merges the per-runner env plugins into config.json after the sync and before the restart', () => {
    const workflow = read('.github/workflows/deploy.yml');

    // Secrets, not variables: a step's env header prints `vars.*` values into the
    // public run log, a secret prints as ***. And each channel reads only its own
    // list — an `a && X || Y` expression would hand a production deploy the
    // preview list whenever the production one is unset (empty is falsy).
    expect(workflow).toContain('ENV_PLUGINS_PREVIEW: ${{ secrets.PREVIEW_ENV_PLUGINS }}');
    expect(workflow).toContain('ENV_PLUGINS_PRODUCTION: ${{ secrets.PRODUCTION_ENV_PLUGINS }}');
    expect(workflow).not.toMatch(/vars\.(PREVIEW|PRODUCTION)_ENV_PLUGINS/);
    expect(workflow).not.toMatch(/PRODUCTION_ENV_PLUGINS\s*\|\|/);
    expect(workflow).not.toMatch(/\|\|\s*secrets\.PREVIEW_ENV_PLUGINS/);
    expect(workflow).toContain(
      [
        'if [[ "$ENV" == "main" ]]; then',
        '            export ENV_PLUGINS="$ENV_PLUGINS_PRODUCTION"',
        '          else',
        '            export ENV_PLUGINS="$ENV_PLUGINS_PREVIEW"',
        '          fi',
      ].join('\n'),
    );
    expect(workflow).toContain('RUNNER_LABEL: ${{ matrix.runner_label }}');

    // The channel's whole runner-label set, taken BEFORE the manual `targets`
    // narrowing, so a line naming a label outside it is a typo the check catches.
    expect(workflow).toContain('runner_labels: ${{ steps.targets.outputs.runner_labels }}');
    expect(workflow).toContain('CHANNEL_RUNNER_LABELS: ${{ needs.prepare.outputs.runner_labels }}');
    const labels = workflow.indexOf('runner_labels=$(jq -r \'[.include[].runner_label] | unique | join(",")\'');
    const narrow = workflow.indexOf('SELECT_NORM="$(tr -d');
    expect(labels).toBeGreaterThan(-1);
    expect(narrow).toBeGreaterThan(labels);
    expect(workflow).toContain('echo "runner_labels=$runner_labels" >> "$GITHUB_OUTPUT"');

    // Validate while the old service still runs; apply between the sync and the
    // restart; and the restarted daemon inherits none of it.
    const select = workflow.indexOf('export ENV_PLUGINS="$ENV_PLUGINS_PRODUCTION"');
    const check = workflow.indexOf('node dist/deploy/apply-env-plugins.js --check "$TARGET"');
    const stop = workflow.indexOf('bash scripts/service.sh "$ENV" stop');
    const sync = workflow.indexOf('bash scripts/deploy/sync-bundle.sh "$TARGET" "."');
    const apply = workflow.indexOf('node dist/deploy/apply-env-plugins.js "$TARGET"');
    const unset = workflow.indexOf(
      'unset ENV_PLUGINS ENV_PLUGINS_PREVIEW ENV_PLUGINS_PRODUCTION RUNNER_LABEL CHANNEL_RUNNER_LABELS',
    );
    const install = workflow.indexOf('bash scripts/deploy/install-target.sh "$TARGET"');
    expect(select).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(select);
    expect(stop).toBeGreaterThan(check);
    expect(sync).toBeGreaterThan(stop);
    expect(apply).toBeGreaterThan(sync);
    expect(unset).toBeGreaterThan(apply);
    expect(install).toBeGreaterThan(unset);
  });
});
