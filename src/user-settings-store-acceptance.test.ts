import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { UserSettingsStore } from './user-settings-store';

// Trace: Scenario 1 — Existing User Migration
// Trace: Scenario 2/3 — Acceptance gate data model

describe('UserSettingsStore — acceptance', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync('/tmp/uss-test-');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Scenario 1: Migration ──
  describe('migration: accepted field', () => {
    it('adds accepted=true to existing records without the field', () => {
      // Pre-populate with old-format data (no accepted field)
      const oldData = {
        U1: {
          userId: 'U1',
          defaultDirectory: '',
          bypassPermission: false,
          persona: 'default',
          defaultModel: 'claude-opus-4-6',
          lastUpdated: '2026-01-01',
        },
      };
      fs.writeFileSync(`${tmpDir}/user-settings.json`, JSON.stringify(oldData));

      const store = new UserSettingsStore(tmpDir);
      const settings = store.getUserSettings('U1');

      expect(settings?.accepted).toBe(true);
    });

    it('preserves existing accepted=true field', () => {
      const data = {
        U1: {
          userId: 'U1',
          defaultDirectory: '',
          bypassPermission: false,
          persona: 'default',
          defaultModel: 'claude-opus-4-6',
          lastUpdated: '2026-01-01',
          accepted: true,
          acceptedBy: 'U_ADMIN',
        },
      };
      fs.writeFileSync(`${tmpDir}/user-settings.json`, JSON.stringify(data));

      const store = new UserSettingsStore(tmpDir);
      const settings = store.getUserSettings('U1');

      expect(settings?.accepted).toBe(true);
      expect(settings?.acceptedBy).toBe('U_ADMIN');
    });

    it('preserves existing accepted=false field', () => {
      const data = {
        U1: {
          userId: 'U1',
          defaultDirectory: '',
          bypassPermission: false,
          persona: 'default',
          defaultModel: 'claude-opus-4-6',
          lastUpdated: '2026-01-01',
          accepted: false,
        },
      };
      fs.writeFileSync(`${tmpDir}/user-settings.json`, JSON.stringify(data));

      const store = new UserSettingsStore(tmpDir);
      const settings = store.getUserSettings('U1');

      expect(settings?.accepted).toBe(false);
    });
  });

  // ── New methods ──
  describe('createPendingUser', () => {
    it('creates user record with accepted=false', () => {
      const store = new UserSettingsStore(tmpDir);
      store.createPendingUser('U_NEW', 'New User');

      const settings = store.getUserSettings('U_NEW');
      expect(settings?.accepted).toBe(false);
      expect(settings?.userId).toBe('U_NEW');
      expect(settings?.slackName).toBe('New User');
    });
  });

  describe('acceptUser', () => {
    it('sets accepted=true with admin info', () => {
      const store = new UserSettingsStore(tmpDir);
      store.createPendingUser('U_NEW', 'New User');
      store.acceptUser('U_NEW', 'U_ADMIN');

      const settings = store.getUserSettings('U_NEW');
      expect(settings?.accepted).toBe(true);
      expect(settings?.acceptedBy).toBe('U_ADMIN');
      expect(settings?.acceptedAt).toBeTruthy();
    });

    it('accepts user who has no record yet (auto-create)', () => {
      const store = new UserSettingsStore(tmpDir);
      store.acceptUser('U_UNKNOWN', 'U_ADMIN');

      const settings = store.getUserSettings('U_UNKNOWN');
      expect(settings?.accepted).toBe(true);
      expect(settings?.acceptedBy).toBe('U_ADMIN');
    });
  });

  describe('getAllUsers', () => {
    it('returns all user settings as array', () => {
      const store = new UserSettingsStore(tmpDir);
      store.createPendingUser('U1', 'User1');
      store.acceptUser('U2', 'U_ADMIN');

      const all = store.getAllUsers();
      expect(all).toHaveLength(2);
      expect(all.map(u => u.userId).sort()).toEqual(['U1', 'U2']);
    });
  });

  describe('isUserAccepted', () => {
    it('returns true for accepted user', () => {
      const store = new UserSettingsStore(tmpDir);
      store.acceptUser('U1', 'U_ADMIN');

      expect(store.isUserAccepted('U1')).toBe(true);
    });

    it('returns false for pending user', () => {
      const store = new UserSettingsStore(tmpDir);
      store.createPendingUser('U1', 'New');

      expect(store.isUserAccepted('U1')).toBe(false);
    });

    it('returns false for unknown user', () => {
      const store = new UserSettingsStore(tmpDir);

      expect(store.isUserAccepted('U_UNKNOWN')).toBe(false);
    });
  });
});
