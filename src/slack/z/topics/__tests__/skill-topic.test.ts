import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnvSkillRegistry } from '../../../../env-skill-registry';
import { addThreadGrant, ENV_SKILL_GRANT_OWNER } from '../../../../user-skill-grants-store';
import { createSkillTopicBinding } from '../skill-topic';

/**
 * The help card's `skill` button must show what typing `skill` in the same thread shows — including
 * an admin's "1회" (this thread only) grant on an environment skill.
 */
describe('skill topic', () => {
  let pluginsDir: string;
  let registry: EnvSkillRegistry;

  beforeEach(() => {
    pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-topic-plugins-'));
    const dir = path.join(pluginsDir, 'acme-env', 'skills', 'post-deploy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: post-deploy\ndescription: "QA the deploy"\n---\n# x');
    registry = { pluginNames: new Set(['acme-env']), pluginsDir };
  });

  afterEach(() => {
    fs.rmSync(pluginsDir, { recursive: true, force: true });
  });

  it('honours a thread-only grant in the thread the card was opened in', async () => {
    addThreadGrant(ENV_SKILL_GRANT_OWNER, 'acme-env:post-deploy', 'UTHREADGRANT', { channel: 'C1', threadTs: '171.1' });
    const binding = createSkillTopicBinding(() => registry);

    const inThread = await binding.renderCard({
      userId: 'UTHREADGRANT',
      issuedAt: 1,
      channel: 'C1',
      threadTs: '171.1',
    });
    expect(JSON.stringify(inThread.followUp)).toContain('QA the deploy');

    const elsewhere = await binding.renderCard({
      userId: 'UTHREADGRANT',
      issuedAt: 1,
      channel: 'C1',
      threadTs: '999.9',
    });
    expect(JSON.stringify(elsewhere.followUp)).not.toContain('QA the deploy');
  });
});
