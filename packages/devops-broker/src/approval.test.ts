import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalConsumeError,
  ApprovalError,
  type ApprovalLimits,
  type ApprovalOutcome,
  type ApprovalRequest,
  type ApprovalState,
  type Approvals,
  approvalDigest,
  createApprovals,
  DEFAULT_APPROVAL_LIMITS,
  initialApprovalState,
} from './approval.js';
import { Ledger } from './ledger.js';
import type { BrokerPolicy } from './policy.js';
import { createSlackApi, type SlackApi } from './slack-api.js';
import { StateStore } from './state.js';

// Per-request approval through the broker's own Slack app (.prd/16-devops-tools-architecture.md §5) against a
// local fake Slack (`__fixtures__/fake-slack.cjs`). loop.md WU2 RED: a bot-identity ✅ is not an approval, a
// non-admin ❌ is ignored, admin ✅+❌ = denied, one approval is consumed once (also across a restart), silence
// expires, the 4th pending card is refused at once, Slack errors and 429 never approve and Retry-After is kept.

interface FakeRequest {
  method: string;
  params: Record<string, unknown>;
  auth: string | undefined;
  at: number;
  overridden: boolean;
}
interface FakeMessage {
  channel: string;
  ts: string;
  text: string;
  blocks: unknown[] | undefined;
  threadTs: string | undefined;
  updates: { text: string; blocks: unknown[] | undefined }[];
}
interface FakeSlack {
  apiBase: string;
  requests: FakeRequest[];
  calls(method: string): FakeRequest[];
  enqueue(
    method: string,
    response: { status?: number; headers?: Record<string, string>; body?: unknown },
    when?: (params: Record<string, unknown>) => boolean,
  ): void;
  cards(channel: string): FakeMessage[];
  replies(channel: string, threadTs: string): FakeMessage[];
  allMessages(): FakeMessage[];
  react(channel: string, ts: string, name: string, user: string): void;
  close(): Promise<void>;
}
const { startFakeSlack } = createRequire(__filename)('./__fixtures__/fake-slack.cjs') as {
  startFakeSlack(opts: { token: string }): Promise<FakeSlack>;
};

const TOKEN = ['xoxb', 'fake', 'broker', 'app', 'not', 'real'].join('-');
const ADMIN = 'U000ADMIN';
const ADMIN_B = 'U000ADMINB';
const BOT = 'U000SOMABOT';
const OTHER = 'U000OTHER';
const START = Date.UTC(2026, 9, 26, 5, 0, 0);

const dm = (user: string) => `D${user.slice(1)}`;

let dir: string;
let stateFile: string;
let ledgerFile: string;
let fake: FakeSlack;
let slack: SlackApi;
let ledger: Ledger;
let clock: number;
let open: Approvals[];

function policy(overrides: Partial<BrokerPolicy> = {}): BrokerPolicy {
  return {
    admins: [ADMIN],
    gh: {
      org: 'example-org',
      allowedOwners: ['example-org'],
      accounts: { member: { login: 'alice', class: 'member' } },
      restWriteAllowlist: [],
    },
    cloudflare: {},
    approvalTimeoutSeconds: 300,
    maxPendingApprovals: 3,
    ...overrides,
  };
}

interface Extra {
  slack?: SlackApi;
  store?: StateStore<ApprovalState>;
  ledger?: Ledger;
  limits?: Partial<ApprovalLimits>;
  buttons?: boolean;
}

/** Log lines the approvals wrote (the default writes to stderr). */
let logged: string[];

async function makeApprovals(
  overrides: Partial<BrokerPolicy> = {},
  pollIntervalMs = 10,
  extra: Extra = {},
): Promise<Approvals> {
  let store = extra.store;
  if (store === undefined) {
    store = new StateStore<ApprovalState>(stateFile, initialApprovalState());
    await store.load();
  }
  const approvals = createApprovals({
    policy: policy(overrides),
    slack: extra.slack ?? slack,
    store,
    ledger: extra.ledger ?? ledger,
    now: () => clock,
    pollIntervalMs,
    limits: extra.limits,
    buttons: extra.buttons,
    log: (line) => logged.push(line),
  });
  open.push(approvals);
  return approvals;
}

/** A state store whose next `update` waits until `release()` (or fails once with `failNext`). */
async function controlledStore(): Promise<{
  store: StateStore<ApprovalState>;
  hold(): void;
  held(): boolean;
  release(): void;
  failNext(): void;
}> {
  const inner = new StateStore<ApprovalState>(stateFile, initialApprovalState());
  await inner.load();
  let holding = false;
  let failing = false;
  let gate: (() => void) | undefined;
  const store = {
    load: () => inner.load(),
    get: () => inner.get(),
    update: async <R>(fn: (draft: ApprovalState) => R | Promise<R>): Promise<R> => {
      if (failing) {
        failing = false;
        throw new Error('EIO: simulated state write failure');
      }
      if (holding) {
        holding = false;
        await new Promise<void>((resolve) => {
          gate = resolve;
        });
      }
      return inner.update(fn);
    },
  } as unknown as StateStore<ApprovalState>;
  return {
    store,
    hold: () => {
      holding = true;
    },
    held: () => gate !== undefined,
    release: () => gate?.(),
    failNext: () => {
      failing = true;
    },
  };
}

/** A ledger whose first `count` appends fail. */
function flakyLedger(count: number): Ledger {
  let left = count;
  return {
    append: (row: { event: string } & Record<string, unknown>) =>
      left-- > 0 ? Promise.reject(new Error('EIO: simulated ledger failure')) : ledger.append(row),
  } as unknown as Ledger;
}

function session(n: number): string {
  return `C000CHAN:1700000000.${String(99 + n).padStart(6, '0')}`;
}

/** A request from an explicit claimed session. */
function from(sessionKey: string, n: number): ApprovalRequest {
  return req(n, { claimedRequester: { slackUserId: 'U000ALICE', sessionKey } });
}

function req(n = 1, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    tool: 'gh_write',
    title: `member 계정으로 example-org/repo PR ${n}에 댓글을 단다`,
    details: [{ label: '계정', value: 'member' }],
    argv: ['pr', 'comment', String(n), '-R', 'example-org/repo', '--body', 'hi'],
    warnings: [],
    claimedRequester: { slackUserId: 'U000ALICE', sessionKey: session(n) },
    canonical: { account: 'member', args: ['pr', 'comment', String(n), '-R', 'example-org/repo', '--body', 'hi'] },
    ...overrides,
  };
}

type Pending = { approvalId: string; digestPrefix: string; expiresAt: string };

function start(
  approvals: Approvals,
  request: ApprovalRequest,
  signal?: AbortSignal,
): { pending: Pending[]; result: Promise<ApprovalOutcome>; settled: () => boolean } {
  const pending: Pending[] = [];
  let done = false;
  const result = approvals.request(request, { onPending: (p) => pending.push(p), signal });
  result.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { pending, result, settled: () => done };
}

async function waitFor<T>(fn: () => T | undefined | null | false, what = 'condition', timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function cardWith(user: string, approvalId: string): FakeMessage {
  const found = fake.cards(dm(user)).find((m) => JSON.stringify(m.blocks ?? []).includes(approvalId));
  if (found === undefined) throw new Error(`no card for ${approvalId} in ${user}'s DM`);
  return found;
}

function card(user: string, index = 0): FakeMessage {
  const cards = fake.cards(dm(user));
  const found = cards[index];
  if (found === undefined) throw new Error(`no card ${index} for ${user}`);
  return found;
}

function rows(): Record<string, unknown>[] {
  if (!fs.existsSync(ledgerFile)) return [];
  return fs
    .readFileSync(ledgerFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function events(approvalId?: string): string[] {
  return rows()
    .filter((row) => approvalId === undefined || row.approvalId === approvalId)
    .map((row) => String(row.event));
}

function stateOnDisk(): ApprovalState {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as ApprovalState;
}

function lastUpdateText(message: FakeMessage): string {
  const update = message.updates.at(-1);
  if (update === undefined) return '';
  return [update.text, JSON.stringify(update.blocks ?? [])].join('\n');
}

async function caughtApprovalError(promise: Promise<unknown>): Promise<ApprovalError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApprovalError);
    return err as ApprovalError;
  }
  throw new Error('expected an ApprovalError');
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devops-approval-'));
  stateFile = path.join(dir, 'state', 'approvals.json');
  ledgerFile = path.join(dir, 'state', 'ledger.jsonl');
  fake = await startFakeSlack({ token: TOKEN });
  slack = createSlackApi({ token: TOKEN, apiBase: fake.apiBase });
  ledger = new Ledger(ledgerFile);
  clock = START;
  open = [];
  logged = [];
});

afterEach(async () => {
  for (const approvals of open) await approvals.close();
  await fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('approvalDigest', () => {
  it('is sha256 of key-sorted JSON of tool, canonical and claimed requester', () => {
    const a = req(1, { canonical: { b: 1, a: { d: [1, 2], c: 'x' } } });
    const b = req(1, { canonical: { a: { c: 'x', d: [1, 2] }, b: 1 } });
    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          canonical: { a: { c: 'x', d: [1, 2] }, b: 1 },
          claimedRequester: { sessionKey: 'C000CHAN:1700000000.000100', slackUserId: 'U000ALICE' },
          tool: 'gh_write',
        }),
      )
      .digest('hex');
    expect(approvalDigest(a)).toBe(expected);
    expect(approvalDigest(b)).toBe(expected);
    expect(approvalDigest(req(1, { tool: 'gh_org_member' }))).not.toBe(expected);
    expect(approvalDigest(req(1, { claimedRequester: { slackUserId: 'U000ALICE', sessionKey: 'other' } }))).not.toBe(
      approvalDigest(req(1)),
    );
  });
});

describe('createApprovals', () => {
  it('posts one card per admin, approves on an admin ✅ and consumes exactly once', async () => {
    const approvals = await makeApprovals({ admins: [ADMIN, ADMIN_B] });
    const run = start(approvals, req());
    const [pending] = await waitFor(() => run.pending.length > 0 && run.pending, 'pending');
    expect(pending.approvalId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(pending.digestPrefix).toBe(approvalDigest(req()).slice(0, 12));
    expect(pending.expiresAt).toBe(new Date(START + 300_000).toISOString());
    expect(fake.calls('chat.postMessage')).toHaveLength(2);
    const onDisk = stateOnDisk().approvals[pending.approvalId];
    expect(onDisk.status).toBe('pending');
    expect(onDisk.posts.map((p) => p.admin)).toEqual([ADMIN, ADMIN_B]);
    expect(onDisk.posts.map((p) => p.channel)).toEqual([dm(ADMIN), dm(ADMIN_B)]);

    fake.react(dm(ADMIN_B), card(ADMIN_B).ts, 'white_check_mark', ADMIN_B);
    const outcome = await run.result;
    expect(outcome).toMatchObject({ outcome: 'approved', approvalId: pending.approvalId });
    if (outcome.outcome !== 'approved') throw new Error('not approved');
    await outcome.consume();
    await expect(outcome.consume()).rejects.toMatchObject({ name: 'ApprovalConsumeError', reason: 'used' });
    expect(stateOnDisk().approvals[pending.approvalId].status).toBe('consumed');
    expect(events(pending.approvalId)).toEqual([
      'approval.requested',
      'approval.card-posted',
      'approval.card-posted',
      'approval.approved',
      'approval.consumed',
    ]);
    expect(rows().find((row) => row.event === 'approval.approved')).toMatchObject({ by: ADMIN_B });
    for (const admin of [ADMIN, ADMIN_B]) {
      await waitFor(() => card(admin).updates.length > 0, 'approved card update');
      expect(lastUpdateText(card(admin))).toContain('승인됨');
    }
    expect(fs.readFileSync(ledgerFile, 'utf8')).not.toContain(TOKEN);
    expect(fs.readFileSync(stateFile, 'utf8')).not.toContain(TOKEN);
  });

  it('does not approve on a ✅ from the bot identity or any non-admin; silence expires', async () => {
    const approvals = await makeApprovals();
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', BOT);
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', OTHER);
    const polls = fake.calls('reactions.get').length;
    await waitFor(() => fake.calls('reactions.get').length >= polls + 5, 'polls');
    expect(run.settled()).toBe(false);
    clock += 301_000;
    const outcome = await run.result;
    expect(outcome.outcome).toBe('expired');
    expect(events(outcome.approvalId)).toContain('approval.expired');
    expect(stateOnDisk().approvals[outcome.approvalId].status).toBe('expired');
    await waitFor(() => card(ADMIN).updates.length > 0, 'expired card update');
    expect(lastUpdateText(card(ADMIN))).toContain('만료됨');
  });

  it('ignores a non-admin ❌ and still approves on a later admin ✅', async () => {
    const approvals = await makeApprovals();
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    fake.react(dm(ADMIN), card(ADMIN).ts, 'x', OTHER);
    fake.react(dm(ADMIN), card(ADMIN).ts, 'x', BOT);
    const polls = fake.calls('reactions.get').length;
    await waitFor(() => fake.calls('reactions.get').length >= polls + 3, 'polls');
    expect(run.settled()).toBe(false);
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    expect((await run.result).outcome).toBe('approved');
  });

  it('denies when an admin has both ✅ and ❌', async () => {
    const approvals = await makeApprovals();
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    fake.react(dm(ADMIN), card(ADMIN).ts, 'x', ADMIN);
    const outcome = await run.result;
    expect(outcome.outcome).toBe('denied');
    expect('consume' in outcome).toBe(false);
    expect(rows().find((row) => row.event === 'approval.denied')).toMatchObject({ by: ADMIN });
    await waitFor(() => card(ADMIN).updates.length > 0, 'denied card update');
    expect(lastUpdateText(card(ADMIN))).toContain('거부됨');
  });

  it("denies when one admin's ✅ meets another admin's ❌", async () => {
    const approvals = await makeApprovals({ admins: [ADMIN, ADMIN_B] });
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    fake.react(dm(ADMIN_B), card(ADMIN_B).ts, 'x', ADMIN_B);
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    expect((await run.result).outcome).toBe('denied');
  });

  it('strips a skin-tone suffix from the reaction name', async () => {
    const approvals = await makeApprovals();
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark::skin-tone-3', ADMIN);
    expect((await run.result).outcome).toBe('approved');
  });

  it('does not count look-alike reactions', async () => {
    const approvals = await makeApprovals();
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    for (const name of ['heavy_check_mark', 'ballot_box_with_check', '+1', 'white_check_mark_extra']) {
      fake.react(dm(ADMIN), card(ADMIN).ts, name, ADMIN);
    }
    const polls = fake.calls('reactions.get').length;
    await waitFor(() => fake.calls('reactions.get').length >= polls + 3, 'polls');
    expect(run.settled()).toBe(false);
  });

  it('always calls reactions.get with full=true (an admin listed second is still seen)', async () => {
    const approvals = await makeApprovals();
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', BOT);
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    expect((await run.result).outcome).toBe('approved');
    const calls = fake.calls('reactions.get');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.params.full).toBe('true');
  });

  it('lets concurrent consumes of one approval succeed exactly once', async () => {
    const approvals = await makeApprovals();
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    const outcome = await run.result;
    if (outcome.outcome !== 'approved') throw new Error('not approved');
    const results = await Promise.allSettled([outcome.consume(), outcome.consume(), outcome.consume()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(ApprovalConsumeError);
        expect((result.reason as ApprovalConsumeError).reason).toBe('used');
      }
    }
    expect(events(outcome.approvalId).filter((e) => e === 'approval.consumed')).toHaveLength(1);
  });

  it('refuses a consume after the broker restarted, and never reuses an old approval for the same request', async () => {
    const first = await makeApprovals();
    const run = start(first, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    const outcome = await run.result;
    if (outcome.outcome !== 'approved') throw new Error('not approved');

    // A second process over the same state directory: the approved-but-unused approval is now void.
    const second = await makeApprovals();
    const rerun = start(second, req());
    await waitFor(() => rerun.pending.length > 0, 'pending after restart');
    expect(stateOnDisk().approvals[outcome.approvalId].status).toBe('expired');
    await expect(outcome.consume()).rejects.toMatchObject({ name: 'ApprovalConsumeError', reason: 'not-approved' });
    expect(rerun.pending[0].approvalId).not.toBe(outcome.approvalId);
    // The ✅ on the old card does not carry over to the new card.
    expect(fake.cards(dm(ADMIN))).toHaveLength(2);
    const polls = fake.calls('reactions.get').length;
    await waitFor(() => fake.calls('reactions.get').length >= polls + 3, 'polls');
    expect(rerun.settled()).toBe(false);
    await waitFor(() => card(ADMIN, 0).updates.some((u) => u.text.includes('만료됨')), 'old card expired');
  });

  it('keeps a consumed approval consumed across a restart', async () => {
    const first = await makeApprovals();
    const run = start(first, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    const outcome = await run.result;
    if (outcome.outcome !== 'approved') throw new Error('not approved');
    await outcome.consume();
    await first.close();
    const second = await makeApprovals();
    const rerun = start(second, req());
    await waitFor(() => rerun.pending.length > 0, 'pending after restart');
    expect(stateOnDisk().approvals[outcome.approvalId].status).toBe('consumed');
    await expect(outcome.consume()).rejects.toMatchObject({ name: 'ApprovalConsumeError', reason: 'used' });
  });

  it('refuses a consume after close', async () => {
    const approvals = await makeApprovals();
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    const outcome = await run.result;
    if (outcome.outcome !== 'approved') throw new Error('not approved');
    await approvals.close();
    await expect(outcome.consume()).rejects.toMatchObject({ name: 'ApprovalConsumeError', reason: 'closed' });
  });

  it('marks approvals left pending or approved by a previous process expired and updates their cards', async () => {
    const pendingCard = await slack.postMessage(dm(ADMIN), { text: 'old pending card' });
    const approvedCard = await slack.postMessage(dm(ADMIN), { text: 'old approved card' });
    const consumedCard = await slack.postMessage(dm(ADMIN), { text: 'old consumed card' });
    const record = (approvalId: string, status: string, ts: string) => ({
      approvalId,
      tool: 'gh_write',
      digest: 'f'.repeat(64),
      status,
      claimedRequester: { slackUserId: 'U000ALICE', sessionKey: 's' },
      createdAt: new Date(START - 60_000).toISOString(),
      expiresAt: new Date(START + 240_000).toISOString(),
      posts: [{ admin: ADMIN, channel: dm(ADMIN), ts }],
    });
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        approvals: {
          oldPending00000000000a: record('oldPending00000000000a', 'pending', pendingCard.ts),
          oldApproved0000000000a: record('oldApproved0000000000a', 'approved', approvedCard.ts),
          oldConsumed0000000000a: record('oldConsumed0000000000a', 'consumed', consumedCard.ts),
        },
      }),
    );
    const approvals = await makeApprovals();
    // Any request waits for the start-up sweep.
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    const state = stateOnDisk().approvals;
    expect(state.oldPending00000000000a.status).toBe('expired');
    expect(state.oldApproved0000000000a.status).toBe('expired');
    expect(state.oldConsumed0000000000a.status).toBe('consumed');
    const byTs = (ts: string) => fake.allMessages().find((m) => m.ts === ts) as FakeMessage;
    await waitFor(() => byTs(pendingCard.ts).updates.length > 0 && byTs(approvedCard.ts).updates.length > 0, 'updates');
    expect(lastUpdateText(byTs(pendingCard.ts))).toContain('만료됨');
    expect(byTs(consumedCard.ts).updates).toHaveLength(0);
    expect(
      rows()
        .filter((row) => row.event === 'approval.expired')
        .map((row) => row.approvalId),
    ).toEqual(['oldPending00000000000a', 'oldApproved0000000000a']);
  });

  it('refuses a 4th distinct pending request at once without posting', async () => {
    const approvals = await makeApprovals();
    const runs = [start(approvals, req(1)), start(approvals, req(2)), start(approvals, req(3))];
    await waitFor(() => runs.every((run) => run.pending.length > 0), 'three pending');
    const posts = fake.calls('chat.postMessage').length;
    const opens = fake.calls('conversations.open').length;
    const err = await caughtApprovalError(approvals.request(req(4), { onPending: () => undefined }));
    expect(err.code).toBe('too-many-pending-approvals');
    expect(fake.calls('chat.postMessage')).toHaveLength(posts);
    expect(fake.calls('conversations.open')).toHaveLength(opens);
    expect(posts).toBe(3);
    expect(opens).toBe(1);
    // A decided card frees its slot.
    fake.react(dm(ADMIN), cardWith(ADMIN, runs[0].pending[0].approvalId).ts, 'x', ADMIN);
    expect((await runs[0].result).outcome).toBe('denied');
    const fourth = start(approvals, req(4));
    await waitFor(() => fourth.pending.length > 0, 'fourth pending');
  });

  it('counts an identical request as the same approval: one card per admin, same id and expiry', async () => {
    const approvals = await makeApprovals({ admins: [ADMIN, ADMIN_B] });
    const a = start(approvals, req());
    const b = start(approvals, req());
    await waitFor(() => a.pending.length > 0 && b.pending.length > 0, 'both pending');
    const c = start(approvals, req());
    await waitFor(() => c.pending.length > 0, 'third pending');
    expect(fake.calls('chat.postMessage')).toHaveLength(2);
    expect(b.pending[0]).toEqual(a.pending[0]);
    expect(c.pending[0]).toEqual(a.pending[0]);
    // The duplicates do not count against the pending cap.
    const others = [start(approvals, req(2)), start(approvals, req(3))];
    await waitFor(() => others.every((run) => run.pending.length > 0), 'others pending');
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    const outcomes = await Promise.all([a.result, b.result, c.result]);
    for (const outcome of outcomes)
      expect(outcome).toMatchObject({ outcome: 'approved', approvalId: a.pending[0].approvalId });
    const consumed = await Promise.allSettled(
      outcomes.map((outcome) => (outcome.outcome === 'approved' ? outcome.consume() : Promise.reject())),
    );
    expect(consumed.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // Once decided, the same request needs a new card.
    const again = start(approvals, req());
    await waitFor(() => again.pending.length > 0, 'new pending');
    expect(again.pending[0].approvalId).not.toBe(a.pending[0].approvalId);
    expect(fake.calls('chat.postMessage')).toHaveLength(2 + 2 * 2 + 2);
  });

  it('refuses a card for a 30k-character --body before any Slack call', async () => {
    const approvals = await makeApprovals();
    const body = 'a'.repeat(30_000);
    const err = await caughtApprovalError(
      approvals.request(req(1, { argv: ['pr', 'comment', '1', '-R', 'example-org/repo', '--body', body] }), {
        onPending: () => undefined,
      }),
    );
    expect(err.code).toBe('card-too-long');
    expect(fake.requests).toHaveLength(0);
    expect(rows().map((row) => row.event)).toEqual(['approval.refused']);
  });

  it('counts a card-too-long refusal against its session window (not the global one); nothing is posted', async () => {
    const approvals = await makeApprovals({}, 10, { limits: { sessionCardsPerWindow: 2 } });
    const tooLong = (n: number, sessionKey: string) =>
      req(n, {
        argv: ['pr', 'comment', String(n), '-R', 'example-org/repo', '--body', 'a'.repeat(30_000)],
        claimedRequester: { slackUserId: 'U000ALICE', sessionKey },
      });
    for (const n of [1, 2]) {
      const err = await caughtApprovalError(approvals.request(tooLong(n, 'S1'), { onPending: () => undefined }));
      expect(err.code).toBe('card-too-long');
    }
    // The session's window is spent: the next request is refused before rendering, even a short one.
    const err = await caughtApprovalError(approvals.request(from('S1', 3), { onPending: () => undefined }));
    expect(err.code).toBe('too-many-pending-approvals');
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(rows().at(-1)).toMatchObject({ event: 'approval.refused', limit: 'session-rate' });
    expect(fake.calls('chat.postMessage')).toHaveLength(0);
    // Another session still gets its card: the global window was not charged.
    const other = start(approvals, from('S2', 4));
    await waitFor(() => other.pending.length > 0, 'other session pending');
    expect(fake.calls('chat.postMessage')).toHaveLength(1);
  });

  it('checks the limits before rendering: an over-limit session gets the limit, not card-too-long', async () => {
    const approvals = await makeApprovals({}, 10, { limits: { sessionPending: 1 } });
    const first = start(approvals, from('S1', 1));
    await waitFor(() => first.pending.length > 0, 'first pending');
    const err = await caughtApprovalError(
      approvals.request(
        req(2, {
          argv: ['pr', 'comment', '2', '-R', 'example-org/repo', '--body', 'a'.repeat(30_000)],
          claimedRequester: { slackUserId: 'U000ALICE', sessionKey: 'S1' },
        }),
        { onPending: () => undefined },
      ),
    );
    expect(err.code).toBe('too-many-pending-approvals');
    expect(rows().at(-1)).toMatchObject({ event: 'approval.refused', limit: 'session-pending' });
    expect(fake.calls('chat.postMessage')).toHaveLength(1);
  });

  it.each([
    ['HTTP 500', { status: 500, body: 'oops' }],
    ['ok:false', { body: { ok: false, error: 'internal_error' } }],
  ])('does not approve on a poll round with a Slack error (%s)', async (_name, failure) => {
    // ADMIN's ✅ is visible in the first round, but ADMIN_B's card cannot be read then (it could hold a ❌).
    fake.enqueue('reactions.get', failure, (params) => params.channel === dm(ADMIN_B));
    const approvals = await makeApprovals({ admins: [ADMIN, ADMIN_B] }, 200);
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    let pollsAtDecision = -1;
    const outcome = await run.result.then((o) => {
      pollsAtDecision = fake.calls('reactions.get').length;
      return o;
    });
    expect(outcome.outcome).toBe('approved');
    const calls = fake.calls('reactions.get');
    expect(calls.slice(0, 2).map((call) => [call.params.channel, call.overridden])).toEqual([
      [dm(ADMIN), false],
      [dm(ADMIN_B), true],
    ]);
    // The decision came from the next, clean round.
    expect(pollsAtDecision).toBe(4);
  });

  it('does not approve while rate limited and sends nothing before Retry-After', async () => {
    fake.enqueue('reactions.get', {
      status: 429,
      headers: { 'Retry-After': '1' },
      body: { ok: false, error: 'ratelimited' },
    });
    const approvals = await makeApprovals({}, 50);
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    const outcome = await run.result;
    expect(outcome.outcome).toBe('approved');
    const calls = fake.calls('reactions.get');
    expect(calls.length).toBe(2);
    expect(calls[0].overridden).toBe(true);
    const gap = calls[1].at - calls[0].at;
    expect(gap).toBeGreaterThanOrEqual(995);
  });

  it('still expires on time while a long Retry-After holds polling back', async () => {
    fake.enqueue('reactions.get', {
      status: 429,
      headers: { 'Retry-After': '30' },
      body: { ok: false, error: 'ratelimited' },
    });
    const approvals = await makeApprovals({}, 20);
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    await waitFor(() => fake.calls('reactions.get').length === 1, 'rate-limited poll');
    clock += 301_000;
    const outcome = await run.result;
    expect(outcome.outcome).toBe('expired');
    expect(fake.calls('reactions.get')).toHaveLength(1);
  });

  it('cancels on abort and updates the card; an attached duplicate keeps waiting', async () => {
    const approvals = await makeApprovals();
    const first = new AbortController();
    const a = start(approvals, req(), first.signal);
    const b = start(approvals, req());
    await waitFor(() => a.pending.length > 0 && b.pending.length > 0, 'pending');
    first.abort();
    expect((await a.result).outcome).toBe('cancelled');
    const polls = fake.calls('reactions.get').length;
    await waitFor(() => fake.calls('reactions.get').length >= polls + 2, 'polls');
    expect(b.settled()).toBe(false);
    const second = new AbortController();
    const c = start(approvals, req(2), second.signal);
    await waitFor(() => c.pending.length > 0, 'pending c');
    second.abort();
    const outcome = await c.result;
    expect(outcome.outcome).toBe('cancelled');
    // The waiter is released at once; the record follows.
    await waitFor(() => stateOnDisk().approvals[outcome.approvalId].status === 'cancelled', 'cancelled on disk');
    await waitFor(() => events(outcome.approvalId).includes('approval.cancelled'), 'cancelled row');
    const cancelledCard = cardWith(ADMIN, outcome.approvalId);
    await waitFor(() => cancelledCard.updates.length > 0, 'cancelled card update');
    expect(lastUpdateText(cancelledCard)).toContain('취소됨');
  });

  it('returns cancelled without posting when the signal is already aborted', async () => {
    const approvals = await makeApprovals();
    const controller = new AbortController();
    controller.abort();
    const outcome = await approvals.request(req(), { onPending: () => undefined, signal: controller.signal });
    expect(outcome.outcome).toBe('cancelled');
    expect(fake.calls('chat.postMessage')).toHaveLength(0);
  });

  it('cancels pending approvals on close and updates their cards', async () => {
    const approvals = await makeApprovals();
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    await approvals.close();
    expect((await run.result).outcome).toBe('cancelled');
    expect(lastUpdateText(card(ADMIN))).toContain('취소됨');
  });

  it('fails with slack-unavailable when no admin card can be posted, and frees the slot', async () => {
    const approvals = await makeApprovals({ maxPendingApprovals: 1 });
    fake.enqueue('conversations.open', { body: { ok: false, error: 'internal_error' } });
    const err = await caughtApprovalError(approvals.request(req(), { onPending: () => undefined }));
    expect(err.code).toBe('slack-unavailable');
    const run = start(approvals, req(2));
    await waitFor(() => run.pending.length > 0, 'pending');
  });

  it('keeps going with the admins it could reach', async () => {
    const approvals = await makeApprovals({ admins: [ADMIN, ADMIN_B] });
    fake.enqueue(
      'chat.postMessage',
      { body: { ok: false, error: 'channel_not_found' } },
      (p) => p.channel === dm(ADMIN),
    );
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    expect(events()).toContain('approval.card-post-failed');
    fake.react(dm(ADMIN_B), card(ADMIN_B).ts, 'white_check_mark', ADMIN_B);
    expect((await run.result).outcome).toBe('approved');
  });

  it('posts the result line in each card thread and marks the cards done', async () => {
    const approvals = await makeApprovals({ admins: [ADMIN, ADMIN_B] });
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    const outcome = await run.result;
    if (outcome.outcome !== 'approved') throw new Error('not approved');
    await outcome.consume();
    await approvals.postResult(outcome.approvalId, 'gh 종료 코드 0');
    for (const admin of [ADMIN, ADMIN_B]) {
      const replies = fake.replies(dm(admin), card(admin).ts);
      expect(replies).toHaveLength(1);
      expect(JSON.stringify(replies[0].blocks)).toContain('gh 종료 코드 0');
      expect(lastUpdateText(card(admin))).toContain('실행 종료');
    }
    // Best effort: an unknown id or a Slack failure never throws.
    await expect(approvals.postResult('unknownApproval0000000', 'x')).resolves.toBeUndefined();
  });

  it('releases an approval nobody will use: cancelled on disk, in the ledger and on the card', async () => {
    const approvals = await makeApprovals({ admins: [ADMIN, ADMIN_B] });
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    const outcome = await run.result;
    if (outcome.outcome !== 'approved') throw new Error('not approved');
    const id = outcome.approvalId;

    await approvals.release(id, 'requester-stopped-waiting');
    const record = stateOnDisk().approvals[id];
    expect(record.status).toBe('cancelled');
    expect(record.reason).toBe('requester-stopped-waiting');
    expect(record.card).toBeUndefined();
    expect(rows().filter((row) => row.event === 'approval.cancelled')).toEqual([
      expect.objectContaining({ approvalId: id, reason: 'requester-stopped-waiting' }),
    ]);
    for (const admin of [ADMIN, ADMIN_B]) {
      await waitFor(() => lastUpdateText(card(admin)).includes('취소됨'), 'cancelled card');
      const replies = await waitFor(
        () => fake.replies(dm(admin), card(admin).ts).length > 0 && fake.replies(dm(admin), card(admin).ts),
        'release reply',
      );
      expect(JSON.stringify(replies[0].blocks)).toContain('취소됨 — 요청자가 응답을 기다리지 않음');
    }
    await expect(outcome.consume()).rejects.toMatchObject({ name: 'ApprovalConsumeError', reason: 'not-approved' });
    // Idempotent: a second release writes nothing.
    await approvals.release(id, 'requester-stopped-waiting');
    expect(rows().filter((row) => row.event === 'approval.cancelled')).toHaveLength(1);
  });

  it('leaves a consumed approval alone on release', async () => {
    const approvals = await makeApprovals();
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    const outcome = await run.result;
    if (outcome.outcome !== 'approved') throw new Error('not approved');
    await outcome.consume();
    await approvals.release(outcome.approvalId, 'requester-stopped-waiting');
    expect(stateOnDisk().approvals[outcome.approvalId].status).toBe('consumed');
    expect(events(outcome.approvalId)).not.toContain('approval.cancelled');
  });

  it('keeps an approval shared by identical requests usable until every holder released it', async () => {
    const approvals = await makeApprovals();
    const a = start(approvals, req());
    const b = start(approvals, req());
    await waitFor(() => a.pending.length > 0 && b.pending.length > 0, 'both pending');
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    const [first, second] = await Promise.all([a.result, b.result]);
    if (first.outcome !== 'approved' || second.outcome !== 'approved') throw new Error('not approved');
    await approvals.release(first.approvalId, 'requester-stopped-waiting');
    expect(stateOnDisk().approvals[first.approvalId].status).toBe('approved');
    await second.consume();
    expect(stateOnDisk().approvals[first.approvalId].status).toBe('consumed');

    const c = start(approvals, req(2));
    const d = start(approvals, req(2));
    await waitFor(() => c.pending.length > 0 && d.pending.length > 0, 'second pair pending');
    fake.react(dm(ADMIN), cardWith(ADMIN, c.pending[0].approvalId).ts, 'white_check_mark', ADMIN);
    const [third, fourth] = await Promise.all([c.result, d.result]);
    if (third.outcome !== 'approved' || fourth.outcome !== 'approved') throw new Error('not approved');
    await approvals.release(third.approvalId, 'requester-stopped-waiting');
    await approvals.release(fourth.approvalId, 'requester-stopped-waiting');
    expect(stateOnDisk().approvals[third.approvalId].status).toBe('cancelled');
  });

  it('never throws from release (unknown id)', async () => {
    const approvals = await makeApprovals();
    await expect(approvals.release('unknownApproval0000000', 'requester-stopped-waiting')).resolves.toBeUndefined();
  });

  // ── Card flood and lockout (review F2) ──

  it('has the documented default limits', () => {
    expect(DEFAULT_APPROVAL_LIMITS).toEqual({
      windowMs: 600_000,
      globalCardsPerWindow: 12,
      sessionCardsPerWindow: 4,
      sessionPending: 2,
      abandonedCoolDownMs: 60_000,
    });
  });

  it('lets one session hold at most two pending cards', async () => {
    const approvals = await makeApprovals();
    const runs = [start(approvals, from('S1', 1)), start(approvals, from('S1', 2))];
    await waitFor(() => runs.every((run) => run.pending.length > 0), 'two pending');
    const posts = fake.calls('chat.postMessage').length;
    const err = await caughtApprovalError(approvals.request(from('S1', 3), { onPending: () => undefined }));
    expect(err.code).toBe('too-many-pending-approvals');
    expect(err.message).toMatch(/this session/);
    expect(fake.calls('chat.postMessage')).toHaveLength(posts);
    const other = start(approvals, from('S2', 4));
    await waitFor(() => other.pending.length > 0, 'other session pending');
  });

  it('rate-limits one session to four new cards per ten minutes', async () => {
    const approvals = await makeApprovals();
    for (let n = 1; n <= 4; n++) {
      const run = start(approvals, from('S1', n));
      await waitFor(() => run.pending.length > 0, `pending ${n}`);
      fake.react(dm(ADMIN), cardWith(ADMIN, run.pending[0].approvalId).ts, 'x', ADMIN);
      expect((await run.result).outcome).toBe('denied');
    }
    const posts = fake.calls('chat.postMessage').length;
    const err = await caughtApprovalError(approvals.request(from('S1', 5), { onPending: () => undefined }));
    expect(err.code).toBe('too-many-pending-approvals');
    expect(err.message).toMatch(/rate-limited/);
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(600);
    expect(fake.calls('chat.postMessage')).toHaveLength(posts);
    expect(rows().at(-1)).toMatchObject({ event: 'approval.refused', limit: 'session-rate' });
    // Another session is not affected; the same session is again after the window.
    const other = start(approvals, from('S2', 6));
    await waitFor(() => other.pending.length > 0, 'other session pending');
    clock += 600_001;
    const later = start(approvals, from('S1', 7));
    await waitFor(() => later.pending.length > 0, 'pending after the window');
  });

  it('rate-limits new cards overall to twelve per ten minutes, abandoned ones included', async () => {
    const approvals = await makeApprovals();
    for (let n = 1; n <= 12; n++) {
      const controller = new AbortController();
      const run = start(approvals, from(`F${n}`, n), controller.signal);
      await waitFor(() => run.pending.length > 0, `pending ${n}`);
      controller.abort();
      expect((await run.result).outcome).toBe('cancelled');
    }
    expect(fake.calls('chat.postMessage')).toHaveLength(12);
    const err = await caughtApprovalError(approvals.request(from('F13', 13), { onPending: () => undefined }));
    expect(err.code).toBe('too-many-pending-approvals');
    expect(err.message).toMatch(/rate-limited/);
    expect(fake.calls('chat.postMessage')).toHaveLength(12);
    clock += 600_001;
    const later = start(approvals, from('F14', 14));
    await waitFor(() => later.pending.length > 0, 'pending after the window');
  });

  it('takes its limits from the options', async () => {
    const approvals = await makeApprovals({}, 10, { limits: { globalCardsPerWindow: 1 } });
    const run = start(approvals, from('S1', 1));
    await waitFor(() => run.pending.length > 0, 'pending');
    const err = await caughtApprovalError(approvals.request(from('S2', 2), { onPending: () => undefined }));
    expect(err.message).toMatch(/rate-limited/);
  });

  it('cools a session down for a minute after it abandoned a card', async () => {
    const approvals = await makeApprovals();
    const controller = new AbortController();
    const run = start(approvals, from('S1', 1), controller.signal);
    await waitFor(() => run.pending.length > 0, 'pending');
    controller.abort();
    const outcome = await run.result;
    await waitFor(() => stateOnDisk().approvals[outcome.approvalId].status === 'cancelled', 'cancelled on disk');
    const err = await caughtApprovalError(approvals.request(from('S1', 2), { onPending: () => undefined }));
    expect(err.code).toBe('too-many-pending-approvals');
    expect(err.message).toMatch(/rate-limited/);
    expect(err.retryAfterSeconds).toBe(60);
    const other = start(approvals, from('S2', 3));
    await waitFor(() => other.pending.length > 0, 'other session pending');
    clock += 60_001;
    const later = start(approvals, from('S1', 4));
    await waitFor(() => later.pending.length > 0, 'pending after the cool-down');
  });

  it('does not spend the budget on a card that reached no admin', async () => {
    const approvals = await makeApprovals();
    for (let n = 1; n <= 5; n++) {
      fake.enqueue('conversations.open', { body: { ok: false, error: 'internal_error' } });
      const err = await caughtApprovalError(approvals.request(from('S1', n), { onPending: () => undefined }));
      expect(err.code).toBe('slack-unavailable');
    }
    const run = start(approvals, from('S1', 6));
    await waitFor(() => run.pending.length > 0, 'pending after Slack recovered');
  });

  // ── Start-up sweep (review F3) ──

  function seedLeftover(ts: string): void {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        approvals: {
          leftover0000000000000a: {
            approvalId: 'leftover0000000000000a',
            tool: 'gh_write',
            digest: 'e'.repeat(64),
            status: 'pending',
            claimedRequester: { slackUserId: 'U000ALICE', sessionKey: 's' },
            createdAt: new Date(START - 60_000).toISOString(),
            expiresAt: new Date(START + 240_000).toISOString(),
            posts: [{ admin: ADMIN, channel: dm(ADMIN), ts }],
          },
        },
      }),
    );
  }

  it('retries the start-up sweep on the next request when its ledger write failed', async () => {
    const old = await slack.postMessage(dm(ADMIN), { text: 'old card' });
    seedLeftover(old.ts);
    const approvals = await makeApprovals({}, 10, { ledger: flakyLedger(1) });
    await waitFor(() => logged.some((line) => /sweep/.test(line)), 'sweep failure logged');
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    expect(stateOnDisk().approvals.leftover0000000000000a.status).toBe('expired');
    expect(events('leftover0000000000000a')).toEqual(['approval.expired']);
    const oldCard = fake.allMessages().find((m) => m.ts === old.ts) as FakeMessage;
    await waitFor(() => oldCard.updates.length > 0, 'old card updated');
    expect(lastUpdateText(oldCard)).toContain('만료됨');
  });

  it('retries the start-up sweep on the next request when its state write failed', async () => {
    seedLeftover('1700000000.999999');
    const controlled = await controlledStore();
    controlled.failNext();
    const approvals = await makeApprovals({}, 10, { store: controlled.store });
    await waitFor(() => logged.some((line) => /sweep/.test(line)), 'sweep failure logged');
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    expect(stateOnDisk().approvals.leftover0000000000000a.status).toBe('expired');
    // The card id is not a real message here, so its update fails; the expiry row is still written once.
    expect(events('leftover0000000000000a').filter((event) => event === 'approval.expired')).toHaveLength(1);
  });

  it('lets a request that waited on a failing sweep retry it itself', async () => {
    seedLeftover('1700000000.999999');
    const controlled = await controlledStore();
    controlled.hold();
    const approvals = await makeApprovals({}, 10, { store: controlled.store, ledger: flakyLedger(1) });
    await waitFor(() => controlled.held(), 'sweep write in progress');
    const run = start(approvals, req());
    controlled.release();
    await waitFor(() => run.pending.length > 0 || run.settled(), 'request answered');
    expect(run.pending).toHaveLength(1);
    expect(logged.some((line) => /sweep/.test(line))).toBe(true);
  });

  // ── Late ✅ (review F4) ──

  it('counts a ✅ first seen after the expiry as expired, not approved', async () => {
    let first = true;
    const slow: SlackApi = {
      ...slack,
      getReactions: async (channel, ts) => {
        if (first && channel === dm(ADMIN)) {
          first = false;
          // While this round runs, the card's deadline passes and the other admin reacts.
          clock = START + 300_000 + 60_000;
          fake.react(dm(ADMIN_B), card(ADMIN_B).ts, 'white_check_mark', ADMIN_B);
        }
        return slack.getReactions(channel, ts);
      },
    };
    const approvals = await makeApprovals({ admins: [ADMIN, ADMIN_B] }, 10, { slack: slow });
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    const outcome = await run.result;
    expect(outcome.outcome).toBe('expired');
    expect(stateOnDisk().approvals[outcome.approvalId].status).toBe('expired');
    expect(events(outcome.approvalId)).not.toContain('approval.approved');
    expect(events(outcome.approvalId)).toContain('approval.expired');
  });

  // ── Orphaned approvals and close (review F5) ──

  it('cancels an approval whose only requester left while it was being recorded', async () => {
    const controlled = await controlledStore();
    const approvals = await makeApprovals({}, 10, { store: controlled.store });
    const controller = new AbortController();
    const run = start(approvals, from('S1', 1), controller.signal);
    await waitFor(() => run.pending.length > 0, 'pending');
    controlled.hold();
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    await waitFor(() => controlled.held(), 'approved write in progress');
    controller.abort();
    expect((await run.result).outcome).toBe('cancelled');
    controlled.release();
    const approvalId = run.pending[0].approvalId;
    await waitFor(() => stateOnDisk().approvals[approvalId].status === 'cancelled', 'cancelled on disk');
    expect(stateOnDisk().approvals[approvalId].reason).toBe('requester-gone');
    await waitFor(() => events(approvalId).includes('approval.cancelled'), 'cancelled row');
    await waitFor(() => lastUpdateText(card(ADMIN)).includes('취소됨'), 'card cancelled');
    // Abandoning an approved card also cools the session down.
    const err = await caughtApprovalError(approvals.request(from('S1', 2), { onPending: () => undefined }));
    expect(err.message).toMatch(/rate-limited/);
  });

  it('makes close wait for an approval being recorded, and cancels it instead of handing it out', async () => {
    const controlled = await controlledStore();
    const approvals = await makeApprovals({}, 10, { store: controlled.store });
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    controlled.hold();
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    await waitFor(() => controlled.held(), 'approved write in progress');
    let closedYet = false;
    const closing = approvals.close().then(() => {
      closedYet = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closedYet).toBe(false);
    controlled.release();
    const outcome = await run.result;
    expect(outcome.outcome).toBe('cancelled');
    await closing;
    const record = stateOnDisk().approvals[run.pending[0].approvalId];
    expect(record.status).toBe('cancelled');
    expect(record.reason).toBe('broker-closing');
    expect(lastUpdateText(card(ADMIN))).toContain('취소됨');
  });

  it('stretches the poll interval with the number of cards being watched', async () => {
    const approvals = await makeApprovals({ admins: [ADMIN, ADMIN_B] }, 40);
    const runs = [start(approvals, req(1)), start(approvals, req(2)), start(approvals, req(3))];
    await waitFor(() => runs.every((run) => run.pending.length > 0), 'three pending');
    const begin = fake.calls('reactions.get').length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    const made = fake.calls('reactions.get').length - begin;
    // 6 cards → one round every 40 ms × ceil(6 / 2) = 120 ms → about 5 rounds of 6 calls in 600 ms.
    expect(made).toBeGreaterThan(0);
    expect(made).toBeLessThanOrEqual(6 * 6);
  });
});

describe('button clicks (decide)', () => {
  /** The click Socket Mode would deliver for `user` pressing a button on `message`. */
  function click(message: FakeMessage, approvalId: string, user: string, action: 'approve' | 'deny' = 'approve') {
    return { approvalId, action, user, channel: message.channel, messageTs: message.ts };
  }

  it('puts 승인 / 거부 buttons on the card and approves on the admin own click, consumed once', async () => {
    const approvals = await makeApprovals({ admins: [ADMIN, ADMIN_B] }, 10, { buttons: true });
    const run = start(approvals, req());
    const [pending] = await waitFor(() => run.pending.length > 0 && run.pending, 'pending');
    const blocks = JSON.stringify(card(ADMIN).blocks);
    expect(blocks).toContain('"type":"actions"');
    expect(blocks).toContain('devops_approval_approve');
    expect(blocks).toContain('devops_approval_deny');

    await expect(approvals.decide(click(card(ADMIN_B), pending.approvalId, ADMIN_B))).resolves.toBe('accepted');
    const outcome = await run.result;
    expect(outcome).toMatchObject({ outcome: 'approved', approvalId: pending.approvalId });
    if (outcome.outcome !== 'approved') throw new Error('not approved');
    await outcome.consume();
    await expect(outcome.consume()).rejects.toMatchObject({ name: 'ApprovalConsumeError', reason: 'used' });
    expect(rows().find((row) => row.event === 'approval.approved')).toMatchObject({ by: ADMIN_B });
    // A second click on a decided card changes nothing.
    await expect(approvals.decide(click(card(ADMIN), pending.approvalId, ADMIN, 'deny'))).resolves.toBe('ignored');
    expect(stateOnDisk().approvals[pending.approvalId].status).toBe('consumed');
    for (const admin of [ADMIN, ADMIN_B]) {
      await waitFor(() => card(admin).updates.length > 0, 'approved card update');
      expect(lastUpdateText(card(admin))).toContain('승인됨');
      expect(lastUpdateText(card(admin))).not.toContain('"type":"actions"');
    }
  });

  it('ignores clicks from non-admins and the bot, then denies on an admin 거부', async () => {
    const approvals = await makeApprovals({}, 10, { buttons: true });
    const run = start(approvals, req());
    const [pending] = await waitFor(() => run.pending.length > 0 && run.pending, 'pending');
    for (const user of [OTHER, BOT]) {
      await expect(approvals.decide(click(card(ADMIN), pending.approvalId, user))).resolves.toBe('ignored');
    }
    expect(run.settled()).toBe(false);
    expect(
      rows()
        .filter((row) => row.event === 'approval.click-ignored')
        .map((row) => row.reason),
    ).toEqual(['not-admin', 'not-admin']);
    await expect(approvals.decide(click(card(ADMIN), pending.approvalId, ADMIN, 'deny'))).resolves.toBe('accepted');
    const outcome = await run.result;
    expect(outcome.outcome).toBe('denied');
    expect(rows().find((row) => row.event === 'approval.denied')).toMatchObject({ by: ADMIN });
  });

  it('ignores a click that did not come from this approval own card, or names an unknown approval', async () => {
    const approvals = await makeApprovals({}, 10, { buttons: true });
    const first = start(approvals, req(1));
    const second = start(approvals, req(2));
    const [p1] = await waitFor(() => first.pending.length > 0 && first.pending, 'pending 1');
    const [p2] = await waitFor(() => second.pending.length > 0 && second.pending, 'pending 2');
    // Card 2's button cannot approve approval 1.
    const wrong = { ...click(cardWith(ADMIN, p2.approvalId), p1.approvalId, ADMIN) };
    await expect(approvals.decide(wrong)).resolves.toBe('ignored');
    await expect(
      approvals.decide({ ...click(card(ADMIN), p1.approvalId, ADMIN), approvalId: 'A'.repeat(22) }),
    ).resolves.toBe('ignored');
    expect(first.settled()).toBe(false);
    expect(second.settled()).toBe(false);
    expect(
      rows()
        .filter((row) => row.event === 'approval.click-ignored')
        .map((row) => row.reason),
    ).toEqual(['wrong-card', 'not-pending']);
  });

  it('does not approve on a click that arrives after the deadline', async () => {
    const approvals = await makeApprovals({}, 60_000, { buttons: true });
    const run = start(approvals, req());
    const [pending] = await waitFor(() => run.pending.length > 0 && run.pending, 'pending');
    clock += 301_000;
    await approvals.decide(click(card(ADMIN), pending.approvalId, ADMIN));
    const outcome = await run.result;
    expect(outcome.outcome).toBe('expired');
    expect(events(pending.approvalId)).not.toContain('approval.approved');
  });

  it('decides once when an approve and a deny click arrive together', async () => {
    const approvals = await makeApprovals({ admins: [ADMIN, ADMIN_B] }, 60_000, { buttons: true });
    const run = start(approvals, req());
    const [pending] = await waitFor(() => run.pending.length > 0 && run.pending, 'pending');
    const results = await Promise.all([
      approvals.decide(click(card(ADMIN), pending.approvalId, ADMIN, 'approve')),
      approvals.decide(click(card(ADMIN_B), pending.approvalId, ADMIN_B, 'deny')),
      approvals.decide(click(card(ADMIN), pending.approvalId, ADMIN, 'approve')),
    ]);
    expect(results.filter((r) => r === 'accepted')).toHaveLength(1);
    const outcome = await run.result;
    expect(outcome.outcome).toBe('approved');
    expect(events(pending.approvalId).filter((e) => e === 'approval.approved' || e === 'approval.denied')).toEqual([
      'approval.approved',
    ]);
  });

  it('keeps reactions working when the cards have buttons', async () => {
    const approvals = await makeApprovals({}, 10, { buttons: true });
    const run = start(approvals, req());
    await waitFor(() => run.pending.length > 0, 'pending');
    fake.react(dm(ADMIN), card(ADMIN).ts, 'white_check_mark', ADMIN);
    expect((await run.result).outcome).toBe('approved');
  });
});
