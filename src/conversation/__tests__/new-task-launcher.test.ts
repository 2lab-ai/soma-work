/**
 * Dashboard "New task" — the launcher (SSOT 2026-10-23 T2/T6/T7/T9).
 *
 * A submitted task becomes a Slack thread in the chosen channel (so the work
 * is visible there) and a session that runs as the requesting user:
 *   1. a root message echoing the instruction is posted into the channel,
 *   2. attachments are uploaded into that thread,
 *   3. the instruction (with `$autoz` when the toggle is on) enters the normal
 *      message pipeline as that user's message on that thread, carrying the
 *      per-task model / effort / autogoal choices,
 *   4. the HTTP caller is answered once the session exists — not after the
 *      whole turn — and every failure is said out loud in the thread.
 */

import { describe, expect, it, vi } from 'vitest';
import type { NewTaskSubmission } from '../new-task';
import { launchNewTask, NewTaskError, type NewTaskLaunchDeps } from '../new-task-launcher';

function submission(overrides: Partial<NewTaskSubmission> = {}): NewTaskSubmission {
  return {
    requestId: 'req-0123456789',
    prompt: 'soma-work 개선해줘',
    nickname: 'opus[1m]',
    model: 'claude-opus-5-5[1m]',
    effort: 'xhigh',
    channelId: 'C_ALPHA',
    autogoal: true,
    autoz: true,
    attachments: [],
    ...overrides,
  };
}

function deps(overrides: Partial<NewTaskLaunchDeps> = {}) {
  const sessions = new Set<string>();
  const calls: string[] = [];
  const d: NewTaskLaunchDeps & { sessions: Set<string>; calls: string[] } = {
    sessions,
    calls,
    postMessage: vi.fn(async () => {
      calls.push('postMessage');
      return { ts: '1792735000.000100' };
    }),
    uploadFiles: vi.fn(async (_channel: string, _threadTs: string, files: any[]) => {
      calls.push('uploadFiles');
      return files.map((f: any, i: number) => ({
        id: `F${i}`,
        name: f.name,
        mimetype: f.mimetype,
        filetype: 'jpg',
        url_private: `https://files/F${i}`,
        url_private_download: `https://files/F${i}/download`,
        size: f.data.length,
      }));
    }),
    postThreadNotice: vi.fn(async () => {
      calls.push('postThreadNotice');
    }),
    getPermalink: vi.fn(async () => 'https://slack.example/archives/C_ALPHA/p1792735000000100'),
    getSessionKey: (channel, threadTs) => `${channel}:${threadTs}`,
    hasSession: (key) => sessions.has(key),
    handleMessage: vi.fn(async (event: any) => {
      calls.push('handleMessage');
      // The pipeline creates the session synchronously-ish, then runs the turn.
      sessions.add(`${event.channel}:${event.thread_ts}`);
      await new Promise(() => {}); // the turn never ends within the test
    }),
    makeSay: vi.fn(() => async () => ({ ts: 'say' })),
    sleep: async () => {},
    acceptTimeoutMs: 50,
    ...overrides,
  };
  return d;
}

describe('launchNewTask', () => {
  it('posts the root message into the chosen channel, as the visible start of the task', async () => {
    const d = deps();
    const result = await launchNewTask('U123', submission(), d);
    expect(d.postMessage).toHaveBeenCalledTimes(1);
    const [channel, text, blocks] = (d.postMessage as any).mock.calls[0];
    expect(channel).toBe('C_ALPHA');
    expect(text).toContain('<@U123>');
    expect(JSON.stringify(blocks)).toContain('soma-work 개선해줘');
    expect(result).toEqual({
      channel: 'C_ALPHA',
      threadTs: '1792735000.000100',
      sessionKey: 'C_ALPHA:1792735000.000100',
      permalink: 'https://slack.example/archives/C_ALPHA/p1792735000000100',
      status: 'running',
    });
  });

  it('runs the instruction as the requesting user on that thread, with the per-task choices and `$autoz` appended', async () => {
    const d = deps();
    await launchNewTask('U123', submission(), d);
    const event = (d.handleMessage as any).mock.calls[0][0];
    expect(event).toMatchObject({
      type: 'message',
      user: 'U123',
      channel: 'C_ALPHA',
      thread_ts: '1792735000.000100',
      ts: '1792735000.000100',
      text: 'soma-work 개선해줘\n\n$autoz',
      modelOverride: 'claude-opus-5-5[1m]',
      effortOverride: 'xhigh',
      autoGoalOverride: true,
      routeContext: { skipAutoBotThread: true },
    });
    // A real user instruction: autogoal, autoskills and deferred `$skill` must run.
    expect(event.synthetic).toBeUndefined();
    expect(event.skipDispatch).toBeUndefined();
    expect(d.makeSay).toHaveBeenCalledWith('C_ALPHA', '1792735000.000100');
  });

  it('autoz off → the instruction is passed through untouched; autogoal off is carried explicitly', async () => {
    const d = deps();
    await launchNewTask('U123', submission({ autoz: false, autogoal: false }), d);
    const event = (d.handleMessage as any).mock.calls[0][0];
    expect(event.text).toBe('soma-work 개선해줘');
    expect(event.autoGoalOverride).toBe(false);
  });

  it('uploads attachments into the thread first and hands them to the pipeline as Slack files', async () => {
    const d = deps();
    const photo = { name: 'photo.jpg', mimetype: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0x00]) };
    const voice = { name: 'voice.m4a', mimetype: 'audio/mp4', data: Buffer.from('aaaa') };
    await launchNewTask('U123', submission({ attachments: [photo, voice] }), d);
    expect(d.calls.slice(0, 3)).toEqual(['postMessage', 'uploadFiles', 'handleMessage']);
    expect(d.uploadFiles).toHaveBeenCalledWith('C_ALPHA', '1792735000.000100', [photo, voice]);
    const event = (d.handleMessage as any).mock.calls[0][0];
    expect(event.files.map((f: any) => f.name)).toEqual(['photo.jpg', 'voice.m4a']);
    expect(event.files[0]).toHaveProperty('url_private_download');
  });

  it('no attachments → no upload call and no `files` on the event', async () => {
    const d = deps();
    await launchNewTask('U123', submission(), d);
    expect(d.uploadFiles).not.toHaveBeenCalled();
    expect((d.handleMessage as any).mock.calls[0][0].files).toBeUndefined();
  });

  it('answers once the session exists, without waiting for the turn to finish', async () => {
    const d = deps();
    const result = await launchNewTask('U123', submission(), d);
    expect(result.status).toBe('running');
  });

  it('a session that does not appear in time is reported as starting, not as running', async () => {
    const d = deps({ handleMessage: vi.fn(() => new Promise(() => {})) });
    const result = await launchNewTask('U123', submission(), d);
    expect(result.status).toBe('starting');
  });

  it('the root message could not be posted → 502 and nothing else happens', async () => {
    const d = deps({ postMessage: vi.fn(async () => ({})) });
    await expect(launchNewTask('U123', submission(), d)).rejects.toMatchObject({ statusCode: 502 });
    expect(d.handleMessage).not.toHaveBeenCalled();
  });

  it('an attachment upload failure stops the launch and says so in the thread', async () => {
    const d = deps({
      uploadFiles: vi.fn(async () => {
        throw new Error('files.uploadV2 failed');
      }),
    });
    const photo = { name: 'photo.jpg', mimetype: 'image/jpeg', data: Buffer.from([1]) };
    const err = await launchNewTask('U123', submission({ attachments: [photo] }), d).catch((e) => e);
    expect(err).toBeInstanceOf(NewTaskError);
    expect(err.statusCode).toBe(502);
    expect(d.handleMessage).not.toHaveBeenCalled();
    const [channel, threadTs, text] = (d.postThreadNotice as any).mock.calls[0];
    expect([channel, threadTs]).toEqual(['C_ALPHA', '1792735000.000100']);
    expect(text).toMatch(/첨부/);
  });

  it('the pipeline rejecting before the session exists → 500 and a notice in the thread', async () => {
    const d = deps({
      handleMessage: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const err = await launchNewTask('U123', submission(), d).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 500 });
    expect(err.message).not.toContain('boom');
    expect((d.postThreadNotice as any).mock.calls[0][2]).toMatch(/작업을 시작하지 못했습니다/);
    // A raw error (it may carry tokens or URLs) never reaches the channel.
    expect((d.postThreadNotice as any).mock.calls[0][2]).not.toContain('boom');
  });

  it('the turn failing after the session started is reported in the thread (not swallowed)', async () => {
    let fail!: (e: Error) => void;
    const d = deps({
      handleMessage: vi.fn((event: any) => {
        d.sessions.add(`${event.channel}:${event.thread_ts}`);
        return new Promise((_r, reject) => {
          fail = reject;
        });
      }),
    });
    const result = await launchNewTask('U123', submission(), d);
    expect(result.status).toBe('running');
    fail(new Error('late failure'));
    await new Promise((r) => setTimeout(r, 0));
    const notice = (d.postThreadNotice as any).mock.calls.at(-1)[2];
    expect(notice).toMatch(/작업 실행 중 오류/);
    expect(notice).not.toContain('late failure');
  });

  it('a permalink failure does not fail the launch', async () => {
    const d = deps({
      getPermalink: vi.fn(async () => {
        throw new Error('no permalink');
      }),
    });
    const result = await launchNewTask('U123', submission(), d);
    expect(result.permalink).toBeUndefined();
    expect(result.status).toBe('running');
  });
});
