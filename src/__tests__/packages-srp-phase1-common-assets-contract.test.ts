import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

interface PackageManifest {
  name?: string;
  exports?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')) as T;
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        out.push(fullPath);
      }
    }
  };
  walk(root);
  return out.sort();
}

describe('packages-srp Phase 1 common/assets contract', () => {
  it('@soma/common is a dependency sink and exposes the package-root assetPath helper', async () => {
    const manifestPath = path.join(repoRoot, 'packages/common/package.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = readJson<PackageManifest>('packages/common/package.json');
    expect(manifest.name).toBe('@soma/common');
    expect(manifest.files).toEqual(expect.arrayContaining(['dist']));
    expect(manifest.exports).toMatchObject({
      '.': './dist/index.js',
      './asset-path': './dist/asset-path.js',
    });

    const deps = {
      ...(manifest.dependencies || {}),
      ...(manifest.peerDependencies || {}),
      ...(manifest.optionalDependencies || {}),
    };
    expect(Object.keys(deps).filter((name) => name.startsWith('@soma/'))).toEqual([]);
    expect(Object.keys(deps).filter((name) => name.startsWith('@slack/'))).toEqual([]);
    expect(deps).not.toHaveProperty('@modelcontextprotocol/sdk');

    const sourceFiles = listFiles(path.join(repoRoot, 'packages/common/src')).filter((file) => file.endsWith('.ts'));
    expect(sourceFiles.length).toBeGreaterThan(0);
    for (const file of sourceFiles) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(
        /from ['"](@soma\/|somalib\/|\.\.\/\.\.\/src\/|@slack\/|@modelcontextprotocol\/sdk)/,
      );
    }

    const helperPath = path.join(repoRoot, 'packages/common/src/asset-path.ts');
    expect(fs.existsSync(helperPath)).toBe(true);
    const { assetPath } = await import(pathToFileURL(helperPath).href);
    const packageRoot = path.join(repoRoot, 'packages/extensions');
    expect(assetPath(packageRoot, 'prompt', 'workflows', 'deploy.prompt')).toBe(
      path.join(packageRoot, 'assets', 'prompt', 'workflows', 'deploy.prompt'),
    );
  });

  it('@soma/common owns the existing common utilities while src keeps compatibility shims', () => {
    const movedModules = [
      ['logger.ts', 'logger'],
      ['path-utils.ts', 'path-utils'],
      ['env-paths.ts', 'env-paths'],
      ['format/display-title.ts', 'format/display-title'],
      ['format/duration.ts', 'format/duration'],
      ['util/format-rate-limited-at.ts', 'util/format-rate-limited-at'],
      ['utils/dir-size.ts', 'utils/dir-size'],
    ];

    for (const [relativePath, importPath] of movedModules) {
      const packageSource = path.join(repoRoot, 'packages/common/src', relativePath);
      const legacySource = path.join(repoRoot, 'src', relativePath);

      expect(fs.existsSync(packageSource), packageSource).toBe(true);
      expect(fs.existsSync(legacySource), legacySource).toBe(true);

      const legacyText = fs.readFileSync(legacySource, 'utf8');
      expect(legacyText, legacySource).toContain(`@soma/common/${importPath}`);
      expect(legacyText, legacySource).not.toMatch(/class Logger|function normalizeTmpPath|function formatDuration/);
    }
  });

  it('@soma/extensions owns prompt/persona/local assets with executable hook bits preserved', () => {
    const manifestPath = path.join(repoRoot, 'packages/extensions/package.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = readJson<PackageManifest>('packages/extensions/package.json');
    expect(manifest.name).toBe('@soma/extensions');
    expect(manifest.dependencies).toMatchObject({ '@soma/common': '*' });
    expect(manifest.files).toEqual(expect.arrayContaining(['dist', 'assets']));
    expect(manifest.scripts).toMatchObject({ 'smoke:assets': 'node scripts/smoke-assets.js' });

    const rootScripts = readJson<PackageManifest>('package.json').scripts;
    expect(rootScripts).toMatchObject({
      'smoke:assets': 'npm run smoke:assets --workspaces --if-present',
    });

    const requiredAssets = [
      'assets/prompt/default.prompt',
      'assets/prompt/workflows/deploy.prompt',
      'assets/persona/default.md',
      'assets/local/agents/orchestrator.md',
      'assets/local/hooks/hook-proxy.sh',
      'assets/local/hooks/stop-hook.sh',
      'assets/local/hooks/todo-guard.sh',
      'assets/local/skills/z/SKILL.md',
    ];

    for (const asset of requiredAssets) {
      expect(fs.existsSync(path.join(repoRoot, 'packages/extensions', asset)), asset).toBe(true);
    }

    const hookFiles = listFiles(path.join(repoRoot, 'packages/extensions/assets/local/hooks')).filter((file) =>
      file.endsWith('.sh'),
    );
    expect(hookFiles.length).toBeGreaterThan(0);
    for (const hookFile of hookFiles) {
      expect(fs.statSync(hookFile).mode & 0o111, hookFile).not.toBe(0);
    }
  });

  it('@soma/test-utils packages reusable test factories without depending on app source paths', () => {
    const manifestPath = path.join(repoRoot, 'packages/test-utils/package.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = readJson<PackageManifest>('packages/test-utils/package.json');
    expect(manifest.name).toBe('@soma/test-utils');
    expect(manifest.files).toEqual(expect.arrayContaining(['dist']));
    expect(manifest.exports).toMatchObject({
      '.': './dist/index.js',
    });

    const requiredSources = [
      'src/mock-claude-handler.ts',
      'src/mock-session.ts',
      'src/mock-slack-api.ts',
      'src/index.ts',
    ];
    for (const source of requiredSources) {
      expect(fs.existsSync(path.join(repoRoot, 'packages/test-utils', source)), source).toBe(true);
    }

    const sourceFiles = listFiles(path.join(repoRoot, 'packages/test-utils/src')).filter((file) =>
      file.endsWith('.ts'),
    );
    for (const file of sourceFiles) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/from ['"](\.\.\/\.\.\/src\/|src\/|somalib\/)/);
    }
  });
});
