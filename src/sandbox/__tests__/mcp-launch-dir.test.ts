// biome-ignore-all lint/suspicious/noTemplateCurlyInString: plugin configs use `${…}` placeholders, not templates

/**
 * env-access #1241: stdio MCP servers start from `<DATA_DIR>/mcp-launch` — read-only, empty, outside every write
 * root — not from the session's working directory, where a model could plant a launcher's package-manager config.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LAUNCH_SCRIPT,
  launchAllFrom,
  launchFrom,
  McpLaunchDirError,
  mcpLaunchDir,
  wrapPluginLaunchers,
} from '../mcp-launch-dir';

let work: string;

beforeEach(() => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-launch-test-')));
});

afterEach(() => {
  // The launch directory is read-only; let the cleanup in.
  for (const dir of [path.join(work, 'mcp-launch'), path.join(work, 'data', 'mcp-launch')]) {
    if (fs.existsSync(dir)) fs.chmodSync(dir, 0o755);
  }
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

  it('points an already wrapped server at the new directory instead of wrapping it twice', () => {
    const once = launchFrom('/old', { command: 'npx', args: ['pkg'] });
    expect(launchFrom('/new', once).args).toEqual(['-c', LAUNCH_SCRIPT, 'mcp-launch', '/new', 'npx', 'pkg']);
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
  it('is <DATA_DIR>/mcp-launch, made on first use, read-only', () => {
    const dir = mcpLaunchDir(work, []);
    expect(dir).toBe(path.join(work, 'mcp-launch'));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o555);
    expect(mcpLaunchDir(work, [])).toBe(dir);
  });

  it('makes a directory that was opened up read-only again', () => {
    fs.mkdirSync(path.join(work, 'mcp-launch'), { mode: 0o755 });
    expect(fs.statSync(mcpLaunchDir(work, [])).mode & 0o777).toBe(0o555);
  });

  it('refuses a directory that holds anything', () => {
    fs.mkdirSync(path.join(work, 'mcp-launch'));
    fs.writeFileSync(path.join(work, 'mcp-launch', '.npmrc'), 'registry=x');
    expect(() => mcpLaunchDir(work, [])).toThrow(/must stay empty but holds \.npmrc/);
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

describe('wrapPluginLaunchers', () => {
  const dir = '/launch';
  let cache: string;

  beforeEach(() => {
    cache = path.join(work, 'plugins');
    fs.mkdirSync(cache);
  });

  function plugin(name: string, files: Record<string, unknown>, parent = cache): string {
    const root = path.join(parent, name);
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content));
    }
    return root;
  }
  const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

  it('wraps the stdio servers in .mcp.json in place and leaves placeholders and other transports to the CLI', () => {
    const root = plugin('pw', {
      '.mcp.json': {
        mcpServers: {
          browser: {
            command: '${CLAUDE_PLUGIN_ROOT}/bin/run',
            args: ['${user_config.key}'],
            env: { D: '${CLAUDE_PLUGIN_DATA}' },
          },
          remote: { type: 'http', url: 'https://${HOST}/mcp', headers: { A: '${TOKEN}' } },
          socket: { type: 'ws', url: 'wss://x' },
        },
      },
    });
    const out = wrapPluginLaunchers([{ type: 'local', path: root }], dir, cache);
    expect(out).toEqual({ plugins: [{ type: 'local', path: root }], turnedOff: [] });
    expect(json(path.join(root, '.mcp.json')).mcpServers).toEqual({
      browser: {
        command: '/bin/sh',
        args: ['-c', LAUNCH_SCRIPT, 'mcp-launch', dir, '${CLAUDE_PLUGIN_ROOT}/bin/run', '${user_config.key}'],
        env: { D: '${CLAUDE_PLUGIN_DATA}' },
      },
      remote: { type: 'http', url: 'https://${HOST}/mcp', headers: { A: '${TOKEN}' } },
      socket: { type: 'ws', url: 'wss://x' },
    });
  });

  it('wraps servers inline in the manifest and in a JSON file it names, and leaves the rest of the manifest', () => {
    const root = plugin('m', {
      '.claude-plugin/plugin.json': {
        name: 'm',
        version: '1.0.0',
        mcpServers: ['./servers.json', { inline: { command: 'uvx', args: ['tool'] } }],
      },
      'servers.json': { file: { command: 'npx', args: ['-y', 'pkg'] } },
    });
    expect(wrapPluginLaunchers([{ type: 'local', path: root }], dir, cache).turnedOff).toEqual([]);
    const manifest = json(path.join(root, '.claude-plugin', 'plugin.json'));
    expect(manifest).toMatchObject({ name: 'm', version: '1.0.0' });
    expect(manifest.mcpServers[0]).toBe('./servers.json');
    expect(manifest.mcpServers[1].inline.args).toEqual(['-c', LAUNCH_SCRIPT, 'mcp-launch', dir, 'uvx', 'tool']);
    expect(json(path.join(root, 'servers.json')).file.args.slice(3)).toEqual([dir, 'npx', '-y', 'pkg']);
  });

  it('writes nothing the second time, and re-points the servers when the directory moves', () => {
    const root = plugin('p', { '.mcp.json': { s: { command: 'npx' } } });
    wrapPluginLaunchers([{ type: 'local', path: root }], dir, cache);
    const first = fs.statSync(path.join(root, '.mcp.json')).mtimeMs;
    const firstText = fs.readFileSync(path.join(root, '.mcp.json'), 'utf8');
    wrapPluginLaunchers([{ type: 'local', path: root }], dir, cache);
    expect(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).toBe(firstText);
    expect(fs.statSync(path.join(root, '.mcp.json')).mtimeMs).toBe(first);
    wrapPluginLaunchers([{ type: 'local', path: root }], '/moved', cache);
    expect(json(path.join(root, '.mcp.json')).s.args).toEqual(['-c', LAUNCH_SCRIPT, 'mcp-launch', '/moved', 'npx']);
  });

  it('leaves a plugin without MCP servers alone, wherever it is', () => {
    const outside = plugin('plain', { '.claude-plugin/plugin.json': { name: 'plain' } }, work);
    expect(wrapPluginLaunchers([{ type: 'local', path: outside }], dir, cache)).toEqual({
      plugins: [{ type: 'local', path: outside }],
      turnedOff: [],
    });
  });

  it('turns the MCP servers off when they cannot be wrapped where the CLI reads them', () => {
    const outside = plugin('out', { '.mcp.json': { s: { command: 'npx' } } }, work);
    const bundle = plugin('bundle', { '.claude-plugin/plugin.json': { name: 'b', mcpServers: './server.mcpb' } });
    const escape = plugin('esc', { '.claude-plugin/plugin.json': { name: 'e', mcpServers: '../../out/.mcp.json' } });
    const broken = plugin('broken', { '.mcp.json': '{ not json' });
    const out = wrapPluginLaunchers(
      [outside, bundle, escape, broken].map((p) => ({ type: 'local' as const, path: p })),
      dir,
      cache,
    );
    expect(out.plugins.map((p) => p.skipMcpDiscovery)).toEqual([true, true, true, true]);
    expect(out.turnedOff).toEqual([
      `${outside}: it is not in the plugin cache`,
      `${bundle}: ./server.mcpb is not a JSON MCP config (an MCP bundle cannot be wrapped)`,
      `${escape}: ../../out/.mcp.json lies outside the plugin`,
      `${broken}: .mcp.json cannot be read`,
    ]);
    expect(json(path.join(outside, '.mcp.json'))).toEqual({ s: { command: 'npx' } });
  });
});
