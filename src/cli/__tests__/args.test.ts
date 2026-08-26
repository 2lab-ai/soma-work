import { describe, expect, it } from 'vitest';
import { CliArgError, type ProfileAction, parseCli, type ServiceAction } from '../args';

describe('parseCli', () => {
  it('parses bare "setup"', () => {
    expect(parseCli(['setup'])).toEqual({ command: 'setup', profile: undefined, resume: false });
  });

  it('parses "setup --resume"', () => {
    expect(parseCli(['setup', '--resume'])).toEqual({
      command: 'setup',
      profile: undefined,
      resume: true,
    });
  });

  it('parses "setup --profile preview"', () => {
    expect(parseCli(['setup', '--profile', 'preview'])).toEqual({
      command: 'setup',
      profile: 'preview',
      resume: false,
    });
  });

  it('parses "doctor --profile production --json"', () => {
    expect(parseCli(['doctor', '--profile', 'production', '--json'])).toEqual({
      command: 'doctor',
      profile: 'production',
      json: true,
    });
  });

  it('parses bare "status"', () => {
    expect(parseCli(['status'])).toEqual({ command: 'status', profile: undefined, json: false });
  });

  it('parses "service start --profile preview"', () => {
    expect(parseCli(['service', 'start', '--profile', 'preview'])).toEqual({
      command: 'service',
      action: 'start',
      profile: 'preview',
    });
  });

  const serviceActions: ServiceAction[] = ['install', 'start', 'stop', 'restart', 'status'];
  it.each(serviceActions)('parses "service %s"', (action) => {
    expect(parseCli(['service', action])).toEqual({
      command: 'service',
      action,
      profile: undefined,
    });
  });

  const profileActions: ProfileAction[] = ['list', 'show', 'remove'];
  it.each(profileActions)('parses "profile %s"', (action) => {
    expect(parseCli(['profile', action])).toEqual({
      command: 'profile',
      action,
      profile: undefined,
      json: false,
    });
  });

  it('rejects an unknown service action', () => {
    expect(() => parseCli(['service', 'nuke'])).toThrow(CliArgError);
  });

  it('rejects an unknown profile action', () => {
    expect(() => parseCli(['profile', 'nuke'])).toThrow(CliArgError);
  });

  it('rejects an unknown top-level command', () => {
    expect(() => parseCli(['launch'])).toThrow(CliArgError);
  });

  it('rejects a missing command', () => {
    expect(() => parseCli([])).toThrow(CliArgError);
  });

  it('rejects an invalid --profile value', () => {
    expect(() => parseCli(['setup', '--profile', 'staging'])).toThrow(CliArgError);
  });

  it('rejects --profile with no value', () => {
    expect(() => parseCli(['setup', '--profile'])).toThrow(CliArgError);
  });

  it('parses "sessions list" and keeps its filters as an opaque tail', () => {
    expect(parseCli(['sessions', 'list', '--user', 'U1', '--limit', '5', '--json'])).toEqual({
      command: 'sessions',
      action: 'list',
      profile: undefined,
      rest: ['--user', 'U1', '--limit', '5', '--json'],
    });
  });

  it('parses "sessions show" and strips only --profile from the tail', () => {
    expect(parseCli(['sessions', 'show', 'abc', '--profile', 'preview', '--conversation'])).toEqual({
      command: 'sessions',
      action: 'show',
      profile: 'preview',
      rest: ['abc', '--conversation'],
    });
  });

  it('does not mistake a session key called "--profile" for the flag position', () => {
    expect(parseCli(['sessions', 'list', '--model', 'opus'])).toEqual({
      command: 'sessions',
      action: 'list',
      profile: undefined,
      rest: ['--model', 'opus'],
    });
  });

  it('rejects an unknown sessions action and a missing one', () => {
    expect(() => parseCli(['sessions', 'purge'])).toThrow(CliArgError);
    expect(() => parseCli(['sessions'])).toThrow(CliArgError);
  });

  it('rejects the private helper subcommands through the public parser', () => {
    expect(() => parseCli(['_capture-slack-auth', '--socket', '/tmp/s'])).toThrow(CliArgError);
    expect(() => parseCli(['_print-slack-manifest', '--manifest', '/tmp/m.json'])).toThrow(CliArgError);
  });

  it('never names a private helper subcommand in a public error message', () => {
    for (const argv of [[], ['launch'], ['sessions', 'purge']]) {
      try {
        parseCli(argv);
        throw new Error('expected a CliArgError');
      } catch (error) {
        expect((error as Error).message).not.toContain('_capture');
        expect((error as Error).message).not.toContain('_print');
      }
    }
  });

  // -------------------------------------------------------------------------
  // Fix round 1 — I-4: every token is consumed exactly once
  // -------------------------------------------------------------------------

  describe('exact argument grammar', () => {
    const REJECTED: ReadonlyArray<[label: string, argv: string[]]> = [
      // unknown flags
      ['setup unknown flag', ['setup', '--bogus']],
      ['doctor mistyped --json', ['doctor', '--jsonn']],
      ['doctor unknown flag', ['doctor', '--bogus']],
      ['status unknown flag', ['status', '--verbose']],
      ['service unknown flag', ['service', 'status', '--json']],
      ['profile unknown flag', ['profile', 'list', '--all']],
      ['sessions list unknown flag', ['sessions', 'list', '--bogus']],
      ['sessions show unknown flag', ['sessions', 'show', 'k', '--raw']],
      // flags valid elsewhere but not here
      ['--resume is setup-only (doctor)', ['doctor', '--resume']],
      ['--resume is setup-only (status)', ['status', '--resume']],
      ['--json is not a setup flag', ['setup', '--json']],
      ['--conversation is sessions-show-only', ['sessions', 'list', '--conversation']],
      ['--user is sessions-list-only', ['sessions', 'show', 'k', '--user', 'U1']],
      // duplicates
      ['repeated --profile', ['doctor', '--profile', 'preview', '--profile', 'production']],
      ['repeated --json', ['doctor', '--json', '--json']],
      ['repeated --resume', ['setup', '--resume', '--resume']],
      ['repeated --conversation', ['sessions', 'show', 'k', '--conversation', '--conversation']],
      // missing values
      ['--profile with no value', ['doctor', '--profile']],
      ['--profile followed by another flag', ['doctor', '--profile', '--json']],
      ['--limit with no value', ['sessions', 'list', '--limit']],
      // The swallowed token is a VALID flag of this same command: accepting it
      // as a value would parse cleanly while silently losing `--json`.
      ['--limit swallowing a real flag', ['sessions', 'list', '--limit', '--json']],
      ['--user swallowing a real flag', ['sessions', 'list', '--user', '--json']],
      // stray positionals
      ['setup positional', ['setup', 'now']],
      ['doctor positional', ['doctor', 'preview']],
      ['service extra positional', ['service', 'status', 'extra']],
      ['sessions list positional', ['sessions', 'list', 'k']],
      ['sessions show second positional', ['sessions', 'show', 'a', 'b']],
      // bad enum values
      ['bad profile value', ['doctor', '--profile', 'staging']],
      ['unknown service action', ['service', 'nuke']],
      ['unknown sessions action', ['sessions', 'purge']],
    ];

    it.each(REJECTED)('rejects %s', (_label, argv) => {
      expect(() => parseCli(argv)).toThrow(CliArgError);
    });

    it('names only the offending flag or value, never the rest of the argv', () => {
      const cases: Array<[string[], string]> = [
        [['doctor', '--bogus'], '--bogus'],
        [['doctor', '--profile', 'preview', '--profile', 'production'], '--profile'],
        [['doctor', '--profile', 'staging'], 'staging'],
        [['setup', 'now'], 'now'],
      ];
      for (const [argv, needle] of cases) {
        try {
          parseCli(argv);
          throw new Error(`expected ${argv.join(' ')} to be rejected`);
        } catch (error) {
          expect(error).toBeInstanceOf(CliArgError);
          expect((error as Error).message).toContain(needle);
        }
      }
    });

    const ACCEPTED: ReadonlyArray<[label: string, argv: string[]]> = [
      ['bare setup', ['setup']],
      ['setup both flags', ['setup', '--resume', '--profile', 'production']],
      ['doctor json', ['doctor', '--json']],
      ['status json with profile', ['status', '--profile', 'preview', '--json']],
      ['every service action', ['service', 'restart', '--profile', 'preview']],
      ['profile list json', ['profile', 'list', '--json']],
      ['profile show', ['profile', 'show', '--profile', 'production']],
      ['profile remove', ['profile', 'remove', '--profile', 'preview']],
      [
        'sessions list full filter set',
        [
          'sessions',
          'list',
          '--user',
          'U1',
          '--model',
          'opus',
          '--since',
          '2026-01-01',
          '--until',
          '2026-02-01',
          '--limit',
          '5',
          '--json',
        ],
      ],
      ['sessions show with no key (handler prints usage)', ['sessions', 'show']],
      ['sessions show full', ['sessions', 'show', 'k', '--conversation', '--json', '--profile', 'preview']],
    ];

    it.each(ACCEPTED)('accepts %s', (_label, argv) => {
      expect(() => parseCli(argv)).not.toThrow();
    });

    it('carries --json on profile commands', () => {
      expect(parseCli(['profile', 'list', '--json'])).toEqual({
        command: 'profile',
        action: 'list',
        profile: undefined,
        json: true,
      });
      expect(parseCli(['profile', 'show'])).toEqual({
        command: 'profile',
        action: 'show',
        profile: undefined,
        json: false,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Fix round 1 — M-1: help and version
  // -------------------------------------------------------------------------

  describe('help and version', () => {
    it.each([['help'], ['--help'], ['-h']])('parses %s', (token) => {
      expect(parseCli([token])).toEqual({ command: 'help' });
    });

    it.each([['version'], ['--version'], ['-V']])('parses %s', (token) => {
      expect(parseCli([token])).toEqual({ command: 'version' });
    });

    it('rejects extra tokens after help or version', () => {
      expect(() => parseCli(['help', 'me'])).toThrow(CliArgError);
      expect(() => parseCli(['--version', '--json'])).toThrow(CliArgError);
    });
  });

  // -------------------------------------------------------------------------
  // Fix round 2 — N-3: the sessions tail reaches the handler normalized
  // -------------------------------------------------------------------------

  describe('normalized sessions argv', () => {
    const asSessions = (argv: string[]) =>
      parseCli(argv) as Extract<ReturnType<typeof parseCli>, { command: 'sessions' }>;

    it('puts the session key first whatever position it was typed in', () => {
      expect(asSessions(['sessions', 'show', 'k', '--json']).rest).toEqual(['k', '--json']);
      expect(asSessions(['sessions', 'show', '--json', 'k']).rest).toEqual(['k', '--json']);
      expect(asSessions(['sessions', 'show', '--conversation', 'k', '--json']).rest).toEqual([
        'k',
        '--conversation',
        '--json',
      ]);
    });

    it('drops --profile from the tail without disturbing the handler flags', () => {
      expect(asSessions(['sessions', 'show', '--profile', 'preview', 'k', '--json']).rest).toEqual(['k', '--json']);
      expect(asSessions(['sessions', 'list', '--profile', 'production', '--user', 'U1']).rest).toEqual([
        '--user',
        'U1',
      ]);
    });

    it('leaves the tail empty when no key was given, so the handler prints its usage', () => {
      expect(asSessions(['sessions', 'show']).rest).toEqual([]);
      expect(asSessions(['sessions', 'show', '--json']).rest).toEqual(['--json']);
    });

    it('emits list filters in one deterministic order with their values attached', () => {
      expect(
        asSessions(['sessions', 'list', '--json', '--limit', '5', '--model', 'opus', '--user', 'U1']).rest,
      ).toEqual(['--user', 'U1', '--model', 'opus', '--limit', '5', '--json']);
    });

    it('never invents a flag the operator did not type', () => {
      expect(asSessions(['sessions', 'list']).rest).toEqual([]);
      expect(asSessions(['sessions', 'show', 'k']).rest).toEqual(['k']);
    });
  });
});
