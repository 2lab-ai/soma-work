import { describe, expect, it, vi } from 'vitest';
import type { ReleaseNotesPayload } from '../directives/release-notes-directive';
import { postReleaseNotes, type ReleaseNotesRouting, SESSION_ROUTING, splitLossless } from '../release-notes-poster';

const SESSION_CHANNEL = 'C0INFRA0001';
const SESSION_THREAD = '1792656911.728569';
const DEV2 = 'C0DEV2CHAN1';
const ROOT_TS = '1792660000.000100';

const PAYLOAD: ReleaseNotesPayload = {
  repo: 'acme/App',
  target: 'deploy/dev2',
  version: '0.2.58 (c8a026e)',
  tldr: ['Payout rounding fixed', 'Settings screen added', 'Admin login is faster'],
  text: '# Release Notes (English)\n\n# App deploy/dev2 c8a026e — 2026-10-22\n\n## Highlights\n\n- one\n- two',
};

function fakeSlack(rootChannel = DEV2) {
  return {
    postMessage: vi.fn(async (channel: string, _text: string, options?: { threadTs?: string }) => ({
      ts: options?.threadTs ? `${Date.now()}.reply` : ROOT_TS,
      channel: channel.startsWith('#') ? rootChannel : channel,
    })),
    getPermalink: vi.fn(async (channel: string, ts: string) => `https://slack.test/archives/${channel}/p${ts}`),
  };
}

const routed = (channel: string): ReleaseNotesRouting => ({
  ...SESSION_ROUTING,
  destination: { kind: 'channel', channel },
});

type Call = [string, string, { threadTs?: string; blocks?: any[] } | undefined];
const calls = (slack: ReturnType<typeof fakeSlack>) => slack.postMessage.mock.calls as unknown as Call[];

describe('postReleaseNotes — header in the channel, full notes in its thread', () => {
  it('posts version + TL;DR as the root and the full notes as a reply under it', async () => {
    const slack = fakeSlack();
    await postReleaseNotes(slack, {
      payload: PAYLOAD,
      sessionChannel: SESSION_CHANNEL,
      sessionThreadTs: SESSION_THREAD,
      routing: routed(DEV2),
    });

    const [root, body] = calls(slack);
    // Root: in #dev2, no thread, header block carries repo/target/version, section carries the 3 lines.
    expect(root[0]).toBe(DEV2);
    expect(root[2]?.threadTs).toBeUndefined();
    const [header, section] = root[2]!.blocks!;
    expect(header).toMatchObject({ type: 'header', text: { type: 'plain_text' } });
    expect(header.text.text).toContain('App');
    expect(header.text.text).toContain('deploy/dev2');
    expect(header.text.text).toContain('0.2.58 (c8a026e)');
    expect(section.text.text.split('\n')).toEqual([
      '• Payout rounding fixed',
      '• Settings screen added',
      '• Admin login is faster',
    ]);
    expect(root[1]).toContain('0.2.58 (c8a026e)');

    // Body: threaded under the root, verbatim.
    expect(body[0]).toBe(DEV2);
    expect(body[2]?.threadTs).toBe(ROOT_TS);
    expect(body[2]?.blocks).toEqual([{ type: 'markdown', text: PAYLOAD.text }]);
    expect(body[1]).toBe(PAYLOAD.text);
  });

  it('links the routed post from the deploy thread', async () => {
    const slack = fakeSlack();
    await postReleaseNotes(slack, {
      payload: PAYLOAD,
      sessionChannel: SESSION_CHANNEL,
      sessionThreadTs: SESSION_THREAD,
      routing: routed(DEV2),
    });

    const link = calls(slack).at(-1)!;
    expect(link[0]).toBe(SESSION_CHANNEL);
    expect(link[2]).toEqual({ threadTs: SESSION_THREAD });
    expect(link[1]).toContain(`<#${DEV2}>`);
    expect(link[1]).toContain(`https://slack.test/archives/${DEV2}/p${ROOT_TS}`);
    expect(calls(slack)).toHaveLength(3);
  });

  it('posts in the session channel without a link line when no mapping is configured', async () => {
    const slack = fakeSlack();
    await postReleaseNotes(slack, {
      payload: PAYLOAD,
      sessionChannel: SESSION_CHANNEL,
      sessionThreadTs: SESSION_THREAD,
      routing: SESSION_ROUTING,
    });

    expect(calls(slack).map(([channel, , options]) => [channel, options?.threadTs])).toEqual([
      [SESSION_CHANNEL, undefined],
      [SESSION_CHANNEL, ROOT_TS],
    ]);
  });

  it('says so in the deploy thread when mappings exist but none matches, then posts in the session channel', async () => {
    const slack = fakeSlack();
    await postReleaseNotes(slack, {
      payload: PAYLOAD,
      sessionChannel: SESSION_CHANNEL,
      sessionThreadTs: SESSION_THREAD,
      routing: {
        destination: { kind: 'session' },
        unmapped: true,
        keys: ['deploy/stage'],
        nearMisses: [],
        invalid: [],
      },
    });

    const [notice, root] = calls(slack);
    expect(notice[0]).toBe(SESSION_CHANNEL);
    expect(notice[2]).toEqual({ threadTs: SESSION_THREAD });
    expect(notice[1]).toContain('acme/App@deploy/dev2');
    expect(notice[1]).toContain('SOMA_RELEASE_NOTES_CHANNELS');
    expect(notice[1]).toContain('deploy/stage');
    expect(root[0]).toBe(SESSION_CHANNEL);
    expect(root[2]?.threadTs).toBeUndefined();
  });

  it('an unmatched deploy without `*` posts no channel root anywhere; a near-miss turns the notice into a warning', async () => {
    const slack = fakeSlack();
    await postReleaseNotes(slack, {
      payload: { ...PAYLOAD, target: 'dev2' },
      sessionChannel: SESSION_CHANNEL,
      sessionThreadTs: SESSION_THREAD,
      routing: {
        destination: { kind: 'deploy-thread' },
        unmapped: true,
        keys: ['acme/app@deploy/dev2'],
        nearMisses: [{ key: 'acme/app@deploy/dev2', channel: DEV2 }],
        invalid: [],
      },
    });

    const posted = calls(slack);
    for (const [channel, , options] of posted) {
      expect(channel).toBe(SESSION_CHANNEL);
      expect(options?.threadTs).toBe(SESSION_THREAD);
    }
    expect(posted[0][1]).toContain('⚠️');
    expect(posted[0][1]).toContain('acme/App@dev2');
    expect(posted[0][1]).toContain('acme/app@deploy/dev2');
    expect(posted[0][1]).toContain(`<#${DEV2}>`);
    expect(posted.some(([, , options]) => options?.blocks?.[0]?.type === 'header')).toBe(true);
    expect(posted.some(([, text]) => text === PAYLOAD.text)).toBe(true);
  });

  it('never re-posts to another channel root when the routed channel refuses: it reports and keeps the notes in the deploy thread', async () => {
    const slack = fakeSlack();
    slack.postMessage.mockImplementationOnce(async () => {
      throw Object.assign(new Error('An API error occurred: not_in_channel'), { data: { error: 'not_in_channel' } });
    });
    await postReleaseNotes(slack, {
      payload: PAYLOAD,
      sessionChannel: SESSION_CHANNEL,
      sessionThreadTs: SESSION_THREAD,
      routing: routed(DEV2),
    });

    const after = calls(slack).slice(1);
    // Everything after the refused root lands in the deploy thread — no channel-root post anywhere.
    for (const [channel, , options] of after) {
      expect(channel).toBe(SESSION_CHANNEL);
      expect(options?.threadTs).toBe(SESSION_THREAD);
    }
    expect(after[0][1]).toContain('⚠️');
    expect(after[0][1]).toContain('not_in_channel');
    expect(after[0][1]).toContain('SOMA_RELEASE_NOTES_CHANNELS');
    expect(after.some(([, , options]) => options?.blocks?.[0]?.type === 'header')).toBe(true);
    expect(after.some(([, text]) => text === PAYLOAD.text)).toBe(true);
  });

  it('retries a failed thread body once', async () => {
    const slack = fakeSlack();
    slack.postMessage
      .mockImplementationOnce(async () => ({ ts: ROOT_TS, channel: DEV2 }))
      .mockImplementationOnce(async () => {
        throw new Error('ratelimited');
      });
    await postReleaseNotes(slack, {
      payload: PAYLOAD,
      sessionChannel: SESSION_CHANNEL,
      sessionThreadTs: SESSION_THREAD,
      routing: routed(DEV2),
    });

    const posted = calls(slack);
    // root, failed body, retried body, link line
    expect(posted.map(([channel, , options]) => [channel, options?.threadTs])).toEqual([
      [DEV2, undefined],
      [DEV2, ROOT_TS],
      [DEV2, ROOT_TS],
      [SESSION_CHANNEL, SESSION_THREAD],
    ]);
    expect(posted[3][1]).not.toContain('⚠️');
  });

  it('when the thread body still fails: no second header, warning + root link + the full notes in the deploy thread', async () => {
    const slack = fakeSlack();
    slack.postMessage
      .mockImplementationOnce(async () => ({ ts: ROOT_TS, channel: DEV2 }))
      .mockImplementationOnce(async () => {
        throw new Error('ratelimited');
      })
      .mockImplementationOnce(async () => {
        throw new Error('ratelimited');
      });
    await postReleaseNotes(slack, {
      payload: PAYLOAD,
      sessionChannel: SESSION_CHANNEL,
      sessionThreadTs: SESSION_THREAD,
      routing: routed(DEV2),
    });

    const posted = calls(slack);
    expect(posted.filter(([, , options]) => options?.blocks?.[0]?.type === 'header')).toHaveLength(1);
    const recovery = posted.slice(3);
    for (const [channel, , options] of recovery) {
      expect(channel).toBe(SESSION_CHANNEL);
      expect(options?.threadTs).toBe(SESSION_THREAD);
    }
    expect(recovery[0][1]).toContain('⚠️');
    expect(recovery[0][1]).toContain(`https://slack.test/archives/${DEV2}/p${ROOT_TS}`);
    expect(recovery.some(([, text]) => text === PAYLOAD.text)).toBe(true);
  });

  it('a missing permalink never triggers a re-post — the link line just names the channel', async () => {
    const slack = fakeSlack();
    slack.getPermalink.mockResolvedValue(null as unknown as string);
    await postReleaseNotes(slack, {
      payload: PAYLOAD,
      sessionChannel: SESSION_CHANNEL,
      sessionThreadTs: SESSION_THREAD,
      routing: routed(DEV2),
    });

    expect(calls(slack)).toHaveLength(3);
    expect(calls(slack)[2][1]).toContain(`<#${DEV2}>`);
  });

  it('keeps the header inside Slack limits and escapes control sequences in TL;DR lines', async () => {
    const slack = fakeSlack();
    await postReleaseNotes(slack, {
      payload: { ...PAYLOAD, version: 'v'.repeat(200), tldr: ['<!channel> ping & <b>', 'x'.repeat(400)] },
      sessionChannel: SESSION_CHANNEL,
      sessionThreadTs: SESSION_THREAD,
      routing: SESSION_ROUTING,
    });

    const [header, section] = calls(slack)[0][2]!.blocks!;
    expect(header.text.text.length).toBeLessThanOrEqual(150);
    const [first, second] = section.text.text.split('\n');
    expect(first).toBe('• &lt;!channel&gt; ping &amp; &lt;b&gt;');
    expect(second.length).toBeLessThanOrEqual(202);
    expect(calls(slack)[0][1]).not.toContain('<!channel>');
  });

  it('splits long notes into several thread replies without losing a character', async () => {
    const slack = fakeSlack();
    const paragraph = `${'가나다라 '.repeat(800)}\n`;
    const text = `# Release Notes\n\n${paragraph.repeat(12)}\`\`\`\ncode block\n\`\`\`\n${'z'.repeat(25_000)}`;
    await postReleaseNotes(slack, {
      payload: { ...PAYLOAD, text },
      sessionChannel: SESSION_CHANNEL,
      sessionThreadTs: SESSION_THREAD,
      routing: SESSION_ROUTING,
    });

    const replies = calls(slack).filter(([, , options]) => options?.threadTs === ROOT_TS);
    expect(replies.length).toBeGreaterThan(1);
    expect(replies.map(([, chunk]) => chunk).join('')).toBe(text);
    for (const [, chunk, options] of replies) {
      expect(options?.blocks).toEqual([{ type: 'markdown', text: chunk }]);
    }
  });
});

describe('postReleaseNotes — notices', () => {
  it('a `*=session` fallback keeps the session channel root and still warns about the near-miss', async () => {
    const slack = fakeSlack();
    await postReleaseNotes(slack, {
      payload: { ...PAYLOAD, target: 'dev2' },
      sessionChannel: SESSION_CHANNEL,
      sessionThreadTs: SESSION_THREAD,
      routing: {
        destination: { kind: 'session' },
        unmapped: true,
        keys: ['acme/app@deploy/dev2'],
        nearMisses: [{ key: 'acme/app@deploy/dev2', channel: DEV2 }],
        invalid: [],
      },
    });

    const [warning, root] = calls(slack);
    expect(warning[2]).toEqual({ threadTs: SESSION_THREAD });
    expect(warning[1]).toContain('⚠️');
    expect(root[0]).toBe(SESSION_CHANNEL);
    expect(root[2]?.threadTs).toBeUndefined();
    expect(calls(slack).map(([channel]) => channel)).not.toContain(DEV2);
  });

  it('reports dropped config entries in the deploy thread and still posts with the rest', async () => {
    const slack = fakeSlack();
    await postReleaseNotes(slack, {
      payload: PAYLOAD,
      sessionChannel: SESSION_CHANNEL,
      sessionThreadTs: SESSION_THREAD,
      routing: { ...routed(DEV2), invalid: ['foo=session'] },
    });

    const [warning, root] = calls(slack);
    expect(warning[0]).toBe(SESSION_CHANNEL);
    expect(warning[2]).toEqual({ threadTs: SESSION_THREAD });
    expect(warning[1]).toContain('foo=session');
    expect(root[0]).toBe(DEV2);
  });
});

describe('splitLossless', () => {
  it('returns the text whole when it fits', () => {
    expect(splitLossless('abc', 10)).toEqual(['abc']);
  });

  it('cuts at line ends when it can, and hard-cuts a line longer than the limit', () => {
    const chunks = splitLossless(`aaaa\nbbbb\n${'c'.repeat(12)}`, 6);
    expect(chunks.join('')).toBe(`aaaa\nbbbb\n${'c'.repeat(12)}`);
    expect(chunks.every((chunk) => chunk.length <= 6)).toBe(true);
    expect(chunks.slice(0, 2)).toEqual(['aaaa\n', 'bbbb\n']);
  });
});
