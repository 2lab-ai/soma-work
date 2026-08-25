import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { profilePaths } from '../profile';
import {
  type ArchivedSession,
  type ConversationRecord,
  listSessions,
  resolvePinnedSessionsDataDir,
  resolveSessionsDataDir,
  runSessionsCommand,
  SESSIONS_DEFAULT_LIMIT,
  SESSIONS_LIST_FLAGS,
  SESSIONS_MAX_LIMIT,
  SESSIONS_SHOW_FLAGS,
  sessionDirs,
  showSession,
} from '../sessions';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'somawork-sessions-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function seedArchive(dataDir: string, archive: Partial<ArchivedSession> & { sessionKey: string }): void {
  const dir = path.join(dataDir, 'archives');
  fs.mkdirSync(dir, { recursive: true });
  const full: ArchivedSession = {
    archivedAt: 1_700_000_000_000,
    archiveReason: 'idle',
    ownerId: 'U1',
    channelId: 'C1',
    lastActivity: '2026-01-01',
    ...archive,
  };
  fs.writeFileSync(path.join(dir, `${archive.sessionKey}_1.json`), JSON.stringify(full));
}

function seedConversation(dataDir: string, record: ConversationRecord): void {
  const dir = path.join(dataDir, 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record));
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  let code: number | null = null;
  return {
    out,
    err,
    get exitCode() {
      return code;
    },
    opts: {
      write: (line: string) => out.push(line),
      writeErr: (line: string) => err.push(line),
      exit: ((c: number) => {
        code = c;
        throw new Error(`__exit_${c}__`);
      }) as (c: number) => never,
    },
  };
}

describe('resolveSessionsDataDir', () => {
  it('resolves the selected profile data root when no override is set', () => {
    expect(resolveSessionsDataDir({ env: {}, home: '/home/z', profile: 'preview' })).toBe(
      profilePaths('/home/z', 'preview').dataDir,
    );
    expect(resolveSessionsDataDir({ env: {}, home: '/home/z', profile: 'production' })).toBe(
      profilePaths('/home/z', 'production').dataDir,
    );
  });

  it('honours the canonical SOMA_DATA_DIR override', () => {
    expect(resolveSessionsDataDir({ env: { SOMA_DATA_DIR: '/srv/data' }, home: '/home/z', profile: 'preview' })).toBe(
      '/srv/data',
    );
  });

  it('never consults the working directory, the git branch, or SOMA_CONFIG_DIR', () => {
    const resolved = resolveSessionsDataDir({
      env: { SOMA_CONFIG_DIR: '/somewhere/else', PWD: '/tmp/checkout' },
      home: '/home/z',
      profile: 'production',
    });
    expect(resolved).toBe(profilePaths('/home/z', 'production').dataDir);
  });

  it('resolves a pinned directory without a profile, and reports when nothing pins it', () => {
    // `SOMA_DATA_DIR` pins it outright.
    expect(resolvePinnedSessionsDataDir({ env: { SOMA_DATA_DIR: '/srv/d' }, home: '/home/z' })).toBe('/srv/d');
    // An explicit profile pins it too — no runtime discovery required.
    expect(resolvePinnedSessionsDataDir({ env: {}, home: '/home/z', profile: 'preview' })).toBe(
      profilePaths('/home/z', 'preview').dataDir,
    );
    // Neither: the caller has to resolve a profile first.
    expect(resolvePinnedSessionsDataDir({ env: {}, home: '/home/z' })).toBeNull();
  });

  it('gives the override precedence over an explicit profile', () => {
    expect(
      resolvePinnedSessionsDataDir({ env: { SOMA_DATA_DIR: '/srv/d' }, home: '/home/z', profile: 'production' }),
    ).toBe('/srv/d');
  });

  it('derives both archive roots from one data directory', () => {
    expect(sessionDirs('/d')).toEqual({
      archivesDir: path.join('/d', 'archives'),
      conversationsDir: path.join('/d', 'conversations'),
    });
  });
});

describe('listSessions', () => {
  it('renders a table, honours --limit, and filters by user and model', () => {
    seedArchive(root, { sessionKey: 'a', ownerId: 'U1', model: 'opus', archivedAt: 3 });
    seedArchive(root, { sessionKey: 'b', ownerId: 'U2', model: 'sonnet', archivedAt: 2 });
    seedArchive(root, { sessionKey: 'c', ownerId: 'U1', model: 'sonnet', archivedAt: 1 });

    const all = capture();
    listSessions([], { ...sessionDirs(root), ...all.opts });
    expect(all.out.join('\n')).toContain('Total: 3 session(s)');

    const byUser = capture();
    listSessions(['--user', 'U1'], { ...sessionDirs(root), ...byUser.opts });
    expect(byUser.out.join('\n')).toContain('Total: 2 session(s)');

    const byModel = capture();
    listSessions(['--model', 'opus'], { ...sessionDirs(root), ...byModel.opts });
    expect(byModel.out.join('\n')).toContain('Total: 1 session(s)');

    const limited = capture();
    listSessions(['--limit', '1'], { ...sessionDirs(root), ...limited.opts });
    expect(limited.out.join('\n')).toContain('Total: 1 session(s)');
  });

  it('emits JSON, newest first, under --json', () => {
    seedArchive(root, { sessionKey: 'old', archivedAt: 1 });
    seedArchive(root, { sessionKey: 'new', archivedAt: 2 });
    const cap = capture();
    listSessions(['--json'], { ...sessionDirs(root), ...cap.opts });
    const parsed = JSON.parse(cap.out.join('\n')) as ArchivedSession[];
    expect(parsed.map((a) => a.sessionKey)).toEqual(['new', 'old']);
  });

  it('says so, rather than throwing, when nothing matches or the directory is absent', () => {
    const cap = capture();
    listSessions([], { ...sessionDirs(path.join(root, 'nope')), ...cap.opts });
    expect(cap.out.join('\n')).toContain('No sessions match the filter.');
  });

  it('reads only the injected archive directory', () => {
    const other = path.join(root, 'other');
    seedArchive(other, { sessionKey: 'hidden' });
    seedArchive(root, { sessionKey: 'visible' });
    const cap = capture();
    listSessions([], { ...sessionDirs(root), ...cap.opts });
    expect(cap.out.join('\n')).toContain('visible');
    expect(cap.out.join('\n')).not.toContain('hidden');
  });
});

describe('showSession', () => {
  it('keeps its historical text output and its JSON mode', () => {
    seedArchive(root, { sessionKey: 'k1', ownerName: 'Zed', model: 'opus', title: 'T' });
    const text = capture();
    showSession(['k1'], { ...sessionDirs(root), ...text.opts });
    expect(text.out[0]).toBe('Session: k1');
    expect(text.out.some((l) => l.startsWith('Owner:'))).toBe(true);

    const json = capture();
    showSession(['k1', '--json'], { ...sessionDirs(root), ...json.opts });
    expect((JSON.parse(json.out.join('\n')) as ArchivedSession).sessionKey).toBe('k1');
  });

  it('prints the conversation when asked and reports its absence otherwise', () => {
    seedArchive(root, { sessionKey: 'k2', conversationId: 'conv1' });
    seedConversation(root, {
      id: 'conv1',
      turns: [{ id: 't1', role: 'user', timestamp: 1, userName: 'Zed', rawContent: 'hello' }],
    });
    const cap = capture();
    showSession(['k2', '--conversation'], { ...sessionDirs(root), ...cap.opts });
    expect(cap.out.join('\n')).toContain('Conversation: 1 turns');

    seedArchive(root, { sessionKey: 'k3' });
    const none = capture();
    showSession(['k3', '--conversation'], { ...sessionDirs(root), ...none.opts });
    expect(none.out.join('\n')).toContain('No conversation linked to this session.');
  });

  it('exits nonzero with a usage line when no session key is given', () => {
    const cap = capture();
    expect(() => showSession([], { ...sessionDirs(root), ...cap.opts })).toThrow('__exit_1__');
    expect(cap.exitCode).toBe(1);
    expect(cap.err.join('\n')).toContain('sessions show');
  });

  it('treats a leading flag as "no key" rather than looking up a session named --json', () => {
    for (const args of [['--json'], ['--conversation', '--json'], ['-x']]) {
      const cap = capture();
      expect(() => showSession(args, { ...sessionDirs(root), ...cap.opts }), args.join(' ')).toThrow('__exit_1__');
      expect(cap.err.join('\n'), args.join(' ')).toContain('Usage:');
      expect(cap.err.join('\n'), args.join(' ')).not.toContain('Session not found');
    }
  });

  it('still accepts a key that merely contains a dash', () => {
    seedArchive(root, { sessionKey: 'C123-thread-9' });
    const cap = capture();
    showSession(['C123-thread-9'], { ...sessionDirs(root), ...cap.opts });
    expect(cap.out[0]).toBe('Session: C123-thread-9');
  });
});

describe('runSessionsCommand', () => {
  it('routes list and show to the same handlers the shim uses', () => {
    seedArchive(root, { sessionKey: 'routed' });
    const list = capture();
    runSessionsCommand('list', [], { ...sessionDirs(root), ...list.opts });
    expect(list.out.join('\n')).toContain('routed');

    const show = capture();
    runSessionsCommand('show', ['routed'], { ...sessionDirs(root), ...show.opts });
    expect(show.out[0]).toBe('Session: routed');
  });
});

describe('module graph', () => {
  /**
   * The sessions module used to reach `@soma/common/env-paths` for one
   * environment variable. Importing that module runs
   * `execSync('git branch --show-current')`, calls `dotenv.config()`, and prints
   * an `[env-paths] …` banner — so `somawork sessions list --json` emitted
   * unparseable output before any command code ran, and the "no subprocess, no
   * source-cwd dependency" contract was violated at import time.
   *
   * A grep would not have caught the reintroduction through a transitive edge,
   * so this imports the module in a fresh process and asserts the streams stay
   * empty.
   */
  it('imports with zero output and no subprocess', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const result = execFileSync('npx', ['tsx', '-e', "import('./src/cli/sessions.ts').then(() => {});"], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    expect(result).toBe('');
  }, 120_000);
});

describe('flag grammar', () => {
  /**
   * The parser in `args.ts` validates the sessions tail against these tables, so
   * they must stay the same set the handlers below actually read. A flag added
   * to one and not the other is either silently ignored (list) or rejected
   * before the handler sees it (args).
   */
  it('declares exactly the flags the handlers read', () => {
    expect(Object.keys(SESSIONS_LIST_FLAGS).sort()).toEqual([
      '--json',
      '--limit',
      '--model',
      '--since',
      '--until',
      '--user',
    ]);
    expect(Object.keys(SESSIONS_SHOW_FLAGS).sort()).toEqual(['--conversation', '--json']);
  });

  it('marks value-taking flags distinctly from boolean ones', () => {
    expect(SESSIONS_LIST_FLAGS['--limit']).toBe('value');
    expect(SESSIONS_LIST_FLAGS['--json']).toBe('boolean');
    expect(SESSIONS_SHOW_FLAGS['--conversation']).toBe('boolean');
  });
});

describe('--limit validation', () => {
  function seed(dataDir: string, count: number): void {
    const dir = path.join(dataDir, 'archives');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i++) {
      fs.writeFileSync(
        path.join(dir, `k${i}_1.json`),
        JSON.stringify({
          archivedAt: i,
          archiveReason: 'idle',
          sessionKey: `k${i}`,
          ownerId: 'U1',
          channelId: 'C1',
          lastActivity: 'x',
        }),
      );
    }
  }

  it('documents its bounds as constants both entry points share', () => {
    expect(SESSIONS_DEFAULT_LIMIT).toBe(50);
    expect(SESSIONS_MAX_LIMIT).toBe(10_000);
  });

  it('rejects every non-positive-integer form with the caller program prefix', () => {
    seed(root, 3);
    for (const value of ['0', '-1', '1.5', 'abc', '', ' 5', '1e5', '+5', '0x10', 'Infinity', 'NaN', '10001']) {
      const cap = capture();
      expect(
        () => listSessions(['--limit', value], { ...sessionDirs(root), programName: 'soma-cli', ...cap.opts }),
        value,
      ).toThrow('__exit_1__');
      expect(cap.exitCode, value).toBe(1);
      expect(cap.err.join('\n'), value).toMatch(/^soma-cli: /);
      expect(cap.out, value).toEqual([]);
    }
  });

  it('never silently turns 0 into the default', () => {
    seed(root, 3);
    const cap = capture();
    expect(() => listSessions(['--limit', '0'], { ...sessionDirs(root), ...cap.opts })).toThrow('__exit_1__');
    expect(cap.out).toEqual([]);
  });

  it('accepts 1 and the documented maximum', () => {
    seed(root, 3);
    for (const value of ['1', String(SESSIONS_MAX_LIMIT)]) {
      const cap = capture();
      listSessions(['--limit', value, '--json'], { ...sessionDirs(root), ...cap.opts });
      expect(cap.err, value).toEqual([]);
    }
  });

  it('keeps the historical default when --limit is omitted', () => {
    seed(root, 60);
    const cap = capture();
    listSessions(['--json'], { ...sessionDirs(root), ...cap.opts });
    expect(JSON.parse(cap.out.join('\n'))).toHaveLength(SESSIONS_DEFAULT_LIMIT);
  });
});
