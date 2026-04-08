import { afterEach, describe, expect, it } from 'vitest';
import {
  buildThreadPermalink,
  getSlackWorkspaceUrl,
  resetSlackWorkspaceUrl,
  setSlackWorkspaceUrl,
} from './turn-notifier';

describe('buildThreadPermalink', () => {
  afterEach(() => {
    resetSlackWorkspaceUrl();
  });

  it('returns null when workspace URL is not set', () => {
    const result = buildThreadPermalink('C123', '1234567890.123456');
    expect(result).toBeNull();
  });

  it('generates correct URL with workspace URL set', () => {
    setSlackWorkspaceUrl('https://myworkspace.slack.com/');
    const result = buildThreadPermalink('C123', '1234567890.123456');
    expect(result).toBe('https://myworkspace.slack.com/archives/C123/p1234567890123456');
  });

  it('handles workspace URL without trailing slash', () => {
    setSlackWorkspaceUrl('https://myworkspace.slack.com');
    const result = buildThreadPermalink('C123', '1234567890.123456');
    expect(result).toBe('https://myworkspace.slack.com/archives/C123/p1234567890123456');
  });

  it('works with Enterprise Grid workspace URLs', () => {
    setSlackWorkspaceUrl('https://enterprise-org.enterprise.slack.com/');
    const result = buildThreadPermalink('C456', '9999999999.000001');
    expect(result).toBe('https://enterprise-org.enterprise.slack.com/archives/C456/p9999999999000001');
  });

  it('works with DM channel IDs', () => {
    setSlackWorkspaceUrl('https://team.slack.com/');
    const result = buildThreadPermalink('D123456', '1234567890.123456');
    expect(result).toBe('https://team.slack.com/archives/D123456/p1234567890123456');
  });

  it('works with group DM channel IDs', () => {
    setSlackWorkspaceUrl('https://team.slack.com/');
    const result = buildThreadPermalink('G123456', '1234567890.123456');
    expect(result).toBe('https://team.slack.com/archives/G123456/p1234567890123456');
  });
});

describe('setSlackWorkspaceUrl / getSlackWorkspaceUrl', () => {
  afterEach(() => {
    resetSlackWorkspaceUrl();
  });

  it('returns undefined before initialization', () => {
    expect(getSlackWorkspaceUrl()).toBeUndefined();
  });

  it('stores URL with trailing slash', () => {
    setSlackWorkspaceUrl('https://test.slack.com');
    expect(getSlackWorkspaceUrl()).toBe('https://test.slack.com/');
  });

  it('preserves existing trailing slash', () => {
    setSlackWorkspaceUrl('https://test.slack.com/');
    expect(getSlackWorkspaceUrl()).toBe('https://test.slack.com/');
  });

  it('resetSlackWorkspaceUrl clears the URL', () => {
    setSlackWorkspaceUrl('https://test.slack.com/');
    expect(getSlackWorkspaceUrl()).toBeDefined();
    resetSlackWorkspaceUrl();
    expect(getSlackWorkspaceUrl()).toBeUndefined();
  });
});
