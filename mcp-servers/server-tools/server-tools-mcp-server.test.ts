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
  validateClickHouseQuery,
  validateRedisCommand,
  validateMongoOperation,
  validateMongoQuery,
  validateDockerName,
  validateTimestamp,
  loadConfig,
  resetConfigCache,
  handleList,
  handleListService,
  handleLogs,
  handleDbQuery,
  handleRedisQuery,
  handleMongoDBQuery,
  handleClickHouseQuery,
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
        cache: { type: 'redis', host: 'redis.internal', port: 6379, password: 'redis-pw', db: 0 },
        docs: { type: 'mongodb', host: 'mongo.internal', port: 27017, user: 'admin', password: 'mongo-pw', authSource: 'admin', database: 'docs' },
        analytics: { type: 'clickhouse', host: 'ch.internal', port: 8123, user: 'default', password: 'ch-pw', database: 'analytics' },
      },
    },
    staging: {
      ssh: { host: 'staging.example.com' },
    },
  },
};

// ══════════════════════════════════════════════════════════════
// validateReadOnlyQuery (MySQL)
// ══════════════════════════════════════════════════════════════

describe('validateReadOnlyQuery', () => {
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

  describe('blocks multi-statement queries', () => {
    it('blocks semicolons outside string literals', () => {
      expect(validateReadOnlyQuery('SELECT 1; DROP TABLE users')).toBe(false);
      expect(validateReadOnlyQuery('SELECT * FROM users; SELECT * FROM orders')).toBe(false);
    });

    it('allows semicolons inside string literals', () => {
      expect(validateReadOnlyQuery("SELECT * FROM users WHERE name = 'test;value'")).toBe(true);
    });
  });

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

  describe('blocks MySQL executable comments', () => {
    it('blocks /*!nnnnn ... */ pattern', () => {
      expect(validateReadOnlyQuery('SELECT /*!50000 1; DROP TABLE users */')).toBe(false);
      expect(validateReadOnlyQuery('/*!32302 SELECT */ 1')).toBe(false);
      expect(validateReadOnlyQuery('SELECT /*!99999 SLEEP(10) */')).toBe(false);
    });
  });

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

  describe('blocks INTO @variable', () => {
    it('blocks SELECT INTO @var', () => {
      expect(validateReadOnlyQuery('SELECT id INTO @myvar FROM users')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('rejects empty queries', () => {
      expect(validateReadOnlyQuery('')).toBe(false);
      expect(validateReadOnlyQuery('   ')).toBe(false);
    });
  });
});

// ══════════════════════════════════════════════════════════════
// validateClickHouseQuery
// ══════════════════════════════════════════════════════════════

describe('validateClickHouseQuery', () => {
  describe('allows safe read-only queries', () => {
    it.each([
      'SELECT * FROM events',
      'SELECT count() FROM events WHERE date > today()',
      'SHOW TABLES',
      'SHOW DATABASES',
      'DESCRIBE events',
      'EXPLAIN SELECT * FROM events',
      'EXISTS TABLE events',
      'DESC events',
    ])('allows: %s', (query) => {
      expect(validateClickHouseQuery(query)).toBe(true);
    });
  });

  describe('blocks write and admin operations', () => {
    it.each([
      'INSERT INTO events VALUES (1, now())',
      'CREATE TABLE test (id UInt64) ENGINE = MergeTree()',
      'DROP TABLE events',
      'ALTER TABLE events ADD COLUMN age UInt8',
      'TRUNCATE TABLE events',
      'SYSTEM RELOAD DICTIONARIES',
      'KILL QUERY WHERE query_id = "abc"',
      'OPTIMIZE TABLE events',
      'RENAME TABLE events TO events_old',
      'GRANT SELECT ON events TO user1',
    ])('blocks: %s', (query) => {
      expect(validateClickHouseQuery(query)).toBe(false);
    });
  });

  describe('blocks dangerous table functions', () => {
    it.each([
      "SELECT * FROM url('http://evil.com/data.csv', CSV)",
      "SELECT * FROM s3('s3://bucket/key', CSV)",
      "SELECT * FROM file('/etc/passwd')",
      "SELECT * FROM remote('host:9000', db, table)",
      "SELECT * FROM mysql('host:3306', db, table, 'user', 'pw')",
      "SELECT * FROM postgresql('host:5432', db, table)",
      "SELECT * FROM jdbc('url', 'query')",
    ])('blocks: %s', (query) => {
      expect(validateClickHouseQuery(query)).toBe(false);
    });
  });

  describe('blocks SETTINGS clause', () => {
    it('blocks queries with SETTINGS', () => {
      expect(validateClickHouseQuery('SELECT 1 SETTINGS readonly=0')).toBe(false);
      expect(validateClickHouseQuery('SELECT * FROM events SETTINGS max_threads=100')).toBe(false);
    });
  });

  describe('blocks INTO OUTFILE', () => {
    it('blocks INTO OUTFILE', () => {
      expect(validateClickHouseQuery("SELECT * FROM events INTO OUTFILE '/tmp/data.csv'")).toBe(false);
    });
  });

  describe('blocks multi-statement', () => {
    it('blocks semicolons outside strings', () => {
      expect(validateClickHouseQuery('SELECT 1; DROP TABLE events')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('rejects empty queries', () => {
      expect(validateClickHouseQuery('')).toBe(false);
      expect(validateClickHouseQuery('   ')).toBe(false);
    });
  });
});

// ══════════════════════════════════════════════════════════════
// validateRedisCommand
// ══════════════════════════════════════════════════════════════

describe('validateRedisCommand', () => {
  describe('allows read-only commands', () => {
    it.each([
      ['GET', ['mykey']],
      ['MGET', ['key1', 'key2']],
      ['HGETALL', ['myhash']],
      ['HGET', ['myhash', 'field']],
      ['LRANGE', ['mylist', '0', '-1']],
      ['SMEMBERS', ['myset']],
      ['ZRANGE', ['myzset', '0', '-1']],
      ['SCAN', ['0']],
      ['TYPE', ['mykey']],
      ['TTL', ['mykey']],
      ['EXISTS', ['mykey']],
      ['INFO', []],
      ['DBSIZE', []],
      ['PING', []],
      ['STRLEN', ['mykey']],
      ['SCARD', ['myset']],
      ['LLEN', ['mylist']],
      ['ZCARD', ['myzset']],
      ['ZSCORE', ['myzset', 'member']],
      ['BITCOUNT', ['mykey']],
      ['PFCOUNT', ['myhll']],
      ['XLEN', ['mystream']],
    ] as [string, string[]][])('allows: %s', (cmd, args) => {
      expect(() => validateRedisCommand(cmd, args)).not.toThrow();
    });
  });

  describe('blocks write/admin commands', () => {
    it.each([
      ['SET', ['key', 'value']],
      ['DEL', ['key']],
      ['KEYS', ['*']],
      ['FLUSHALL', []],
      ['FLUSHDB', []],
      ['CONFIG', ['SET', 'maxmemory', '1gb']],
      ['EVAL', ['return 1', '0']],
      ['SCRIPT', ['LOAD', 'return 1']],
      ['SUBSCRIBE', ['channel']],
      ['MONITOR', []],
      ['SHUTDOWN', []],
      ['DEBUG', ['SLEEP', '10']],
      ['CLIENT', ['KILL', 'ID', '1']],
      ['SLAVEOF', ['NO', 'ONE']],
      ['REPLICAOF', ['NO', 'ONE']],
      ['BGSAVE', []],
      ['BGREWRITEAOF', []],
      ['HSET', ['myhash', 'field', 'value']],
      ['LPUSH', ['mylist', 'value']],
      ['SADD', ['myset', 'member']],
      ['ZADD', ['myzset', '1', 'member']],
      ['EXPIRE', ['key', '60']],
      ['RENAME', ['key1', 'key2']],
      ['MOVE', ['key', '1']],
    ] as [string, string[]][])('blocks: %s', (cmd, args) => {
      expect(() => validateRedisCommand(cmd, args)).toThrow(/not allowed/);
    });
  });

  describe('SCAN count cap', () => {
    it('allows SCAN with COUNT <= 100', () => {
      expect(() => validateRedisCommand('SCAN', ['0', 'COUNT', '50'])).not.toThrow();
      expect(() => validateRedisCommand('SCAN', ['0', 'COUNT', '100'])).not.toThrow();
    });

    it('blocks SCAN with COUNT > 100', () => {
      expect(() => validateRedisCommand('SCAN', ['0', 'COUNT', '10000'])).toThrow(/COUNT must be/);
    });

    it('blocks SCAN with invalid COUNT', () => {
      expect(() => validateRedisCommand('SCAN', ['0', 'COUNT', 'abc'])).toThrow(/COUNT must be/);
    });
  });

  describe('case insensitivity', () => {
    it('accepts lowercase commands', () => {
      expect(() => validateRedisCommand('get', ['mykey'])).not.toThrow();
      expect(() => validateRedisCommand('hgetall', ['myhash'])).not.toThrow();
    });
  });
});

// ══════════════════════════════════════════════════════════════
// validateMongoOperation / validateMongoQuery
// ══════════════════════════════════════════════════════════════

describe('validateMongoOperation', () => {
  describe('allows read-only operations', () => {
    it.each([
      'find', 'aggregate', 'countDocuments', 'estimatedDocumentCount',
      'distinct', 'listCollections', 'listIndexes',
    ])('allows: %s', (op) => {
      expect(() => validateMongoOperation(op)).not.toThrow();
    });
  });

  describe('blocks write operations', () => {
    it.each([
      'insertOne', 'insertMany', 'updateOne', 'updateMany',
      'deleteOne', 'deleteMany', 'replaceOne', 'drop',
      'createIndex', 'dropIndex', 'rename', 'bulkWrite',
    ])('blocks: %s', (op) => {
      expect(() => validateMongoOperation(op)).toThrow(/not allowed/);
    });
  });
});

describe('validateMongoQuery', () => {
  describe('allows safe queries', () => {
    it('allows simple filter', () => {
      expect(() => validateMongoQuery({ name: 'test', age: { $gt: 18 } })).not.toThrow();
    });

    it('allows standard operators', () => {
      expect(() => validateMongoQuery({ $and: [{ a: 1 }, { b: 2 }] })).not.toThrow();
      expect(() => validateMongoQuery({ $or: [{ a: 1 }, { b: 2 }] })).not.toThrow();
    });

    it('allows aggregation pipeline stages', () => {
      expect(() => validateMongoQuery([
        { $match: { status: 'active' } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ])).not.toThrow();
    });
  });

  describe('blocks dangerous operators', () => {
    it('blocks $where', () => {
      expect(() => validateMongoQuery({ $where: 'this.a > 1' })).toThrow(/\$where.*blocked/);
    });

    it('blocks $function', () => {
      expect(() => validateMongoQuery({
        $expr: { $function: { body: 'return true', args: [], lang: 'js' } },
      })).toThrow(/\$function.*blocked/);
    });

    it('blocks $accumulator', () => {
      expect(() => validateMongoQuery([
        { $group: { _id: null, sum: { $accumulator: { init: 'function(){return 0}' } } } },
      ])).toThrow(/\$accumulator.*blocked/);
    });

    it('blocks $out in pipeline', () => {
      expect(() => validateMongoQuery([
        { $match: { status: 'active' } },
        { $out: 'other_collection' },
      ])).toThrow(/\$out.*blocked/);
    });

    it('blocks $merge in pipeline', () => {
      expect(() => validateMongoQuery([
        { $match: { status: 'active' } },
        { $merge: { into: 'other_collection' } },
      ])).toThrow(/\$merge.*blocked/);
    });

    it('blocks nested dangerous operators', () => {
      expect(() => validateMongoQuery({
        a: { b: { c: { $where: 'true' } } },
      })).toThrow(/\$where.*blocked/);
    });
  });

  describe('handles edge cases', () => {
    it('allows null/undefined', () => {
      expect(() => validateMongoQuery(null)).not.toThrow();
      expect(() => validateMongoQuery(undefined)).not.toThrow();
    });

    it('allows empty objects', () => {
      expect(() => validateMongoQuery({})).not.toThrow();
      expect(() => validateMongoQuery([])).not.toThrow();
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

  it('loads multi-type database configs', () => {
    mockConfig(PROD_CONFIG, 1100);
    const config = loadConfig();
    const dbs = config.prod.databases!;

    expect(dbs.app_db.type).toBe('mysql');
    expect(dbs.cache.type).toBe('redis');
    expect(dbs.docs.type).toBe('mongodb');
    expect(dbs.analytics.type).toBe('clickhouse');
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
// handleList — now includes database types
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

  it('returns configured servers with databases and types', () => {
    mockConfig(PROD_CONFIG, 5000);

    const result = handleList();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.servers).toHaveLength(2);
    expect(parsed.servers[0].name).toBe('prod');
    expect(parsed.servers[0].databases).toEqual([
      { name: 'app_db', type: 'mysql' },
      { name: 'cache', type: 'redis' },
      { name: 'docs', type: 'mongodb' },
      { name: 'analytics', type: 'clickhouse' },
    ]);
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
// handleListService
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
// handleLogs
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

  it('rejects negative tail values', () => {
    mockConfig(PROD_CONFIG, 9200);
    expect(() => handleLogs({ server: 'prod', service: 'nginx', tail: -1 })).toThrow(/invalid tail/i);
  });

  it('rejects excessively large tail values', () => {
    mockConfig(PROD_CONFIG, 9300);
    expect(() => handleLogs({ server: 'prod', service: 'nginx', tail: 999999 })).toThrow(/invalid tail/i);
  });

  it('rejects non-integer tail values', () => {
    mockConfig(PROD_CONFIG, 9400);
    expect(() => handleLogs({ server: 'prod', service: 'nginx', tail: 1.5 })).toThrow(/invalid tail/i);
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
// handleDbQuery — validation path
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

  it('rejects when database is wrong type', async () => {
    mockConfig(PROD_CONFIG, 11500);
    await expect(
      handleDbQuery({ server: 'prod', database: 'cache', query: 'SELECT 1' }),
    ).rejects.toThrow('Database "cache" is type "redis", not "mysql"');
  });
});

// ══════════════════════════════════════════════════════════════
// handleRedisQuery — validation path
// ══════════════════════════════════════════════════════════════

describe('handleRedisQuery', () => {
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
    mockConfig(PROD_CONFIG, 12000);
    await expect(handleRedisQuery({ server: 'nonexistent', database: 'cache', command: 'GET', args: ['key'] })).rejects.toThrow(
      'Unknown server: nonexistent',
    );
  });

  it('throws for unknown database', async () => {
    mockConfig(PROD_CONFIG, 12100);
    await expect(handleRedisQuery({ server: 'prod', database: 'no_such_db', command: 'GET', args: ['key'] })).rejects.toThrow(
      'Unknown database: no_such_db',
    );
  });

  it('rejects write commands', async () => {
    mockConfig(PROD_CONFIG, 12200);
    await expect(
      handleRedisQuery({ server: 'prod', database: 'cache', command: 'SET', args: ['key', 'value'] }),
    ).rejects.toThrow(/not allowed/);
  });

  it('rejects FLUSHALL', async () => {
    mockConfig(PROD_CONFIG, 12300);
    await expect(
      handleRedisQuery({ server: 'prod', database: 'cache', command: 'FLUSHALL', args: [] }),
    ).rejects.toThrow(/not allowed/);
  });

  it('rejects EVAL', async () => {
    mockConfig(PROD_CONFIG, 12400);
    await expect(
      handleRedisQuery({ server: 'prod', database: 'cache', command: 'EVAL', args: ['return 1', '0'] }),
    ).rejects.toThrow(/not allowed/);
  });

  it('rejects when database is wrong type', async () => {
    mockConfig(PROD_CONFIG, 12500);
    await expect(
      handleRedisQuery({ server: 'prod', database: 'app_db', command: 'GET', args: ['key'] }),
    ).rejects.toThrow('Database "app_db" is type "mysql", not "redis"');
  });

  it('rejects missing command', async () => {
    mockConfig(PROD_CONFIG, 12600);
    await expect(
      handleRedisQuery({ server: 'prod', database: 'cache', command: '', args: [] }),
    ).rejects.toThrow('Redis command is required');
  });
});

// ══════════════════════════════════════════════════════════════
// handleMongoDBQuery — validation path
// ══════════════════════════════════════════════════════════════

describe('handleMongoDBQuery', () => {
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
    mockConfig(PROD_CONFIG, 13000);
    await expect(
      handleMongoDBQuery({ server: 'nonexistent', database: 'docs', collection: 'users', operation: 'find' }),
    ).rejects.toThrow('Unknown server: nonexistent');
  });

  it('throws for unknown database', async () => {
    mockConfig(PROD_CONFIG, 13100);
    await expect(
      handleMongoDBQuery({ server: 'prod', database: 'no_such_db', collection: 'users', operation: 'find' }),
    ).rejects.toThrow('Unknown database: no_such_db');
  });

  it('rejects write operations', async () => {
    mockConfig(PROD_CONFIG, 13200);
    await expect(
      handleMongoDBQuery({ server: 'prod', database: 'docs', collection: 'users', operation: 'deleteMany' }),
    ).rejects.toThrow(/not allowed/);
  });

  it('rejects insertOne', async () => {
    mockConfig(PROD_CONFIG, 13300);
    await expect(
      handleMongoDBQuery({ server: 'prod', database: 'docs', collection: 'users', operation: 'insertOne' }),
    ).rejects.toThrow(/not allowed/);
  });

  it('rejects $where in filter', async () => {
    mockConfig(PROD_CONFIG, 13400);
    await expect(
      handleMongoDBQuery({
        server: 'prod', database: 'docs', collection: 'users', operation: 'find',
        filter: { $where: 'this.a > 1' },
      }),
    ).rejects.toThrow(/\$where.*blocked/);
  });

  it('rejects $out in pipeline', async () => {
    mockConfig(PROD_CONFIG, 13500);
    await expect(
      handleMongoDBQuery({
        server: 'prod', database: 'docs', collection: 'users', operation: 'aggregate',
        pipeline: [{ $match: {} }, { $out: 'evil_collection' }],
      }),
    ).rejects.toThrow(/\$out.*blocked/);
  });

  it('rejects when database is wrong type', async () => {
    mockConfig(PROD_CONFIG, 13600);
    await expect(
      handleMongoDBQuery({ server: 'prod', database: 'app_db', collection: 'users', operation: 'find' }),
    ).rejects.toThrow('Database "app_db" is type "mysql", not "mongodb"');
  });
});

// ══════════════════════════════════════════════════════════════
// handleClickHouseQuery — validation path
// ══════════════════════════════════════════════════════════════

describe('handleClickHouseQuery', () => {
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
    mockConfig(PROD_CONFIG, 14000);
    await expect(
      handleClickHouseQuery({ server: 'nonexistent', database: 'analytics', query: 'SELECT 1' }),
    ).rejects.toThrow('Unknown server: nonexistent');
  });

  it('throws for unknown database', async () => {
    mockConfig(PROD_CONFIG, 14100);
    await expect(
      handleClickHouseQuery({ server: 'prod', database: 'no_such_db', query: 'SELECT 1' }),
    ).rejects.toThrow('Unknown database: no_such_db');
  });

  it('rejects write queries', async () => {
    mockConfig(PROD_CONFIG, 14200);
    await expect(
      handleClickHouseQuery({ server: 'prod', database: 'analytics', query: 'INSERT INTO events VALUES (1)' }),
    ).rejects.toThrow('Only read-only queries are allowed');
  });

  it('rejects dangerous table functions', async () => {
    mockConfig(PROD_CONFIG, 14300);
    await expect(
      handleClickHouseQuery({ server: 'prod', database: 'analytics', query: "SELECT * FROM url('http://evil.com/data.csv', CSV)" }),
    ).rejects.toThrow('Only read-only queries are allowed');
  });

  it('rejects SETTINGS override', async () => {
    mockConfig(PROD_CONFIG, 14400);
    await expect(
      handleClickHouseQuery({ server: 'prod', database: 'analytics', query: 'SELECT 1 SETTINGS readonly=0' }),
    ).rejects.toThrow('Only read-only queries are allowed');
  });

  it('rejects when database is wrong type', async () => {
    mockConfig(PROD_CONFIG, 14500);
    await expect(
      handleClickHouseQuery({ server: 'prod', database: 'app_db', query: 'SELECT 1' }),
    ).rejects.toThrow('Database "app_db" is type "mysql", not "clickhouse"');
  });
});
