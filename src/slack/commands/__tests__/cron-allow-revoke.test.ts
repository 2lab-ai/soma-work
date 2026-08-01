/**
 * RED tests — `cron allow` / `cron revoke`.
 *
 * A grant the owner cannot take back is a one-way door: "항상 허용" must have an
 * inverse, and the owner must be able to grant up front without waiting for
 * someone to ask. Owner/admin only — the allowlist is a permission surface.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-settings-store', () => ({
  AVAILABLE_MODELS: [],
  userSettingsStore: {
    resolveModelInput: vi.fn(() => null),
    resolveModelInputWithRefresh: vi.fn(async () => null),
  },
}));

vi.mock('../../../admin-utils', () => ({
  isAdminUser: vi.fn((u: string) => u === 'U_ADMIN'),
}));

const runJobNow = vi.fn().mockResolvedValue({ ok: true, message: 'fired' });
vi.mock('../../../cron-scheduler', () => ({
  getActiveCronScheduler: vi.fn(() => ({ runJobNow })),
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
  return (ctx.say as any).mock.calls.map((c: any[]) => c[0].text ?? '').join('\n');
}

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `cron-allow-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  storage = new CronStorage(tmpFile);
  storage.addJob({
    name: 'deploy',
    expression: '0 19 * * *',
    prompt: 'p',
    owner: 'U_ALICE',
    channel: 'C1',
    threadTs: null,
  });
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

describe('cron allow / revoke', () => {
  it('canHandle routes both subcommands', () => {
    expect(handler.canHandle('cron allow deploy <@U_BOB>')).toBe(true);
    expect(handler.canHandle('cron revoke deploy <@U_BOB>')).toBe(true);
  });

  it('allow adds a user to the job allowlist', async () => {
    const ctx = makeCtx({ text: 'cron allow deploy <@U_BOB>' });
    await handler.execute(ctx);
    expect(storage.getJobsByOwner('U_ALICE')[0].runAllowlist).toEqual(['U_BOB']);
    expect(saidText(ctx)).toContain('U_BOB');
  });

  it('revoke removes the user again', async () => {
    storage.allowRun('U_ALICE', 'deploy', 'U_BOB');
    const ctx = makeCtx({ text: 'cron revoke deploy <@U_BOB>' });
    await handler.execute(ctx);
    expect(storage.getJobsByOwner('U_ALICE')[0].runAllowlist ?? []).toEqual([]);
  });

  it('a non-owner cannot grant themselves access', async () => {
    const ctx = makeCtx({ user: 'U_BOB', text: 'cron allow deploy <@U_BOB>' });
    await handler.execute(ctx);
    expect(storage.getJobsByOwner('U_ALICE')[0].runAllowlist ?? []).toEqual([]);
  });

  it('admin can grant on another user’s job with an explicit owner', async () => {
    const ctx = makeCtx({ user: 'U_ADMIN', text: 'cron allow deploy <@U_BOB> <@U_ALICE>' });
    await handler.execute(ctx);
    expect(storage.getJobsByOwner('U_ALICE')[0].runAllowlist).toEqual(['U_BOB']);
  });

  // The exact attack: a stranger naming the owner explicitly to slip past the
  // implicit-owner check and grant themselves run access.
  it('a non-owner cannot grant themselves by naming the owner explicitly', async () => {
    const ctx = makeCtx({ user: 'U_BOB', text: 'cron allow deploy <@U_BOB> <@U_ALICE>' });
    await handler.execute(ctx);
    expect(storage.getJobsByOwner('U_ALICE')[0].runAllowlist ?? []).toEqual([]);
    expect(saidText(ctx)).toContain('admin');
  });

  it('a non-owner cannot revoke someone else’s grant either', async () => {
    storage.allowRun('U_ALICE', 'deploy', 'U_CAROL');
    const ctx = makeCtx({ user: 'U_BOB', text: 'cron revoke deploy <@U_CAROL> <@U_ALICE>' });
    await handler.execute(ctx);
    expect(storage.getJobsByOwner('U_ALICE')[0].runAllowlist).toEqual(['U_CAROL']);
  });

  it('revoking the last entry clears the field rather than leaving []', async () => {
    storage.allowRun('U_ALICE', 'deploy', 'U_BOB');
    await handler.execute(makeCtx({ text: 'cron revoke deploy <@U_BOB>' }));
    expect(storage.getJobsByOwner('U_ALICE')[0].runAllowlist).toBeUndefined();
  });

  it('rejects a missing/!mention target user', async () => {
    const ctx = makeCtx({ text: 'cron allow deploy' });
    await handler.execute(ctx);
    expect(storage.getJobsByOwner('U_ALICE')[0].runAllowlist ?? []).toEqual([]);
    expect(saidText(ctx)).toContain('사용법');
  });
});
