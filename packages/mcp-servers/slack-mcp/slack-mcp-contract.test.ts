import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The slack-mcp contract: the tools the model can call and what each one does, run through the real
 * SlackMcpServer's MCP handlers (ListTools / CallTool) against a stub Slack client.
 *
 * The server constructs itself and calls run() when its module loads. The MCP SDK transport is stubbed so the
 * handlers it registers can be called in-process; the published base class is swapped for its TypeScript source
 * (the build input of the dist copy the server imports), so the SDK stub reaches it.
 */

interface Tool {
  name: string;
  description: string;
  inputSchema: { properties: Record<string, unknown>; required?: string[] };
}
interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

const h = vi.hoisted(() => ({
  servers: [] as Array<{ handlers: Map<string, (request?: unknown) => Promise<unknown>> }>,
  // biome-ignore lint/suspicious/noExplicitAny: each test swaps in its own Slack stub.
  slack: {} as Record<string, (args: any) => Promise<unknown>>,
}));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    private readonly entry = { handlers: new Map<string, (request?: unknown) => Promise<unknown>>() };
    constructor() {
      h.servers.push(this.entry);
    }
    setRequestHandler(schema: string, handler: (request?: unknown) => Promise<unknown>) {
      this.entry.handlers.set(schema, handler);
    }
    async connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema',
}));
vi.mock('@soma/process-shared/mcp/base-mcp-server.js', () => import('../../process-shared/src/mcp/base-mcp-server'));
vi.mock('../../process-shared/src/stderr-logger', () => ({
  StderrLogger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));
// The real converter, except that it fails on a marker — the only way to reach the server's fallback for it.
vi.mock('markdown-to-slack-blocks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('markdown-to-slack-blocks')>();
  return {
    ...actual,
    markdownToBlocks: (markdown: string, ...rest: unknown[]) => {
      if (markdown.includes('BREAK_CONVERTER')) throw new Error('converter failed');
      return (actual.markdownToBlocks as (...args: unknown[]) => unknown)(markdown, ...rest);
    },
  };
});
vi.mock('@slack/web-api', () => ({
  WebClient: class {
    chat = {
      postMessage: (args: unknown) => h.slack.postMessage(args),
      getPermalink: (args: unknown) => h.slack.getPermalink(args),
    };
    conversations = { replies: (args: unknown) => h.slack.replies(args) };
    filesUploadV2 = (args: unknown) => h.slack.filesUploadV2(args);
  },
}));

const TOKEN = 'xoxb-contract-test';
const WORK = { channel: 'C_WORK', threadTs: '1700000000.000000', mentionTs: '1700000003.000000' };
const MOVED = { ...WORK, sourceChannel: 'C_SRC', sourceThreadTs: '1690000000.000000' };

async function startServer(context: object) {
  vi.stubEnv('SLACK_BOT_TOKEN', TOKEN);
  vi.stubEnv('SLACK_MCP_CONTEXT', JSON.stringify(context));
  vi.resetModules();
  await import('./slack-mcp-server');
  const { handlers } = h.servers[h.servers.length - 1];
  const handler = (schema: string) => {
    const registered = handlers.get(schema);
    if (!registered) throw new Error(`${schema} was not registered`);
    return registered;
  };
  return {
    async tools(): Promise<Tool[]> {
      return ((await handler('ListToolsRequestSchema')()) as { tools: Tool[] }).tools;
    },
    call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      return handler('CallToolRequestSchema')({ params: { name, arguments: args } }) as Promise<ToolResult>;
    },
  };
}

const body = (r: ToolResult) => JSON.parse(r.content[0].text);

interface Msg {
  ts: string;
  text: string;
  user: string;
  reply_count?: number;
}

/** A thread whose root is at `rootSec`: the root plus `replies` replies, one second apart. */
function makeThread(rootSec: number, replies: number): Msg[] {
  return [
    { ts: `${rootSec}.000000`, text: 'Root', user: 'U1', reply_count: replies },
    ...Array.from({ length: replies }, (_, i) => ({
      ts: `${rootSec + 1 + i}.000000`,
      text: `Reply ${i + 1}`,
      user: 'U2',
    })),
  ];
}

/** conversations.replies over fixed threads, paged by a numeric cursor; `oldest` keeps later messages only. */
function serveThreads(threads: Record<string, Msg[]>) {
  return vi.fn(async (args: { channel: string; ts: string; limit?: number; cursor?: string; oldest?: string }) => {
    const all = threads[`${args.channel}:${args.ts}`] ?? [];
    const msgs = args.oldest ? all.filter((m) => m.ts > (args.oldest as string)) : all;
    const start = args.cursor ? Number(args.cursor) : 0;
    const end = start + (args.limit || 200);
    return {
      messages: msgs.slice(start, end),
      response_metadata: end < msgs.length ? { next_cursor: String(end) } : {},
    };
  });
}

let server: Awaited<ReturnType<typeof startServer>>;
let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join('/tmp', 'slack-mcp-contract-'));
  server = await startServer(MOVED);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  h.slack.postMessage = vi.fn(async () => ({ ts: '1700000009.000100' }));
  h.slack.getPermalink = vi.fn(async () => ({ permalink: 'https://x.slack.com/archives/C_WORK/p1700000009000100' }));
  h.slack.replies = serveThreads({});
  h.slack.filesUploadV2 = vi.fn(async () => ({ files: [{ files: [{ id: 'F1', permalink: 'https://x/F1' }] }] }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('starting up', () => {
  it('will not start without its thread: SLACK_MCP_CONTEXT is required and must name a channel and threadTs', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', TOKEN);
    vi.stubEnv('SLACK_MCP_CONTEXT', '');
    vi.resetModules();
    await expect(import('./slack-mcp-server')).rejects.toThrow('SLACK_MCP_CONTEXT environment variable is required');

    vi.stubEnv('SLACK_MCP_CONTEXT', JSON.stringify({ channel: 'C1' }));
    vi.resetModules();
    await expect(import('./slack-mcp-server')).rejects.toThrow('SLACK_MCP_CONTEXT must contain channel and threadTs');

    // The name it had before the slack-thread → slack-mcp rename is not read: a context given only there is no context.
    vi.stubEnv('SLACK_MCP_CONTEXT', '');
    vi.stubEnv('SLACK_THREAD_CONTEXT', JSON.stringify(WORK));
    vi.resetModules();
    await expect(import('./slack-mcp-server')).rejects.toThrow('SLACK_MCP_CONTEXT environment variable is required');
  });
});

describe('the tools offered', () => {
  it('lists every tool with the parameters it requires and takes', async () => {
    const tools = new Map((await server.tools()).map((t) => [t.name, t.inputSchema]));
    expect([...tools.keys()]).toEqual([
      'get_thread_messages',
      'download_thread_file',
      'send_thread_message',
      'send_file',
      'send_media',
      'send_link',
    ]);
    expect(tools.get('download_thread_file')?.required).toEqual(['file_url', 'file_name']);
    expect(tools.get('send_thread_message')?.required).toEqual(['text']);
    expect(tools.get('send_file')?.required).toEqual(['file_path']);
    expect(tools.get('send_media')?.required).toEqual(['file_path']);
    expect(tools.get('send_link')?.required).toEqual(['url']);

    const props = (name: string) => Object.keys(tools.get(name)?.properties ?? {});
    expect(props('get_thread_messages')).toEqual(
      expect.arrayContaining(['thread', 'offset', 'limit', 'anchor_ts', 'before', 'after']),
    );
    expect(props('send_thread_message')).toContain('thread');
    expect(props('send_file')).toEqual(expect.arrayContaining(['filename', 'url', 'thread', 'artifact_key']));
    expect(props('send_media')).toEqual(expect.arrayContaining(['alt_text', 'thread', 'artifact_key']));
  });

  it('tells the model how to page a thread and when a link goes with send_link instead of send_file', async () => {
    const description = new Map((await server.tools()).map((t) => [t.name, t.description]));
    const read = description.get('get_thread_messages') ?? '';
    expect(read).toContain('offset');
    expect(read).toContain('limit');
    expect(read).toContain(`Work thread: channel=${WORK.channel}, thread_ts=${WORK.threadTs}`);

    const link = description.get('send_link') ?? '';
    expect(link).toMatch(/serve/);
    expect(link).toMatch(/artifact/i);
    expect(link).toContain('send_file with url');
  });

  it('answers an unknown tool with an error result', async () => {
    const r = await server.call('nope');
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe('Unknown tool: nope');
  });
});

describe('get_thread_messages — array mode (offset/limit)', () => {
  it.each([
    [
      'no arguments: the first 10, root first',
      20,
      {},
      { total_count: 21, offset: 0, returned: 10, has_more: true },
      '1700000000.000000',
    ],
    [
      'offset 0, limit 1: the root only',
      5,
      { offset: 0, limit: 1 },
      { total_count: 6, returned: 1, has_more: true },
      '1700000000.000000',
    ],
    ['offset 1 skips the root', 5, { offset: 1, limit: 5 }, { returned: 5, has_more: false }, '1700000001.000000'],
    ['the last page has no more', 3, { offset: 2, limit: 10 }, { returned: 2, has_more: false }, '1700000002.000000'],
    [
      'an offset past the end is clamped to the last message',
      3,
      { offset: 100, limit: 5 },
      { offset: 3, returned: 1 },
      '1700000003.000000',
    ],
    ['a negative offset is clamped to 0', 3, { offset: -5, limit: 2 }, { offset: 0, returned: 2 }, '1700000000.000000'],
    ['limit 0 is clamped to 1', 3, { offset: 0, limit: 0 }, { returned: 1 }, '1700000000.000000'],
    ['limit over 50 is clamped to 50', 100, { offset: 0, limit: 999 }, { returned: 50 }, '1700000000.000000'],
    [
      'a thread with no replies',
      0,
      { offset: 0, limit: 10 },
      { total_count: 1, returned: 1, has_more: false },
      '1700000000.000000',
    ],
  ])('%s', async (_title, replies, args, expected, firstTs) => {
    h.slack.replies = serveThreads({ [`C_WORK:${WORK.threadTs}`]: makeThread(1700000000, replies) });
    const out = body(await server.call('get_thread_messages', args));
    expect(out).toMatchObject({ thread_ts: WORK.threadTs, channel: 'C_WORK', ...expected });
    expect(out.messages).toHaveLength(out.returned);
    expect(out.messages[0].ts).toBe(firstTs);
  });

  it('a thread Slack cannot count comes back empty, not as an error', async () => {
    h.slack.replies = vi.fn(async () => {
      throw new Error('Slack down');
    });
    const r = await server.call('get_thread_messages', { offset: 0, limit: 10 });
    expect(r.isError).toBeUndefined();
    expect(body(r)).toMatchObject({ total_count: 0, returned: 0, has_more: false, messages: [] });
  });
});

describe('get_thread_messages — legacy mode (anchor_ts / before / after)', () => {
  beforeEach(() => {
    h.slack.replies = serveThreads({ [`C_WORK:${WORK.threadTs}`]: makeThread(1700000000, 10) });
  });

  it('before: the messages up to the mention, with the root kept in front', async () => {
    const out = body(await server.call('get_thread_messages', { before: 2 }));
    expect(out.messages.map((m: { ts: string }) => m.ts)).toEqual([
      '1700000000.000000',
      '1700000002.000000',
      '1700000003.000000',
    ]);
    // The injected root is not counted as one of the 2: the window is full, so there may be more before it.
    expect(out.has_more).toBe(true);
    expect(out.total_count).toBe(11);
  });

  it('before beyond what exists: everything up to the mention, nothing more', async () => {
    const out = body(await server.call('get_thread_messages', { before: 50 }));
    expect(out.returned).toBe(4);
    expect(out.has_more).toBe(false);
  });

  it('anchor_ts moves the window; after reads past it', async () => {
    const anchored = body(await server.call('get_thread_messages', { anchor_ts: '1700000005.000000' }));
    expect(anchored.messages.at(-1).ts).toBe('1700000005.000000');
    expect(anchored.returned).toBe(6);

    const after = body(await server.call('get_thread_messages', { before: 0, after: 2 }));
    expect(after.messages.map((m: { ts: string }) => m.ts)).toEqual(['1700000004.000000', '1700000005.000000']);
    expect(after.has_more).toBe(true);
  });

  // Offset/limit alone would return the first 10 (the last one 1700000009); each legacy argument on its own reads
  // around the mention instead (before defaults to 10, after to 0).
  it.each([
    ['anchor_ts', { anchor_ts: WORK.mentionTs }, WORK.mentionTs, 4],
    ['before', { before: 2 }, WORK.mentionTs, 3],
    ['after', { after: 2 }, '1700000005.000000', 6],
  ])('any legacy argument wins over offset/limit: %s', async (_name, legacy, lastTs, returned) => {
    const out = body(await server.call('get_thread_messages', { offset: 0, limit: 10, ...legacy }));
    expect(out.messages.at(-1).ts).toBe(lastTs);
    expect(out.returned).toBe(returned);
  });
});

describe('thread selection — work (default) or source', () => {
  it('reads and posts in the work thread by default, and in the source thread when asked', async () => {
    h.slack.replies = serveThreads({
      [`C_WORK:${WORK.threadTs}`]: makeThread(1700000000, 1),
      [`C_SRC:${MOVED.sourceThreadTs}`]: makeThread(1690000000, 2),
    });
    expect(body(await server.call('get_thread_messages'))).toMatchObject({ channel: 'C_WORK', total_count: 2 });
    expect(body(await server.call('get_thread_messages', { thread: 'source' }))).toMatchObject({
      channel: 'C_SRC',
      thread_ts: MOVED.sourceThreadTs,
      total_count: 3,
    });

    await server.call('send_thread_message', { text: 'hi', thread: 'source' });
    expect(h.slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C_SRC', thread_ts: MOVED.sourceThreadTs }),
    );
  });

  it('refuses a selector other than work or source', async () => {
    const r = await server.call('get_thread_messages', { thread: 'elsewhere' });
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe('Invalid thread selector: "elsewhere". Must be "work" or "source".');
  });

  it('a session that was not moved has no source thread to read', async () => {
    const unmoved = await startServer(WORK);
    const r = await unmoved.call('get_thread_messages', { thread: 'source' });
    expect(r.isError).toBe(true);
    expect(body(r).error).toMatch(/^No source thread available/);
  });
});

describe('send_thread_message', () => {
  const sent = (n = 0) => (h.slack.postMessage as ReturnType<typeof vi.fn>).mock.calls[n][0];

  it('posts markdown into the work thread as blocks, with a Slack mrkdwn fallback text', async () => {
    const out = body(
      await server.call('send_thread_message', {
        text: '**Done** — see [the PR](https://github.com/o/r/pull/1)\n\n- one\n- two',
      }),
    );
    expect(sent()).toMatchObject({
      channel: 'C_WORK',
      thread_ts: WORK.threadTs,
      text: '*Done* — see <https://github.com/o/r/pull/1|the PR>\n\n- one\n- two',
    });
    // The list is what tells the converter's blocks from the plain mrkdwn section the fallback would send;
    // the exact block shape belongs to the markdown-to-slack-blocks library, not to this server.
    expect(sent().blocks).toContainEqual(expect.objectContaining({ type: 'rich_text' }));
    expect(out).toEqual({ sent: true, channel: 'C_WORK', thread_ts: WORK.threadTs, message_ts: '1700000009.000100' });
  });

  it('heading, table and paragraph keep their order; a table is a native block, cut to 100 rows; a heading to 150 characters', async () => {
    const rows = Array.from({ length: 109 }, (_, i) => `| ${i} | v |`);
    const text = [`# ${'A'.repeat(200)}`, '', '| A | B |', '|---|---|', ...rows, '', 'Done.'].join('\n');
    await server.call('send_thread_message', { text });
    const blocks = sent().blocks as Array<{ type: string; rows?: unknown[]; text?: { text: string } }>;
    expect(blocks.find((b) => b.type === 'header')?.text?.text).toBe(`${'A'.repeat(147)}...`);
    expect(blocks.find((b) => b.type === 'table')?.rows).toHaveLength(100);
    expect(blocks.map((b) => b.type).slice(0, 2)).toEqual(['header', 'table']);
    expect(JSON.stringify(blocks.slice(2))).toContain('Done.');
  });

  it('a second table goes out as its own "(continued)" message in the same thread', async () => {
    h.slack.postMessage = vi
      .fn()
      .mockResolvedValueOnce({ ts: '1700000009.000100' })
      .mockResolvedValueOnce({ ts: '1700000009.000200' });
    const text = '| A | B |\n|---|---|\n| 1 | 2 |\n\nText\n\n| C | D |\n|---|---|\n| 3 | 4 |';
    const out = body(await server.call('send_thread_message', { text }));
    expect(h.slack.postMessage).toHaveBeenCalledTimes(2);
    const tables = (n: number) => sent(n).blocks.filter((b: { type: string }) => b.type === 'table');
    expect(tables(0)).toHaveLength(1);
    expect(sent(1)).toMatchObject({ channel: 'C_WORK', thread_ts: WORK.threadTs, text: '(continued)' });
    expect(tables(1)).toHaveLength(1);
    expect(out.overflow_ts).toEqual(['1700000009.000200']);
  });

  it('text the converter makes no blocks of still goes out as a mrkdwn section', async () => {
    await server.call('send_thread_message', { text: '   ' });
    expect(sent().blocks).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: '   ' } }]);
  });

  it.each([
    'invalid_blocks',
    'invalid_attachments',
    'too_many_blocks',
    'invalid_blocks_format',
  ])('blocks Slack refuses (%s) are sent once more as plain mrkdwn sections', async (code) => {
    h.slack.postMessage = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error(code), { data: { error: code } }))
      .mockResolvedValueOnce({ ts: '1700000009.000300' });
    const out = body(await server.call('send_thread_message', { text: '# Title\n\n**bold**' }));
    expect(h.slack.postMessage).toHaveBeenCalledTimes(2);
    expect(sent(0).blocks[0].type).toBe('header');
    expect(sent(1)).toEqual({
      channel: 'C_WORK',
      thread_ts: WORK.threadTs,
      text: '*Title*\n\n*bold*',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Title*\n\n*bold*' } }],
    });
    expect(out.message_ts).toBe('1700000009.000300');
  });

  it('a converter that fails still sends the message, as mrkdwn sections', async () => {
    // Converted, a heading is a header block; the fallback makes it a bold mrkdwn line.
    await server.call('send_thread_message', { text: '# Title BREAK_CONVERTER' });
    expect(h.slack.postMessage).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual({
      channel: 'C_WORK',
      thread_ts: WORK.threadTs,
      text: '*Title BREAK_CONVERTER*',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Title BREAK_CONVERTER*' } }],
    });
  });

  it('refuses an empty text', async () => {
    const r = await server.call('send_thread_message', { text: '' });
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe('text is required');
    expect(h.slack.postMessage).not.toHaveBeenCalled();
  });
});

describe('a failed Slack call comes back as a classified error', () => {
  const failWith = (err: unknown) => {
    h.slack.postMessage = vi.fn().mockRejectedValue(err);
    return server.call('send_thread_message', { text: 'x' });
  };

  it('a rate limit is retryable and names its Slack error code', async () => {
    const r = await failWith(
      Object.assign(new Error('An API error occurred: ratelimited'), { data: { error: 'ratelimited' } }),
    );
    expect(r.isError).toBe(true);
    expect(body(r)).toEqual({
      error: 'An API error occurred: ratelimited',
      slack_error: 'ratelimited',
      retryable: true,
    });
    expect(body(await failWith(Object.assign(new Error('Too Many Requests'), { status: 429 })))).toEqual({
      error: 'Too Many Requests',
      retryable: true,
    });
  });

  it('an auth failure carries a hint about the token; an ordinary failure is not retryable', async () => {
    expect(body(await failWith(Object.assign(new Error('invalid auth'), { data: { error: 'invalid_auth' } })))).toEqual(
      {
        error: 'invalid auth',
        slack_error: 'invalid_auth',
        retryable: false,
        hint: 'Bot token may be invalid or expired',
      },
    );
    expect(
      body(await failWith(Object.assign(new Error('channel_not_found'), { data: { error: 'channel_not_found' } }))),
    ).toEqual({ error: 'channel_not_found', slack_error: 'channel_not_found', retryable: false });
  });
});

describe('download_thread_file', () => {
  const fetchOk = (bytes = 'hello') => {
    const fetch = vi.fn(async () => new Response(bytes));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('never sends the bot token anywhere but Slack’s file hosts over https', async () => {
    const fetch = fetchOk();
    for (const [url, error] of [
      ['https://evil.com/exfiltrate', /untrusted host: evil\.com/],
      ['https://files.slack.com.evil.com/x', /untrusted host: files\.slack\.com\.evil\.com/],
      ['https://slack.com/x', /untrusted host: slack\.com/],
      ['http://files.slack.com/x', /insecure protocol: http:/],
      ['not-a-url', /Invalid file URL/],
    ] as const) {
      const r = await server.call('download_thread_file', { file_url: url, file_name: 'a.txt' });
      expect(r.isError, url).toBe(true);
      expect(body(r).error, url).toMatch(error);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('downloads from each Slack file host with the bot token and keeps only a safe base name', async () => {
    const fetch = fetchOk('hello');
    for (const host of ['files.slack.com', 'files-pri.slack.com', 'files-tmb.slack.com']) {
      const url = `https://${host}/files-pri/T1-F1/x`;
      const out = body(
        await server.call('download_thread_file', { file_url: url, file_name: '../../etc/pass wd<1>.txt' }),
      );
      expect(fetch).toHaveBeenLastCalledWith(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(path.dirname(out.path)).toBe(path.join(os.tmpdir(), 'slack-mcp-files'));
      expect(path.basename(out.path)).toMatch(/^\d+_pass_wd_1_\.txt$/);
      expect(await fs.readFile(out.path, 'utf-8')).toBe('hello');
      expect(out).toMatchObject({ name: '../../etc/pass wd<1>.txt', size: 5 });
      await fs.rm(out.path, { force: true });
    }
  });

  it('refuses audio and video by name before any download; an image downloads', async () => {
    const fetch = fetchOk('png');
    for (const name of ['call.mp3', 'demo.mov']) {
      const out = body(
        await server.call('download_thread_file', { file_url: 'https://files.slack.com/x', file_name: name }),
      );
      expect(out).toMatchObject({ blocked: true, name });
    }
    expect(fetch).not.toHaveBeenCalled();

    const image = body(
      await server.call('download_thread_file', { file_url: 'https://files.slack.com/x', file_name: 'shot.png' }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    await fs.rm(image.path, { force: true });
  });
});

describe('send_file / send_media', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const upload = () => (h.slack.filesUploadV2 as ReturnType<typeof vi.fn>).mock.calls[0][0];
  async function file(name: string, content: string): Promise<string> {
    const p = path.join(dir, name);
    await fs.writeFile(p, content);
    return p;
  }

  it('send_file uploads into the work thread under the file’s base name and reports what Slack made', async () => {
    const p = await file('notes.txt', 'abc');
    const out = body(await server.call('send_file', { file_path: p, title: 'Notes' }));
    expect(upload()).toEqual({
      file: p,
      filename: 'notes.txt',
      channel_id: 'C_WORK',
      thread_ts: WORK.threadTs,
      title: 'Notes',
    });
    expect(out).toEqual({
      uploaded: true,
      file_id: 'F1',
      filename: 'notes.txt',
      size: 3,
      permalink: 'https://x/F1',
      channel: 'C_WORK',
      thread_ts: WORK.threadTs,
    });
  });

  it('send_file refuses a path outside /tmp and a bad url before anything is uploaded; a good url is echoed', async () => {
    const outside = await server.call('send_file', { file_path: '/etc/hosts' });
    expect(body(outside).error).toMatch(/^Upload restricted to \/tmp directory/);
    const p = await file('page.html', '<p>');
    const badUrl = await server.call('send_file', { file_path: p, url: 'javascript:alert(1)' });
    expect(badUrl.isError).toBe(true);
    expect(body(badUrl).error).toMatch(/http\(s\)/);
    expect(h.slack.filesUploadV2).not.toHaveBeenCalled();

    const served = body(await server.call('send_file', { file_path: p, url: 'http://192.168.0.10:8763/page.html' }));
    expect(served.url).toBe('http://192.168.0.10:8763/page.html');
  });

  it('an upload Slack answers without file metadata is an error, not a success', async () => {
    h.slack.filesUploadV2 = vi.fn(async () => ({ ok: true }));
    const doc = await server.call('send_file', { file_path: await file('a.txt', 'a') });
    expect(doc.isError).toBe(true);
    expect(body(doc).error).toBe('File upload succeeded but Slack returned no file metadata. Response keys: ok');
    const media = await server.call('send_media', { file_path: await file('a.png', 'a') });
    expect(media.isError).toBe(true);
    expect(body(media).error).toBe('Media upload succeeded but Slack returned no file metadata. Response keys: ok');

    // A file object without an id is no upload either: there is no file to name in the reply.
    h.slack.filesUploadV2 = vi.fn(async () => ({ ok: true, files: [{ files: [{ name: 'b' }] }] }));
    const docNoId = await server.call('send_file', { file_path: await file('b.txt', 'b') });
    expect(docNoId.isError).toBe(true);
    expect(body(docNoId).error).toBe(
      'File upload succeeded but Slack returned no file metadata. Response keys: ok, files',
    );
    const mediaNoId = await server.call('send_media', { file_path: await file('b.png', 'b') });
    expect(mediaNoId.isError).toBe(true);
    expect(body(mediaNoId).error).toBe(
      'Media upload succeeded but Slack returned no file metadata. Response keys: ok, files',
    );
  });

  it('send_media refuses a file that is not an image, audio or video', async () => {
    const r = await server.call('send_media', { file_path: await file('report.txt', 'x') });
    expect(body(r).error).toMatch(/^Unsupported media type: \.txt\./);
    expect(h.slack.filesUploadV2).not.toHaveBeenCalled();
  });

  describe('the version an upload is (#1074)', () => {
    beforeAll(async () => {
      const index = path.join(dir, 'index.json');
      await fs.writeFile(
        index,
        JSON.stringify({
          version: 1,
          artifacts: [{ id: 'A', name: 'report.html', key: 'name:report.html', version: 1, sha256: sha('one') }],
        }),
      );
      vi.stubEnv('SOMA_ARTIFACT_INDEX', index);
      vi.stubEnv('SOMA_DISPLAY_LANG', 'ko');
    });
    // The index is read on every upload: unstub it so it stays out of tests that run after this block (shuffled
    // order). The server read SLACK_* once, when it started.
    afterAll(() => {
      vi.unstubAllEnvs();
    });

    it('send_file: a changed report under a known name is version 2, and the note leads the comment', async () => {
      const out = body(
        await server.call('send_file', { file_path: await file('report.html', 'two'), initial_comment: 'live' }),
      );
      expect(upload().initial_comment).toBe('판 2 · 이전 판 이후 바뀜\nlive');
      expect(out).toMatchObject({
        version_key: 'name:report.html',
        version: 2,
        changed: true,
        previous_version: 1,
        sha256: sha('two'),
      });
    });

    it('send_media: the model’s artifact_key names the artifact; its first upload is version 1 with its alt text and media type', async () => {
      const out = body(
        await server.call('send_media', {
          file_path: await file('chart.png', 'png'),
          alt_text: 'weekly chart',
          artifact_key: 'weekly-chart',
        }),
      );
      expect(upload()).toMatchObject({ filename: 'chart.png', alt_text: 'weekly chart' });
      expect(out).toMatchObject({ media_type: 'image', version_key: 'key:weekly-chart', version: 1, changed: null });
    });

    it('two uploads of one report at once are versions 1 and 2: the second plans after the first is sent', async () => {
      let n = 0;
      let firstEntered: () => void = () => {};
      const firstInFlight = new Promise<void>((resolve) => {
        firstEntered = resolve;
      });
      h.slack.filesUploadV2 = vi.fn(async () => {
        const id = `F_DIGEST_${++n}`;
        if (n === 1) firstEntered();
        await new Promise((resolve) => setTimeout(resolve, 20)); // the first upload is still in flight
        return { files: [{ files: [{ id, permalink: `https://x/${id}` }] }] };
      });
      const one = await file('digest-a.html', 'week one');
      const two = await file('digest-b.html', 'week two');
      // Start the second call only once the first upload is in flight, so which one is "first" is fixed.
      const pending = server.call('send_file', { file_path: one, artifact_key: 'weekly-digest' });
      await firstInFlight;
      const [first, second] = await Promise.all([
        pending,
        server.call('send_file', { file_path: two, artifact_key: 'weekly-digest' }),
      ]);
      expect(body(first)).toMatchObject({
        file_id: 'F_DIGEST_1',
        version_key: 'key:weekly-digest',
        version: 1,
        changed: null,
      });
      expect(body(second)).toMatchObject({ file_id: 'F_DIGEST_2', version: 2, changed: true, previous_version: 1 });
      const calls = (h.slack.filesUploadV2 as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[1][0].initial_comment).toBe('판 2 · 이전 판 이후 바뀜');
    });
  });
});

describe('send_link', () => {
  it('posts the link into the thread and reports it sent with its ts', async () => {
    const url = 'http://192.168.0.10:8763/r.html';
    const out = body(await server.call('send_link', { url, title: '리포트' }));
    expect(h.slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C_WORK', thread_ts: WORK.threadTs, text: `🔗 <${url}|리포트>` }),
    );
    expect(out).toMatchObject({ sent: true, url, title: '리포트', ts: '1700000009.000100', channel: 'C_WORK' });
  });
});

describe('the auto-resume prompt', () => {
  it('tells the model to read the thread with the slack-mcp tool', async () => {
    const handler = await fs.readFile(path.resolve(__dirname, '..', '..', '..', 'src', 'slack-handler.ts'), 'utf-8');
    expect(handler).toContain('slack-mcp__get_thread_messages');
  });
});
