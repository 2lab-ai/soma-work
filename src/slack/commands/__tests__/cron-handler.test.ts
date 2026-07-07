/**
 * CronCommandHandler — `cron`/`schedule` as a first-class user command.
 *
 * Why a command: typing `cron` as plain text goes through the model dispatch
 * path where autogoal can promote it to a session goal (observed live:
 * "Autogoal: 이 지시를 goal로 설정했습니다 — cron"). Commands are routed in
 * slack-handler BEFORE session dispatch/autogoal, so a command can never be
 * swallowed as a goal. Trace: session goal "cron 스케줄러 관리 UI" drift #3.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    resolveModelInput: vi.fn((input: string) => {
      const map: Record<string, string> = {
        'gpt-5.5': 'gpt-5.5',
        gpt: 'gpt-5.5',
        opus: 'claude-opus-4-8',
        'claude-fable-5': 'claude-fable-5',
      };
      return map[input] ?? null;
    }),
  },
}));

vi.mock('../../../admin-utils', () => ({
  isAdminUser: vi.fn((u: string) => u === 'U_ADMIN'),
}));

import { CronStorage } from 'somalib/cron/cron-storage';
import { CronCommandHandler } from '../cron-handler';
import type { CommandContext } from '../types';

let tmpFile: string;
let storage: CronStorage;
let handler: CronCommandHandler;

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    user: 'U_ALICE',
    channel: 'C123',
    threadTs: 'thread123',
    text: '',
    say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    ...overrides,
  };
}

function saidText(ctx: CommandContext): string {
  const calls = (ctx.say as any).mock.calls;
  return calls.map((c: any[]) => c[0].text).join('\n');
}

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `cron-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  storage = new CronStorage(tmpFile);
  handler = new CronCommandHandler(tmpFile);
});

afterEach(() => {
  for (const f of [tmpFile, tmpFile + '.tmp', tmpFile.replace(/\.json$/, '-history.json')]) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
  vi.clearAllMocks();
});

function seed(over: Record<string, any> = {}) {
  return storage.addJob({
    name: 'daily-report',
    expression: '0 9 * * 1-5',
    prompt: 'morning report',
    owner: 'U_ALICE',
    channel: 'C111',
    threadTs: null,
    ...over,
  });
}

describe('canHandle', () => {
  it.each([
    'cron',
    'CRON',
    '/cron',
    'schedule',
    'scheduler',
    '크론',
    '스케줄',
    '스케쥴',
    '스케줄러',
    '스케쥴러',
    'cron list',
    'cron model daily gpt-5.5',
    'cron target daily dm',
    'cron delete daily',
    'cron help',
  ])('handles %s', (text) => {
    expect(handler.canHandle(text)).toBe(true);
  });

  it.each([
    'cron 등록해줘',
    '크론 잡 하나 만들어줘',
    'schedule a meeting tomorrow',
    'cronjob이 뭐야',
    'model gpt-5.5',
    'goal list',
  ])('does NOT handle %s (falls through to the model)', (text) => {
    expect(handler.canHandle(text)).toBe(false);
  });
});

describe('list', () => {
  it('bare `cron` lists own jobs for non-admin (own only, no owner column)', async () => {
    seed();
    seed({ name: 'other-job', owner: 'U_BOB', target: 'dm' });
    const ctx = makeCtx({ text: 'cron' });
    const r = await handler.execute(ctx);
    expect(r.handled).toBe(true);
    const out = saidText(ctx);
    expect(out).toContain('daily-report');
    expect(out).not.toContain('other-job');
    expect(out).not.toContain('owner:');
    // model + output target explicit, defaults included
    expect(out).toContain('default');
    expect(out).toContain('channel');
  });

  it('admin sees all jobs with owner shown', async () => {
    seed();
    seed({ name: 'other-job', owner: 'U_BOB', target: 'dm', modelConfig: { type: 'custom', model: 'gpt-5.5' } });
    const ctx = makeCtx({ user: 'U_ADMIN', text: 'cron' });
    await handler.execute(ctx);
    const out = saidText(ctx);
    expect(out).toContain('daily-report');
    expect(out).toContain('other-job');
    expect(out).toContain('<@U_ALICE>');
    expect(out).toContain('<@U_BOB>');
    expect(out).toContain('gpt-5.5');
    expect(out).toContain('dm');
  });

  it('empty list shows usage hint', async () => {
    const ctx = makeCtx({ text: 'cron' });
    await handler.execute(ctx);
    expect(saidText(ctx)).toContain('cron model');
  });
});

describe('model change', () => {
  it('sets a specific model via alias resolution', async () => {
    seed();
    const ctx = makeCtx({ text: 'cron model daily-report gpt' });
    const r = await handler.execute(ctx);
    expect(r.handled).toBe(true);
    expect(storage.getJobsByOwner('U_ALICE')[0].modelConfig).toEqual({ type: 'custom', model: 'gpt-5.5' });
  });

  it('default clears the override (creator current model at fire time)', async () => {
    seed({ modelConfig: { type: 'custom', model: 'gpt-5.5' } });
    const ctx = makeCtx({ text: 'cron model daily-report default' });
    await handler.execute(ctx);
    expect(storage.getJobsByOwner('U_ALICE')[0].modelConfig).toBeUndefined();
    expect(saidText(ctx)).toContain('만든 사람');
  });

  it('fast sets the fast model config', async () => {
    seed();
    await handler.execute(makeCtx({ text: 'cron model daily-report fast' }));
    expect(storage.getJobsByOwner('U_ALICE')[0].modelConfig).toEqual({ type: 'fast' });
  });

  it('unknown model is rejected', async () => {
    seed();
    const ctx = makeCtx({ text: 'cron model daily-report not-a-model' });
    await handler.execute(ctx);
    expect(saidText(ctx)).toContain('알 수 없는 모델');
    expect(storage.getJobsByOwner('U_ALICE')[0].modelConfig).toBeUndefined();
  });
});

describe('target change', () => {
  it('dm target clears threadTs', async () => {
    seed({ target: 'thread', threadTs: '1.2' });
    await handler.execute(makeCtx({ text: 'cron target daily-report dm' }));
    const job = storage.getJobsByOwner('U_ALICE')[0];
    expect(job.target).toBe('dm');
    expect(job.threadTs).toBeNull();
  });

  it('channel target clears override and threadTs', async () => {
    seed({ target: 'dm', threadTs: '1.2' });
    await handler.execute(makeCtx({ text: 'cron target daily-report channel' }));
    const job = storage.getJobsByOwner('U_ALICE')[0];
    expect(job.target).toBeUndefined();
    expect(job.threadTs).toBeNull();
  });

  it('thread target uses current thread ts when not given', async () => {
    seed();
    await handler.execute(makeCtx({ text: 'cron target daily-report thread' }));
    const job = storage.getJobsByOwner('U_ALICE')[0];
    expect(job.target).toBe('thread');
    expect(job.threadTs).toBe('thread123');
  });
});

describe('admin scoping on modification', () => {
  it('non-admin cannot modify another user job via owner mention', async () => {
    seed({ owner: 'U_BOB' });
    const ctx = makeCtx({ text: 'cron model daily-report fast <@U_BOB>' });
    await handler.execute(ctx);
    expect(saidText(ctx)).toContain('admin');
    expect(storage.getJobsByOwner('U_BOB')[0].modelConfig).toBeUndefined();
  });

  it('admin modifies another user job via owner mention', async () => {
    seed({ owner: 'U_BOB' });
    const ctx = makeCtx({ user: 'U_ADMIN', text: 'cron model daily-report fast <@U_BOB>' });
    await handler.execute(ctx);
    expect(storage.getJobsByOwner('U_BOB')[0].modelConfig).toEqual({ type: 'fast' });
  });

  it('admin name-only with cross-owner collision is rejected as ambiguous', async () => {
    seed({ owner: 'U_ADMIN' });
    seed({ owner: 'U_BOB' });
    const ctx = makeCtx({ user: 'U_ADMIN', text: 'cron model daily-report fast' });
    await handler.execute(ctx);
    expect(saidText(ctx)).toContain('여러');
    expect(storage.getJobsByOwner('U_ADMIN')[0].modelConfig).toBeUndefined();
    expect(storage.getJobsByOwner('U_BOB')[0].modelConfig).toBeUndefined();
  });
});

describe('delete', () => {
  it('deletes own job', async () => {
    seed();
    const ctx = makeCtx({ text: 'cron delete daily-report' });
    await handler.execute(ctx);
    expect(storage.getJobsByOwner('U_ALICE')).toHaveLength(0);
  });

  it('unknown job reports not found', async () => {
    const ctx = makeCtx({ text: 'cron delete nope' });
    await handler.execute(ctx);
    expect(saidText(ctx)).toContain('없');
  });
});
