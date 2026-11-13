/**
 * RED tests for the cross-user skill PERMISSION grants store.
 *
 * A user (B, the owner) grants another user (A, the requester) permission to
 * use B's personal skills. Three tiers:
 *   - one-time   (transient, in-memory, single-use, consumed at fulfillment)
 *   - per-skill  (persisted: A may use B's skill X)
 *   - all-skills (persisted: A may use any of B's skills)
 *
 * `isSkillUseAllowed` MUST be non-mutating (codex review): one-time grants are
 * consumed only via `consumeOneTimeGrant` at the actual fulfillment, never by a
 * probe/check.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;

vi.mock('../env-paths', () => ({
  get DATA_DIR() {
    return tempDir;
  },
  IS_DEV: true,
}));

vi.mock('../logger', () => ({
  Logger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));

describe('user-skill-grants-store', () => {
  const owner = 'U0OWNER0001';
  const requester = 'U0REQ00002';
  let store: typeof import('../user-skill-grants-store');

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-grants-'));
    vi.resetModules();
    store = await import('../user-skill-grants-store');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('owner is always allowed to use their own skill', () => {
    expect(store.isSkillUseAllowed(owner, 'deploy', owner)).toBe(true);
  });

  it('denies a requester with no grant', () => {
    expect(store.isSkillUseAllowed(owner, 'deploy', requester)).toBe(false);
  });

  it('per-skill grant allows exactly that skill, not others', () => {
    store.grantSkill(owner, 'deploy', requester);
    expect(store.isSkillUseAllowed(owner, 'deploy', requester)).toBe(true);
    expect(store.isSkillUseAllowed(owner, 'qa', requester)).toBe(false);
  });

  it('all-skills grant allows any skill', () => {
    store.grantAllSkills(owner, requester);
    expect(store.isSkillUseAllowed(owner, 'deploy', requester)).toBe(true);
    expect(store.isSkillUseAllowed(owner, 'anything-else', requester)).toBe(true);
  });

  it('grants persist to disk and survive a fresh module load', async () => {
    store.grantSkill(owner, 'deploy', requester);
    vi.resetModules();
    const reloaded = await import('../user-skill-grants-store');
    expect(reloaded.isSkillUseAllowed(owner, 'deploy', requester)).toBe(true);
  });

  it('grants are idempotent (no duplicate requester entries)', () => {
    store.grantSkill(owner, 'deploy', requester);
    store.grantSkill(owner, 'deploy', requester);
    const grants = store.loadGrants(owner);
    expect(grants.perSkill.deploy).toEqual([requester]);
  });

  // #1079 — the settings page's 스킬 tab takes a grant back: the owner (or an admin, for environment skills).
  describe('revoke', () => {
    it('revokeSkill takes back one per-skill grant and leaves the others', () => {
      store.grantSkill(owner, 'deploy', requester);
      store.grantSkill(owner, 'deploy', 'U0OTHER');
      store.grantSkill(owner, 'qa', requester);
      expect(store.revokeSkill(owner, 'deploy', requester)).toBe(true);
      expect(store.isSkillUseAllowed(owner, 'deploy', requester)).toBe(false);
      expect(store.isSkillUseAllowed(owner, 'deploy', 'U0OTHER')).toBe(true);
      expect(store.isSkillUseAllowed(owner, 'qa', requester)).toBe(true);
    });

    it('revokeSkill prunes an emptied skill entry, and persists', async () => {
      store.grantSkill(owner, 'deploy', requester);
      store.revokeSkill(owner, 'deploy', requester);
      vi.resetModules();
      const reloaded = await import('../user-skill-grants-store');
      expect(reloaded.loadGrants(owner)).toEqual({ allowAll: [], perSkill: {} });
    });

    it('revokeSkill is idempotent: nothing to take back is not an error and writes nothing', () => {
      expect(store.revokeSkill(owner, 'deploy', requester)).toBe(false);
      expect(fs.existsSync(path.join(tempDir, owner, 'skill-grants.json'))).toBe(false);
      store.grantSkill(owner, 'deploy', requester);
      store.revokeSkill(owner, 'deploy', requester);
      expect(store.revokeSkill(owner, 'deploy', requester)).toBe(false);
    });

    it('revokeAllSkills takes back the all-skills grant only — a per-skill grant stays', () => {
      store.grantAllSkills(owner, requester);
      store.grantSkill(owner, 'deploy', requester);
      expect(store.revokeAllSkills(owner, requester)).toBe(true);
      expect(store.loadGrants(owner).allowAll).toEqual([]);
      expect(store.isSkillUseAllowed(owner, 'deploy', requester)).toBe(true);
      expect(store.isSkillUseAllowed(owner, 'qa', requester)).toBe(false);
      expect(store.revokeAllSkills(owner, requester)).toBe(false);
    });

    it('environment grants revoke under the reserved owner', () => {
      const env = store.ENV_SKILL_GRANT_OWNER;
      store.grantSkill(env, 'envx:qa', requester);
      store.grantAllSkills(env, 'U0OTHER');
      store.revokeSkill(env, 'envx:qa', requester);
      store.revokeAllSkills(env, 'U0OTHER');
      expect(store.isEnvSkillUseAllowed('envx:qa', requester)).toBe(false);
      expect(store.isEnvSkillUseAllowed('envx:qa', 'U0OTHER')).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(tempDir, 'env-skill-grants.json'), 'utf-8'))).toEqual({
        allowAll: [],
        perSkill: {},
      });
    });

    it('an unsafe owner id is refused without touching the disk', () => {
      expect(store.revokeSkill('../evil', 'deploy', requester)).toBe(false);
      expect(store.revokeAllSkills('../evil', requester)).toBe(false);
    });
  });

  describe('one-time grants', () => {
    it('isSkillUseAllowed sees a one-time grant WITHOUT consuming it (non-mutating)', () => {
      store.addOneTimeGrant(owner, 'deploy', requester);
      expect(store.isSkillUseAllowed(owner, 'deploy', requester)).toBe(true);
      // A second check still passes — the check did not consume it.
      expect(store.isSkillUseAllowed(owner, 'deploy', requester)).toBe(true);
    });

    it('consumeOneTimeGrant removes the grant (strict single-use)', () => {
      store.addOneTimeGrant(owner, 'deploy', requester);
      expect(store.consumeOneTimeGrant(owner, 'deploy', requester)).toBe(true);
      // Now gone — no persisted grant remains.
      expect(store.isSkillUseAllowed(owner, 'deploy', requester)).toBe(false);
      // Consuming again returns false (nothing to consume).
      expect(store.consumeOneTimeGrant(owner, 'deploy', requester)).toBe(false);
    });

    it('one-time grant is scoped to the exact (owner, skill, requester)', () => {
      store.addOneTimeGrant(owner, 'deploy', requester);
      expect(store.isSkillUseAllowed(owner, 'qa', requester)).toBe(false);
      expect(store.isSkillUseAllowed(owner, 'deploy', 'U0OTHER')).toBe(false);
    });

    it('an expired one-time grant is not honored', () => {
      store.addOneTimeGrant(owner, 'deploy', requester, Date.now() - 1000);
      expect(store.isSkillUseAllowed(owner, 'deploy', requester)).toBe(false);
    });
  });

  // An environment plugin as a whole (its MCP tools, policy step 6d) opens on any grant of one of
  // its skills: all environment skills, a standing grant of one of its skills, or one of its skills
  // in this thread.
  // env-access WU4 (#1212): the admin's "this environment, always" answer.
  describe('environment grants', () => {
    const thread = { channel: 'C1', threadTs: '171.1' };
    const dev2 = { id: 'env:acme-dev2', skills: ['acme-env:deploy-dev2', 'acme-env:qa-dev2'] };
    const stage0 = { id: 'env:acme-stage0', skills: ['acme-stage:*'] };

    it('opens every skill of that environment and none of another', () => {
      store.grantEnvironment('env:acme-dev2', requester);
      expect(store.hasEnvironmentGrant('env:acme-dev2', requester)).toBe(true);
      expect(store.isEnvSkillUseAllowed('acme-env:qa-dev2', requester, thread, 'env:acme-dev2')).toBe(true);
      expect(store.isEnvSkillUseAllowed('acme-stage:deploy', requester, thread, 'env:acme-stage0')).toBe(false);
      expect(store.isEnvSkillUseAllowed('acme-env:qa-dev2', requester, thread)).toBe(false);
      expect(store.isEnvSkillUseAllowed('acme-env:qa-dev2', 'U0OTHER', thread, 'env:acme-dev2')).toBe(false);
    });

    it('opens the tools of that environment, and of the plugins its skills come from', () => {
      store.grantEnvironment('env:acme-dev2', requester);
      expect(store.isEnvironmentToolUseAllowed(dev2, requester, thread)).toBe(true);
      expect(store.isEnvironmentToolUseAllowed(stage0, requester, thread)).toBe(false);
      expect(store.isEnvPluginUseAllowed('acme-env', requester, thread, ['env:acme-dev2'])).toBe(true);
      expect(store.isEnvPluginUseAllowed('acme-env', requester, thread, ['env:acme-stage0'])).toBe(false);
    });

    it('lets a grant of one of its skills open its tools in the same scope', () => {
      expect(store.isEnvironmentToolUseAllowed(dev2, requester, thread)).toBe(false);
      store.addThreadGrant(store.ENV_SKILL_GRANT_OWNER, 'acme-env:deploy-dev2', requester, thread);
      expect(store.isEnvironmentToolUseAllowed(dev2, requester, thread)).toBe(true);
      expect(store.isEnvironmentToolUseAllowed(dev2, requester, { channel: 'C1', threadTs: '9.9' })).toBe(false);
      store.addThreadGrant(store.ENV_SKILL_GRANT_OWNER, 'acme-stage:qa', requester, thread);
      expect(store.isEnvironmentToolUseAllowed(stage0, requester, thread)).toBe(true);
      store.grantSkill(store.ENV_SKILL_GRANT_OWNER, 'acme-stage:deploy', 'U0THIRD');
      expect(store.isEnvironmentToolUseAllowed(stage0, 'U0THIRD')).toBe(true);
    });

    it('is persisted, revocable, and refuses a malformed environment id', () => {
      store.grantEnvironment('env:acme-dev2', requester);
      store.grantEnvironment('env:acme-dev2', requester);
      const file = JSON.parse(fs.readFileSync(path.join(tempDir, 'env-skill-grants.json'), 'utf-8'));
      expect(file.perEnvironment).toEqual({ 'env:acme-dev2': [requester] });
      expect(store.revokeEnvironment('env:acme-dev2', requester)).toBe(true);
      expect(store.hasEnvironmentGrant('env:acme-dev2', requester)).toBe(false);
      expect(store.revokeEnvironment('env:acme-dev2', requester)).toBe(false);
      expect(() => store.grantEnvironment('acme-dev2', requester)).toThrow(/environment/);
      expect(store.hasEnvironmentGrant('__proto__', requester)).toBe(false);
    });
  });

  describe('isEnvPluginUseAllowed', () => {
    const thread = { channel: 'C1', threadTs: '171.1' };

    it('denies a requester with no environment grant', () => {
      expect(store.isEnvPluginUseAllowed('envx', requester, thread)).toBe(false);
      expect(store.isEnvPluginUseAllowed('envx', requester)).toBe(false);
    });

    it('the all-environment-skills grant opens every environment plugin', () => {
      store.grantAllSkills(store.ENV_SKILL_GRANT_OWNER, requester);
      expect(store.isEnvPluginUseAllowed('envx', requester)).toBe(true);
      expect(store.isEnvPluginUseAllowed('acme-env', requester, thread)).toBe(true);
      expect(store.isEnvPluginUseAllowed('envx', 'U0OTHER')).toBe(false);
    });

    it('a standing grant of one of its skills opens the plugin, matched on the whole plugin name', () => {
      store.grantSkill(store.ENV_SKILL_GRANT_OWNER, 'envx:browser-qa', requester);
      expect(store.isEnvPluginUseAllowed('envx', requester)).toBe(true);
      expect(store.isEnvPluginUseAllowed('envx', 'U0OTHER')).toBe(false);
      // `env` / `envx-two` are other plugins: the key prefix is `<plugin>:`, never a substring.
      expect(store.isEnvPluginUseAllowed('env', requester)).toBe(false);
      expect(store.isEnvPluginUseAllowed('envx-two', requester)).toBe(false);
      store.grantSkill(store.ENV_SKILL_GRANT_OWNER, 'abc-def:qa', requester);
      expect(store.isEnvPluginUseAllowed('abc', requester)).toBe(false);
      expect(store.isEnvPluginUseAllowed('abc-def', requester)).toBe(true);
    });

    it('a thread grant of one of its skills opens the plugin in that thread only', () => {
      store.addThreadGrant(store.ENV_SKILL_GRANT_OWNER, 'envx:browser-qa', requester, thread);
      expect(store.isEnvPluginUseAllowed('envx', requester, thread)).toBe(true);
      expect(store.isEnvPluginUseAllowed('envx', requester, { channel: 'C1', threadTs: '999.9' })).toBe(false);
      expect(store.isEnvPluginUseAllowed('envx', requester, { channel: 'C2', threadTs: '171.1' })).toBe(false);
      expect(store.isEnvPluginUseAllowed('envx', requester)).toBe(false);
      expect(store.isEnvPluginUseAllowed('envx', 'U0OTHER', thread)).toBe(false);
      expect(store.isEnvPluginUseAllowed('env', requester, thread)).toBe(false);
      // The skill-level check is unchanged: the grant covers that skill, not its siblings.
      expect(store.isEnvSkillUseAllowed('envx:browser-qa', requester, thread)).toBe(true);
      expect(store.isEnvSkillUseAllowed('envx:deploy', requester, thread)).toBe(false);
    });

    it('a thread grant counts for its own plugin only, even with a look-alike name', () => {
      store.addThreadGrant(store.ENV_SKILL_GRANT_OWNER, 'abc-def:qa', requester, thread);
      store.addThreadGrant(store.ENV_SKILL_GRANT_OWNER, 'abc_def:qa', requester, thread);
      expect(store.isEnvPluginUseAllowed('abc', requester, thread)).toBe(false);
      expect(store.isEnvPluginUseAllowed('abc-def', requester, thread)).toBe(true);
      expect(store.isEnvPluginUseAllowed('abc_def', requester, thread)).toBe(true);
    });

    it('an expired thread grant does not count, and a live sibling still does', () => {
      store.addThreadGrant(store.ENV_SKILL_GRANT_OWNER, 'envx:old', requester, thread, Date.now() - 1);
      expect(store.isEnvPluginUseAllowed('envx', requester, thread)).toBe(false);
      expect(store.hasThreadGrant(store.ENV_SKILL_GRANT_OWNER, 'envx:old', requester, thread)).toBe(false);
      store.addThreadGrant(store.ENV_SKILL_GRANT_OWNER, 'envx:old', requester, thread, Date.now() - 1);
      store.addThreadGrant(store.ENV_SKILL_GRANT_OWNER, 'envx:live', requester, thread);
      expect(store.isEnvPluginUseAllowed('envx', requester, thread)).toBe(true);
      expect(store.isEnvPluginUseAllowed('envx', requester, thread)).toBe(true);
    });

    it('a grant re-armed after it expired counts again', () => {
      store.addThreadGrant(store.ENV_SKILL_GRANT_OWNER, 'envx:qa', requester, thread, Date.now() - 1);
      expect(store.isEnvPluginUseAllowed('envx', requester, thread)).toBe(false);
      store.addThreadGrant(store.ENV_SKILL_GRANT_OWNER, 'envx:qa', requester, thread);
      expect(store.isEnvPluginUseAllowed('envx', requester, thread)).toBe(true);
    });

    it('an empty plugin name never matches', () => {
      store.grantSkill(store.ENV_SKILL_GRANT_OWNER, ':odd', requester);
      store.addThreadGrant(store.ENV_SKILL_GRANT_OWNER, ':odd', requester, thread);
      expect(store.isEnvPluginUseAllowed('', requester, thread)).toBe(false);
    });

    it('a malformed per-skill entry in the grant file is skipped, not thrown on', () => {
      fs.writeFileSync(
        path.join(tempDir, 'env-skill-grants.json'),
        JSON.stringify({ allowAll: [], perSkill: { 'envx:a': 'not-a-list', 'envx:b': [requester] } }),
      );
      expect(store.isEnvPluginUseAllowed('envx', requester)).toBe(true);
      expect(store.isEnvPluginUseAllowed('envx', 'U0OTHER')).toBe(false);
    });
  });
});
