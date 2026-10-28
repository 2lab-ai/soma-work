import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../../../env-paths';
import type { EnvSkillRegistry } from '../../../env-skill-registry';
import { ENV_SKILL_GRANT_OWNER, grantSkill } from '../../../user-skill-grants-store';
import { createUserSkill } from '../../../user-skill-store';
import { SkillsHandler } from '../skills-handler';

const h = vi.hoisted(() => ({ isAdmin: vi.fn((_u: string) => false) }));
vi.mock('../../../admin-utils', () => ({ isAdminUser: h.isAdmin }));

/**
 * `skill` — the one word that lists the skills a user can run: their personal skills as the
 * interactive list (same UI as `$user`), then this host's environment skills.
 *
 * SSOT T1: "봇이 skill이나 /skill을 텍스트 명령으로 인식하지 못합니다"
 * SSOT T2: "skill 치면 내 스킬 리스트 ui로 나오고 그 다음에 환경 스킬로 리스트업해줘야함"
 */
describe('SkillsHandler', () => {
  const USER = 'USKILLLIST1';
  let pluginsDir: string;
  let registry: EnvSkillRegistry;
  let handler: SkillsHandler;
  const say = vi.fn().mockResolvedValue({ ts: '1' });

  const ctx = (text: string) => ({ user: USER, channel: 'C1', threadTs: '171.1', text, say });

  function writeEnvSkill(skill: string, description: string): void {
    const dir = path.join(pluginsDir, 'acme-env', 'skills', skill);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: "${description}"\n---\n# ${skill}\nsecret host values`,
    );
  }

  const posted = () => say.mock.calls.map((c) => c[0]);
  const textOf = (msg: any) => JSON.stringify(msg.blocks ?? []) + (msg.text ?? '');

  beforeEach(() => {
    vi.clearAllMocks();
    h.isAdmin.mockReturnValue(false);
    pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-handler-plugins-'));
    writeEnvSkill('post-deploy', 'QA the acme staging deploy');
    registry = { pluginNames: new Set(['acme-env']), pluginsDir };
    handler = new SkillsHandler(() => registry);
    fs.rmSync(path.join(DATA_DIR, USER), { recursive: true, force: true });
    fs.rmSync(path.join(DATA_DIR, 'env-skill-grants.json'), { force: true });
    fs.rmSync(path.join(DATA_DIR, ENV_SKILL_GRANT_OWNER), { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(pluginsDir, { recursive: true, force: true });
    fs.rmSync(path.join(DATA_DIR, USER), { recursive: true, force: true });
    fs.rmSync(path.join(DATA_DIR, 'env-skill-grants.json'), { force: true });
  });

  describe('canHandle — every way a user types the list command (T1)', () => {
    it.each([
      'skill',
      'skills',
      '/skill',
      '/skills',
      'SKILL',
      '  skill  ',
      'skill list',
      'skills list',
      '/skill list',
      'skills download',
      'skill download',
    ])('claims %j', (text) => {
      expect(handler.canHandle(text)).toBe(true);
    });

    it.each([
      'skill me a deploy script',
      'skills foo',
      '$skill',
      'skillz',
      'autoskill',
      'my skill',
    ])('leaves %j to the model', (text) => {
      expect(handler.canHandle(text)).toBe(false);
    });
  });

  describe('list (T2)', () => {
    it('posts the personal skill list UI first, then the environment skills', async () => {
      createUserSkill(USER, 'my-deploy', '---\nname: my-deploy\ndescription: "ship it"\n---\n# deploy');

      const result = await handler.execute(ctx('skill'));

      expect(result.handled).toBe(true);
      expect(say).toHaveBeenCalledTimes(2);
      const [personal, env] = posted();
      // 1st: the same interactive list `$user` renders — overflow menu per skill.
      expect(personal.thread_ts).toBe('171.1');
      expect(textOf(personal)).toContain('$user:my-deploy');
      expect(JSON.stringify(personal.blocks)).toContain('user_skill_menu_my-deploy');
      // 2nd: the environment skills of this host.
      expect(env.thread_ts).toBe('171.1');
      expect(env.blocks[0].type).toBe('header');
      expect(textOf(env)).toContain('환경 스킬');
      expect(textOf(env)).toContain('$acme-env:post-deploy');
    });

    it.each(['skills', '/skill', 'skill list', '/skills list'])('%j lists the same two messages', async (text) => {
      await handler.execute(ctx(text));
      expect(say).toHaveBeenCalledTimes(2);
      expect(textOf(posted()[1])).toContain('$acme-env:post-deploy');
    });

    it('still lists the environment skills when the user has no personal skill', async () => {
      await handler.execute(ctx('skill'));
      const [personal, env] = posted();
      expect(textOf(personal)).toContain('등록된 personal skill이 없습니다');
      expect(textOf(env)).toContain('$acme-env:post-deploy');
    });

    it('says so when the host has no environment skill', async () => {
      handler = new SkillsHandler(() => ({ pluginNames: new Set(), pluginsDir }));
      await handler.execute(ctx('skill'));
      expect(textOf(posted()[1])).toContain('환경 스킬이 없습니다');
    });

    it('hides an environment skill description from a non-admin without a grant', async () => {
      await handler.execute(ctx('skill'));
      const env = textOf(posted()[1]);
      expect(env).toContain('$acme-env:post-deploy');
      expect(env).toContain('승인 필요');
      expect(env).not.toContain('QA the acme staging deploy');
      expect(env).not.toContain('secret host values');
    });

    it('shows the description once an admin granted the skill', async () => {
      grantSkill(ENV_SKILL_GRANT_OWNER, 'acme-env:post-deploy', USER);
      await handler.execute(ctx('skill'));
      const env = textOf(posted()[1]);
      expect(env).toContain('QA the acme staging deploy');
      expect(env).not.toContain('승인 필요');
    });

    it('shows every description to an admin', async () => {
      h.isAdmin.mockReturnValue(true);
      await handler.execute(ctx('skill'));
      expect(textOf(posted()[1])).toContain('QA the acme staging deploy');
    });

    it('keeps every message within the Slack 50-block cap', async () => {
      for (let i = 0; i < 60; i++) writeEnvSkill(`s-${String(i).padStart(2, '0')}`, `d${i}`);
      await handler.execute(ctx('skill'));
      const env = posted()[1];
      expect(env.blocks.length).toBeLessThanOrEqual(50);
      expect(textOf(env)).toContain('more');
    });
  });

  describe('download', () => {
    it('still exports the personal skills', async () => {
      createUserSkill(USER, 'my-deploy', '---\nname: my-deploy\ndescription: "ship it"\n---\n# deploy');
      await handler.execute(ctx('skills download'));
      expect(say).toHaveBeenCalledTimes(1);
      expect(posted()[0].text).toContain('Skills Export');
    });
  });
});
