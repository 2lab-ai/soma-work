/**
 * The voice service client (.prd/31-phone-calls-architecture.md §3): `warm()` wakes the speech engine with a
 * one-word synthesis whose audio is thrown away — the engine answers ~0.8 s slower after a few idle seconds.
 */
import { describe, expect, it } from 'vitest';
import { createVoiceClient } from '../voice-client';

describe('createVoiceClient().warm', () => {
  it('sends one tiny streaming synthesis in the call voice, reads it to the end, and never throws', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    let drained = false;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      const body = new ReadableStream({
        pull(ctrl) {
          drained = true;
          ctrl.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const client = createVoiceClient(
      { url: 'http://voice-host:9999/', voice: 'cwon-phone', model: 'drama-3', language: 'ko' },
      fetchImpl,
    );
    await client.warm?.();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://voice-host:9999/api/tts/stream');
    expect(calls[0].body).toMatchObject({ voice: 'cwon-phone', model: 'drama-3', format: 'pcm' });
    expect(String((calls[0].body as { text: string }).text).length).toBeLessThanOrEqual(2);
    expect(drained).toBe(true);
    const failing = createVoiceClient(
      { url: 'http://voice-host:9999', voice: 'v', model: 'drama-3', language: 'ko' },
      (async () => {
        throw new Error('down');
      }) as unknown as typeof fetch,
    );
    await expect(failing.warm?.()).resolves.toBeUndefined();
  });
});
