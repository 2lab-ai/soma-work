import { describe, expect, it } from 'vitest';
import { resolveUserIdentifier, type UserDirectory } from '../user-identity-resolver';

/**
 * RED tests for cross-user skill identity resolution (S6).
 *
 * `{slackUserName}` in `${user}:{skill}` / `$user:{user}` may be a uid OR a
 * display name OR a Slack mention markup (`<@U…>`). All three must resolve to
 * the canonical uid using an OFFLINE directory (userSettingsStore) — no Slack
 * API round-trip (CommandContext exposes none).
 */
const directory: UserDirectory = {
  getAllUsers: () => [
    { userId: 'U094E5L4A15', slackName: 'Zhuge' },
    { userId: 'U0ALICE0001', slackName: 'alice.kim' },
    { userId: 'U0BOB000002', slackName: 'Bob' },
  ],
};

describe('resolveUserIdentifier', () => {
  it('resolves a raw uid to itself', () => {
    expect(resolveUserIdentifier('U094E5L4A15', directory)).toBe('U094E5L4A15');
  });

  it('resolves a display name (case-insensitive) to its uid', () => {
    expect(resolveUserIdentifier('zhuge', directory)).toBe('U094E5L4A15');
    expect(resolveUserIdentifier('Zhuge', directory)).toBe('U094E5L4A15');
  });

  it('resolves a display name containing dots', () => {
    expect(resolveUserIdentifier('alice.kim', directory)).toBe('U0ALICE0001');
  });

  it('strips a leading @ from a display name', () => {
    expect(resolveUserIdentifier('@Bob', directory)).toBe('U0BOB000002');
  });

  it('resolves Slack mention markup <@UID> to the uid', () => {
    expect(resolveUserIdentifier('<@U094E5L4A15>', directory)).toBe('U094E5L4A15');
  });

  it('resolves Slack mention markup with a label <@UID|name>', () => {
    expect(resolveUserIdentifier('<@U094E5L4A15|zhuge>', directory)).toBe('U094E5L4A15');
  });

  it('returns a uid-shaped token even when not in the directory', () => {
    // The skill-existence check downstream is the real gate; the resolver only
    // canonicalizes the identifier.
    expect(resolveUserIdentifier('U0NOTKNOWN9', directory)).toBe('U0NOTKNOWN9');
  });

  it('returns null for an unknown display name', () => {
    expect(resolveUserIdentifier('nobody-here', directory)).toBeNull();
  });

  it('fails closed on an AMBIGUOUS display name (duplicate slackName)', () => {
    const dupDir: UserDirectory = {
      getAllUsers: () => [
        { userId: 'U0SAM000001', slackName: 'Sam' },
        { userId: 'U0SAM000002', slackName: 'sam' }, // case-insensitive collision
      ],
    };
    // Two distinct uids share the name → must require uid/mention, not guess.
    expect(resolveUserIdentifier('Sam', dupDir)).toBeNull();
  });

  it('SECURITY: a uid-shaped token resolves to the uid, not a display-name squatter', () => {
    // A malicious user sets their display name to another user's uid. The uid
    // is canonical and must win, so `$user:U0VICTIM01` cannot be hijacked.
    const squatDir: UserDirectory = {
      getAllUsers: () => [
        { userId: 'U0VICTIM01', slackName: 'victim' },
        { userId: 'U0ATTACKER', slackName: 'U0VICTIM01' },
      ],
    };
    expect(resolveUserIdentifier('U0VICTIM01', squatDir)).toBe('U0VICTIM01');
  });

  it('still resolves a uid even when a display name is ambiguous', () => {
    const dupDir: UserDirectory = {
      getAllUsers: () => [
        { userId: 'U0SAM000001', slackName: 'Sam' },
        { userId: 'U0SAM000002', slackName: 'Sam' },
      ],
    };
    expect(resolveUserIdentifier('U0SAM000001', dupDir)).toBe('U0SAM000001');
    expect(resolveUserIdentifier('<@U0SAM000002>', dupDir)).toBe('U0SAM000002');
  });

  it('returns null for empty / whitespace token', () => {
    expect(resolveUserIdentifier('', directory)).toBeNull();
    expect(resolveUserIdentifier('   ', directory)).toBeNull();
  });
});
