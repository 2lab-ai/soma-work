/**
 * E2 ⑤a — the notice deliverer (.prd/18 D6 · D7 · D8 · D10 · D13, §6.3).
 *
 * It registers the notices a task owes its instruction thread into the
 * ledger, then posts what is owed: a task's link first, each notice claimed
 * before its post and marked with the message ts after; a failed post is
 * retried up to a limit, then marked failed. A result is the turn's own main
 * agent `final`, rendered as a Slack session's final answer, one message, with
 * an overflow note and the card link. A question is posted only while the task
 * still waits on that same askId; otherwise it is closed, not sent. The task
 * runner is never asked to call Slack: only this module posts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTaskNoticeDeliverer,
  owesInstructionThread,
  type TaskNoticeDelivererDeps,
} from '../task-notice-deliverer';
import { TaskNotificationLedger } from '../task-notification-ledger';

const ORIGIN = { channel: 'C123', threadTs: '1700000000.000100', messageTs: '1700000000.000100' };
const TASK_ID = 'task-1111';
const KEY = `task:${TASK_ID}`;

let dir: string;
let ledgers = 0;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliverer-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function task(extra: Record<string, unknown> = {}) {
  return {
    taskId: TASK_ID,
    slackless: true,
    ownerId: 'U1',
    conversationId: 'conv-1',
    originThread: ORIGIN,
    activityState: 'idle',
    notices: [] as any[],
    ...extra,
  } as any;
}

function harness(over: Partial<TaskNoticeDelivererDeps> = {}, session = task()) {
  const ledger = new TaskNotificationLedger(path.join(dir, `ledger-${++ledgers}.json`));
  ledger.load();
  const posts: Array<{ channel: string; threadTs: string; text: string; blocks?: unknown[] }> = [];
  let tsSeq = 0;
  const deps: TaskNoticeDelivererDeps = {
    ledger,
    post: vi.fn(async (target, message) => {
      posts.push({ ...target, ...message });
      tsSeq++;
      return { ts: `1700000099.00000${tsSeq}` };
    }),
    readFinal: vi.fn(async () => ({ text: 'All done: **3 files** changed.', clipped: false })),
    cardUrl: vi.fn(() => 'https://dash.example/dashboard/U1?session=task%3Atask-1111'),
    getTask: vi.fn((taskId: string) => (taskId === TASK_ID ? { session, sessionKey: KEY } : undefined)),
    isApprovalOpen: vi.fn(() => false),
    maxAttempts: 3,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
  return { deliverer: createTaskNoticeDeliverer(deps), ledger, posts, deps, session };
}

const link = { id: `${TASK_ID}:create:link`, kind: 'link', at: 1 };
const result = { id: `${TASK_ID}:c1:result`, kind: 'result', chainId: 'c1', turnId: 't1', outcome: 'completed', at: 2 };

describe('task notice deliverer (E2 ⑤a)', () => {
  it('registers a task’s notices into the ledger, addressed to its instruction thread — once', () => {
    const h = harness();
    h.session.notices = [link, result];
    h.deliverer.enqueue(h.session, KEY);
    h.deliverer.enqueue(h.session, KEY);
    expect(h.ledger.owed().map((e) => e.id)).toEqual([link.id, result.id]);
    expect(h.ledger.get(result.id)).toMatchObject({
      taskId: TASK_ID,
      channel: ORIGIN.channel,
      threadTs: ORIGIN.threadTs,
      kind: 'result',
      intent: expect.objectContaining({ turnId: 't1', conversationId: 'conv-1', ownerId: 'U1', sessionKey: KEY }),
    });
  });

  it('a task with no instruction thread registers nothing', () => {
    const h = harness({}, task({ originThread: undefined }));
    h.session.notices = [result];
    h.deliverer.enqueue(h.session, KEY);
    expect(h.ledger.owed()).toEqual([]);
  });

  it('posts the link first, then the result — each claimed before its post and marked with the ts after', async () => {
    const h = harness();
    h.session.notices = [result, link];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    expect(h.posts.map((p) => p.text)).toEqual([
      expect.stringMatching(/대시보드 작업/),
      expect.stringMatching(/All done/),
    ]);
    expect(h.posts.every((p) => p.channel === ORIGIN.channel && p.threadTs === ORIGIN.threadTs)).toBe(true);
    expect(h.ledger.get(link.id)).toMatchObject({ state: 'posted', messageTs: '1700000099.000001' });
    expect(h.ledger.get(result.id)).toMatchObject({ state: 'posted', messageTs: '1700000099.000002' });
    // A second pass posts nothing more.
    await h.deliverer.deliver();
    expect(h.posts).toHaveLength(2);
  });

  it('the link message carries the card link and says what comes back to the thread', async () => {
    const h = harness();
    h.session.notices = [link];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    expect(h.posts[0].text).toContain('https://dash.example/dashboard/U1?session=task%3Atask-1111');
    expect(h.posts[0].text).toMatch(/결과와 입력 요청이 이 스레드에 올라옵니다/);
  });

  it('a result waits while its task’s link is still owed', async () => {
    let fail = true;
    const h = harness({
      post: vi.fn(async (_t, m: any) => {
        if (fail && /대시보드 작업/.test(m.text)) throw new Error('ratelimited');
        return { ts: 'ts' };
      }),
    });
    h.session.notices = [link, result];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    expect(h.ledger.get(link.id)?.state).toBe('pending');
    expect(h.ledger.get(result.id)?.state).toBe('pending');
    expect(h.deps.post).toHaveBeenCalledTimes(1);
    fail = false;
    await h.deliverer.deliver();
    expect(h.ledger.get(link.id)?.state).toBe('posted');
    expect(h.ledger.get(result.id)?.state).toBe('posted');
  });

  it('the result is the turn’s main-agent final, rendered as blocks, with the card link', async () => {
    const h = harness();
    h.session.notices = [result];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    expect(h.deps.readFinal).toHaveBeenCalledWith('conv-1', 't1');
    const post = h.posts[0];
    expect(Array.isArray(post.blocks)).toBe(true);
    expect(JSON.stringify(post.blocks)).toContain('3 files');
    expect(JSON.stringify(post.blocks)).toContain('https://dash.example/dashboard/U1');
    expect(JSON.stringify(post.blocks)).not.toContain('이하 카드에서');
  });

  it('a clipped or overflowing final says the rest is on the card — still one message', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\nparagraph ${i}`).join('\n\n');
    const h = harness({ readFinal: vi.fn(async () => ({ text: long, clipped: false })) });
    h.session.notices = [result];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    expect(h.posts).toHaveLength(1);
    expect(JSON.stringify(h.posts[0].blocks)).toContain('이하 카드에서');
    expect((h.posts[0].blocks as unknown[]).length).toBeLessThanOrEqual(50);

    const c = harness({ readFinal: vi.fn(async () => ({ text: 'short but clipped', clipped: true })) });
    c.session.notices = [result];
    c.deliverer.enqueue(c.session, KEY);
    await c.deliverer.deliver();
    expect(JSON.stringify(c.posts[0].blocks)).toContain('이하 카드에서');
  });

  it('no final for that turn says so', async () => {
    const h = harness({ readFinal: vi.fn(async () => undefined) });
    h.session.notices = [result];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    expect(h.posts[0].text).toMatch(/답변 기록 없음 — 카드에서 확인/);
  });

  it('failure and interrupted say what happened and why, with the link', async () => {
    const h = harness();
    h.session.notices = [
      { id: `${TASK_ID}:c1:failure`, kind: 'failure', outcome: 'failed', reason: 'turn threw: boom', at: 3 },
      { id: `${TASK_ID}:c2:interrupted`, kind: 'interrupted', outcome: 'interrupted', reason: 'process ended', at: 4 },
    ];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    expect(h.posts[0].text).toMatch(/끝나지 못했/);
    expect(h.posts[0].text).toContain('turn threw: boom');
    expect(h.posts[1].text).toMatch(/중단/);
    expect(h.posts.every((p) => p.text.includes('https://dash.example'))).toBe(true);
  });

  it('a question is posted only while the task still waits on that askId; otherwise it is closed, not sent', async () => {
    const question = {
      id: `${TASK_ID}:c1:question:ask-7`,
      kind: 'question',
      askId: 'ask-7',
      outcome: 'waiting',
      at: 5,
    };
    const waiting = harness(
      {},
      task({ activityState: 'waiting', actionPanel: { pendingQuestion: { askId: 'ask-7' } } }),
    );
    waiting.session.notices = [question];
    waiting.deliverer.enqueue(waiting.session, KEY);
    await waiting.deliverer.deliver();
    expect(waiting.posts[0].text).toMatch(/답이 필요/);
    expect(waiting.ledger.get(question.id)?.state).toBe('posted');

    const answered = harness({}, task({ activityState: 'idle' }));
    answered.session.notices = [question];
    answered.deliverer.enqueue(answered.session, KEY);
    await answered.deliverer.deliver();
    expect(answered.posts).toHaveLength(0);
    expect(answered.ledger.get(question.id)?.state).toBe('resolved');

    const replaced = harness(
      {},
      task({ activityState: 'waiting', actionPanel: { pendingQuestion: { askId: 'ask-8' } } }),
    );
    replaced.session.notices = [question];
    replaced.deliverer.enqueue(replaced.session, KEY);
    await replaced.deliverer.deliver();
    expect(replaced.posts).toHaveLength(0);
    expect(replaced.ledger.get(question.id)?.state).toBe('superseded');
  });

  it('a failed post is retried, then marked failed once the attempts are spent — never re-posted after', async () => {
    const h = harness({
      post: vi.fn(async () => {
        throw new Error('channel_not_found');
      }),
    });
    h.session.notices = [result];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    await h.deliverer.deliver();
    expect(h.ledger.get(result.id)?.state).toBe('pending');
    await h.deliverer.deliver();
    expect(h.ledger.get(result.id)).toMatchObject({ state: 'failed', attempts: 3, error: 'channel_not_found' });
    await h.deliverer.deliver();
    expect(h.deps.post).toHaveBeenCalledTimes(3);
  });

  it('a pass started while one is running runs once more after it — never two at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const h = harness({
      post: vi.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight--;
        return { ts: 'ts' };
      }),
    });
    h.session.notices = [link];
    h.deliverer.enqueue(h.session, KEY);
    const first = h.deliverer.deliver();
    h.session.notices = [link, result];
    h.deliverer.enqueue(h.session, KEY);
    const second = h.deliverer.deliver();
    release();
    await Promise.all([first, second]);
    expect(maxInFlight).toBe(1);
    expect(h.ledger.get(result.id)?.state).toBe('posted');
  });

  it('a notice whose task is gone still posts, from what the ledger kept (the card link it was handed off with)', async () => {
    const h = harness();
    h.session.notices = [result];
    h.deliverer.enqueue(h.session, KEY);
    (h.deps.getTask as any).mockImplementation(() => undefined);
    await h.deliverer.deliver();
    expect(h.posts).toHaveLength(1);
    expect(h.deps.readFinal).toHaveBeenCalledWith('conv-1', 't1');
  });
});

describe('task notice deliverer — the delete boundary, settling, the card, retries (E2 ⑤b)', () => {
  it('the delete boundary hands a task’s notices to the ledger, plus an interrupted one while its chain is open', async () => {
    const h = harness({}, task({ activityState: 'working', openChain: 'c9', activeTaskTurnId: 't9' }));
    h.session.notices = [link];
    h.deliverer.handoff(h.session, KEY);
    // The same id restart reconciliation and endStranded give that chain.
    expect(h.ledger.get(`${TASK_ID}:c9:interrupted`)).toMatchObject({
      state: 'pending',
      kind: 'interrupted',
      intent: { chainId: 'c9', turnId: 't9', outcome: 'interrupted' },
    });
    expect(h.ledger.get(link.id)?.state).toBe('pending');
  });

  it('…a turn working with no chain on record is keyed by its turn', () => {
    const h = harness({}, task({ activityState: 'working', activeTaskTurnId: 't9' }));
    h.deliverer.handoff(h.session, KEY);
    expect(h.ledger.get(`${TASK_ID}:t9:interrupted`)?.kind).toBe('interrupted');
  });

  it('…an idle task with no open chain hands over only what it owes', () => {
    const h = harness();
    h.session.notices = [result];
    h.deliverer.handoff(h.session, KEY);
    expect(h.ledger.owed().map((e) => e.id)).toEqual([result.id]);
  });

  it('a handoff the ledger cannot write throws — the registry then refuses the deletion', () => {
    const h = harness();
    h.session.notices = [result];
    vi.spyOn(h.ledger, 'register').mockImplementation(() => {
      throw new Error('EROFS');
    });
    expect(() => h.deliverer.handoff(h.session, KEY)).toThrow('EROFS');
  });

  it('a task with no instruction thread hands over nothing', () => {
    const h = harness({}, task({ originThread: undefined, activityState: 'working', openChain: 'c9' }));
    h.deliverer.handoff(h.session, KEY);
    expect(h.ledger.owed()).toHaveLength(0);
  });

  it('a notice that reached the thread, or was closed, is settled — its intent can leave the task record', async () => {
    const settled = vi.fn();
    const h = harness({ settled });
    h.session.notices = [link, result];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    expect(settled.mock.calls).toEqual([
      [TASK_ID, link.id],
      [TASK_ID, result.id],
    ]);
  });

  it('…a post that will be retried is not settled', async () => {
    const settled = vi.fn();
    const h = harness({
      settled,
      retryDelayMs: 60_000,
      post: vi.fn(async () => {
        throw new Error('ratelimited');
      }),
    });
    h.session.notices = [result];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    expect(settled).not.toHaveBeenCalled();
    h.deliverer.stop();
  });

  it('the card shows a notice that could not be delivered', async () => {
    const h = harness({
      post: vi.fn(async () => {
        throw new Error('channel_not_found');
      }),
      maxAttempts: 1,
    });
    h.session.notices = [result];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    expect(h.deliverer.failures(KEY)).toEqual([{ kind: 'result', error: 'channel_not_found' }]);
    expect(h.deliverer.failures('task:other')).toEqual([]);
  });

  it('a failed post is retried by itself after a delay — no other event needed', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const h = harness({
        retryDelayMs: 30_000,
        post: vi.fn(async () => {
          calls++;
          if (calls === 1) throw new Error('ratelimited');
          return { ts: '1700000099.000009' };
        }),
      });
      h.session.notices = [result];
      h.deliverer.enqueue(h.session, KEY);
      await h.deliverer.deliver();
      expect(h.ledger.get(result.id)?.state).toBe('pending');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.ledger.get(result.id)?.state).toBe('posted');
      h.deliverer.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('task notice deliverer — restart re-send and a mark that cannot be saved (E2 ⑤b, fable #667)', () => {
  it('after a restart, a notice that had failed is tried once more (D13); failing again, it is failed again', async () => {
    let fail = true;
    const h = harness({
      maxAttempts: 1,
      post: vi.fn(async () => {
        if (fail) throw new Error('channel_not_found');
        return { ts: '1700000099.000001' };
      }),
    });
    h.session.notices = [result];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    expect(h.ledger.get(result.id)?.state).toBe('failed');
    // In the same process it is left alone.
    await h.deliverer.deliver();
    expect(h.deps.post).toHaveBeenCalledTimes(1);
    // The boot pass tries it again.
    fail = false;
    await h.deliverer.deliver({ retryFailed: true });
    expect(h.ledger.get(result.id)?.state).toBe('posted');
    expect(h.deps.post).toHaveBeenCalledTimes(2);
  });

  it('a post Slack took whose mark could not be saved is not posted again in this process', async () => {
    const settled = vi.fn();
    const h = harness({ settled });
    h.session.notices = [link, result];
    h.deliverer.enqueue(h.session, KEY);
    const mark = vi.spyOn(h.ledger, 'markPosted').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    await h.deliverer.deliver();
    // The link went out but stays `unknown` on disk; the result is not held behind it.
    expect(h.ledger.get(link.id)?.state).toBe('unknown');
    expect(h.ledger.get(result.id)?.state).toBe('posted');
    mark.mockRestore();
    await h.deliverer.deliver();
    expect(h.posts.filter((p) => p.text.includes('대시보드 작업'))).toHaveLength(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(h.deps.logger.error).toHaveBeenCalled();
  });
});

describe('task notice deliverer — approvals (E2 ⑥, D9 · D13)', () => {
  const REQ_EVENT = {
    type: 'requested' as const,
    approvalId: 'approval_1',
    sessionKey: KEY,
    turnId: 't1',
    toolName: 'Bash',
    expiresAt: 1_700_000_300_000,
  };
  const requestId = `${TASK_ID}:t1:approval:approval_1`;
  const expiredId = `${TASK_ID}:t1:approval-expired:approval_1`;

  it('an approval asked is posted at once — the tool’s name and the deadline, never its input', async () => {
    const h = harness({ isApprovalOpen: () => true }, task({ activityState: 'working' }));
    h.deliverer.approval(REQ_EVENT);
    await h.deliverer.deliver();
    expect(h.ledger.get(requestId)).toMatchObject({ kind: 'approval', state: 'posted' });
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].text).toContain('Bash');
    expect(h.posts[0].text).toContain('<!date^1700000300^');
    expect(h.posts[0].text).toContain('https://dash.example/');
  });

  it('a ledger that cannot be written does not stop the approval (the event is logged, nothing thrown)', () => {
    const h = harness({ isApprovalOpen: () => true }, task({ activityState: 'working' }));
    vi.spyOn(h.ledger, 'register').mockImplementation(() => {
      throw new Error('EROFS');
    });
    expect(() => h.deliverer.approval(REQ_EVENT)).not.toThrow();
    expect(h.deps.logger.error).toHaveBeenCalled();
  });

  it('answered or ended before it was posted: closed, not sent', async () => {
    let open = true;
    const h = harness(
      { isApprovalOpen: () => open, post: vi.fn(async () => ({ ts: 'x' })) },
      task({ activityState: 'working' }),
    );
    h.deliverer.approval(REQ_EVENT);
    open = false;
    h.deliverer.approval({ ...REQ_EVENT, type: 'resolved', resolution: 'allow' });
    await h.deliverer.deliver();
    expect(h.deps.post).not.toHaveBeenCalled();
    expect(h.ledger.get(requestId)?.state).toBe('resolved');
  });

  it('expired: one “not run” notice; the owner’s deny and no-window: none', async () => {
    for (const resolution of ['expired', 'deny', 'no-window'] as const) {
      const h = harness({ isApprovalOpen: () => false }, task({ activityState: 'working' }));
      h.deliverer.approval({ ...REQ_EVENT, type: 'resolved', resolution });
      await h.deliverer.deliver();
      if (resolution === 'expired') {
        expect(h.posts).toHaveLength(1);
        expect(h.posts[0].text).toContain('실행하지 않았');
        expect(h.posts[0].text).toContain('Bash');
        expect(h.ledger.get(expiredId)?.state).toBe('posted');
      } else {
        expect(h.posts).toHaveLength(0);
      }
    }
  });

  it('a task with no instruction thread gets no approval notices', async () => {
    const h = harness({ isApprovalOpen: () => true }, task({ originThread: undefined }));
    h.deliverer.approval(REQ_EVENT);
    h.deliverer.approval({ ...REQ_EVENT, type: 'resolved', resolution: 'expired' });
    expect(h.ledger.owed()).toHaveLength(0);
    // Not an error: a dashboard task simply has no thread to tell.
    expect(h.deps.logger.error).not.toHaveBeenCalled();
  });

  it('restart while an approval waited: the interrupted notice says so; the stale request is closed, not sent', async () => {
    // Before the restart: the request was posted and never resolved.
    const before = harness({ isApprovalOpen: () => true }, task({ activityState: 'working' }));
    before.deliverer.approval(REQ_EVENT);
    await before.deliverer.deliver();
    // A second request was registered but not yet posted when the process died:
    // its row is on the ledger, and no pass of the dead process runs any more (fable #669 P3-1).
    before.ledger.register({
      id: `${TASK_ID}:t1:approval:approval_2`,
      taskId: TASK_ID,
      kind: 'approval',
      channel: ORIGIN.channel,
      threadTs: ORIGIN.threadTs,
      intent: {
        approval: 'request',
        approvalId: 'approval_2',
        toolName: 'Bash',
        turnId: 't1',
        ownerId: 'U1',
        sessionKey: KEY,
      },
    });
    before.deliverer.stop();
    // Restart reconciliation's interrupted notice for that turn.
    const reconciled = task({
      notices: [
        {
          id: `${TASK_ID}:c1:interrupted`,
          kind: 'interrupted',
          chainId: 'c1',
          turnId: 't1',
          outcome: 'interrupted',
          reason: 'process ended before the outcome was recorded',
          at: 3,
        },
      ],
    });
    const posts: string[] = [];
    const after = createTaskNoticeDeliverer({
      ...before.deps,
      isApprovalOpen: () => false,
      getTask: () => ({ session: reconciled, sessionKey: KEY }),
      post: vi.fn(async (_t, m) => {
        posts.push(m.text);
        return { ts: 'y' };
      }),
    });
    after.enqueue(reconciled, KEY);
    await after.deliver({ retryFailed: true });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('승인 대기 중 중단');
    expect(before.ledger.get(`${TASK_ID}:t1:approval:approval_2`)?.state).toBe('superseded');
    expect(before.posts).toHaveLength(1);
  });

  it('a graceful restart (the wait aborted by shutdown) still reads “승인 대기 중 중단” (fable #669 P2-1)', async () => {
    const h = harness({ isApprovalOpen: () => true }, task({ activityState: 'working' }));
    h.deliverer.approval(REQ_EVENT);
    await h.deliverer.deliver();
    // SIGTERM: the SDK aborts the hook's signal, the approver resolves `aborted`.
    h.deliverer.approval({ ...REQ_EVENT, type: 'resolved', resolution: 'aborted' });
    h.session.notices = [
      {
        id: `${TASK_ID}:c1:interrupted`,
        kind: 'interrupted',
        chainId: 'c1',
        turnId: 't1',
        outcome: 'interrupted',
        reason: 'r',
        at: 3,
      },
    ];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    expect(h.posts.slice(-1)[0]?.text).toContain('승인 대기 중 중단');
  });

  it('an approval asked is posted with no other event to start a pass (fable #669 P3-2)', async () => {
    const h = harness({ isApprovalOpen: () => true }, task({ activityState: 'working' }));
    h.deliverer.approval(REQ_EVENT);
    await vi.waitFor(() => expect(h.posts).toHaveLength(1));
    expect(h.posts[0].text).toContain('Bash');
  });

  it('an approval another turn left open does not make this turn’s interruption “waiting”', async () => {
    const h = harness({ isApprovalOpen: () => true }, task({ activityState: 'working' }));
    h.deliverer.approval({ ...REQ_EVENT, turnId: 't0' });
    await h.deliverer.deliver();
    h.session.notices = [
      {
        id: `${TASK_ID}:c1:interrupted`,
        kind: 'interrupted',
        chainId: 'c1',
        turnId: 't1',
        outcome: 'interrupted',
        reason: 'r',
        at: 3,
      },
    ];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    expect(h.posts.slice(-1)[0]?.text).toContain('작업이 중단됐어요');
    expect(h.posts.slice(-1)[0]?.text).not.toContain('승인 대기 중');
  });

  it('a resolved approval is no longer “waiting” for the interrupted notice', async () => {
    const h = harness({ isApprovalOpen: () => true }, task({ activityState: 'working' }));
    h.deliverer.approval(REQ_EVENT);
    await h.deliverer.deliver();
    h.deliverer.approval({ ...REQ_EVENT, type: 'resolved', resolution: 'allow' });
    h.session.notices = [
      {
        id: `${TASK_ID}:c1:interrupted`,
        kind: 'interrupted',
        chainId: 'c1',
        turnId: 't1',
        outcome: 'interrupted',
        reason: 'r',
        at: 3,
      },
    ];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    expect(h.posts.slice(-1)[0]?.text).not.toContain('승인 대기 중');
  });
});

describe('task notice deliverer — never rejects, says what it drops, stops (grok #668)', () => {
  it('a final that cannot be read still posts the result, saying so; deliver never rejects', async () => {
    const h = harness({
      readFinal: vi.fn(async () => {
        throw new Error('EIO');
      }),
    });
    h.session.notices = [result];
    h.deliverer.enqueue(h.session, KEY);
    await expect(h.deliverer.deliver()).resolves.toBeUndefined();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].text).toContain('결과를 읽지 못했어요');
    expect(h.ledger.get(result.id)?.state).toBe('posted');
  });

  it('an unexpected throw in a pass rejects no caller — the one who joined it included', async () => {
    const h = harness();
    h.session.notices = [link];
    h.deliverer.enqueue(h.session, KEY);
    const owed = vi.spyOn(h.ledger, 'owed').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const first = h.deliverer.deliver();
    const joined = h.deliverer.deliver();
    await expect(first).resolves.toBeUndefined();
    await expect(joined).resolves.toBeUndefined();
    expect(h.deps.logger.error).toHaveBeenCalled();
    owed.mockRestore();
    // The coalesced pass still ran: the link went out.
    expect(h.ledger.get(link.id)?.state).toBe('posted');
  });

  it('notices on a task that lost its instruction thread are logged, not silently dropped', () => {
    const h = harness({}, task({ originThread: undefined }));
    h.session.notices = [result];
    h.deliverer.enqueue(h.session, KEY);
    expect(h.ledger.owed()).toHaveLength(0);
    expect(h.deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no instruction thread'),
      expect.anything(),
    );
  });

  it('after stop() no pass runs and no retry fires', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        retryDelayMs: 1_000,
        post: vi.fn(async () => {
          throw new Error('ratelimited');
        }),
      });
      h.session.notices = [result];
      h.deliverer.enqueue(h.session, KEY);
      await h.deliverer.deliver();
      expect(h.deps.post).toHaveBeenCalledTimes(1);
      h.deliverer.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      await h.deliverer.deliver();
      expect(h.deps.post).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('task notice deliverer — coverage from the reviews (fable #668)', () => {
  it('a link that has failed for good does not hold the task’s result back', async () => {
    let n = 0;
    const h = harness({
      maxAttempts: 1,
      post: vi.fn(async () => {
        if (++n === 1) throw new Error('channel_not_found');
        return { ts: '1700000099.000002' };
      }),
    });
    h.session.notices = [link, result];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    expect(h.ledger.get(link.id)?.state).toBe('failed');
    expect(h.ledger.get(result.id)?.state).toBe('posted');
    h.deliverer.stop();
  });

  it('one notice that throws does not stop the others; it is retried later', async () => {
    vi.useFakeTimers();
    try {
      const other = { ...result, id: `${TASK_ID}:c2:result`, chainId: 'c2', turnId: 't2', at: 3 };
      const h = harness({ retryDelayMs: 1_000 });
      h.session.notices = [result, other];
      h.deliverer.enqueue(h.session, KEY);
      const claim = h.ledger.claim.bind(h.ledger);
      const spy = vi.spyOn(h.ledger, 'claim').mockImplementationOnce(() => {
        throw new Error('EIO');
      });
      await h.deliverer.deliver();
      expect(h.ledger.get(result.id)?.state).toBe('pending');
      expect(h.ledger.get(other.id)?.state).toBe('posted');
      spy.mockImplementation(claim);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.ledger.get(result.id)?.state).toBe('posted');
      h.deliverer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a notice failed for good sets no retry timer', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        maxAttempts: 1,
        retryDelayMs: 1_000,
        post: vi.fn(async () => {
          throw new Error('channel_not_found');
        }),
      });
      h.session.notices = [result];
      h.deliverer.enqueue(h.session, KEY);
      await h.deliverer.deliver();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the link without a dashboard says it started and what comes back — no card link', async () => {
    const h = harness({ cardUrl: vi.fn(() => undefined) });
    h.session.notices = [link];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    expect(h.posts[0].text).toContain('대시보드 작업으로 시작했어요');
    expect(h.posts[0].text).toContain('결과와 입력 요청이 이 스레드에 올라옵니다');
    expect(h.posts[0].text).not.toContain('http');
  });

  it('a question handed off by a task that is gone is closed, not sent', async () => {
    const h = harness({}, task({ activityState: 'waiting' }));
    const question = {
      id: `${TASK_ID}:c1:question:ask1`,
      kind: 'question',
      chainId: 'c1',
      turnId: 't1',
      askId: 'ask1',
      outcome: 'waiting',
      at: 2,
    };
    h.session.notices = [question];
    h.deliverer.handoff(h.session, KEY);
    (h.deps.getTask as any).mockImplementation(() => undefined);
    await h.deliverer.deliver();
    expect(h.posts).toHaveLength(0);
    expect(h.ledger.get(question.id)?.state).toBe('resolved');
  });

  it('after stop() no new pass reads the ledger; a pass under way stops after its current post', async () => {
    const h = harness();
    const second = { ...result, id: `${TASK_ID}:c2:result`, chainId: 'c2', turnId: 't2', at: 3 };
    h.session.notices = [link, result, second];
    h.deliverer.enqueue(h.session, KEY);
    (h.deps.post as any).mockImplementationOnce(async () => {
      h.deliverer.stop();
      return { ts: '1700000099.000001' };
    });
    await h.deliverer.deliver();
    expect(h.deps.post).toHaveBeenCalledTimes(1);
    const owed = vi.spyOn(h.ledger, 'owed');
    await h.deliverer.deliver();
    expect(owed).not.toHaveBeenCalled();
  });

  it('stop() during the last post of a pass: no retry timer is armed after it (grok #668 R2)', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ retryDelayMs: 1_000 });
      h.session.notices = [result];
      h.deliverer.enqueue(h.session, KEY);
      (h.deps.post as any).mockImplementationOnce(async () => {
        h.deliverer.stop();
        throw new Error('ratelimited');
      });
      await h.deliverer.deliver();
      expect(h.ledger.get(result.id)?.state).toBe('pending');
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.deps.post).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('what a task still owes its thread, with no ledger to hand it to (deletion must be refused)', () => {
    expect(owesInstructionThread(task({ notices: [result] }))).toBe(true);
    expect(owesInstructionThread(task({ openChain: 'c1' }))).toBe(true);
    expect(owesInstructionThread(task({ activityState: 'working' }))).toBe(true);
    expect(owesInstructionThread(task())).toBe(false);
    expect(owesInstructionThread(task({ originThread: undefined, notices: [result] }))).toBe(false);
    expect(owesInstructionThread(task({ slackless: false, notices: [result] }))).toBe(false);
  });
});

describe('task notice deliverer — hardening (E2 ⑨, fable #668 P3)', () => {
  it('a final read that fails once is read again: the thread gets the answer, not "unreadable"', async () => {
    const readFinal = vi
      .fn()
      .mockRejectedValueOnce(new Error('EIO'))
      .mockResolvedValue({ text: 'All done: **3 files** changed.', clipped: false });
    const h = harness({ readFinal });
    h.session.notices = [result];
    h.deliverer.enqueue(h.session, KEY);
    await h.deliverer.deliver();
    expect(readFinal).toHaveBeenCalledTimes(2);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].text).toContain('All done');
    expect(h.posts[0].text).not.toContain('결과를 읽지 못했어요');
  });

  it('stop() resolves only after the post under way has its mark saved', async () => {
    const h = harness();
    h.session.notices = [link, result];
    h.deliverer.enqueue(h.session, KEY);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    (h.deps.post as any).mockImplementationOnce(async () => {
      await gate;
      return { ts: '1700000099.000001' };
    });
    void h.deliverer.deliver();
    await vi.waitFor(() => expect(h.deps.post).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = h.deliverer.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(h.ledger.get(link.id)).toMatchObject({ state: 'posted', messageTs: '1700000099.000001' });
    // The pass ended after that post: the result waits for the next process.
    expect(h.ledger.get(result.id)?.state).toBe('pending');
  });

  it('stop() with no pass under way resolves at once', async () => {
    const h = harness();
    await expect(h.deliverer.stop()).resolves.toBeUndefined();
  });

  it('a claim that keeps failing is tried maxAttempts times, then left alone and shown on the card; the boot pass tries again', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ maxAttempts: 2, retryDelayMs: 1_000 });
      h.session.notices = [result];
      h.deliverer.enqueue(h.session, KEY);
      const claim = h.ledger.claim.bind(h.ledger);
      const spy = vi.spyOn(h.ledger, 'claim').mockImplementation(() => {
        throw new Error('ENOSPC');
      });
      await h.deliverer.deliver();
      expect(h.deliverer.failures(KEY)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(spy).toHaveBeenCalledTimes(2);
      // Spent: no timer, no more claims in this process, on the card.
      expect(vi.getTimerCount()).toBe(0);
      // A code on the card; the write error (it can carry a path) only in the log.
      expect(h.deliverer.failures(KEY)).toEqual([{ kind: 'result', error: 'notice_not_recorded' }]);
      expect(h.deps.logger.error).toHaveBeenCalledWith(
        'Task notice not delivered',
        expect.objectContaining({ error: 'ENOSPC' }),
      );
      await h.deliverer.deliver();
      expect(spy).toHaveBeenCalledTimes(2);
      // The disk is back; the boot pass (retryFailed) tries again and it goes out.
      spy.mockImplementation(claim);
      await h.deliverer.deliver({ retryFailed: true });
      expect(h.ledger.get(result.id)?.state).toBe('posted');
      expect(h.deliverer.failures(KEY)).toEqual([]);
      await h.deliverer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a claim that fails once and then works leaves nothing on the card', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ maxAttempts: 2, retryDelayMs: 1_000 });
      h.session.notices = [result];
      h.deliverer.enqueue(h.session, KEY);
      const claim = h.ledger.claim.bind(h.ledger);
      vi.spyOn(h.ledger, 'claim')
        .mockImplementationOnce(() => {
          throw new Error('EIO');
        })
        .mockImplementation(claim);
      await h.deliverer.deliver();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.ledger.get(result.id)?.state).toBe('posted');
      expect(h.deliverer.failures(KEY)).toEqual([]);
      await h.deliverer.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('task notice deliverer — claim failures count in a row (E2 ⑨)', () => {
  it('a claim that worked in between resets the count: two failures apart do not spend the notice', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ maxAttempts: 3, retryDelayMs: 1_000 });
      h.session.notices = [result];
      h.deliverer.enqueue(h.session, KEY);
      const claim = h.ledger.claim.bind(h.ledger);
      const fail = () => {
        throw new Error('EIO');
      };
      vi.spyOn(h.ledger, 'claim')
        .mockImplementationOnce(fail) // claim fails (1)
        .mockImplementationOnce(fail) // claim fails (2)
        .mockImplementationOnce(claim) // claim works; the post fails below
        .mockImplementationOnce(fail) // claim fails — 1 in a row, not 3
        .mockImplementation(claim);
      (h.deps.post as any).mockImplementationOnce(async () => {
        throw new Error('ratelimited');
      });
      await h.deliverer.deliver();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.deliverer.failures(KEY)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.ledger.get(result.id)?.state).toBe('posted');
      await h.deliverer.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
