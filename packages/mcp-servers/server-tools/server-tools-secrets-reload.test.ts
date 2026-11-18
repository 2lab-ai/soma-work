/**
 * secret-access WU1 (#1337): an admin adds or replaces a secret from the dashboard's 비밀 tab without touching
 * config.json. server-tools — one stdio child per session — must resolve the new value on its next call instead
 * of keeping the server left out (missing secret) or the old value until the session ends.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    setRequestHandler() {}
    connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: Symbol('CallToolRequestSchema'),
  ListToolsRequestSchema: Symbol('ListToolsRequestSchema'),
}));
vi.mock('@soma/process-shared/stderr-logger.js', () => ({
  StderrLogger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));

import { loadConfig, resetConfigCache } from './server-tools-mcp-server.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'server-tools-secrets-reload-'));
const CONFIG_FILE = path.join(ROOT, 'config.json');
const SECRETS = path.join(ROOT, 'secrets');
const saved = { ...process.env };

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** Write as the dashboard does: a temp file renamed into place (the directory changes). */
function putSecret(name: string, value: string): void {
  const tmp = path.join(SECRETS, `.${name}.tmp-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(tmp, value, { mode: 0o600 });
  fs.renameSync(tmp, path.join(SECRETS, name));
}

beforeEach(() => {
  fs.rmSync(SECRETS, { recursive: true, force: true });
  fs.mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({
      'server-tools': {
        dev2: {
          ssh: { host: 'dev2' },
          databases: {
            app: { type: 'mysql', host: '127.0.0.1', port: 3306, user: 'app', password: { $secret: 'db' } },
          },
        },
      },
    }),
  );
  process.env.SOMA_CONFIG_FILE = CONFIG_FILE;
  process.env.SOMA_SECRETS_DIR = SECRETS;
  resetConfigCache();
});

afterEach(() => {
  process.env = { ...saved };
});

describe('server-tools resolves a secret the dashboard wrote, on the next call', () => {
  it('a server left out for a missing secret comes back once the secret is added', () => {
    expect(loadConfig().dev2).toBeUndefined();
    putSecret('db', 'first');
    expect(loadConfig().dev2?.databases?.app.password).toBe('first');
  });

  it('a replaced value replaces the one in use', () => {
    putSecret('db', 'first');
    expect(loadConfig().dev2?.databases?.app.password).toBe('first');
    putSecret('db', 'rotated');
    expect(loadConfig().dev2?.databases?.app.password).toBe('rotated');
  });
});
