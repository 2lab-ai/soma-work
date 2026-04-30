/**
 * Tests for `renderInPlace` transport helper (#803).
 *
 * Covers:
 *   - surface classification: message / ephemeral / unknown
 *   - channel/ts fallback chain (container preferred, falls back to
 *     `body.channel.id` / `body.message.ts`)
 *   - ephemeral surface + missing respond → `unknown` failure
 *   - chat.update / respond failure paths return `{ ok: false }`
 *   - unknown surface refuses to stack a fresh ephemeral
 */

import { describe, expect, it, vi } from 'vitest';
import { classifyRenderInPlaceSurface, renderInPlace } from '../render-in-place';

function makeClient(updateImpl?: (args: any) => Promise<unknown>) {
  return {
    chat: {
      update: vi.fn(updateImpl ?? (async () => ({ ok: true }))),
    },
  } as any;
}

function makeBlocks(): Record<string, unknown>[] {
  return [{ type: 'header', text: { type: 'plain_text', text: ':key: CCT' } }];
}

describe('classifyRenderInPlaceSurface', () => {
  it('returns "message" for container.type=message + channel + ts', () => {
    expect(
      classifyRenderInPlaceSurface({
        container: { type: 'message', channel_id: 'C1', message_ts: '1.0' },
      }),
    ).toBe('message');
  });

  it('returns "message" using top-level channel/message fallback', () => {
    expect(
      classifyRenderInPlaceSurface({
        container: { type: 'message' },
        channel: { id: 'C1' },
        message: { ts: '1.0' },
      }),
    ).toBe('message');
  });

  it('returns "unknown" when container.type=message but no channel/ts anywhere', () => {
    expect(classifyRenderInPlaceSurface({ container: { type: 'message' } })).toBe('unknown');
  });

  it('returns "ephemeral" for container.type=ephemeral', () => {
    expect(classifyRenderInPlaceSurface({ container: { type: 'ephemeral' } })).toBe('ephemeral');
  });

  it('returns "ephemeral" when container.is_ephemeral is true (older Bolt shape)', () => {
    expect(classifyRenderInPlaceSurface({ container: { is_ephemeral: true } })).toBe('ephemeral');
  });

  it('returns "unknown" when no container present', () => {
    expect(classifyRenderInPlaceSurface({})).toBe('unknown');
  });

  it('returns "unknown" for view-tab container type', () => {
    expect(classifyRenderInPlaceSurface({ container: { type: 'view' } })).toBe('unknown');
  });
});

describe('renderInPlace — message surface', () => {
  it('calls chat.update with channel/ts from container, returns {message, ok:true}', async () => {
    const client = makeClient();
    const renderMessageBlocks = vi.fn(async () => makeBlocks());
    const renderEphemeralBlocks = vi.fn(async () => []);
    const result = await renderInPlace({
      body: { container: { type: 'message', channel_id: 'C1', message_ts: '1.0' } },
      client,
      text: 'cct',
      renderMessageBlocks,
      renderEphemeralBlocks,
    });
    expect(result).toEqual({ surface: 'message', ok: true });
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', ts: '1.0', text: 'cct', blocks: expect.any(Array) }),
    );
    // Ephemeral builder must NOT have been invoked on the message path.
    expect(renderEphemeralBlocks).not.toHaveBeenCalled();
  });

  it('falls back to body.channel.id / body.message.ts when container omits them', async () => {
    const client = makeClient();
    const result = await renderInPlace({
      body: {
        container: { type: 'message' },
        channel: { id: 'C-fallback' },
        message: { ts: '99.9' },
      },
      client,
      text: 'cct',
      renderMessageBlocks: async () => makeBlocks(),
      renderEphemeralBlocks: async () => [],
    });
    expect(result.ok).toBe(true);
    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C-fallback', ts: '99.9' }));
  });

  it('returns {message, ok:false} when chat.update throws', async () => {
    const client = makeClient(async () => {
      throw new Error('rate_limited');
    });
    const result = await renderInPlace({
      body: { container: { type: 'message', channel_id: 'C1', message_ts: '1.0' } },
      client,
      text: 'cct',
      renderMessageBlocks: async () => makeBlocks(),
      renderEphemeralBlocks: async () => [],
    });
    expect(result).toEqual({ surface: 'message', ok: false });
  });
});

describe('renderInPlace — ephemeral surface', () => {
  it('calls respond({replace_original:true}) and returns {ephemeral, ok:true}', async () => {
    const respond = vi.fn(async () => ({ ok: true }));
    const renderMessageBlocks = vi.fn(async () => []);
    const renderEphemeralBlocks = vi.fn(async () => makeBlocks());
    const result = await renderInPlace({
      body: { container: { type: 'ephemeral' } },
      client: makeClient(),
      respond,
      text: 'cct',
      renderMessageBlocks,
      renderEphemeralBlocks,
    });
    expect(result).toEqual({ surface: 'ephemeral', ok: true });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        response_type: 'ephemeral',
        replace_original: true,
        text: 'cct',
        blocks: expect.any(Array),
      }),
    );
    expect(renderMessageBlocks).not.toHaveBeenCalled();
  });

  it('returns {ephemeral, ok:false} when respond is missing', async () => {
    const result = await renderInPlace({
      body: { container: { type: 'ephemeral' } },
      client: makeClient(),
      // respond intentionally omitted
      text: 'cct',
      renderMessageBlocks: async () => [],
      renderEphemeralBlocks: async () => makeBlocks(),
    });
    expect(result).toEqual({ surface: 'ephemeral', ok: false });
  });

  it('returns {ephemeral, ok:false} when respond throws', async () => {
    const respond = vi.fn(async () => {
      throw new Error('expired_url');
    });
    const result = await renderInPlace({
      body: { container: { type: 'ephemeral' } },
      client: makeClient(),
      respond,
      text: 'cct',
      renderMessageBlocks: async () => [],
      renderEphemeralBlocks: async () => makeBlocks(),
    });
    expect(result).toEqual({ surface: 'ephemeral', ok: false });
  });
});

describe('renderInPlace — unknown surface', () => {
  it('refuses to stack a fresh card and returns {unknown, ok:false}', async () => {
    const respond = vi.fn(async () => ({ ok: true }));
    const client = makeClient();
    const result = await renderInPlace({
      body: {}, // no container
      client,
      respond,
      text: 'cct',
      renderMessageBlocks: async () => makeBlocks(),
      renderEphemeralBlocks: async () => makeBlocks(),
    });
    expect(result).toEqual({ surface: 'unknown', ok: false });
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it('returns {unknown, ok:false} when container.type=message but channel/ts missing', async () => {
    const respond = vi.fn(async () => ({ ok: true }));
    const client = makeClient();
    const result = await renderInPlace({
      body: { container: { type: 'message' } },
      client,
      respond,
      text: 'cct',
      renderMessageBlocks: async () => makeBlocks(),
      renderEphemeralBlocks: async () => makeBlocks(),
    });
    expect(result).toEqual({ surface: 'unknown', ok: false });
  });
});
