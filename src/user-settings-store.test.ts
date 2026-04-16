// resolveThemeInput is an instance method on UserSettingsStore.
// We can instantiate a throwaway store pointed at a temp dir to test it.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { migrateLegacyTheme, UserSettingsStore } from './user-settings-store';

function makeStore(): UserSettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uss-test-'));
  return new UserSettingsStore(dir);
}

describe('migrateLegacyTheme', () => {
  it('maps legacy A to minimal', () => {
    expect(migrateLegacyTheme('A')).toBe('minimal');
  });

  it('maps legacy G to default', () => {
    expect(migrateLegacyTheme('G')).toBe('default');
  });

  it('maps legacy C to compact', () => {
    expect(migrateLegacyTheme('C')).toBe('compact');
  });

  it('returns default for unknown input', () => {
    expect(migrateLegacyTheme('unknown')).toBe('default');
  });

  it('returns as-is when already a 3-tier theme', () => {
    expect(migrateLegacyTheme('default')).toBe('default');
  });
});

describe('resolveThemeInput', () => {
  const store = makeStore();

  it('resolves "default" to default', () => {
    expect(store.resolveThemeInput('default')).toBe('default');
  });

  it('resolves "compact" to compact', () => {
    expect(store.resolveThemeInput('compact')).toBe('compact');
  });

  it('resolves "minimal" to minimal', () => {
    expect(store.resolveThemeInput('minimal')).toBe('minimal');
  });

  it('resolves legacy letter A to minimal', () => {
    expect(store.resolveThemeInput('A')).toBe('minimal');
  });

  it('resolves "reset" to reset', () => {
    expect(store.resolveThemeInput('reset')).toBe('reset');
  });
});

describe('Sandbox + network toggles', () => {
  it('defaults sandbox to ON (disabled=false) and network to ON (disabled=false)', () => {
    const store = makeStore();
    expect(store.getUserSandboxDisabled('U1')).toBe(false);
    expect(store.getUserNetworkDisabled('U1')).toBe(false);
  });

  it('persists sandboxDisabled + networkDisabled independently', () => {
    const store = makeStore();
    store.setUserSandboxDisabled('U1', true);
    store.setUserNetworkDisabled('U1', true);
    expect(store.getUserSandboxDisabled('U1')).toBe(true);
    expect(store.getUserNetworkDisabled('U1')).toBe(true);

    store.setUserNetworkDisabled('U1', false);
    expect(store.getUserSandboxDisabled('U1')).toBe(true);
    expect(store.getUserNetworkDisabled('U1')).toBe(false);
  });

  it('keeps settings isolated per user', () => {
    const store = makeStore();
    store.setUserNetworkDisabled('U1', true);
    expect(store.getUserNetworkDisabled('U1')).toBe(true);
    expect(store.getUserNetworkDisabled('U2')).toBe(false);
  });

  it('survives a reload from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uss-reload-'));
    const s1 = new UserSettingsStore(dir);
    s1.setUserNetworkDisabled('U1', true);
    s1.setUserSandboxDisabled('U1', true);

    const s2 = new UserSettingsStore(dir);
    expect(s2.getUserSandboxDisabled('U1')).toBe(true);
    expect(s2.getUserNetworkDisabled('U1')).toBe(true);
  });
});

describe('updateUserJiraInfo (regression: must not reset unrelated fields)', () => {
  // Before the patchUserSettings refactor, updateUserJiraInfo overwrote the
  // whole settings record — silently zeroing out sandboxDisabled,
  // networkDisabled, sessionTheme, notifications, etc. This test pins the
  // new behaviour so we never regress.
  it('preserves sandboxDisabled + networkDisabled when syncing Jira info', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uss-jira-'));

    // Seed Slack↔Jira mapping on disk before constructing the store.
    const mappingFile = path.join(dir, 'slack_jira_mapping.json');
    fs.writeFileSync(
      mappingFile,
      JSON.stringify({ U1: { jiraAccountId: 'jira-U1', name: 'Alice', slackName: 'alice' } }, null, 2),
      'utf8',
    );

    const store = new UserSettingsStore(dir);
    store.setUserSandboxDisabled('U1', true);
    store.setUserNetworkDisabled('U1', true);
    store.setUserEmail('U1', 'alice@example.com');

    const changed = store.updateUserJiraInfo('U1', 'alice');
    expect(changed).toBe(true);

    // Jira fields updated …
    expect(store.getUserJiraAccountId('U1')).toBe('jira-U1');
    expect(store.getUserJiraName('U1')).toBe('Alice');
    // … but unrelated fields must still be intact.
    expect(store.getUserSandboxDisabled('U1')).toBe(true);
    expect(store.getUserNetworkDisabled('U1')).toBe(true);
    expect(store.getUserEmail('U1')).toBe('alice@example.com');
  });
});
