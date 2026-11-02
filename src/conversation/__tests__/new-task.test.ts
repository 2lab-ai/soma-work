/**
 * Dashboard "New task" — the pure half (SSOT 2026-10-23 T2–T9).
 *
 * What the composer offers (models with a quota battery, efforts, channels,
 * autogoal default), how a submission is validated before anything touches
 * Slack, how the autoz toggle reaches the session (`$autoz` appended at the end
 * of the instruction), and what the root message posted into the chosen
 * channel looks like.
 */

import { describe, expect, it } from 'vitest';
import {
  buildNewTaskContext,
  buildNewTaskRootMessage,
  composeTaskText,
  computeModelBattery,
  createNewTaskGate,
  isSlackFileUrl,
  NEW_TASK_LIMITS,
  type NewTaskContextInput,
  parseNewTaskSubmission,
  providerGroupOf,
  type UsageAccountView,
} from '../new-task';

const MODELS = [
  { nickname: 'opus[1m]', model: 'claude-opus-5-5[1m]', label: 'Opus 5.5 (1M)' },
  { nickname: 'fable[1m]', model: 'claude-fable-5-1[1m]', label: 'Fable 5.1 (1M)' },
  { nickname: 'sol[1m]', model: 'gpt-5.6-sol[1m]', label: 'GPT-5.6 Sol (1M)' },
  { nickname: 'grok[1m]', model: 'grok-4.6', label: 'Grok 4.6' },
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

function input(overrides: Partial<NewTaskContextInput> = {}): NewTaskContextInput {
  return {
    representativeModels: MODELS,
    userDefaultModel: 'claude-opus-5-5[1m]',
    userDefaultModelLabel: 'Opus 5.5 (1M)',
    userDefaultEffort: 'xhigh',
    efforts: EFFORTS,
    autogoalDefault: true,
    registryChannels: [
      { id: 'C_ALPHA', name: 'workspace-alpha', repos: ['2lab-ai/soma-work'] },
      { id: 'C_SOMA', name: 'soma', repos: ['2lab-ai/soma'] },
      { id: 'C_RANDOM', name: 'random', repos: [] },
      { id: 'C_SECRET', name: 'secret-proj', repos: ['2lab-ai/secret'] },
    ],
    memberChannelIds: new Set(['C_ALPHA', 'C_SOMA', 'C_RANDOM']),
    recentSessions: [
      { channelId: 'C_SOMA', lastActivity: 1_000 },
      { channelId: 'C_ALPHA', lastActivity: 5_000 },
      { channelId: 'D_DM', lastActivity: 9_000 },
    ],
    usageAccounts: null,
    lastCommandChannelId: null,
    usageSource: null,
    usageFetchedAt: null,
    ...overrides,
  };
}

describe('composeTaskText — T7 autoz toggle', () => {
  it('autoz off: the instruction is sent as typed (trimmed)', () => {
    expect(composeTaskText('  soma-work 개선해줘\n블라블라  ', false)).toBe('soma-work 개선해줘\n블라블라');
  });

  it('autoz on: `$autoz` is appended at the very end of the instruction', () => {
    const text = composeTaskText('soma-work 개선해줘\n블라블라', true);
    expect(text).toBe('soma-work 개선해줘\n블라블라\n\n$autoz');
    expect(text.trimEnd().endsWith('$autoz')).toBe(true);
  });

  it('autoz on twice is still one `$autoz` (already typed by the user)', () => {
    expect(composeTaskText('고쳐줘 $autoz', true)).toBe('고쳐줘 $autoz');
  });

  it('a different skill that merely starts with autoz is not mistaken for it', () => {
    expect(composeTaskText('run $autozeta', true)).toBe('run $autozeta\n\n$autoz');
  });

  it('autoz on with only attachments: the text is just `$autoz`', () => {
    expect(composeTaskText('   ', true)).toBe('$autoz');
  });
});

describe('providerGroupOf', () => {
  it('maps model ids to the account pool that serves them', () => {
    expect(providerGroupOf('claude-opus-5-5[1m]')).toBe('claude');
    expect(providerGroupOf('gpt-5.6-sol[1m]')).toBe('codex');
    expect(providerGroupOf('grok-4.6')).toBe('grok');
  });
});

describe('computeModelBattery — T3 remaining quota as a battery', () => {
  const claudeA: UsageAccountView = {
    group: 'claude',
    windows: [
      { label: '5h', remaining: 0.8, resetsAt: 2_000 },
      { label: '7d', remaining: 0.5, resetsAt: 9_000 },
      { label: '7d-opus', remaining: 0.3, resetsAt: 8_000 },
      { label: '7d-fable', remaining: 0.9 },
    ],
  };
  const claudeB: UsageAccountView = {
    group: 'claude',
    windows: [
      { label: '5h', remaining: 1 },
      { label: '7d', remaining: 0.7 },
    ],
  };

  it('level = pool average of each account’s binding window for that model', () => {
    // A: min(0.8, 0.5, opus 0.3) = 0.3 · B: min(1, 0.7) = 0.7 → 0.5
    const battery = computeModelBattery('claude-opus-5-5[1m]', [claudeA, claudeB]);
    expect(battery.level).toBeCloseTo(0.5);
    expect(battery.accounts).toEqual({ measured: 2, total: 2, available: 2 });
    // The most headroom one routable account has — what the next task can get.
    expect(battery.best).toBeCloseTo(0.7);
  });

  it('a model-scoped weekly window only binds the model it names', () => {
    // fable: A = min(0.8, 0.5, 0.9) = 0.5 · B = 0.7 → 0.6
    expect(computeModelBattery('claude-fable-5-1[1m]', [claudeA, claudeB]).level).toBeCloseTo(0.6);
  });

  it('breaks the level down per window (average remaining, earliest reset)', () => {
    const battery = computeModelBattery('claude-opus-5-5[1m]', [claudeA, claudeB]);
    expect(battery.windows).toEqual([
      { label: '5h', remaining: 0.9, resetsAt: 2_000 },
      { label: '7d', remaining: 0.6, resetsAt: 9_000 },
      { label: '7d-opus', remaining: 0.3, resetsAt: 8_000 },
    ]);
  });

  it('an account in cooldown counts as empty and is not available', () => {
    const cooling = { ...claudeB, unavailable: true };
    const battery = computeModelBattery('claude-opus-5-5[1m]', [claudeA, cooling]);
    expect(battery.level).toBeCloseTo(0.15);
    expect(battery.accounts).toEqual({ measured: 2, total: 2, available: 1 });
    expect(battery.best).toBeCloseTo(0.3);
  });

  it('an exhausted binding window makes the account unavailable', () => {
    const empty: UsageAccountView = { group: 'claude', windows: [{ label: '5h', remaining: 0 }] };
    expect(computeModelBattery('claude-opus-5-5[1m]', [empty, claudeB]).accounts.available).toBe(1);
  });

  it('only accounts of the model’s provider count', () => {
    const grok: UsageAccountView = { group: 'grok', windows: [{ label: '5h', remaining: 0.1 }] };
    expect(computeModelBattery('claude-opus-5-5[1m]', [claudeB, grok]).level).toBeCloseTo(0.7);
    expect(computeModelBattery('grok-4.6', [claudeB, grok]).level).toBeCloseTo(0.1);
  });

  it('no measured data → level null (rendered as an unknown battery, never as full)', () => {
    expect(computeModelBattery('claude-opus-5-5[1m]', []).level).toBeNull();
    expect(computeModelBattery('claude-opus-5-5[1m]', null).level).toBeNull();
    const unmeasured: UsageAccountView = { group: 'claude', windows: [{ label: '5h' }] };
    expect(computeModelBattery('claude-opus-5-5[1m]', [unmeasured])).toMatchObject({
      level: null,
      best: null,
      accounts: { measured: 0, total: 1, available: 0 },
    });
  });
});

describe('buildNewTaskContext — T3/T4/T5/T6 composer defaults', () => {
  it('model default = the user’s default model, offered as its representative nickname', () => {
    const ctx = buildNewTaskContext(input());
    expect(ctx.defaultModel).toBe('opus[1m]');
    expect(ctx.models.map((m) => m.nickname)).toEqual(['opus[1m]', 'fable[1m]', 'sol[1m]', 'grok[1m]']);
    expect(ctx.models[0].battery).toEqual({
      level: null,
      best: null,
      windows: [],
      accounts: { measured: 0, total: 0, available: 0 },
    });
  });

  it('a user default that is not a representative model is still offered, first, and selected', () => {
    const ctx = buildNewTaskContext(
      input({ userDefaultModel: 'claude-sonnet-4-6', userDefaultModelLabel: 'Sonnet 4.6' }),
    );
    expect(ctx.defaultModel).toBe('claude-sonnet-4-6');
    expect(ctx.models[0]).toMatchObject({
      nickname: 'claude-sonnet-4-6',
      model: 'claude-sonnet-4-6',
      label: 'Sonnet 4.6',
    });
  });

  it('effort default = the user’s default effort; autogoal default = the user setting', () => {
    const ctx = buildNewTaskContext(input({ userDefaultEffort: 'high', autogoalDefault: false }));
    expect(ctx.efforts).toEqual([...EFFORTS]);
    expect(ctx.defaultEffort).toBe('high');
    expect(ctx.autogoalDefault).toBe(false);
  });

  it('channels = repo-mapped channels the user is a member of; default = the channel of their last command', () => {
    const ctx = buildNewTaskContext(input({ lastCommandChannelId: 'C_SOMA' }));
    // C_SECRET is mapped but the user is not a member; C_RANDOM has no repo; D_DM is a DM.
    expect(ctx.channels.map((c) => c.id)).toEqual(['C_SOMA', 'C_ALPHA']);
    expect(ctx.channels[1]).toEqual({ id: 'C_ALPHA', name: 'workspace-alpha', repos: ['2lab-ai/soma-work'] });
    expect(ctx.defaultChannelId).toBe('C_SOMA');
    expect(ctx.membershipUnknown).toBe(false);
  });

  it('no recorded last command → the offered channel of the user’s most recent session', () => {
    const ctx = buildNewTaskContext(input());
    expect(ctx.defaultChannelId).toBe('C_ALPHA');
    expect(ctx.channels.map((c) => c.id)).toEqual(['C_ALPHA', 'C_SOMA']);
  });

  it('a last-command channel without a repo mapping is not offered (the list is the repo channels)', () => {
    const ctx = buildNewTaskContext(input({ lastCommandChannelId: 'C_RANDOM' }));
    expect(ctx.channels.map((c) => c.id)).not.toContain('C_RANDOM');
    expect(ctx.defaultChannelId).toBe('C_ALPHA');
  });

  it('membership unknown → no channel is offered (fail closed, never from session history)', () => {
    const ctx = buildNewTaskContext(input({ memberChannelIds: null, lastCommandChannelId: 'C_ALPHA' }));
    expect(ctx.channels).toEqual([]);
    expect(ctx.defaultChannelId).toBeNull();
    expect(ctx.membershipUnknown).toBe(true);
  });

  it('no recent command in an offered channel → the first channel by name', () => {
    const ctx = buildNewTaskContext(input({ recentSessions: [] }));
    expect(ctx.channels.map((c) => c.name)).toEqual(['soma', 'workspace-alpha']);
    expect(ctx.defaultChannelId).toBe('C_SOMA');
  });

  it('labels the battery as a shared-pool estimate with its source and freshness', () => {
    const accounts: UsageAccountView[] = [{ group: 'claude', windows: [{ label: '5h', remaining: 0.4 }] }];
    const ctx = buildNewTaskContext(input({ usageAccounts: accounts, usageSource: 'llmux', usageFetchedAt: 1234 }));
    expect(ctx.usage).toEqual({ scope: 'shared-pool', source: 'llmux', fetchedAt: 1234 });
    expect(ctx.models[0].battery.level).toBeCloseTo(0.4);
    expect(buildNewTaskContext(input()).usage).toEqual({ scope: 'shared-pool', source: null, fetchedAt: null });
  });

  it('carries the upload limits the client enforces before sending', () => {
    expect(buildNewTaskContext(input()).limits).toEqual(NEW_TASK_LIMITS);
  });
});

describe('parseNewTaskSubmission — T2/T8/T9 server-side validation', () => {
  const ctx = buildNewTaskContext(input());
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const body = (overrides: Record<string, unknown> = {}) => ({
    requestId: 'req-0123456789',
    prompt: 'soma-work 개선해줘',
    model: 'opus[1m]',
    effort: 'xhigh',
    channelId: 'C_ALPHA',
    autogoal: true,
    autoz: false,
    attachments: [],
    ...overrides,
  });

  it('accepts a complete submission and resolves the nickname to the model id', () => {
    const r = parseNewTaskSubmission(body(), ctx);
    expect(r).toEqual({
      ok: true,
      value: {
        requestId: 'req-0123456789',
        prompt: 'soma-work 개선해줘',
        nickname: 'opus[1m]',
        model: 'claude-opus-5-5[1m]',
        effort: 'xhigh',
        channelId: 'C_ALPHA',
        autogoal: true,
        autoz: false,
        attachments: [],
      },
    });
  });

  it('decodes base64 attachments and keeps name / type', () => {
    const r = parseNewTaskSubmission(
      body({ attachments: [{ name: 'photo.jpg', mimetype: 'image/jpeg', data: b64('\xff\xd8\xffjpeg') }] }),
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.attachments).toHaveLength(1);
    expect(r.value.attachments[0].name).toBe('photo.jpg');
    expect(r.value.attachments[0].mimetype).toBe('image/jpeg');
    expect(r.value.attachments[0].data.length).toBeGreaterThan(0);
  });

  it('an empty instruction is allowed only with attachments', () => {
    expect(parseNewTaskSubmission(body({ prompt: '  ' }), ctx)).toMatchObject({ ok: false });
    expect(
      parseNewTaskSubmission(
        body({ prompt: '', attachments: [{ name: 'voice.m4a', mimetype: 'audio/mp4', data: b64('aaaa') }] }),
        ctx,
      ).ok,
    ).toBe(true);
  });

  it.each([
    ['a missing request id (idempotency key)', { requestId: undefined }],
    ['a malformed request id', { requestId: 'x y' }],
    ['unknown model', { model: 'gpt-9000' }],
    ['unknown effort', { effort: 'ultra' }],
    ['a channel not offered to this user', { channelId: 'C_SECRET' }],
    ['a non-boolean toggle', { autogoal: 'yes' }],
    ['a prompt over the limit', { prompt: 'x'.repeat(NEW_TASK_LIMITS.maxPromptChars + 1) }],
    [
      'too many files',
      {
        attachments: Array.from({ length: NEW_TASK_LIMITS.maxFiles + 1 }, (_, i) => ({
          name: `f${i}`,
          mimetype: 'text/plain',
          data: b64('a'),
        })),
      },
    ],
    ['invalid base64', { attachments: [{ name: 'a.txt', mimetype: 'text/plain', data: '***' }] }],
    ['an empty file', { attachments: [{ name: 'a.txt', mimetype: 'text/plain', data: '' }] }],
    ['a bad mimetype', { attachments: [{ name: 'a.txt', mimetype: 'text/plain; x=<script>', data: b64('a') }] }],
  ])('rejects %s', (_label, overrides) => {
    const r = parseNewTaskSubmission(body(overrides), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(typeof r.error).toBe('string');
  });

  it('strips path parts and control characters from file names', () => {
    const r = parseNewTaskSubmission(
      body({ attachments: [{ name: '../../etc/pa\u0000ss\nwd', mimetype: 'text/plain', data: b64('a') }] }),
      ctx,
    );
    expect(r.ok && r.value.attachments[0].name).toBe('passwd');
  });

  it('rejects a body that is not an object', () => {
    expect(parseNewTaskSubmission(null, ctx).ok).toBe(false);
    expect(parseNewTaskSubmission('x', ctx).ok).toBe(false);
  });
});

describe('buildNewTaskRootMessage — T2 the task is visible in the Slack channel', () => {
  const base = {
    userId: 'U123',
    prompt: 'soma-work 개선해줘\n<@U999> *bold*',
    nickname: 'opus[1m]',
    effort: 'xhigh',
    autogoal: true,
    autoz: true,
    attachmentNames: ['photo.jpg', 'voice.m4a'],
  };

  it('names the requester and that it came from the dashboard', () => {
    const msg = buildNewTaskRootMessage(base);
    const json = JSON.stringify(msg.blocks);
    expect(json).toContain('<@U123>');
    expect(json).toContain('Dashboard');
    expect(msg.text).toContain('<@U123>');
  });

  it('echoes the instruction as plain text (no mention / mrkdwn injection)', () => {
    const msg = buildNewTaskRootMessage(base);
    const section = msg.blocks.find((b: any) => b.type === 'section');
    expect(section.text).toEqual({ type: 'plain_text', text: 'soma-work 개선해줘\n<@U999> *bold*' });
    expect(msg.text).not.toContain('<@U999>');
  });

  it('shows the chosen settings and the attachment count', () => {
    const json = JSON.stringify(buildNewTaskRootMessage(base).blocks);
    for (const part of ['opus[1m]', 'xhigh', 'autogoal', 'autoz', '2']) expect(json).toContain(part);
  });

  it('splits a long instruction across sections that fit Slack’s 3000-char limit', () => {
    const msg = buildNewTaskRootMessage({ ...base, prompt: 'a'.repeat(7000) });
    const sections = msg.blocks.filter((b: any) => b.type === 'section');
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) expect(s.text.text.length).toBeLessThanOrEqual(3000);
    expect(sections.map((s: any) => s.text.text).join('')).toBe('a'.repeat(7000));
  });
});

describe('createNewTaskGate — idempotent submission + per-user limits', () => {
  it('the same request id launches once; a retry gets the first result', async () => {
    const gate = createNewTaskGate();
    let launches = 0;
    const launch = async () => {
      launches++;
      return { threadTs: 't1' };
    };
    const [a, b] = await Promise.all([gate.run('U1', 'req-a', launch), gate.run('U1', 'req-a', launch)]);
    expect(launches).toBe(1);
    expect(a).toEqual({ threadTs: 't1' });
    expect(b).toEqual({ threadTs: 't1' });
    expect(await gate.run('U1', 'req-a', launch)).toEqual({ threadTs: 't1' });
    expect(launches).toBe(1);
  });

  it('a second, different request from the same user while one is in flight is refused', async () => {
    const gate = createNewTaskGate();
    let release!: () => void;
    const first = gate.run('U1', 'req-a', () => new Promise((r) => (release = () => r('done'))));
    await expect(gate.run('U1', 'req-b', async () => 'other')).rejects.toMatchObject({ statusCode: 429 });
    // Another user is not blocked.
    await expect(gate.run('U2', 'req-c', async () => 'ok')).resolves.toBe('ok');
    release();
    await expect(first).resolves.toBe('done');
    await expect(gate.run('U1', 'req-b', async () => 'other')).resolves.toBe('other');
  });

  it('a failed launch is not cached: the same request id may be retried', async () => {
    const gate = createNewTaskGate();
    await expect(gate.run('U1', 'req-a', async () => Promise.reject(new Error('slack down')))).rejects.toThrow(
      'slack down',
    );
    await expect(gate.run('U1', 'req-a', async () => 'ok')).resolves.toBe('ok');
  });

  it('caps launches per user per window', async () => {
    let now = 0;
    const gate = createNewTaskGate({ maxPerWindow: 2, windowMs: 60_000, now: () => now });
    await gate.run('U1', 'req-1', async () => 1);
    await gate.run('U1', 'req-2', async () => 2);
    await expect(gate.run('U1', 'req-3', async () => 3)).rejects.toMatchObject({ statusCode: 429 });
    now = 61_000;
    await expect(gate.run('U1', 'req-3', async () => 3)).resolves.toBe(3);
  });
});

describe('isSlackFileUrl — the bot token is only ever sent to Slack', () => {
  it.each([
    ['https://files.slack.com/files-pri/T1-F1/download/photo.jpg', true],
    ['https://slack.com/x', true],
    ['https://files-edge.slack.com/a', true],
    ['http://files.slack.com/a', false],
    ['https://evil.example/files.slack.com', false],
    ['https://files.slack.com.evil.example/a', false],
    ['not a url', false],
  ])('%s → %s', (url, ok) => {
    expect(isSlackFileUrl(url)).toBe(ok);
  });
});

// The task's effort must be one its model runs: the dialog's picker offers only those, the server checks again.
describe('new task — the effort the chosen model runs', () => {
  const ALL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const MENUS = [
    { nickname: 'opus[1m]', model: 'claude-opus-5-5[1m]', label: 'Opus 5.5 (1M)', effortLevels: [...EFFORTS] },
    { nickname: 'sol[1m]', model: 'gpt-6.1-sol[1m]', label: 'Sol 6.1 (1M)', effortLevels: ALL },
    { nickname: 'grok[1m]', model: 'grok-4.6', label: 'Grok 4.6', effortLevels: ['low', 'medium', 'high', 'xhigh'] },
  ];
  const ctxWith = (over: Partial<NewTaskContextInput> = {}) =>
    buildNewTaskContext(input({ representativeModels: MENUS, efforts: ALL, ...over }));

  it('each offered model carries the levels it runs (the user’s own default outside them too)', () => {
    const ctx = ctxWith({
      userDefaultModel: 'claude-haiku-4-5',
      userDefaultModelLabel: 'Haiku',
      userDefaultModelEffortLevels: ['low', 'high'],
    });
    expect(ctx.models.map((m) => [m.nickname, m.effortLevels])).toEqual([
      ['claude-haiku-4-5', ['low', 'high']],
      ['opus[1m]', [...EFFORTS]],
      ['sol[1m]', ALL],
      ['grok[1m]', ['low', 'medium', 'high', 'xhigh']],
    ]);
  });

  it('the default effort is kept to the default model’s levels', () => {
    expect(ctxWith({ userDefaultModel: 'gpt-6.1-sol[1m]', userDefaultEffort: 'ultra' }).defaultEffort).toBe('ultra');
    expect(ctxWith({ userDefaultModel: 'grok-4.6', userDefaultEffort: 'ultra' }).defaultEffort).toBe('xhigh');
    expect(ctxWith({ userDefaultModel: 'claude-opus-5-5[1m]', userDefaultEffort: 'ultra' }).defaultEffort).toBe('max');
  });

  it('a submission with a level its model does not run is refused; one it runs is taken', () => {
    const ctx = ctxWith();
    const body = (model: string, effort: string) => ({
      requestId: 'req-0123456789',
      prompt: 'go',
      model,
      effort,
      channelId: 'C_ALPHA',
      autogoal: false,
      autoz: false,
      attachments: [],
    });
    expect(parseNewTaskSubmission(body('sol[1m]', 'ultra'), ctx)).toMatchObject({
      ok: true,
      value: { effort: 'ultra' },
    });
    expect(parseNewTaskSubmission(body('grok[1m]', 'max'), ctx)).toEqual({
      ok: false,
      error: 'grok[1m] does not run effort max: one of low, medium, high, xhigh',
    });
    expect(parseNewTaskSubmission(body('opus[1m]', 'ultra'), ctx)).toMatchObject({ ok: false });
  });
});
