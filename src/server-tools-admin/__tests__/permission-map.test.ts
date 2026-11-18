import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPermissionMap, PermissionMapError, readPermissionMap, setToolLevel } from '../permission-map';

/**
 * secret-access WU3 (#1339, .prd/32 D10): the server-tools tool levels stay where they are — `config.json`
 * `server-tools.permission` — and the dashboard edits that one key. Nothing else in the file changes; a file
 * changed by someone else since it was read is not overwritten (409).
 */

describe('permission-map', () => {
  let root: string;
  let file: string;
  const BASE = {
    mcpServers: { a: { command: 'x', env: { TOKEN: '${JIRA_TOKEN}' } } },
    'server-tools': {
      permission: { db_query: 'read', logs: 'read' },
      dev2: { ssh: { host: 'dev2' }, github: { token: { $secret: 'gh' } } },
    },
    plugin: { marketplace: [] },
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-map-'));
    file = path.join(root, 'config.json');
    fs.writeFileSync(file, `${JSON.stringify(BASE, null, 2)}\n`);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads the map and says whether one exists', () => {
    expect(readPermissionMap(file)).toEqual({ present: true, levels: { db_query: 'read', logs: 'read' } });
    fs.writeFileSync(file, JSON.stringify({ 'server-tools': { dev2: {} } }));
    expect(readPermissionMap(file)).toEqual({ present: false, levels: {} });
  });

  it('sets, changes and removes one tool level, and changes nothing else in the file', () => {
    expect(setToolLevel(file, 'redis_query', 'read')).toEqual({ from: null, to: 'read' });
    expect(setToolLevel(file, 'db_query', 'write')).toEqual({ from: 'read', to: 'write' });
    expect(setToolLevel(file, 'logs', null)).toEqual({ from: 'read', to: null });
    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(after['server-tools'].permission).toEqual({ db_query: 'write', redis_query: 'read' });
    // everything else exactly as it was — unresolved ${VAR} and {"$secret"} included
    const { 'server-tools': st, ...rest } = after;
    const { 'server-tools': baseSt, ...baseRest } = BASE;
    expect(rest).toEqual(baseRest);
    expect(st.dev2).toEqual(baseSt.dev2);
    expect(Object.keys(after)).toEqual(Object.keys(BASE));
  });

  it('creates a map where there is none', () => {
    fs.writeFileSync(file, JSON.stringify({ 'server-tools': { dev2: {} } }));
    createPermissionMap(file, { db_query: 'read', logs: 'read' });
    expect(readPermissionMap(file)).toEqual({ present: true, levels: { db_query: 'read', logs: 'read' } });
    expect(() => createPermissionMap(file, { logs: 'read' })).toThrow(expect.objectContaining({ statusCode: 409 }));
  });

  it('refuses without a server-tools section, an invalid level, or a file that does not parse', () => {
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }));
    expect(() => setToolLevel(file, 'logs', 'read')).toThrow(expect.objectContaining({ statusCode: 409 }));
    fs.writeFileSync(file, `${JSON.stringify(BASE)}`);
    expect(() => setToolLevel(file, 'logs', 'admin' as never)).toThrow(PermissionMapError);
    fs.writeFileSync(file, '{ "server-tools": ');
    expect(() => setToolLevel(file, 'logs', 'read')).toThrow(expect.objectContaining({ statusCode: 409 }));
  });

  it('does not overwrite a file another writer changed since it was read', () => {
    let bumped = false;
    expect(() =>
      setToolLevel(file, 'logs', 'write', {
        beforeWrite: () => {
          if (bumped) return;
          bumped = true;
          fs.writeFileSync(file, `${JSON.stringify({ ...BASE, plugin: { marketplace: ['x'] } }, null, 2)}\n`);
        },
      }),
    ).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).plugin.marketplace).toEqual(['x']);
  });
});
