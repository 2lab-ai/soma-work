import { describe, expect, it } from 'vitest';
import {
  buildCronRunPermissionMessage,
  CRON_RUN_PERM_ACTION_ID_PREFIX,
  VALUE_KIND_CRON_RUN_ALWAYS,
  VALUE_KIND_CRON_RUN_DENY,
  VALUE_KIND_CRON_RUN_ONCE,
} from '../cron-run-permission-blocks';

describe('buildCronRunPermissionMessage', () => {
  const msg = buildCronRunPermissionMessage({
    requestId: 'req-1',
    requesterId: 'U_BOB',
    ownerId: 'U_ALICE',
    jobName: 'stage0-daily-deploy-0400kst',
  });

  it('mentions the owner and the requester and names the job', () => {
    expect(msg.text).toContain('U_ALICE');
    expect(msg.text).toContain('U_BOB');
    expect(msg.text).toContain('stage0-daily-deploy-0400kst');
  });

  it('renders 3 buttons (once / always / deny) with cron_run_perm_ action_ids', () => {
    const actions = msg.blocks.find((b: any) => b.type === 'actions');
    expect(actions.elements).toHaveLength(3);
    for (const el of actions.elements) {
      expect(el.action_id.startsWith(CRON_RUN_PERM_ACTION_ID_PREFIX)).toBe(true);
    }
    const kinds = actions.elements.map((el: any) => JSON.parse(el.value).kind);
    expect(kinds).toEqual([VALUE_KIND_CRON_RUN_ONCE, VALUE_KIND_CRON_RUN_ALWAYS, VALUE_KIND_CRON_RUN_DENY]);
  });

  it('carries ONLY the requestId in each button value — never forgeable owner/requester fields', () => {
    const actions = msg.blocks.find((b: any) => b.type === 'actions');
    for (const el of actions.elements) {
      expect(Object.keys(JSON.parse(el.value)).sort()).toEqual(['kind', 'requestId']);
      expect(JSON.parse(el.value).requestId).toBe('req-1');
    }
  });
});
