import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { expect, it, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: { auth: { mode: 'llmux', llmux: { baseUrl: 'http://localhost:3456', apiKey: 'llmux-local' } } },
  LLMUX_PLACEHOLDER_API_KEY: 'llmux-local',
}));

import { resetAuthRuntimeForTests } from '../auth-runtime';
import { buildQueryEnv } from '../query-env-builder';

it.each([
  'bearer',
  'oauth',
  'custom-header',
])('actual SDK preserves tenant identity with inherited %s', async (source) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-llmux-sdk-'));
  resetAuthRuntimeForTests(path.join(dir, 'auth-runtime.json'));
  const requests: http.IncomingHttpHeaders[] = [];
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
      /* drain */
    }
    if (!req.url?.startsWith('/v1/messages')) {
      res.end('{}');
      return;
    }
    requests.push(req.headers);
    const frames = [
      {
        type: 'message_start',
        message: {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture complete' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // OAuth alone is a compatibility case; an empty bearer token also creates an auth header.
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', source === 'oauth' ? 'fixture-unrelated-oauth' : undefined);
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', source === 'bearer' ? 'fixture-unrelated-bearer' : undefined);
  vi.stubEnv(
    'ANTHROPIC_CUSTOM_HEADERS',
    source === 'custom-header'
      ? 'x-api-key: fixture-wrong-tenant\nAuthorization: Bearer fixture-header-bearer\nX-Fixture-Trace: retained'
      : 'X-Fixture-Trace: retained',
  );
  const { env } = buildQueryEnv(
    { keyId: 'llmux', accessToken: 'unused', kind: 'api_key', release: async () => {}, heartbeat: async () => {} },
    { llmuxTenant: { baseUrl, secret: 'lmk-fixture-tenant' } },
  );
  // Explicit SDK config/cwd isolation; preserve the parent HOME.
  env.CLAUDE_CONFIG_DIR = path.join(dir, '.claude');
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_TELEMETRY = '1';
  env.DISABLE_ERROR_REPORTING = '1';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    let success = false;
    for await (const message of query({
      prompt: 'Say fixture complete',
      options: {
        env,
        cwd: dir,
        model: 'claude-haiku-4-5',
        tools: [],
        settingSources: [],
        plugins: [],
        persistSession: false,
        maxTurns: 1,
        thinking: { type: 'disabled' },
        abortController: controller,
      },
    })) {
      if (message.type === 'result') success = !message.is_error;
    }
    expect(success).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
    for (const headers of requests) {
      expect(headers['x-api-key']).toBe('lmk-fixture-tenant');
      expect(headers.authorization).toBeUndefined();
      expect(headers['x-fixture-trace']).toBe('retained');
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    resetAuthRuntimeForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
