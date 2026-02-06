import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock env-paths to return our test directory
vi.mock('./env-paths', () => ({
  DATA_DIR: '/tmp/test-data-dir',
}));

import { UserSettingsStore, DEFAULT_MODEL } from './user-settings-store';

describe('UserSettingsStore', () => {
  let store: UserSettingsStore;
  let testDir: string;

  beforeEach(() => {
    // Create temp directory for each test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-settings-test-'));
    store = new UserSettingsStore(testDir);
  });

  afterEach(() => {
    // Clean up temp directory
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('ensureUserExists', () => {
    it('should create new settings for user that does not exist', () => {
      const userId = 'U_NEW_USER';
      const slackName = 'New User';

      const result = store.ensureUserExists(userId, slackName);

      expect(result.userId).toBe(userId);
      expect(result.slackName).toBe(slackName);
      expect(result.defaultDirectory).toBe('');
      expect(result.bypassPermission).toBe(false);
      expect(result.persona).toBe('default');
      expect(result.defaultModel).toBe(DEFAULT_MODEL);
      expect(result.lastUpdated).toBeDefined();
    });

    it('should return existing settings if user already exists', () => {
      const userId = 'U_EXISTING';
      const slackName = 'Existing User';

      // Create user first
      store.ensureUserExists(userId, slackName);

      // Modify some settings
      store.setUserBypassPermission(userId, true);
      store.setUserPersona(userId, 'linus');

      // Call ensureUserExists again
      const result = store.ensureUserExists(userId, slackName);

      // Should preserve existing settings
      expect(result.bypassPermission).toBe(true);
      expect(result.persona).toBe('linus');
    });

    it('should update slackName if different from existing', () => {
      const userId = 'U_NAME_CHANGE';

      // Create user with original name
      store.ensureUserExists(userId, 'Original Name');

      // Call with new name
      const result = store.ensureUserExists(userId, 'Updated Name');

      expect(result.slackName).toBe('Updated Name');
    });

    it('should persist settings to file', () => {
      const userId = 'U_PERSIST';
      store.ensureUserExists(userId, 'Persist User');

      // Create new store instance pointing to same directory
      const store2 = new UserSettingsStore(testDir);
      const loaded = store2.getUserSettings(userId);

      expect(loaded).toBeDefined();
      expect(loaded?.userId).toBe(userId);
      expect(loaded?.slackName).toBe('Persist User');
    });

    it('should work without slackName parameter', () => {
      const userId = 'U_NO_NAME';

      const result = store.ensureUserExists(userId);

      expect(result.userId).toBe(userId);
      expect(result.slackName).toBeUndefined();
    });
  });

  describe('getUserSettings', () => {
    it('should return undefined for non-existent user', () => {
      const result = store.getUserSettings('U_NONEXISTENT');
      expect(result).toBeUndefined();
    });

    it('should return settings for existing user', () => {
      const userId = 'U_EXISTS';
      store.ensureUserExists(userId, 'Test User');

      const result = store.getUserSettings(userId);

      expect(result).not.toBeNull();
      expect(result?.userId).toBe(userId);
    });
  });

  describe('model aliases', () => {
    it('should resolve opus alias to latest opus model', () => {
      const result = store.resolveModelInput('opus');
      expect(result).toBe('claude-opus-4-6');
    });

    it('should display opus 4.6 name', () => {
      const display = store.getModelDisplayName('claude-opus-4-6' as any);
      expect(display).toBe('Opus 4.6');
    });
  });

  describe('settings migrations', () => {
    it('migrates legacy opus model defaults to the latest opus', () => {
      const userId = 'U_LEGACY_OPUS';
      const settingsPath = path.join(testDir, 'user-settings.json');
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          [userId]: {
            userId,
            defaultDirectory: '',
            bypassPermission: false,
            persona: 'default',
            defaultModel: 'claude-opus-4-5-20251101',
            lastUpdated: new Date().toISOString(),
          },
        }, null, 2),
        'utf8'
      );

      const store2 = new UserSettingsStore(testDir);
      const loaded = store2.getUserSettings(userId);

      expect(loaded?.defaultModel).toBe(DEFAULT_MODEL);
    });
  });
});
