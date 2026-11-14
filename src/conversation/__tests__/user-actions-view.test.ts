import { inspectUserActionScript, type UserActionRecord } from 'somalib/user-action/user-action';
import { describe, expect, it } from 'vitest';
import { dashboardUserActions } from '../user-actions-view';

const script = "open 'https://example.com/verify'";
const rec: UserActionRecord = {
  id: 'ua_1',
  title: '인증 페이지 열기',
  host: 'owner-mac',
  why: '소유자 본인만 할 수 있다.',
  script,
  shell: 'bash',
  expect: '페이지가 열린다',
  effects: '페이지를 연다.',
  optional: false,
  createdAt: 1,
  status: 'pending',
  slackTs: '111.222',
  inspection: inspectUserActionScript(script, 'bash', { checked: true, ok: true, tool: 'bash -n' }),
};

describe('dashboardUserActions', () => {
  it('passes the record with its inspection and keeps the Slack ts server-side', () => {
    const [view] = dashboardUserActions([rec]) ?? [];
    expect(view).toMatchObject({ id: 'ua_1', host: 'owner-mac', script, status: 'pending' });
    expect(view.inspection.verdict).toBe('ok');
    expect(view).not.toHaveProperty('slackTs');
  });

  it('drops malformed entries and returns undefined when nothing is left', () => {
    expect(dashboardUserActions([{ id: 'x' }])).toBeUndefined();
    expect(dashboardUserActions(undefined)).toBeUndefined();
    expect(dashboardUserActions([])).toBeUndefined();
    expect(dashboardUserActions([rec, { id: 'x' }])).toHaveLength(1);
  });
});
