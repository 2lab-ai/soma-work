import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('deploy bundle contract', () => {
  it('keeps deploy workflow on script-based bundle sync instead of legacy split rsync', () => {
    const workflow = read('.github/workflows/deploy.yml');

    expect(workflow).toContain('npm run smoke:mcp-bins');
    expect(workflow).toContain('npm run smoke:assets');
    expect(workflow).toContain('bash scripts/deploy/stage-bundle.sh');
    expect(workflow).toContain('npm run smoke:deploy-bundle');
    expect(workflow).toContain('scripts/deploy/sync-bundle.sh');
    expect(workflow).toContain('scripts/deploy/install-target.sh');
    expect(workflow).not.toMatch(/rsync\s+-a\s+--delete\s+mcp-servers\//);
    expect(workflow).not.toMatch(/rsync\s+-a\s+--delete\s+somalib\//);
  });

  it('defines the deploy scripts and protected target paths used by bundle sync', () => {
    const requiredFiles = [
      'deploy/protected-paths.txt',
      'scripts/deploy/stage-bundle.sh',
      'scripts/deploy/sync-bundle.sh',
      'scripts/deploy/install-target.sh',
      'scripts/smoke/mcp-bins.js',
      'scripts/smoke/deploy-bundle.js',
    ];

    for (const file of requiredFiles) {
      expect(fs.existsSync(path.join(repoRoot, file)), file).toBe(true);
    }

    const protectedPaths = read('deploy/protected-paths.txt').split(/\r?\n/).filter(Boolean);
    expect(protectedPaths).toEqual(
      expect.arrayContaining([
        '.env',
        '.system.prompt',
        'config.json',
        'mcp-servers.json',
        'data/',
        'logs/',
        '.claude/',
      ]),
    );
  });
});
