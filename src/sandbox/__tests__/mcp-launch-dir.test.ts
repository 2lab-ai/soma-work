// biome-ignore-all lint/suspicious/noTemplateCurlyInString: plugin configs use `${…}` placeholders, not templates

/**
 * env-access #1241: stdio MCP servers start from `<DATA_DIR>/mcp-launch`, not from the session's working
 * directory, where a model could plant a launcher's package-manager config.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchAllFrom, launchFrom, McpLaunchDirError, mcpLaunchDir, pluginMcpServers } from '../mcp-launch-dir';

let work: string;

beforeEach(() => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-launch-test-')));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe('launchFrom', () => {
  it('runs the server command from the launch directory, whatever directory it is started in', () => {
    const dir = path.join(work, 'launch');
    const session = path.join(work, 'session');
    fs.mkdirSync(dir);
    fs.mkdirSync(session);
    const wrapped = launchFrom(dir, { command: 'sh', args: ['-c', 'pwd; echo "$0 $1"', 'first', 'second'] });
    const run = spawnSync(wrapped.command, wrapped.args ?? [], { cwd: session, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout.split('\n').slice(0, 2)).toEqual([dir, 'first second']);
  });

  it('does not start the server when the directory is missing', () => {
    const wrapped = launchFrom(path.join(work, 'missing'), { command: 'echo', args: ['started'] });
    const run = spawnSync(wrapped.command, wrapped.args ?? [], { cwd: work, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain('started');
  });

  it('keeps the env and every other field', () => {
    const wrapped = launchFrom('/x', {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { A: '1' },
      timeout: 5000,
    });
    expect(wrapped).toMatchObject({ type: 'stdio', command: '/bin/sh', env: { A: '1' }, timeout: 5000 });
    expect(wrapped.args?.slice(3)).toEqual(['/x', 'npx', '-y', 'pkg']);
  });
});

describe('launchAllFrom', () => {
  it('wraps stdio servers and leaves SDK, HTTP and SSE servers alone', () => {
    const http = { type: 'http' as const, url: 'https://x' };
    const sse = { type: 'sse' as const, url: 'https://y' };
    const sdk = { type: 'sdk' as const, name: 'inproc', instance: {} as never };
    const out = launchAllFrom('/d', { a: { command: 'node', args: ['s.js'] }, http, sse, sdk });
    expect(out.a).toMatchObject({ command: '/bin/sh' });
    expect(out.http).toBe(http);
    expect(out.sse).toBe(sse);
    expect(out.sdk).toBe(sdk);
  });
});

describe('mcpLaunchDir', () => {
  it('is <DATA_DIR>/mcp-launch, made on first use', () => {
    const dir = mcpLaunchDir(work, []);
    expect(dir).toBe(path.join(work, 'mcp-launch'));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(mcpLaunchDir(work, [])).toBe(dir);
  });

  it('refuses a linked directory', () => {
    fs.mkdirSync(path.join(work, 'elsewhere'));
    fs.symlinkSync(path.join(work, 'elsewhere'), path.join(work, 'mcp-launch'));
    expect(() => mcpLaunchDir(work, [])).toThrow(McpLaunchDirError);
  });

  it('refuses a directory inside one the session writes', () => {
    expect(() => mcpLaunchDir(work, [work])).toThrow(/lies inside/);
    expect(() => mcpLaunchDir(work, [path.join(work, 'other')])).not.toThrow();
  });
});

describe('pluginMcpServers', () => {
  function plugin(name: string, files: Record<string, unknown>): string {
    const root = path.join(work, 'plugins', name);
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    for (const [file, json] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), JSON.stringify(json));
    }
    return root;
  }

  it('reads .mcp.json and the manifest, under the CLI names, with placeholders filled', () => {
    const root = plugin('dir-name', {
      '.claude-plugin/plugin.json': {
        name: 'pw',
        mcpServers: ['./more.json', { inline: { command: 'uvx', args: ['tool', '${REGION:-eu}'] } }],
      },
      '.mcp.json': { mcpServers: { browser: { command: 'npx', args: ['${CLAUDE_PLUGIN_ROOT}/cli.js', '${TOKEN}'] } } },
      'more.json': { remote: { type: 'http', url: 'https://${HOST}/mcp' } },
    });
    const { servers, skipped } = pluginMcpServers([{ type: 'local', path: root }], { TOKEN: 't', HOST: 'h.io' });
    expect(skipped).toEqual([]);
    expect(servers).toEqual({
      plugin_pw_browser: { command: 'npx', args: [`${root}/cli.js`, 't'], env: { CLAUDE_PLUGIN_ROOT: root } },
      plugin_pw_inline: { command: 'uvx', args: ['tool', 'eu'], env: { CLAUDE_PLUGIN_ROOT: root } },
      plugin_pw_remote: { type: 'http', url: 'https://h.io/mcp' },
    });
  });

  it('skips a server with a placeholder it cannot fill, or with no command or url', () => {
    const root = plugin('p', {
      '.mcp.json': {
        data: { command: 'x', args: ['${CLAUDE_PLUGIN_DATA}'] },
        broken: { args: ['y'] },
        ok: { command: 'z' },
      },
    });
    const { servers, skipped } = pluginMcpServers([{ type: 'local', path: root }], {});
    expect(Object.keys(servers)).toEqual(['plugin_p_ok']);
    expect(skipped.sort()).toEqual(['plugin_p_broken', 'plugin_p_data']);
  });

  it('declares nothing for a plugin without MCP servers', () => {
    const root = plugin('plain', { '.claude-plugin/plugin.json': { name: 'plain' } });
    expect(pluginMcpServers([{ type: 'local', path: root }], {})).toEqual({ servers: {}, skipped: [] });
  });
});
