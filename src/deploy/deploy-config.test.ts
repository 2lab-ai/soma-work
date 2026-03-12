import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('deploy config expectations', () => {
  it('deploy workflow bootstraps main from macmini legacy paths before install', () => {
    const workflow = read('.github/workflows/deploy.yml');

    expect(workflow).toContain('"target_dir":"/opt/soma-work/main"');
    expect(workflow).toContain('node dist/deploy/main-env-bootstrap.js');
    expect(workflow).toContain('/Users/dd/app.claude-code-slack-bot');
  });

  it('supporting setup scripts and docs reference the dev branch consistently', () => {
    const files = [
      'scripts/setup/05-system-prompt.sh',
      'scripts/setup/07-deploy-dirs.sh',
      'scripts/setup/09-github-environments.sh',
      'scripts/new-deploy-setup.sh',
      'docs/add-new-deploy.md',
    ];

    for (const file of files) {
      expect(read(file)).not.toMatch(/\bdevelop\b/);
    }
  });
});
