import { describe, expect, it } from 'vitest';
import { buildCronCard } from '../cron-blocks';
import { buildCronRunPermissionMessage } from '../cron-run-permission-blocks';
import { userMention } from '../user-mention';

// An environment user (`env:<name>`) is not a Slack account. Written as `<@env:<name>>` it showed up raw on a live
// admin card ("⏱️ <@env:<org>-stage0> — …"), because Slack only resolves `<@U…>` ids.
describe('userMention', () => {
  it('mentions a Slack user and shows an environment user as code', () => {
    expect(userMention('U0ABC123')).toBe('<@U0ABC123>');
    expect(userMention('W0ABC123')).toBe('<@W0ABC123>');
    expect(userMention('env:acme-stage0')).toBe('`env:acme-stage0`');
  });

  it('the cron run card names an environment owner without a broken mention', () => {
    const msg = buildCronRunPermissionMessage({
      requestId: 'r1',
      requesterId: 'U0REQ',
      ownerId: 'env:acme-stage0',
      jobName: 'nightly-deploy',
    } as any);
    const all = msg.text + JSON.stringify(msg.blocks);
    expect(all).not.toContain('<@env:');
    expect(all).toContain('`env:acme-stage0`');
    expect(all).toContain('<@U0REQ>');
  });

  it('the cron list shows an environment owner without a broken mention', () => {
    const { blocks } = buildCronCard({
      jobs: [
        {
          id: 'j1',
          name: 'nightly-deploy',
          expression: '0 19 * * *',
          prompt: 'run',
          owner: 'env:acme-stage0',
          channel: 'C1',
          threadTs: null,
          createdAt: '2026-11-13T00:00:00.000Z',
        } as any,
      ],
      isAdmin: true,
    });
    expect(JSON.stringify(blocks)).not.toContain('<@env:');
  });
});
