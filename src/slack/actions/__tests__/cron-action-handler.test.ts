/**
 * CronActionHandler — card interactions (model/target selects, delete button).
 * Authorization: clicker must be job owner or admin; card re-renders in place.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../admin-utils', () => ({
  isAdminUser: vi.fn((u: string) => u === 'U_ADMIN'),
}));

const runJobNow = vi.fn().mockResolvedValue({ ok: true, message: 'fired' });
vi.mock('../../../cron-scheduler', () => ({
  getActiveCronScheduler: vi.fn(() => ({ runJobNow })),
}));

import { CronStorage } from 'somalib/cron/cron-storage';
import { CronActionHandler } from '../cron-action-handler';

let tmpFile: string;
let storage: CronStorage;
let handler: CronActionHandler;
let updateMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `cron-action-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  storage = new CronStorage(tmpFile);
  updateMessage = vi.fn().mockResolvedValue(undefined);
  handler = new CronActionHandler({ slackApi: { updateMessage } as any, storagePath: tmpFile });
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

function body(args: { actionId: string; user: string; selected?: string; threadTs?: string }) {
  return {
    user: { id: args.user },
    channel: { id: 'C_CARD' },
    message: { ts: '111.222', ...(args.threadTs ? { thread_ts: args.threadTs } : {}) },
    actions: [
      {
        action_id: args.actionId,
        ...(args.selected ? { selected_option: { value: args.selected } } : {}),
      },
    ],
  };
}

describe('authorization', () => {
  it('owner can change own job model', async () => {
    seed();
    const respond = vi.fn();
    await handler.handleAction(
      body({ actionId: 'cron_model::U_ALICE::daily-report', user: 'U_ALICE', selected: 'fast' }),
      respond,
    );
    expect(storage.getJobsByOwner('U_ALICE')[0].modelConfig).toEqual({ type: 'fast' });
    expect(updateMessage).toHaveBeenCalledTimes(1);
  });

  it("admin can change another user's job", async () => {
    seed();
    const respond = vi.fn();
    await handler.handleAction(
      body({ actionId: 'cron_model::U_ALICE::daily-report', user: 'U_ADMIN', selected: 'custom:gpt-5.5' }),
      respond,
    );
    expect(storage.getJobsByOwner('U_ALICE')[0].modelConfig).toEqual({ type: 'custom', model: 'gpt-5.5' });
  });

  it('non-owner non-admin is rejected with ephemeral, job untouched', async () => {
    seed();
    const respond = vi.fn();
    await handler.handleAction(
      body({ actionId: 'cron_model::U_ALICE::daily-report', user: 'U_EVE', selected: 'fast' }),
      respond,
    );
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
    expect(storage.getJobsByOwner('U_ALICE')[0].modelConfig).toBeUndefined();
    expect(updateMessage).not.toHaveBeenCalled();
  });
});

describe('model select', () => {
  it('default clears the override (creator current model at fire time)', async () => {
    seed({ modelConfig: { type: 'custom', model: 'gpt-5.5' } });
    await handler.handleAction(
      body({ actionId: 'cron_model::U_ALICE::daily-report', user: 'U_ALICE', selected: 'default' }),
      vi.fn(),
    );
    expect(storage.getJobsByOwner('U_ALICE')[0].modelConfig).toBeUndefined();
  });
});

describe('target select', () => {
  it('dm clears threadTs', async () => {
    seed({ target: 'thread', threadTs: '9.9' });
    await handler.handleAction(
      body({ actionId: 'cron_target::U_ALICE::daily-report', user: 'U_ALICE', selected: 'dm' }),
      vi.fn(),
    );
    const j = storage.getJobsByOwner('U_ALICE')[0];
    expect(j.target).toBe('dm');
    expect(j.threadTs).toBeNull();
  });

  it('channel clears target override and threadTs', async () => {
    seed({ target: 'dm', threadTs: '9.9' });
    await handler.handleAction(
      body({ actionId: 'cron_target::U_ALICE::daily-report', user: 'U_ALICE', selected: 'channel' }),
      vi.fn(),
    );
    const j = storage.getJobsByOwner('U_ALICE')[0];
    expect(j.target).toBeUndefined();
    expect(j.threadTs).toBeNull();
  });

  it('thread anchors to the card thread ts AND repoints channel to the card channel', async () => {
    seed(); // job.channel = C111, card lives in C_CARD
    await handler.handleAction(
      body({
        actionId: 'cron_target::U_ALICE::daily-report',
        user: 'U_ALICE',
        selected: 'thread',
        threadTs: '777.888',
      }),
      vi.fn(),
    );
    const j = storage.getJobsByOwner('U_ALICE')[0];
    expect(j.target).toBe('thread');
    expect(j.threadTs).toBe('777.888');
    // scheduler posts threadReplier(job.channel, job.threadTs) — both must match the card
    expect(j.channel).toBe('C_CARD');
  });
});

describe('delete', () => {
  it('owner deletes own job and card re-renders', async () => {
    seed();
    await handler.handleAction(body({ actionId: 'cron_delete::U_ALICE::daily-report', user: 'U_ALICE' }), vi.fn());
    expect(storage.getJobsByOwner('U_ALICE')).toHaveLength(0);
    expect(updateMessage).toHaveBeenCalledTimes(1);
  });

  it('already-deleted job responds not-found ephemeral', async () => {
    const respond = vi.fn();
    await handler.handleAction(body({ actionId: 'cron_delete::U_ALICE::daily-report', user: 'U_ALICE' }), respond);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
  });
});

describe('rerender scope', () => {
  it('admin rerender includes all users; owner rerender only own', async () => {
    seed();
    seed({ name: 'other', owner: 'U_BOB' });
    await handler.handleAction(
      body({ actionId: 'cron_model::U_ALICE::daily-report', user: 'U_ALICE', selected: 'fast' }),
      vi.fn(),
    );
    const ownerBlocks = JSON.stringify(updateMessage.mock.calls[0][3]);
    expect(ownerBlocks).toContain('daily-report');
    expect(ownerBlocks).not.toContain('other');

    updateMessage.mockClear();
    await handler.handleAction(
      body({ actionId: 'cron_model::U_ALICE::daily-report', user: 'U_ADMIN', selected: 'fast' }),
      vi.fn(),
    );
    const adminBlocks = JSON.stringify(updateMessage.mock.calls[0][3]);
    expect(adminBlocks).toContain('daily-report');
    expect(adminBlocks).toContain('other');
  });
});

describe('mode select', () => {
  it('fastlane sets the mode; default clears it', async () => {
    seed();
    await handler.handleAction(
      body({ actionId: 'cron_mode::U_ALICE::daily-report', user: 'U_ALICE', selected: 'fastlane' }),
      vi.fn(),
    );
    expect(storage.getJobsByOwner('U_ALICE')[0].mode).toBe('fastlane');
    await handler.handleAction(
      body({ actionId: 'cron_mode::U_ALICE::daily-report', user: 'U_ALICE', selected: 'default' }),
      vi.fn(),
    );
    expect(storage.getJobsByOwner('U_ALICE')[0].mode).toBeUndefined();
  });
});

describe('run now', () => {
  it('fires through the real scheduler path and reports via ephemeral', async () => {
    seed();
    const respond = vi.fn();
    await handler.handleAction(body({ actionId: 'cron_run::U_ALICE::daily-report', user: 'U_ALICE' }), respond);
    expect(runJobNow).toHaveBeenCalledWith('U_ALICE', 'daily-report', { triggeredBy: 'U_ALICE' });
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
    expect(updateMessage).toHaveBeenCalledTimes(1); // last-run rerender
  });

  it('non-owner non-admin cannot run', async () => {
    seed();
    runJobNow.mockClear();
    await handler.handleAction(body({ actionId: 'cron_run::U_ALICE::daily-report', user: 'U_EVE' }), vi.fn());
    expect(runJobNow).not.toHaveBeenCalled();
  });
});

describe('edit button', () => {
  it('opens the edit modal via views.open with job-prefilled view', async () => {
    seed();
    const viewsOpen = vi.fn().mockResolvedValue({});
    const b: any = body({ actionId: 'cron_edit::U_ALICE::daily-report', user: 'U_ALICE' });
    b.trigger_id = 'trig-1';
    await handler.handleAction(b, vi.fn(), { views: { open: viewsOpen } });
    expect(viewsOpen).toHaveBeenCalledTimes(1);
    const view = viewsOpen.mock.calls[0][0].view;
    expect(view.callback_id).toBe('cron_edit_modal_submit');
    expect(JSON.stringify(view.blocks)).toContain('daily-report');
  });

  it('missing client/trigger_id degrades to ephemeral error', async () => {
    seed();
    const respond = vi.fn();
    await handler.handleAction(body({ actionId: 'cron_edit::U_ALICE::daily-report', user: 'U_ALICE' }), respond);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
  });
});
