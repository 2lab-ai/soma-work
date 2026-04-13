/**
 * WebResponseSession tests (Issue #412)
 */

import { describe, expect, it, vi } from 'vitest';
import { WebResponseSession, type WebSocketBroadcaster } from './web-response-session.js';

function createMockBroadcaster(): WebSocketBroadcaster & {
  messages: Array<{ key: string; msg: Record<string, unknown> }>;
} {
  const messages: Array<{ key: string; msg: Record<string, unknown> }> = [];
  return {
    messages,
    send: vi.fn((key: string, msg: Record<string, unknown>) => {
      messages.push({ key, msg });
    }),
  };
}

describe('WebResponseSession', () => {
  it('sends response_start on construction', () => {
    const broadcaster = createMockBroadcaster();
    new WebResponseSession('sess-1', broadcaster);

    expect(broadcaster.send).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({
        type: 'response_start',
        sessionKey: 'sess-1',
      }),
    );
  });

  it('sends text deltas immediately (native streaming)', () => {
    const broadcaster = createMockBroadcaster();
    const session = new WebResponseSession('sess-1', broadcaster);

    session.appendText('Hello ');
    session.appendText('world!');

    const textMessages = broadcaster.messages.filter((m) => m.msg.type === 'response_text');
    expect(textMessages).toHaveLength(2);
    expect(textMessages[0].msg.delta).toBe('Hello ');
    expect(textMessages[1].msg.delta).toBe('world!');
  });

  it('sends status updates', () => {
    const broadcaster = createMockBroadcaster();
    const session = new WebResponseSession('sess-1', broadcaster);

    session.setStatus('thinking', { context: 'analyzing code' });

    const statusMessages = broadcaster.messages.filter((m) => m.msg.type === 'response_status');
    expect(statusMessages).toHaveLength(1);
    expect(statusMessages[0].msg.phase).toBe('thinking');
    expect(statusMessages[0].msg.detail).toEqual({ context: 'analyzing code' });
  });

  it('sends part replacements', () => {
    const broadcaster = createMockBroadcaster();
    const session = new WebResponseSession('sess-1', broadcaster);

    session.replacePart('tool-1', { type: 'status', phase: 'running', tool: 'Bash' });

    const replaceMessages = broadcaster.messages.filter((m) => m.msg.type === 'response_replace');
    expect(replaceMessages).toHaveLength(1);
    expect(replaceMessages[0].msg.partId).toBe('tool-1');
  });

  it('sends file metadata', () => {
    const broadcaster = createMockBroadcaster();
    const session = new WebResponseSession('sess-1', broadcaster);

    session.attachFile({
      name: 'output.txt',
      mimeType: 'text/plain',
      data: Buffer.from('hello'),
    });

    const fileMessages = broadcaster.messages.filter((m) => m.msg.type === 'response_file');
    expect(fileMessages).toHaveLength(1);
    expect(fileMessages[0].msg.name).toBe('output.txt');
    expect(fileMessages[0].msg.size).toBe(5);
  });

  it('sends response_complete and returns handle', async () => {
    const broadcaster = createMockBroadcaster();
    const session = new WebResponseSession('sess-1', broadcaster);

    session.appendText('Done');
    const handle = await session.complete();

    const completeMessages = broadcaster.messages.filter((m) => m.msg.type === 'response_complete');
    expect(completeMessages).toHaveLength(1);
    expect(completeMessages[0].msg.textLength).toBe(4);
    expect(handle.platform).toBe('web');
  });

  it('sends response_abort with reason', () => {
    const broadcaster = createMockBroadcaster();
    const session = new WebResponseSession('sess-1', broadcaster);

    session.abort('API error');

    const abortMessages = broadcaster.messages.filter((m) => m.msg.type === 'response_abort');
    expect(abortMessages).toHaveLength(1);
    expect(abortMessages[0].msg.reason).toBe('API error');
  });

  it('ignores calls after complete', async () => {
    const broadcaster = createMockBroadcaster();
    const session = new WebResponseSession('sess-1', broadcaster);

    await session.complete();
    session.appendText('ignored');
    session.setStatus('ignored');

    const textMessages = broadcaster.messages.filter((m) => m.msg.type === 'response_text');
    expect(textMessages).toHaveLength(0);
  });

  it('ignores calls after abort', () => {
    const broadcaster = createMockBroadcaster();
    const session = new WebResponseSession('sess-1', broadcaster);

    session.abort('error');
    session.appendText('ignored');

    const textMessages = broadcaster.messages.filter((m) => m.msg.type === 'response_text');
    expect(textMessages).toHaveLength(0);
  });
});
