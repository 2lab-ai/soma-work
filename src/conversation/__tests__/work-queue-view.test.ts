/**
 * The board's 작업 큐 section and the settings page read one view of every queue (.prd/36 v2 §4.3): lanes and people
 * in the same shape, each entry named for the reader, a private task named only to its owner and admins.
 */
import type { LineQueueView } from 'somalib/work-queue/line';
import { describe, expect, it } from 'vitest';
import { buildWorkQueuesView, PRIVATE_TITLE, type WorkQueuesViewDeps } from '../work-queue-view';

const lane: LineQueueView = {
  id: 'qa-dev2',
  kind: 'lane',
  capacity: 1,
  running: [
    {
      id: 'wq-1',
      keys: ['ABC-1'],
      holder: { user: 'U1', channel: 'C1', threadTs: '1.0' },
      state: 'running',
      position: 0,
      enteredAt: 10,
      startedAt: 10,
      label: 'deploy-qa run',
    },
  ],
  waiting: [
    {
      id: 'wq-2',
      keys: ['ABC-2'],
      holder: { user: 'U2', channel: 'D9', threadTs: '2.0' },
      state: 'waiting',
      position: 1,
      enteredAt: 20,
      label: 'secret deploy note',
    },
  ],
  recent: [
    {
      id: 'wq-p',
      queue: 'qa-dev2',
      keys: ['ABC-9'],
      holder: { user: 'U2', channel: 'D9', threadTs: '9.0' },
      label: 'secret run',
      enteredAt: 1,
      startedAt: 2,
      endedAt: 3,
      end: 'released',
      reason: 'secret reason',
    },
    {
      id: 'wq-0',
      queue: 'qa-dev2',
      keys: ['ABC-0'],
      holder: { user: 'U1', channel: 'C1', threadTs: '0.5' },
      enteredAt: 1,
      startedAt: 2,
      endedAt: 9,
      end: 'done',
    },
  ],
};

const person: LineQueueView = { id: 'user:U1', kind: 'person', capacity: 1, running: [], waiting: [], recent: [] };

function deps(over: Partial<WorkQueuesViewDeps> = {}): WorkQueuesViewDeps {
  return {
    sessionAt: (channel, threadTs) =>
      channel === 'C1' && threadTs === '1.0' ? { key: 'C1:1.0', title: 'ABC-1 QA', ownerId: 'U1' } : undefined,
    nameOf: (id) => ({ U1: 'Ann', U2: 'Bob' })[id] ?? id,
    permalink: (c, t) => `https://slack/${c}/${t}`,
    isPrivate: (c) => c.startsWith('D'),
    viewer: 'U1',
    admin: false,
    ...over,
  };
}

describe('buildWorkQueuesView', () => {
  it('names each entry for the reader: title, owner, card key, thread link — lanes and people alike', () => {
    const view = buildWorkQueuesView({ lanes: [lane], people: [person] }, deps());
    expect(view.lanes[0]).toMatchObject({ id: 'qa-dev2', kind: 'lane', title: 'qa-dev2', capacity: 1 });
    expect(view.lanes[0].running[0]).toMatchObject({
      id: 'wq-1',
      keys: ['ABC-1'],
      label: 'deploy-qa run',
      task: { key: 'C1:1.0', title: 'ABC-1 QA', ownerName: 'Ann', slackThreadUrl: 'https://slack/C1/1.0' },
    });
    expect(view.lanes[0].recent[1]).toMatchObject({ id: 'wq-0', end: 'done', startedAt: 2, endedAt: 9 });
    expect(view.people[0]).toMatchObject({ id: 'user:U1', kind: 'person', title: 'Ann' });
    expect(view.canManage).toBe(false);
  });

  it('a private task is named only to its owner and admins: to anyone else no title, keys or link', () => {
    const other = buildWorkQueuesView({ lanes: [lane], people: [] }, deps({ viewer: 'U1' }));
    expect(other.lanes[0].waiting[0]).toMatchObject({ keys: [], task: { title: PRIVATE_TITLE, hidden: true } });
    expect(other.lanes[0].waiting[0].task.slackThreadUrl).toBeUndefined();
    const json = JSON.stringify(other);
    for (const secret of ['secret deploy note', 'secret run', 'secret reason', 'ABC-9', 'D9/'])
      expect(json, secret).not.toContain(secret);
    const owner = buildWorkQueuesView({ lanes: [lane], people: [] }, deps({ viewer: 'U2' }));
    expect(owner.lanes[0].waiting[0]).toMatchObject({ keys: ['ABC-2'], task: { ownerName: 'Bob' } });
    const admin = buildWorkQueuesView({ lanes: [lane], people: [] }, deps({ viewer: 'U9', admin: true }));
    expect(admin.lanes[0].waiting[0].keys).toEqual(['ABC-2']);
    expect(admin.canManage).toBe(true);
  });
});
