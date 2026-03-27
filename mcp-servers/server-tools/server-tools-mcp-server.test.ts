import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as child_process from 'child_process';

// Mock child_process BEFORE importing the module under test
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
vi.mock('../_shared/stderr-logger.js', () => ({
  StderrLogger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));

import {
  validateReadOnlyQuery,
  validateDockerName,
  validateTimestamp,
  loadConfig,
  resetConfigCache,
  handleList,
  handleListService,
  handleLogs,
  handleDbQuery,
} from './server-tools-mcp-server.js';

// ── Helper: set up config mock ──────────────────────────────

function mockConfig(data: Record<string, any>, mtimeMs = Date.now()) {
  process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';
  vi.mocked(fs.statSync).mockReturnValue({ mtimeMs, size: 999 } as fs.Stats);
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data));
  resetConfigCache();
  loadConfig();
}

const PROD_CONFIG = {
  'server-tools': {
    prod: {
      ssh: { host: 'prod.example.com' },
      databases: {
        app_db: { type: 'mysql', host: 'db.internal', port: 3306, user: 'root', password: 'pw' },
      },
    },
    staging: {
      ssh: { host: 'staging.example.com' },
    },
  },
};

// ══════════════════════════════════════════════════════════════
// validateReadOnlyQuery
// ══════════════════════════════════════════════════════════════

describe('validateReadOnlyQuery', () => {
  // ── Allowed queries ───────────────────────────────────────
  describe('allows safe read-only queries', () => {
    it.each([
      'SELECT * FROM users',
      'select id, name from users where id = 1',
      '  SELECT count(*) FROM orders  ',
      'SHOW TABLES',
      'SHOW DATABASES',
      'DESCRIBE users',
      'EXPLAIN SELECT * FROM users',
      'DESC users',
      '/* comment */ SELECT * FROM users',
      '/* DROP TABLE users */ SELECT 1',
    ])('allows: %s', (query) => {
      expect(validateReadOnlyQuery(query)).toBe(true);
    });
  });

  // ── Blocked: basic write operations ──────────────────────
  describe('blocks write operations', () => {
    it.each([
      'INSERT INTO users VALUES (1, "test")',
      'UPDATE users SET name = "test"',
      'DELETE FROM users WHERE id = 1',
      'DROP TABLE users',
      'CREATE TABLE test (id INT)',
      'ALTER TABLE users ADD COLUMN age INT',
      'TRUNCATE TABLE users',
    ])('blocks: %s', (query) => {
      expect(validateReadOnlyQuery(query)).toBe(false);
    });
  });

  // ── Blocked: semicolons (multi-statement) ────────────────
  describe('blocks multi-statement queries', () => {
    it('blocks semicolons outside string literals', () => {
      expect(validateReadOnlyQuery('SELECT 1; DROP TABLE users')).toBe(false);
      expect(validateReadOnlyQuery('SELECT * FROM users; SELECT * FROM orders')).toBe(false);
    });

    it('allows semicolons inside string literals', () => {
      expect(validateReadOnlyQuery("SELECT * FROM users WHERE name = 'test;value'")).toBe(true);
    });
  });

  // ── Blocked: INTO OUTFILE/DUMPFILE ───────────────────────
  describe('blocks INTO OUTFILE/DUMPFILE', () => {
    it('blocks standard INTO OUTFILE', () => {
      expect(validateReadOnlyQuery("SELECT * FROM users INTO OUTFILE '/tmp/data.csv'")).toBe(false);
      expect(validateReadOnlyQuery("SELECT * FROM users INTO DUMPFILE '/tmp/data.bin'")).toBe(false);
      expect(validateReadOnlyQuery("SELECT * FROM users into outfile '/tmp/data.csv'")).toBe(false);
    });

    it('blocks INTO/**/OUTFILE comment token glue', () => {
      expect(validateReadOnlyQuery("SELECT * FROM users INTO/**/OUTFILE '/tmp/x'")).toBe(false);
      expect(validateReadOnlyQuery("SELECT * FROM users INTO /* */ OUTFILE '/tmp/x'")).toBe(false);
      expect(validateReadOnlyQuery("SELECT * FROM users INTO/**/DUMPFILE '/tmp/x'")).toBe(false);
    });
  });

  // ── Blocked: MySQL executable comments ───────────────────
  describe('blocks MySQL executable comments', () => {
    it('blocks /*!nnnnn ... */ pattern', () => {
      expect(validateReadOnlyQuery('SELECT /*!50000 1; DROP TABLE users */')).toBe(false);
      expect(validateReadOnlyQuery('/*!32302 SELECT */ 1')).toBe(false);
      expect(validateReadOnlyQuery('SELECT /*!99999 SLEEP(10) */')).toBe(false);
    });
  });

  // ── Blocked: dangerous functions ─────────────────────────
  describe('blocks dangerous SQL functions', () => {
    it.each([
      'SELECT SLEEP(999)',
      'SELECT LOAD_FILE("/etc/passwd")',
      'SELECT BENCHMARK(1000000, SHA1("test"))',
      'SELECT GET_LOCK("x", 100)',
      'SELECT RELEASE_LOCK("x")',
      'SELECT IS_FREE_LOCK("x")',
    ])('blocks: %s', (query) => {
      expect(validateReadOnlyQuery(query)).toBe(false);
    });
  });

  // ── Blocked: locking clauses ─────────────────────────────
  describe('blocks locking clauses', () => {
    it('blocks FOR UPDATE', () => {
      expect(validateReadOnlyQuery('SELECT * FROM users FOR UPDATE')).toBe(false);
    });

    it('blocks LOCK IN SHARE MODE', () => {
      expect(validateReadOnlyQuery('SELECT * FROM users LOCK IN SHARE MODE')).toBe(false);
    });

    it('blocks FOR SHARE', () => {
      expect(validateReadOnlyQuery('SELECT * FROM users FOR SHARE')).toBe(false);
    });
  });

  // ── Blocked: INTO @variable ──────────────────────────────
  describe('blocks INTO @variable', () => {
    it('blocks SELECT INTO @var', () => {
      expect(validateReadOnlyQuery('SELECT id INTO @myvar FROM users')).toBe(false);
    });
  });

  // ── Edge cases ───────────────────────────────────────────
  describe('edge cases', () => {
    it('rejects empty queries', () => {
      expect(validateReadOnlyQuery('')).toBe(false);
      expect(validateReadOnlyQuery('   ')).toBe(false);
    });
  });
});

// ══════════════════════════════════════════════════════════════
// Input Sanitization
// ══════════════════════════════════════════════════════════════

describe('validateDockerName', () => {
  it('accepts valid Docker container names', () => {
    expect(() => validateDockerName('nginx', 'service')).not.toThrow();
    expect(() => validateDockerName('my-app_web.1', 'service')).not.toThrow();
    expect(() => validateDockerName('redis-cluster', 'service')).not.toThrow();
    expect(() => validateDockerName('a', 'service')).not.toThrow();
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => validateDockerName('nginx; rm -rf /', 'service')).toThrow(/invalid.*service/i);
    expect(() => validateDockerName('nginx$(whoami)', 'service')).toThrow(/invalid.*service/i);
    expect(() => validateDockerName('test`id`', 'service')).toThrow(/invalid.*service/i);
    expect(() => validateDockerName('a | cat /etc/passwd', 'service')).toThrow(/invalid.*service/i);
  });

  it('rejects names starting with special chars', () => {
    expect(() => validateDockerName('.hidden', 'service')).toThrow(/invalid.*service/i);
    expect(() => validateDockerName('-flag', 'service')).toThrow(/invalid.*service/i);
  });

  it('rejects empty names', () => {
    expect(() => validateDockerName('', 'service')).toThrow(/invalid.*service/i);
  });
});

describe('validateTimestamp', () => {
  it('accepts valid ISO 8601 dates and durations', () => {
    expect(() => validateTimestamp('2024-01-01', 'since')).not.toThrow();
    expect(() => validateTimestamp('2024-01-01T00:00', 'since')).not.toThrow();
    expect(() => validateTimestamp('2024-01-01T00:00:00', 'since')).not.toThrow();
    expect(() => validateTimestamp('10m', 'since')).not.toThrow();
    expect(() => validateTimestamp('1h', 'since')).not.toThrow();
    expect(() => validateTimestamp('2d', 'since')).not.toThrow();
    expect(() => validateTimestamp('30s', 'since')).not.toThrow();
  });

  it('rejects values with shell metacharacters', () => {
    expect(() => validateTimestamp('1h; rm -rf /', 'since')).toThrow(/invalid.*since/i);
    expect(() => validateTimestamp('$(date)', 'since')).toThrow(/invalid.*since/i);
    expect(() => validateTimestamp('`date`', 'since')).toThrow(/invalid.*since/i);
  });

  it('rejects empty values', () => {
    expect(() => validateTimestamp('', 'since')).toThrow(/invalid.*since/i);
  });
});

// ══════════════════════════════════════════════════════════════
// Config loading
// ══════════════════════════════════════════════════════════════

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
    mockConfig(PROD_CONFIG, 1000);
    const config = loadConfig();
    expect(config).toHaveProperty('prod');
    expect(config.prod.ssh.host).toBe('prod.example.com');
    expect(config.prod.databases?.app_db.host).toBe('db.internal');
  });

  it('returns empty config when server-tools section is missing', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 2000, size: 100 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ other: {} }));
    resetConfigCache();

    const config = loadConfig();
    expect(Object.keys(config)).toHaveLength(0);
  });

  it('uses mtime cache and does not re-read unchanged file', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';
    vi.mocked(fs.statSync).mockClear();
    vi.mocked(fs.readFileSync).mockClear();

    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 3000, size: 200 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ 'server-tools': { staging: { ssh: { host: 'staging.example.com' } } } }),
    );

    resetConfigCache();
    loadConfig();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);

    // Same mtime → cache hit
    loadConfig();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);

    // Changed mtime → re-read
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 4000, size: 200 } as fs.Stats);
    loadConfig();
    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
  });
});

// ══════════════════════════════════════════════════════════════
// handleList — calls actual handler
// ══════════════════════════════════════════════════════════════

describe('handleList', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfigCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('returns configured servers with databases', () => {
    mockConfig(PROD_CONFIG, 5000);

    const result = handleList();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.servers).toHaveLength(2);
    expect(parsed.servers[0]).toEqual({
      name: 'prod',
      ssh_host: 'prod.example.com',
      databases: ['app_db'],
    });
    expect(parsed.servers[1]).toEqual({
      name: 'staging',
      ssh_host: 'staging.example.com',
      databases: [],
    });
  });

  it('returns empty array when no config', () => {
    delete process.env.SOMA_CONFIG_FILE;
    resetConfigCache();

    const result = handleList();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.servers).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════
// handleListService — calls actual handler
// ══════════════════════════════════════════════════════════════

describe('handleListService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfigCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('calls SSH with correct args and parses JSON output', () => {
    mockConfig(PROD_CONFIG, 6000);

    const dockerOutput = '{"Names":"nginx","Status":"Up 2 hours"}\n{"Names":"redis","Status":"Up 3 hours"}\n';
    vi.mocked(child_process.execFileSync).mockReturnValue(dockerOutput);

    const result = handleListService({ server: 'prod' });
    const containers = JSON.parse(result.content[0].text);

    expect(child_process.execFileSync).toHaveBeenCalledWith(
      'ssh',
      ['prod.example.com', 'docker', 'ps', '--format', 'json'],
      expect.objectContaining({ timeout: 30000 }),
    );
    expect(containers).toHaveLength(2);
    expect(containers[0].Names).toBe('nginx');
  });

  it('throws for unknown server', () => {
    mockConfig(PROD_CONFIG, 7000);
    expect(() => handleListService({ server: 'nonexistent' })).toThrow('Unknown server: nonexistent');
  });
});

// ══════════════════════════════════════════════════════════════
// handleLogs — calls actual handler
// ══════════════════════════════════════════════════════════════

describe('handleLogs', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfigCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('calls SSH with all options', () => {
    mockConfig(PROD_CONFIG, 8000);
    vi.mocked(child_process.execFileSync).mockReturnValue('log output');

    handleLogs({
      server: 'prod',
      service: 'nginx',
      tail: 50,
      since: '2024-01-01T00:00:00',
      until: '2024-01-02T00:00:00',
      timestamps: true,
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

  it('defaults tail to 100 when omitted', () => {
    mockConfig(PROD_CONFIG, 9000);
    vi.mocked(child_process.execFileSync).mockReturnValue('output');

    handleLogs({ server: 'prod', service: 'nginx' });

    expect(child_process.execFileSync).toHaveBeenCalledWith(
      'ssh',
      expect.arrayContaining(['--tail', '100']),
      expect.any(Object),
    );
  });

  it('passes tail=0 as "0", not "100"', () => {
    mockConfig(PROD_CONFIG, 9100);
    vi.mocked(child_process.execFileSync).mockReturnValue('output');

    handleLogs({ server: 'prod', service: 'nginx', tail: 0 });

    expect(child_process.execFileSync).toHaveBeenCalledWith(
      'ssh',
      expect.arrayContaining(['--tail', '0']),
      expect.any(Object),
    );
  });

  it('throws for unknown server', () => {
    mockConfig(PROD_CONFIG, 10000);
    expect(() => handleLogs({ server: 'unknown', service: 'nginx' })).toThrow('Unknown server: unknown');
  });

  it('rejects service names with shell metacharacters', () => {
    mockConfig(PROD_CONFIG, 10100);
    expect(() => handleLogs({ server: 'prod', service: 'nginx; rm -rf /' })).toThrow(/invalid.*service/i);
    expect(() => handleLogs({ server: 'prod', service: 'nginx$(whoami)' })).toThrow(/invalid.*service/i);
  });

  it('rejects since/until with shell metacharacters', () => {
    mockConfig(PROD_CONFIG, 10200);
    expect(() => handleLogs({ server: 'prod', service: 'nginx', since: '1h; rm -rf /' })).toThrow(
      /invalid.*since/i,
    );
    expect(() => handleLogs({ server: 'prod', service: 'nginx', until: '$(date)' })).toThrow(
      /invalid.*until/i,
    );
  });

  it('returns log output as text content', () => {
    mockConfig(PROD_CONFIG, 10300);
    vi.mocked(child_process.execFileSync).mockReturnValue('line1\nline2\nline3\n');

    const result = handleLogs({ server: 'prod', service: 'nginx', tail: 3 });

    expect(result.content[0].text).toBe('line1\nline2\nline3\n');
    expect(result.content[0].type).toBe('text');
  });
});

// ══════════════════════════════════════════════════════════════
// handleDbQuery — calls actual handler (validation path only)
// ══════════════════════════════════════════════════════════════

describe('handleDbQuery', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfigCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('throws for unknown server', async () => {
    mockConfig(PROD_CONFIG, 11000);
    await expect(handleDbQuery({ server: 'nonexistent', database: 'app_db', query: 'SELECT 1' })).rejects.toThrow(
      'Unknown server: nonexistent',
    );
  });

  it('throws for unknown database', async () => {
    mockConfig(PROD_CONFIG, 11100);
    await expect(handleDbQuery({ server: 'prod', database: 'no_such_db', query: 'SELECT 1' })).rejects.toThrow(
      'Unknown database: no_such_db on server prod',
    );
  });

  it('rejects non-read-only queries', async () => {
    mockConfig(PROD_CONFIG, 11200);
    await expect(handleDbQuery({ server: 'prod', database: 'app_db', query: 'DROP TABLE users' })).rejects.toThrow(
      'Only read-only queries are allowed',
    );
  });

  it('rejects queries with SLEEP', async () => {
    mockConfig(PROD_CONFIG, 11300);
    await expect(handleDbQuery({ server: 'prod', database: 'app_db', query: 'SELECT SLEEP(999)' })).rejects.toThrow(
      'Only read-only queries are allowed',
    );
  });

  it('rejects MySQL executable comment injection', async () => {
    mockConfig(PROD_CONFIG, 11400);
    await expect(
      handleDbQuery({ server: 'prod', database: 'app_db', query: 'SELECT /*!50000 1; DROP TABLE users */' }),
    ).rejects.toThrow('Only read-only queries are allowed');
  });
});
