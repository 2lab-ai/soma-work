/**
 * `TurnInputChannel` contract (user-steering WU1).
 *
 * The channel is the `prompt` argument of a streaming-input `query()` call: it
 * yields the turn's initial user message first, then whatever the host pushes
 * mid-turn, and terminates only on `close()`. Everything the SDK needs is here
 * — the tests pin the ordering and the closed-channel semantics because the
 * CLI child process lives exactly as long as this iterator does.
 */

import { describe, expect, it } from 'vitest';
import type { SteerUserMessage } from '../turn-input-channel';
import { TurnInputChannel } from '../turn-input-channel';

function userMessage(text: string): SteerUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  };
}

function steerMessage(text: string, uuid: string): SteerUserMessage {
  return { ...userMessage(text), uuid: uuid as SteerUserMessage['uuid'] };
}

async function drain(channel: TurnInputChannel): Promise<SteerUserMessage[]> {
  const out: SteerUserMessage[] = [];
  for await (const m of channel) out.push(m);
  return out;
}

describe('TurnInputChannel (user-steering WU1)', () => {
  it('yields the initial message first', async () => {
    const channel = new TurnInputChannel(userMessage('first'));
    const iterator = channel[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.message.content).toBe('first');
  });

  it('yields pushed messages in order after the initial one, then ends on close()', async () => {
    const channel = new TurnInputChannel(userMessage('first'));
    channel.push(userMessage('second'));
    channel.push(userMessage('third'));
    channel.close();

    const messages = await drain(channel);
    expect(messages.map((m) => m.message.content)).toEqual(['first', 'second', 'third']);
  });

  it('parks the consumer until a push arrives (mid-turn injection)', async () => {
    const channel = new TurnInputChannel(userMessage('first'));
    const iterator = channel[Symbol.asyncIterator]();
    await iterator.next();

    let settled = false;
    const pending = iterator.next().then((r) => {
      settled = true;
      return r;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    channel.push(userMessage('steered'));
    const next = await pending;
    expect(next.done).toBe(false);
    expect(next.value?.message.content).toBe('steered');
  });

  it('close() releases a parked consumer', async () => {
    const channel = new TurnInputChannel(userMessage('first'));
    const iterator = channel[Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    channel.close();
    expect((await pending).done).toBe(true);
  });

  it('push() returns true while open and false after close()', async () => {
    const channel = new TurnInputChannel(userMessage('first'));
    expect(channel.push(userMessage('second'))).toBe(true);
    channel.close();
    expect(channel.isClosed).toBe(true);
    expect(channel.push(userMessage('too late'))).toBe(false);

    const messages = await drain(channel);
    expect(messages.map((m) => m.message.content)).toEqual(['first', 'second']);
  });

  it('close() is idempotent', async () => {
    const channel = new TurnInputChannel(userMessage('first'));
    channel.close();
    channel.close();
    expect(await drain(channel)).toHaveLength(1);
  });

  it('records pushed steer uuids in push order, excluding the initial message', () => {
    const channel = new TurnInputChannel(steerMessage('first', 'u-initial'));
    expect(channel.pushedUuids()).toEqual([]);

    channel.push(steerMessage('second', 'u-1'));
    channel.push(userMessage('uuid-less'));
    channel.push(steerMessage('third', 'u-2'));

    expect(channel.pushedUuids()).toEqual(['u-1', 'u-2']);
  });

  it('does not record a uuid for a push refused after close()', () => {
    const channel = new TurnInputChannel(userMessage('first'));
    channel.push(steerMessage('second', 'u-1'));
    channel.close();
    expect(channel.push(steerMessage('too late', 'u-2'))).toBe(false);
    expect(channel.pushedUuids()).toEqual(['u-1']);
  });

  it('pushedUuids() hands back a copy (callers cannot mutate the record)', () => {
    const channel = new TurnInputChannel(userMessage('first'));
    channel.push(steerMessage('second', 'u-1'));
    channel.pushedUuids().push('forged');
    expect(channel.pushedUuids()).toEqual(['u-1']);
  });
});
