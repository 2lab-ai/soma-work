import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkQueuesConfig } from '../config';
import type { SessionProbe } from '../manager';
import { WorkQueueService } from '../service';

// End-to-end behaviour of the queue as the requester sees it in Slack:
// T1 one dev2 deploy at a time · T2 "already deploying" + not started ·
// T4 cancel / deploy-after card · T5 10-minute auto-cancel.

const MIN = 60_000;
const TRIGGER = 'Projalpha: develop -&gt; deploy/dev2';

function harness() {
  let now = 5_000_000;
  const probes = new Map<string, SessionProbe>();
  const idle = new Map<string, Array<() => void>>();
  let ts = 0;
  const slackApi = {
    postMessage: vi.fn(async (_c: string, _t: string, _o?: any) => ({ ts: `9${++ts}` })),
    updateMessage: vi.fn(async () => undefined),
    getPermalink: vi.fn(async (c: string, t: string) => `https://slack.test/${c}/${t}`),
  };
  const replay = vi.fn(async () => undefined);
  const terminateSession = vi.fn();
  const queues = parseWorkQueuesConfig(undefined).queues;
  const service = new WorkQueueService({
    slackApi,
    getQueues: () => queues,
    probe: (key) => probes.get(key) ?? { exists: false, active: false },
    registerOnIdle: (key, cb) => idle.set(key, [...(idle.get(key) ?? []), cb]),
    terminateSession,
    now: () => now,
  });
  service.setReplay(replay);
  return {
    service,
    slackApi,
    replay,
    terminateSession,
    probes,
    advance: (ms: number) => {
      now += ms;
    },
    fireIdle: (key: string) => {
      const cbs = idle.get(key) ?? [];
      idle.delete(key);
      for (const cb of cbs) cb();
    },
  };
}

function session(over: Record<string, unknown> = {}) {
  return { workflow: 'deploy', sessionId: undefined as string | undefined, ...over } as any;
}

function input(key: string, s: any, text = TRIGGER, user = 'UA') {
  const [channel, threadTs] = key.split(':');
  return { session: s, sessionKey: key, channel, threadTs, user, text };
}

function click(action: 'work_queue_wait' | 'work_queue_cancel', waiterId: string, user: string) {
  return { user: { id: user }, actions: [{ action_id: action, value: waiterId }] };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('WorkQueueService', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('lets the first dev2 deploy through and binds the session to the queue', () => {
    const s = session();
    expect(h.service.decide(input('C1:100', s)).kind).toBe('pass');
    expect(s.workQueueId).toBe('deploy-dev2');
  });

  it('ignores other workflows and other targets', () => {
    expect(h.service.decide(input('C1:100', session({ workflow: 'default' }))).kind).toBe('pass');
    expect(h.service.decide(input('C1:101', session(), 'Projalpha develop -> dev3')).kind).toBe('pass');
    expect(h.service.decide(input('C1:102', session())).kind).toBe('pass');
  });

  it('stops a second deploy and asks the requester: deploy after, or cancel', async () => {
    h.service.decide(input('C1:100', session()));
    h.probes.set('C1:100', { exists: true, active: true, activity: 'working', workflow: 'deploy' });
    const decision = h.service.decide(input('C1:200', session(), TRIGGER, 'UB'));
    expect(decision.kind).toBe('blocked');
    await h.service.notifyBlocked(decision);

    const [channel, text, options] = h.slackApi.postMessage.mock.calls[0];
    expect(channel).toBe('C1');
    expect(text).toContain('이미 배포가 진행 중');
    expect(options.threadTs).toBe('200');
    const body = JSON.stringify(options.blocks);
    expect(body).toContain('<@UA>');
    expect(body).toContain('https://slack.test/C1/100');
    expect(body).toContain('work_queue_wait');
    expect(body).toContain('work_queue_cancel');
    expect(body).toContain('10분 안에 선택하지 않으면');
  });

  it('gates later turns of a bound deploy session even when the text has no trigger', () => {
    h.service.decide(input('C1:100', session()));
    h.probes.set('C1:100', { exists: true, active: true, activity: 'working', workflow: 'deploy' });
    const bound = session({ workQueueId: 'deploy-dev2', sessionId: 'sdk-1' });
    expect(h.service.decide(input('C1:200', bound, 'Proceed with deployment', 'UB')).kind).toBe('blocked');
  });

  it('answers a second message in a blocked thread with a short notice, not a second card', async () => {
    h.service.decide(input('C1:100', session()));
    h.probes.set('C1:100', { exists: true, active: true, activity: 'working', workflow: 'deploy' });
    const s = session();
    await h.service.notifyBlocked(h.service.decide(input('C1:200', s, TRIGGER, 'UB')));
    const again = h.service.decide(input('C1:200', s, '빨리 해줘', 'UB'));
    expect(again.kind).toBe('already-waiting');
    await h.service.notifyBlocked(again);
    expect(h.slackApi.postMessage).toHaveBeenCalledTimes(2);
    expect(h.slackApi.postMessage.mock.calls[1][1]).toContain('이미 선택을 기다리고');
  });

  it('cancels the request after 10 minutes without a choice and closes the never-run session', async () => {
    h.service.decide(input('C1:100', session()));
    h.probes.set('C1:100', { exists: true, active: true, activity: 'working', workflow: 'deploy' });
    await h.service.notifyBlocked(h.service.decide(input('C1:200', session(), TRIGGER, 'UB')));
    h.probes.set('C1:200', { exists: true, active: false, activity: 'idle', workflow: 'deploy' });

    h.advance(10 * MIN);
    await h.service.runTick();
    expect(h.slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      '91',
      expect.stringContaining('10분 동안 선택이 없어'),
      expect.any(Array),
    );
    expect(h.terminateSession).toHaveBeenCalledWith('C1:200');
  });

  it('keeps a session that had run turns before when its request times out', async () => {
    h.service.decide(input('C1:100', session()));
    h.probes.set('C1:100', { exists: true, active: true, activity: 'working', workflow: 'deploy' });
    await h.service.notifyBlocked(
      h.service.decide(input('C1:200', session({ workQueueId: 'deploy-dev2', sessionId: 'sdk-2' }), TRIGGER, 'UB')),
    );
    h.advance(10 * MIN);
    await h.service.runTick();
    expect(h.terminateSession).not.toHaveBeenCalled();
  });

  it('"deploy after" waits, then replays the request in its own thread when the first deploy ends', async () => {
    h.service.decide(input('C1:100', session()));
    h.probes.set('C1:100', { exists: true, active: true, activity: 'working', workflow: 'deploy' });
    const decision = h.service.decide(input('C1:200', session(), TRIGGER, 'UB'));
    await h.service.notifyBlocked(decision);
    const waiterId = decision.kind === 'blocked' ? decision.waiter.id : '';

    const respond = vi.fn(async () => undefined);
    await h.service.handleClick(click('work_queue_wait', waiterId, 'UB'), respond);
    expect(h.slackApi.updateMessage).toHaveBeenLastCalledWith(
      'C1',
      '91',
      expect.stringContaining('대기 순번 1'),
      expect.any(Array),
    );
    expect(h.replay).not.toHaveBeenCalled();

    h.probes.set('C1:200', { exists: true, active: false, activity: 'idle', workflow: 'deploy' });
    h.probes.set('C1:100', { exists: true, active: false, activity: 'idle', workflow: 'deploy' });
    h.fireIdle('C1:100');
    await flush();

    expect(h.replay).toHaveBeenCalledTimes(1);
    const [event] = h.replay.mock.calls[0] as any[];
    expect(event).toMatchObject({ user: 'UB', channel: 'C1', thread_ts: '200', text: TRIGGER });
    expect(event.routeContext).toEqual({ skipAutoBotThread: true });
    expect(h.slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      '91',
      expect.stringContaining('시작합니다'),
      expect.any(Array),
    );
    // The replayed turn holds the slot; nobody else gets in.
    expect(h.service.decide(input('C1:200', session(), TRIGGER, 'UB')).kind).toBe('pass');
    expect(h.service.decide(input('C1:300', session(), TRIGGER, 'UC')).kind).toBe('blocked');
  });

  it('frees the slot the moment the holder goes idle, even before its turn controller is removed', async () => {
    // StreamExecutor sets `idle` at the turn end and removes the controller
    // later, in its finally — the idle transition alone means the work is over.
    h.service.decide(input('C1:100', session()));
    h.probes.set('C1:100', { exists: true, active: true, activity: 'idle', workflow: 'deploy' });
    h.fireIdle('C1:100');
    await flush();
    expect(h.service.decide(input('C1:300', session(), TRIGGER, 'UC')).kind).toBe('pass');
  });

  it('keeps the slot when the turn ended waiting on its own question', async () => {
    h.service.decide(input('C1:100', session()));
    h.probes.set('C1:100', { exists: true, active: false, activity: 'waiting', workflow: 'deploy' });
    h.fireIdle('C1:100');
    await flush();
    expect(h.service.decide(input('C1:300', session(), TRIGGER, 'UC')).kind).toBe('blocked');
  });

  it('a requester\'s cancel also closes the session made only for the request', async () => {
    h.service.decide(input('C1:100', session()));
    h.probes.set('C1:100', { exists: true, active: true, activity: 'working', workflow: 'deploy' });
    const decision = h.service.decide(input('C1:200', session(), TRIGGER, 'UB'));
    await h.service.notifyBlocked(decision);
    await h.service.handleClick(
      click('work_queue_cancel', decision.kind === 'blocked' ? decision.waiter.id : '', 'UB'),
      vi.fn(),
    );
    expect(h.terminateSession).toHaveBeenCalledWith('C1:200');
  });

  it('does not replay into a session that was reset in the meantime', async () => {
    h.service.decide(input('C1:100', session()));
    h.probes.set('C1:100', { exists: true, active: true, activity: 'working', workflow: 'deploy' });
    const decision = h.service.decide(input('C1:200', session(), TRIGGER, 'UB'));
    await h.service.notifyBlocked(decision);
    await h.service.handleClick(
      click('work_queue_wait', decision.kind === 'blocked' ? decision.waiter.id : '', 'UB'),
      vi.fn(),
    );
    h.probes.set('C1:200', { exists: true, active: false, activity: 'idle', workflow: undefined });
    h.probes.set('C1:100', { exists: true, active: false, activity: 'idle', workflow: 'deploy' });
    h.fireIdle('C1:100');
    await flush();
    expect(h.replay).not.toHaveBeenCalled();
    expect(h.slackApi.updateMessage).toHaveBeenLastCalledWith(
      'C1',
      '91',
      expect.stringContaining('초기화'),
      expect.any(Array),
    );
    expect(h.service.decide(input('C1:300', session(), TRIGGER, 'UC')).kind).toBe('pass');
  });

  it('only the requester can choose; a stale button says it expired', async () => {
    h.service.decide(input('C1:100', session()));
    h.probes.set('C1:100', { exists: true, active: true, activity: 'working', workflow: 'deploy' });
    const decision = h.service.decide(input('C1:200', session(), TRIGGER, 'UB'));
    await h.service.notifyBlocked(decision);
    const id = decision.kind === 'blocked' ? decision.waiter.id : '';

    const respond = vi.fn(async () => undefined);
    await h.service.handleClick(click('work_queue_cancel', id, 'UA'), respond);
    expect(respond).toHaveBeenLastCalledWith(
      expect.objectContaining({ response_type: 'ephemeral', replace_original: false }),
    );

    await h.service.handleClick(click('work_queue_cancel', id, 'UB'), respond);
    expect(h.slackApi.updateMessage).toHaveBeenLastCalledWith(
      'C1',
      '91',
      expect.stringContaining('취소했습니다'),
      expect.any(Array),
    );

    await h.service.handleClick(click('work_queue_wait', id, 'UB'), respond);
    expect(respond).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('만료된 요청') }));
  });

  it('tells the holder thread when its slot was returned for not answering', async () => {
    h.service.decide(input('C1:100', session()));
    h.probes.set('C1:100', {
      exists: true,
      active: false,
      activity: 'waiting',
      activityChangedAt: 5_000_000,
      workflow: 'deploy',
    });
    h.advance(10 * MIN);
    await h.service.runTick();
    h.advance(MIN);
    await h.service.runTick();
    expect(h.slackApi.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('슬롯을 반납'), {
      threadTs: '100',
    });
  });

  it('onSessionDeleted frees the slot and never throws', () => {
    h.service.decide(input('C1:100', session()));
    h.slackApi.updateMessage.mockRejectedValue(new Error('slack down'));
    expect(() => h.service.onSessionDeleted('C1:100')).not.toThrow();
    expect(h.service.decide(input('C1:300', session(), TRIGGER, 'UC')).kind).toBe('pass');
  });
});

describe('WorkQueueService — sweep timer', () => {
  it('keeps no timer while the queue is idle, and arms one only while something is held', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.service.start(15_000);
      expect(vi.getTimerCount()).toBe(0);
      h.service.decide(input('C1:100', session()));
      expect(vi.getTimerCount()).toBe(1);
      h.service.onSessionDeleted('C1:100');
      await h.service.runTick();
      expect(vi.getTimerCount()).toBe(0);
      h.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
