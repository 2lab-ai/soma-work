import { describe, expect, it } from 'vitest';
import { addOneTimeGrant, consumeOneTimeGrant, hasOneTimeGrant, isSkillUseAllowed } from '../user-skill-grants-store';

describe('one-time grants bound to a message (environment users)', () => {
  it('serves only the message it was granted for', () => {
    addOneTimeGrant('env:acme-dev2', 'deploy', 'U1', undefined, '$acme-dev2:deploy A');
    expect(hasOneTimeGrant('env:acme-dev2', 'deploy', 'U1', '$acme-dev2:deploy B')).toBe(false);
    expect(hasOneTimeGrant('env:acme-dev2', 'deploy', 'U1')).toBe(false);
    expect(isSkillUseAllowed('env:acme-dev2', 'deploy', 'U1', '$acme-dev2:deploy B')).toBe(false);
    expect(consumeOneTimeGrant('env:acme-dev2', 'deploy', 'U1', '$acme-dev2:deploy B')).toBe(false);
    expect(isSkillUseAllowed('env:acme-dev2', 'deploy', 'U1', '$acme-dev2:deploy A')).toBe(true);
    expect(consumeOneTimeGrant('env:acme-dev2', 'deploy', 'U1', '$acme-dev2:deploy A')).toBe(true);
    expect(hasOneTimeGrant('env:acme-dev2', 'deploy', 'U1', '$acme-dev2:deploy A')).toBe(false);
  });

  it('an unbound one-time grant keeps serving any message', () => {
    addOneTimeGrant('U_OWNER', 'deploy', 'U2');
    expect(hasOneTimeGrant('U_OWNER', 'deploy', 'U2', 'anything')).toBe(true);
    expect(consumeOneTimeGrant('U_OWNER', 'deploy', 'U2')).toBe(true);
  });
});
