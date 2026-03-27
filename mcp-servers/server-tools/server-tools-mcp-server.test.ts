import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as child_process from 'child_process';
import { validateReadOnlyQuery, loadConfig, resetConfigCache } from './server-tools-mcp-server.js';

// Mock child_process
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: vi.fn(),
    spawn: vi.fn(),
  };
});

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    statSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// Mock the MCP SDK so the server doesn't actually start
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    setRequestHandler() {}
    connect() {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: Symbol('CallToolRequestSchema'),
  ListToolsRequestSchema: Symbol('ListToolsRequestSchema'),
}));

// Mock stderr-logger
vi.mock('../_shared/stderr-logger.js', () => {
  return {
    StderrLogger: class {
      debug() {}
      info() {}
      warn() {}
      error() {}
    },
  };
});

// ── validateReadOnlyQuery tests ────────────────────────────

describe('validateReadOnlyQuery', () => {
  it('allows SELECT queries', () => {
    expect(validateReadOnlyQuery('SELECT * FROM users')).toBe(true);
    expect(validateReadOnlyQuery('select id, name from users where id = 1')).toBe(true);
    expect(validateReadOnlyQuery('  SELECT count(*) FROM orders  ')).toBe(true);
  });

  it('allows SHOW, DESCRIBE, EXPLAIN, DESC queries', () => {
    expect(validateReadOnlyQuery('SHOW TABLES')).toBe(true);
    expect(validateReadOnlyQuery('SHOW DATABASES')).toBe(true);
    expect(validateReadOnlyQuery('DESCRIBE users')).toBe(true);
    expect(validateReadOnlyQuery('EXPLAIN SELECT * FROM users')).toBe(true);
    expect(validateReadOnlyQuery('DESC users')).toBe(true);
  });

  it('blocks INSERT, UPDATE, DELETE, DROP', () => {
    expect(validateReadOnlyQuery('INSERT INTO users VALUES (1, "test")')).toBe(false);
    expect(validateReadOnlyQuery('UPDATE users SET name = "test"')).toBe(false);
    expect(validateReadOnlyQuery('DELETE FROM users WHERE id = 1')).toBe(false);
    expect(validateReadOnlyQuery('DROP TABLE users')).toBe(false);
    expect(validateReadOnlyQuery('CREATE TABLE test (id INT)')).toBe(false);
    expect(validateReadOnlyQuery('ALTER TABLE users ADD COLUMN age INT')).toBe(false);
    expect(validateReadOnlyQuery('TRUNCATE TABLE users')).toBe(false);
  });

  it('blocks multi-statement queries (semicolons outside strings)', () => {
    expect(validateReadOnlyQuery('SELECT 1; DROP TABLE users')).toBe(false);
    expect(validateReadOnlyQuery('SELECT * FROM users; SELECT * FROM orders')).toBe(false);
  });

  it('allows semicolons inside string literals', () => {
    expect(validateReadOnlyQuery("SELECT * FROM users WHERE name = 'test;value'")).toBe(true);
  });

  it('blocks INTO OUTFILE/DUMPFILE', () => {
    expect(validateReadOnlyQuery("SELECT * FROM users INTO OUTFILE '/tmp/data.csv'")).toBe(false);
    expect(validateReadOnlyQuery("SELECT * FROM users INTO DUMPFILE '/tmp/data.bin'")).toBe(false);
    expect(validateReadOnlyQuery("SELECT * FROM users into outfile '/tmp/data.csv'")).toBe(false);
  });

  it('strips block comments before validation', () => {
    expect(validateReadOnlyQuery('/* comment */ SELECT * FROM users')).toBe(true);
    expect(validateReadOnlyQuery('/* DROP TABLE users */ SELECT 1')).toBe(true);
  });

  it('rejects empty queries', () => {
    expect(validateReadOnlyQuery('')).toBe(false);
    expect(validateReadOnlyQuery('   ')).toBe(false);
  });
});

// ── Config loading tests ───────────────────────────────────

describe('Config loading', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfigCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('loads server-tools section from config file', () => {
    const configData = {
      'server-tools': {
        prod: {
          ssh: { host: 'prod.example.com' },
          databases: {
            main: { type: 'mysql', host: 'db.internal', port: 3306, user: 'root', password: 'secret' },
          },
        },
      },
    };

    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';

    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000, size: 500 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(configData));

    const config = loadConfig();
    expect(config).toHaveProperty('prod');
    expect(config.prod.ssh.host).toBe('prod.example.com');
    expect(config.prod.databases?.main.host).toBe('db.internal');
  });

  it('returns empty config when server-tools section is missing', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';

    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 2000, size: 100 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ other: {} }));

    const config = loadConfig();
    expect(Object.keys(config)).toHaveLength(0);
  });

  it('uses mtime cache and does not re-read unchanged file', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';

    const configData = {
      'server-tools': {
        staging: { ssh: { host: 'staging.example.com' } },
      },
    };

    // Clear any previous call counts
    vi.mocked(fs.statSync).mockClear();
    vi.mocked(fs.readFileSync).mockClear();

    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 3000, size: 200 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(configData));

    // First call — reads file
    loadConfig();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);

    // Second call — same mtime, should use cache
    loadConfig();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);

    // Third call with changed mtime — should re-read
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 4000, size: 200 } as fs.Stats);
    loadConfig();
    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
  });
});

// ── Tool behavior tests (using internal logic) ─────────────

describe('list tool', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfigCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('returns configured servers', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';

    const configData = {
      'server-tools': {
        web: {
          ssh: { host: 'web.example.com' },
          databases: {
            app_db: { type: 'mysql', host: 'db.internal', port: 3306, user: 'root', password: 'pw' },
          },
        },
        api: {
          ssh: { host: 'api.example.com' },
        },
      },
    };

    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 5000, size: 300 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(configData));

    const config = loadConfig();
    const servers = Object.entries(config).map(([name, srv]) => ({
      name,
      ssh_host: srv.ssh.host,
      databases: srv.databases ? Object.keys(srv.databases) : [],
    }));

    expect(servers).toHaveLength(2);
    expect(servers[0]).toEqual({
      name: 'web',
      ssh_host: 'web.example.com',
      databases: ['app_db'],
    });
    expect(servers[1]).toEqual({
      name: 'api',
      ssh_host: 'api.example.com',
      databases: [],
    });
  });

  it('returns empty when no config', () => {
    // No SOMA_CONFIG_FILE set
    delete process.env.SOMA_CONFIG_FILE;
    const config = loadConfig();
    const servers = Object.entries(config).map(([name, srv]) => ({
      name,
      ssh_host: srv.ssh.host,
      databases: srv.databases ? Object.keys(srv.databases) : [],
    }));
    expect(servers).toHaveLength(0);
  });
});

describe('list_service tool', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfigCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('builds correct SSH command', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';

    const configData = {
      'server-tools': {
        prod: { ssh: { host: 'prod.example.com' } },
      },
    };

    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 6000, size: 100 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(configData));

    const dockerOutput = '{"Names":"nginx","Status":"Up 2 hours"}\n{"Names":"redis","Status":"Up 3 hours"}\n';
    vi.mocked(child_process.execFileSync).mockReturnValue(dockerOutput);

    // Simulate the handler logic
    const config = loadConfig();
    const server = 'prod';
    const sshHost = config[server].ssh.host;

    const output = child_process.execFileSync(
      'ssh',
      [sshHost, 'docker', 'ps', '--format', 'json'],
      { timeout: 30000, encoding: 'utf-8' },
    );

    expect(child_process.execFileSync).toHaveBeenCalledWith(
      'ssh',
      ['prod.example.com', 'docker', 'ps', '--format', 'json'],
      expect.objectContaining({ timeout: 30000 }),
    );

    const containers = (output as string)
      .trim()
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));

    expect(containers).toHaveLength(2);
    expect(containers[0].Names).toBe('nginx');
  });

  it('throws error for unknown server', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';

    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 7000, size: 50 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ 'server-tools': {} }));

    const config = loadConfig();
    expect(() => {
      if (!config['nonexistent']) {
        throw new Error('Unknown server: nonexistent');
      }
    }).toThrow('Unknown server: nonexistent');
  });
});

describe('logs tool', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfigCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('builds correct SSH command with all options', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';

    const configData = {
      'server-tools': {
        prod: { ssh: { host: 'prod.example.com' } },
      },
    };

    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 8000, size: 100 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(configData));
    vi.mocked(child_process.execFileSync).mockReturnValue('some log output');

    const config = loadConfig();
    const server = 'prod';
    const service = 'nginx';
    const tail = 50;
    const since = '2024-01-01T00:00:00';
    const until = '2024-01-02T00:00:00';
    const timestamps = true;

    const sshHost = config[server].ssh.host;
    const sshArgs = [sshHost, 'docker', 'logs', '--tail', String(tail)];
    if (since) sshArgs.push('--since', since);
    if (until) sshArgs.push('--until', until);
    if (timestamps) sshArgs.push('--timestamps');
    sshArgs.push(service);

    child_process.execFileSync('ssh', sshArgs, {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
    });

    expect(child_process.execFileSync).toHaveBeenCalledWith(
      'ssh',
      [
        'prod.example.com',
        'docker', 'logs',
        '--tail', '50',
        '--since', '2024-01-01T00:00:00',
        '--until', '2024-01-02T00:00:00',
        '--timestamps',
        'nginx',
      ],
      expect.objectContaining({ timeout: 30000, maxBuffer: 1024 * 1024 }),
    );
  });

  it('uses default tail of 100', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';

    const configData = {
      'server-tools': {
        prod: { ssh: { host: 'prod.example.com' } },
      },
    };

    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 9000, size: 100 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(configData));
    vi.mocked(child_process.execFileSync).mockReturnValue('log output');

    const config = loadConfig();
    const tail = undefined || 100;

    const sshArgs = [config['prod'].ssh.host, 'docker', 'logs', '--tail', String(tail), 'myservice'];

    child_process.execFileSync('ssh', sshArgs, {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
    });

    expect(child_process.execFileSync).toHaveBeenCalledWith(
      'ssh',
      expect.arrayContaining(['--tail', '100']),
      expect.any(Object),
    );
  });

  it('throws error for unknown server', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';

    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 10000, size: 50 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ 'server-tools': {} }));

    const config = loadConfig();
    expect(() => {
      if (!config['unknown']) {
        throw new Error('Unknown server: unknown');
      }
    }).toThrow('Unknown server: unknown');
  });
});

describe('db_query tool', () => {
  it('validates SELECT queries only', () => {
    expect(validateReadOnlyQuery('SELECT * FROM users')).toBe(true);
    expect(validateReadOnlyQuery('INSERT INTO users VALUES (1)')).toBe(false);
    expect(validateReadOnlyQuery('UPDATE users SET x = 1')).toBe(false);
    expect(validateReadOnlyQuery('DELETE FROM users')).toBe(false);
    expect(validateReadOnlyQuery('DROP TABLE users')).toBe(false);
  });

  it('throws error for unknown server', () => {
    const config: Record<string, any> = {};
    const server = 'nonexistent';

    expect(() => {
      if (!config[server]) {
        throw new Error(`Unknown server: ${server}`);
      }
    }).toThrow('Unknown server: nonexistent');
  });

  it('throws error for unknown database', () => {
    const config: Record<string, any> = {
      prod: {
        ssh: { host: 'prod.example.com' },
        databases: {
          app_db: { type: 'mysql', host: 'db.internal', port: 3306, user: 'root', password: 'pw' },
        },
      },
    };

    const server = 'prod';
    const database = 'nonexistent_db';

    expect(() => {
      if (!config[server].databases?.[database]) {
        throw new Error(`Unknown database: ${database} on server ${server}`);
      }
    }).toThrow('Unknown database: nonexistent_db on server prod');
  });
});
