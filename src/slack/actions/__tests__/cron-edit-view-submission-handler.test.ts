/**
 * CronEditViewSubmissionHandler — edit modal submit (name/schedule/channel/prompt).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../admin-utils', () => ({
  isAdminUser: vi.fn((u: string) => u === 'U_ADMIN'),
}));

import { CronStorage } from 'somalib/cron/cron-storage';
import { CronEditViewSubmissionHandler } from '../cron-edit-view-submission-handler';

let tmpFile: string;
let storage: CronStorage;
let handler: CronEditViewSubmissionHandler;
let updateMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `cron-edit-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  storage = new CronStorage(tmpFile);
  updateMessage = vi.fn().mockResolvedValue(undefined);
  handler = new CronEditViewSubmissionHandler({ slackApi: { updateMessage } as any, storagePath: tmpFile });
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

function submitBody(args: {
  user: string;
  name?: string;
  expr?: string;
  channel?: string;
  prompt?: string;
  meta?: Record<string, any>;
}) {
  return {
    user: { id: args.user },
    view: {
      private_metadata: JSON.stringify({
        owner: 'U_ALICE',
        name: 'daily-report',
        cardChannelId: 'C_CARD',
        cardMessageTs: '1.2',
        requesterId: args.user,
        ...(args.meta ?? {}),
      }),
      state: {
        values: {
          cron_edit_name: { value: { value: args.name ?? 'daily-report' } },
          cron_edit_expr: { value: { value: args.expr ?? '0 9 * * 1-5' } },
          cron_edit_channel: { value: { selected_channel: args.channel ?? 'C111' } },
          cron_edit_prompt: { value: { value: args.prompt ?? 'morning report' } },
        },
      },
    },
  };
}

describe('CronEditViewSubmissionHandler', () => {
  it('applies name/schedule/channel/prompt and re-renders the card', async () => {
    seed();
    const ack = vi.fn();
    await handler.handleSubmit(
      ack as any,
      submitBody({ user: 'U_ALICE', name: 'renamed-job', expr: '*/30 * * * *', channel: 'C999', prompt: 'new prompt' }),
    );
    expect(ack).toHaveBeenCalledWith({ response_action: 'clear' });
    const job = storage.getJobsByOwner('U_ALICE')[0];
    expect(job.name).toBe('renamed-job');
    expect(job.expression).toBe('*/30 * * * *');
    expect(job.channel).toBe('C999');
    expect(job.prompt).toBe('new prompt');
    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(updateMessage.mock.calls[0][3])).toContain('renamed-job');
  });

  it('rename to an existing name is rejected with an inline error', async () => {
    seed();
    seed({ name: 'other-job' });
    const ack = vi.fn();
    await handler.handleSubmit(ack as any, submitBody({ user: 'U_ALICE', name: 'other-job' }));
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        response_action: 'errors',
        errors: expect.objectContaining({ cron_edit_name: expect.any(String) }),
      }),
    );
    // original untouched
    expect(
      storage
        .getJobsByOwner('U_ALICE')
        .map((j) => j.name)
        .sort(),
    ).toEqual(['daily-report', 'other-job']);
  });

  it('invalid expression is rejected inline', async () => {
    seed();
    const ack = vi.fn();
    await handler.handleSubmit(ack as any, submitBody({ user: 'U_ALICE', expr: 'not-a-cron' }));
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        response_action: 'errors',
        errors: expect.objectContaining({ cron_edit_expr: expect.any(String) }),
      }),
    );
  });

  it('someone else submitting the modal is rejected', async () => {
    seed();
    const ack = vi.fn();
    const body = submitBody({ user: 'U_EVE' });
    // requesterId in metadata is U_EVE (same as submitter) but owner is U_ALICE and U_EVE is not admin
    await handler.handleSubmit(ack as any, body);
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ response_action: 'errors' }));
    expect(storage.getJobsByOwner('U_ALICE')[0].prompt).toBe('morning report');
  });

  it('long prompt (>3000) is preserved when only other fields are edited', async () => {
    const long = 'y'.repeat(3500);
    seed({ prompt: long });
    const ack = vi.fn();
    // Modal showed the truncated 3000-char prefix; user only changed the schedule.
    await handler.handleSubmit(
      ack as any,
      submitBody({ user: 'U_ALICE', expr: '*/15 * * * *', prompt: long.substring(0, 3000) }),
    );
    expect(ack).toHaveBeenCalledWith({ response_action: 'clear' });
    const job = storage.getJobsByOwner('U_ALICE')[0];
    expect(job.expression).toBe('*/15 * * * *');
    expect(job.prompt).toBe(long); // full 3500 chars preserved — no silent truncation
  });

  it('long prompt IS replaced when the user actually typed a new one', async () => {
    seed({ prompt: 'z'.repeat(3500) });
    const ack = vi.fn();
    await handler.handleSubmit(ack as any, submitBody({ user: 'U_ALICE', prompt: 'brand new prompt' }));
    expect(storage.getJobsByOwner('U_ALICE')[0].prompt).toBe('brand new prompt');
  });

  it('admin can edit another user job via the modal', async () => {
    seed();
    const ack = vi.fn();
    await handler.handleSubmit(ack as any, submitBody({ user: 'U_ADMIN', prompt: 'admin edited' }));
    expect(ack).toHaveBeenCalledWith({ response_action: 'clear' });
    expect(storage.getJobsByOwner('U_ALICE')[0].prompt).toBe('admin edited');
  });
});
