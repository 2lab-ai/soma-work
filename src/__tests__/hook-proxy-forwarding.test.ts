import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Async on purpose: the stub service below lives in THIS process, so a
// synchronous child would block the event loop and the request could never be
// answered — curl would time out and every forwarding assertion would fail.
const execFileAsync = promisify(execFile);

const proxy = path.resolve(__dirname, '..', 'local', 'hooks', 'hook-proxy.sh');

/**
 * hook-proxy.sh in PROXY mode (`HOOKS_PROXY_ENABLED=true`) — the path soma-work
 * puts its spawned agents on.
 *
 * The proxy filters client-side so it only POSTs what the call log actually
 * records: `Task` and `mcp__*`. That filter is a copy of `shouldTrackTool`
 * (src/hooks/hook-policy.ts) living in shell, and it runs on EVERY tool call —
 * a typo in the case pattern would silently empty the call log for every
 * spawned agent, with nothing on the TypeScript side to catch it. Hence this
 * test drives the real script against a real socket.
 */
describe('hook-proxy.sh proxy mode', () => {
  let server: http.Server;
  let port: number;
  let received: Array<{ url: string; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push({ url: req.url || '', body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ action: 'pass' }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const run = async (event: string, payload: Record<string, unknown>) => {
    received = [];
    const child = execFileAsync('bash', [proxy, event], {
      encoding: 'utf-8',
      env: { ...process.env, HOOKS_PROXY_ENABLED: 'true', SOMA_HOOK_PORT: String(port) },
    });
    child.child.stdin?.end(JSON.stringify(payload));
    await child;
    return received;
  };

  it.each([
    ['Task', 'pre_tool_use'],
    ['Task', 'post_tool_use'],
    ['mcp__slack-mcp__send_thread_message', 'pre_tool_use'],
    ['mcp__anything', 'post_tool_use'],
  ])('forwards %s on %s', async (toolName, event) => {
    const hits = await run(event, { session_id: 'sess-proxy', tool_name: toolName });

    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe(`/api/hooks/v1/${event}`);
    expect(JSON.parse(hits[0].body).tool_name).toBe(toolName);
  });

  it.each([
    'Read',
    'Bash',
    'Edit',
    'ToolSearch',
    'TodoWrite',
  ])('skips the roundtrip for untracked tool %s', async (toolName) => {
    expect(await run('pre_tool_use', { session_id: 'sess-proxy', tool_name: toolName })).toEqual([]);
  });

  it('always forwards cleanup, which carries no tool_name', async () => {
    const hits = await run('cleanup', { session_id: 'sess-proxy' });

    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('/api/hooks/v1/cleanup');
    expect(JSON.parse(hits[0].body).session_id).toBe('sess-proxy');
  });

  it('never blocks, even when the service is unreachable', async () => {
    // Port 1 is reserved and refuses instantly — the fail-open path.
    const child = execFileAsync('bash', [proxy, 'pre_tool_use'], {
      encoding: 'utf-8',
      env: { ...process.env, HOOKS_PROXY_ENABLED: 'true', SOMA_HOOK_PORT: '1' },
    });
    child.child.stdin?.end(JSON.stringify({ session_id: 'sess-proxy', tool_name: 'Task' }));

    // execFile rejects on a non-zero exit, so resolving here proves exit 0.
    const { stdout } = await child;
    expect(stdout).toBe('');
  });
});
