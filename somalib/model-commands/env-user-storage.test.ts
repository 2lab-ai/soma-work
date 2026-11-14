import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { l1FilePath, legacyL1FilePath, memoryRoot, migrateLegacyL1 } from './hierarchical-memory-store';
import { MemoryFileStore } from './memory-file-store';
import { memoryLockPath, withMemoryLock } from './memory-lock';
import { isSafeUserIdSegment } from './memory-page-id';
import { SkillFileStore } from './skill-file-store';

// An environment user (`env:<name>`) runs sessions like any other user: its data lives under
// `{dataDir}/env:<name>/` next to its skills. Its memory and skill stores take that id; a live run on a dev
// host failed before the model was called because the memory path check refused the `:`.

const ENV_USER = 'env:acme-dev2';

function tmpData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'envuser-store-'));
}

describe('environment user ids in memory and skill storage', () => {
  it('memory paths are built for an environment user, under its own folder', () => {
    const data = tmpData();
    expect(memoryRoot(data, ENV_USER)).toBe(path.join(data, ENV_USER, 'memory'));
    expect(l1FilePath(data, ENV_USER, 'memory')).toBe(path.join(data, ENV_USER, 'memory', 'MEMORY.md'));
    expect(legacyL1FilePath(data, ENV_USER, 'user')).toBe(path.join(data, ENV_USER, 'USER.md'));
    expect(() => migrateLegacyL1(data, ENV_USER, 'memory')).not.toThrow();
    expect(memoryLockPath(data, ENV_USER)).toBe(path.join(data, ENV_USER, 'memory', '.lock'));
    expect(withMemoryLock(data, ENV_USER, () => 'held')).toBe('held');
  });

  it("the model-command stores read and write an environment user's memory and list its skills", () => {
    const data = tmpData();
    const memory = new MemoryFileStore(data);
    expect(memory.addMemory(ENV_USER, 'memory', 'deploy lane lock lives in the lane folder').ok).toBe(true);
    expect(fs.readFileSync(path.join(data, ENV_USER, 'memory', 'MEMORY.md'), 'utf-8')).toContain('deploy lane lock');

    fs.mkdirSync(path.join(data, ENV_USER, 'skills', 'deploy'), { recursive: true });
    fs.writeFileSync(
      path.join(data, ENV_USER, 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: deploy dev2\n---\nbody\n',
    );
    expect(new SkillFileStore(data).listSkills(ENV_USER).map((s) => s.name)).toEqual(['deploy']);
  });

  it('only the env: prefix is let through: anything that could leave the data folder is still refused', () => {
    expect(isSafeUserIdSegment('U0ABC123')).toBe(true);
    expect(isSafeUserIdSegment(ENV_USER)).toBe(true);
    for (const bad of ['', 'env:', 'env:..', 'env:.', 'env:a/b', 'env:../x', 'env:a\\b', 'x:y', 'env:env:a', '..']) {
      expect(isSafeUserIdSegment(bad), bad).toBe(false);
    }
    const data = tmpData();
    expect(() => memoryRoot(data, 'env:..')).toThrow(/Invalid userId/);
    expect(() => memoryLockPath(data, 'x:y')).toThrow(/Invalid userId/);
    expect(() => new MemoryFileStore(data).addMemory('env:a/b', 'memory', 'x')).toThrow(/Invalid userId/);
    expect(() => new SkillFileStore(data).listSkills('env:../x')).toThrow(/Invalid userId/);
  });
});
