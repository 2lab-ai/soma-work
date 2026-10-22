import { describe, expect, it } from 'vitest';
import { parseReleaseNotesChannels, routeReleaseNotes } from '../release-notes-routes';

const DEV2 = 'C0DEV2CHAN1';

describe('parseReleaseNotesChannels (SOMA_RELEASE_NOTES_CHANNELS)', () => {
  it('is empty when unset or blank', () => {
    expect(parseReleaseNotesChannels(undefined)).toEqual({ routes: [], invalid: [] });
    expect(parseReleaseNotesChannels('  ')).toEqual({ routes: [], invalid: [] });
  });

  it('reads repo@branch, bare-branch and `*` entries, separated by commas or newlines', () => {
    const parsed = parseReleaseNotesChannels(
      `acme/App@deploy/dev2=${DEV2}, deploy/stage=#stage-releases\nmain=#릴리즈,*=session`,
    );
    expect(parsed).toEqual({
      routes: [
        { repo: 'acme/app', target: 'deploy/dev2', channel: DEV2 },
        { target: 'deploy/stage', channel: '#stage-releases' },
        { target: 'main', channel: '#릴리즈' },
      ],
      fallback: 'session',
      invalid: [],
    });
    expect(parseReleaseNotesChannels('*=C0FALLBACK1').fallback).toBe('C0FALLBACK1');
  });

  it('drops only the malformed entries and keeps the rest — `session` is valid for `*` alone', () => {
    const parsed = parseReleaseNotesChannels(
      `deploy/dev2, App@deploy/dev2=C1, deploy/dev2=not a channel, =C2, foo=session, acme/app@deploy/dev2=${DEV2}`,
    );
    expect(parsed.routes).toEqual([{ repo: 'acme/app', target: 'deploy/dev2', channel: DEV2 }]);
    expect(parsed.invalid).toEqual([
      'deploy/dev2',
      'App@deploy/dev2=C1',
      'deploy/dev2=not a channel',
      '=C2',
      'foo=session',
    ]);
  });
});

describe('routeReleaseNotes', () => {
  const MAPPED = parseReleaseNotesChannels(
    `acme/app@deploy/dev2=${DEV2},deploy/dev2=C0GENERIC1,deploy/stage=#stage`,
  );

  it('is the session channel, silently, when nothing is configured', () => {
    expect(routeReleaseNotes(parseReleaseNotesChannels(''), 'acme/app', 'deploy/dev2')).toEqual({
      destination: { kind: 'session' },
      unmapped: false,
      keys: [],
      nearMisses: [],
      invalid: [],
    });
  });

  it('prefers the repo@branch entry, matching the repo case-insensitively', () => {
    expect(routeReleaseNotes(MAPPED, 'acme/App', 'deploy/dev2').destination).toEqual({
      kind: 'channel',
      channel: DEV2,
    });
  });

  it('normalizes the emitted branch (trim, refs/heads/) before the exact match', () => {
    expect(routeReleaseNotes(MAPPED, 'acme/app', ' refs/heads/deploy/dev2 ').destination).toEqual({
      kind: 'channel',
      channel: DEV2,
    });
  });

  it('falls back to the bare-branch entry for another repo', () => {
    expect(routeReleaseNotes(MAPPED, 'acme/Web', 'deploy/dev2').destination).toEqual({
      kind: 'channel',
      channel: 'C0GENERIC1',
    });
    expect(routeReleaseNotes(MAPPED, 'acme/app', 'deploy/stage').destination).toEqual({
      kind: 'channel',
      channel: '#stage',
    });
  });

  describe('an unmatched deploy: the `*` policy alone decides, near-misses only warn', () => {
    const DEV2_ONLY = `acme/app@deploy/dev2=${DEV2}`;
    const NO_FALLBACK = parseReleaseNotesChannels(DEV2_ONLY);
    const SESSION_FALLBACK = parseReleaseNotesChannels(`${DEV2_ONLY},*=session`);
    const CHANNEL_FALLBACK = parseReleaseNotesChannels(`${DEV2_ONLY},*=C0FALLBACK1`);

    it.each([
      ['an unmapped environment', 'deploy/stage', []],
      ['a typo the near rule misses', 'deploy/dv2', []],
      ['a bare-name typo', 'dev2', [{ key: 'acme/app@deploy/dev2', channel: DEV2 }]],
      ['a case typo', 'deploy/DEV2', [{ key: 'acme/app@deploy/dev2', channel: DEV2 }]],
      [
        'another branch with the same last segment',
        'hotfix/dev2',
        [{ key: 'acme/app@deploy/dev2', channel: DEV2 }],
      ],
    ])('%s (%s) never reaches C0DEV2CHAN1', (_label, target, nearMisses) => {
      // No `*`: no channel root at all — not the session channel either.
      expect(routeReleaseNotes(NO_FALLBACK, 'acme/app', target)).toEqual({
        destination: { kind: 'deploy-thread' },
        unmapped: true,
        keys: ['acme/app@deploy/dev2'],
        nearMisses,
        invalid: [],
      });
      // `*=session`: the session channel root, as before routing existed.
      expect(routeReleaseNotes(SESSION_FALLBACK, 'acme/app', target)).toMatchObject({
        destination: { kind: 'session' },
        unmapped: true,
        nearMisses,
      });
      // `*=<channel>`: that channel — a near-miss does not divert it to the dev2 channel.
      expect(routeReleaseNotes(CHANNEL_FALLBACK, 'acme/app', target)).toMatchObject({
        destination: { kind: 'channel', channel: 'C0FALLBACK1' },
        unmapped: true,
        nearMisses,
      });
    });

    it('a repo-scoped key does not claim another repo with the same branch', () => {
      expect(routeReleaseNotes(NO_FALLBACK, 'acme/web', 'deploy/dev2')).toEqual({
        destination: { kind: 'deploy-thread' },
        unmapped: true,
        keys: ['acme/app@deploy/dev2'],
        nearMisses: [],
        invalid: [],
      });
    });

    it('lists every near-miss key', () => {
      expect(routeReleaseNotes(MAPPED, 'acme/app', 'dev2').nearMisses).toEqual([
        { key: 'acme/app@deploy/dev2', channel: DEV2 },
        { key: 'deploy/dev2', channel: 'C0GENERIC1' },
      ]);
    });
  });

  it('a config holding only malformed entries still counts as configured, and carries them for the warning', () => {
    expect(routeReleaseNotes(parseReleaseNotesChannels('foo=session'), 'acme/app', 'deploy/dev2')).toEqual(
      {
        destination: { kind: 'deploy-thread' },
        unmapped: true,
        keys: [],
        nearMisses: [],
        invalid: ['foo=session'],
      },
    );
  });
});
