import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadServerToolsSection, secretUsages } from '../secret-usage';

/**
 * secret-access WU1 (#1337, .prd/33 §2.1): where configuration names each secret — the 비밀 tab's "쓰는 곳" and,
 * in WU2, the secrets one server-tools call uses. Read from the raw `server-tools` section (references unresolved).
 */

const SECTION = {
  permission: { db_query: 'read' },
  dev2: {
    envUser: 'env:acme-dev2',
    ssh: { host: 'dev2' },
    databases: { app: { type: 'mysql', host: '127.0.0.1', user: 'app', password: { $secret: 'dev2-db-app' } } },
    github: { repos: ['acme/app'], token: { $secret: 'gh-org-admin' } },
    web: { logins: { player: { url: 'https://x.test/login', body: { id: 'p', pw: { $secret: 'dev2-player' } } } } },
  },
  stage0: {
    cloudflare: {
      accounts: { main: { token: { $secret: 'cf-stage0' } }, side: { token: { $secret: 'gh-org-admin' } } },
    },
  },
};

describe('secretUsages', () => {
  it('maps every referenced name to the servers and paths that use it', () => {
    const usages = secretUsages(SECTION);
    expect(Object.fromEntries(usages)).toEqual({
      'dev2-db-app': [{ server: 'dev2', path: 'databases.app.password' }],
      'gh-org-admin': [
        { server: 'dev2', path: 'github.token' },
        { server: 'stage0', path: 'cloudflare.accounts.side.token' },
      ],
      'dev2-player': [{ server: 'dev2', path: 'web.logins.player.body.pw' }],
      'cf-stage0': [{ server: 'stage0', path: 'cloudflare.accounts.main.token' }],
    });
  });

  it('reads nothing from the reserved permission key and ignores a section that is not an object', () => {
    expect(secretUsages({ permission: { a: { $secret: 'nope' } } }).size).toBe(0);
    expect(secretUsages(null).size).toBe(0);
    expect(secretUsages('x').size).toBe(0);
  });

  it('walks arrays and skips a malformed reference', () => {
    const usages = secretUsages({ s: { list: [{ $secret: 'in-array' }], bad: { $secret: 'x', extra: 1 } } });
    expect(Object.fromEntries(usages)).toEqual({ 'in-array': [{ server: 's', path: 'list.0' }] });
  });
});

describe('loadServerToolsSection', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('reads the raw section, follows edits, keeps the last good one on a half-written file', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-usage-'));
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ 'server-tools': SECTION }));
    expect(loadServerToolsSection(file)).toEqual(SECTION);

    fs.writeFileSync(file, JSON.stringify({ 'server-tools': { one: { token: { $secret: 'n' } } }, other: 1 }));
    expect(loadServerToolsSection(file)).toEqual({ one: { token: { $secret: 'n' } } });

    fs.writeFileSync(file, '{ "server-tools": ');
    expect(loadServerToolsSection(file)).toEqual({ one: { token: { $secret: 'n' } } });
  });

  it('a config that does not parse never puts its contents in the log', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-usage-'));
    const file = path.join(root, 'config.json');
    const seen: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        seen.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      }),
    );
    try {
      // Short on purpose: V8 quotes the whole of a short input in the parse error ("… is not valid JSON").
      fs.writeFileSync(file, '{"pw": LEAK-MARKER}');
      expect(loadServerToolsSection(file)).toBeNull();
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(seen.join('\n')).not.toContain('LEAK-MARKER');
  });

  it('keeps the last section read when the file briefly cannot be found (as server-tools does)', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-usage-'));
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ 'server-tools': SECTION }));
    expect(loadServerToolsSection(file)).toEqual(SECTION);
    fs.renameSync(file, `${file}.moved`);
    expect(loadServerToolsSection(file)).toEqual(SECTION);
  });

  it('is null without a file or a section', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-usage-'));
    expect(loadServerToolsSection(path.join(root, 'missing.json'))).toBeNull();
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }));
    expect(loadServerToolsSection(file)).toBeNull();
  });
});
