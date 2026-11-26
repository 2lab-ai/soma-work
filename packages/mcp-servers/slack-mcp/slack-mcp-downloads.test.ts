import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pruneOldDownloads } from './helpers/downloads';

describe('pruneOldDownloads', () => {
  it('removes downloads older than a week and keeps newer ones', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mcp-dl-'));
    try {
      const old = path.join(dir, '1_old.png');
      const fresh = path.join(dir, '2_new.png');
      fs.writeFileSync(old, 'x');
      fs.writeFileSync(fresh, 'x');
      const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
      fs.utimesSync(old, eightDaysAgo, eightDaysAgo);
      await pruneOldDownloads(dir);
      expect(fs.existsSync(old)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing directory is not an error', async () => {
    await expect(pruneOldDownloads(path.join(os.tmpdir(), 'slack-mcp-dl-missing-x'))).resolves.toBeUndefined();
  });
});
