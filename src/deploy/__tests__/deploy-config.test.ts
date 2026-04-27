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
    expect(workflow).toContain('deploy/prod)');
    expect(workflow).toContain('"name":"mac-mini-dev"');
    expect(workflow).toContain('"name":"oudwood-dev"');
    expect(workflow).toContain('"deploy_env":"dev"');
    expect(workflow).toContain('"target_dir":"/opt/soma-work/dev"');
    expect(workflow).toContain('"target_dir":"/opt/soma-work/main"');
    expect(workflow).toContain('node dist/deploy/main-env-bootstrap.js');
    expect(workflow).toContain('/Users/dd/app.claude-code-slack-bot');
  });

  it('supporting setup scripts and docs use main as the default PR target and deploy/prod for production deploys', () => {
    const promptSetup = read('scripts/setup/05-system-prompt.sh');
    const deployDirs = read('scripts/setup/07-deploy-dirs.sh');
    const environments = read('scripts/setup/09-github-environments.sh');
    const newDeploySetup = read('scripts/new-deploy-setup.sh');
    const deployDoc = read('docs/add-new-deploy.md');
    const prFixWorkflow = read('src/prompt/workflows/pr-fix-and-update.prompt');
    const versionBump = read('scripts/version-bump.sh');

    expect(promptSetup).toContain('Default PR target branch" "pr_target" "main"');
    expect(deployDirs).toContain('(branch: deploy/prod)');
    expect(deployDirs).toContain('(branch: main)');
    expect(environments).toContain('--field name="deploy/prod"');
    expect(environments).toContain('--field name="main"');
    expect(newDeploySetup).toContain('PR target: main');
    expect(deployDoc).toContain('main 브랜치가 macmini와 oudwood-512의 `/opt/soma-work/dev`로 배포');
    expect(deployDoc).toContain('deploy/prod 브랜치는 macmini의 `/opt/soma-work/main`으로 배포');
    expect(prFixWorkflow).toContain('git rebase origin/main');
    expect(prFixWorkflow).toContain('origin/main...HEAD');
    expect(versionBump).toContain('deploy/prod');
    expect(versionBump).not.toMatch(/\borigin\/develop\b/);
  });
});
