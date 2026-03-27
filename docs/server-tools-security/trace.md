# server-tools Security Hardening — Trace

> STV Trace | Created: 2026-03-27 | Spec: docs/server-tools-security/spec.md

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| 1 | SQL: MySQL executable comment block | small | 🔴 RED |
| 2 | SQL: Comment token glue (INTO/**/OUTFILE) | small | 🔴 RED |
| 3 | SQL: Dangerous function blocklist | small | 🔴 RED |
| 4 | SSH: Arg sanitization | small | 🔴 RED |
| 5 | Bug: tail=0 fix | tiny | 🔴 RED |
| 6 | Test: Export handlers + real handler tests | medium | 🔴 RED |
| 7 | Test: config-builder server-tools wiring | small | 🔴 RED |
| 8 | Config: config.example.json update | tiny | 🔴 RED |

---

## Scenario 1: SQL — MySQL executable comment block

### Trace
```
validateReadOnlyQuery(query)
  → server-tools-mcp-server.ts:78-89
  → CURRENT: strips all block comments (line 79)
  → MySQL executable comments (/*!50000 ... */) are stripped → content inside executes on MySQL
  → FIX: detect /*!  pattern BEFORE stripping → reject immediately
```

### Parameter Flow
```
query: "SELECT /*!50000 1; DROP TABLE users */"
  → strip comments → "SELECT "
  → firstWord = "SELECT" → passes ✅ (WRONG — should fail)
  → FIX: /\/\*!/ detected → return false
```

### Contract Test
```typescript
it('blocks MySQL executable comments', () => {
  expect(validateReadOnlyQuery('SELECT /*!50000 1; DROP TABLE users */')).toBe(false);
  expect(validateReadOnlyQuery('/*!32302 SELECT */ 1')).toBe(false);
});
```

---

## Scenario 2: SQL — Comment token glue

### Trace
```
validateReadOnlyQuery(query)
  → server-tools-mcp-server.ts:79 strips /**/ → tokens glue
  → server-tools-mcp-server.ts:87 checks stripped text for INTO\s+OUTFILE
  → "INTO/**/OUTFILE" → stripped to "INTOOUTFILE" → no match
  → FIX: check INTO OUTFILE on ORIGINAL query (before stripping)
```

### Parameter Flow
```
query: "SELECT * FROM users INTO/**/OUTFILE '/tmp/x'"
  → stripped: "SELECT * FROM users INTOOUTFILE '/tmp/x'"
  → INTO\s+OUTFILE check on stripped: NO MATCH (WRONG)
  → FIX: check on original query: "INTO/**/OUTFILE" → /INTO\s*(?:\/\*.*?\*\/\s*)*OUTFILE/i
  → OR simply: check on original query with comment-tolerant regex
```

### Contract Test
```typescript
it('blocks INTO OUTFILE with comment glue', () => {
  expect(validateReadOnlyQuery('SELECT * FROM users INTO/**/OUTFILE \'/tmp/x\'')).toBe(false);
  expect(validateReadOnlyQuery('SELECT * FROM users INTO /* */ OUTFILE \'/tmp/x\'')).toBe(false);
  expect(validateReadOnlyQuery('SELECT * FROM users INTO/**/DUMPFILE \'/tmp/x\'')).toBe(false);
});
```

---

## Scenario 3: SQL — Dangerous function blocklist

### Trace
```
validateReadOnlyQuery(query)
  → CURRENT: no check for dangerous functions
  → SLEEP(N) blocks connection = DoS
  → LOAD_FILE('/path') reads server filesystem
  → BENCHMARK(N, expr) = DoS
  → GET_LOCK('name', N) = resource lock DoS
  → SELECT ... FOR UPDATE = row lock
  → SELECT ... LOCK IN SHARE MODE = shared lock
  → SELECT ... INTO @var = variable assignment (information leak path)
  → FIX: blocklist regex after allowlist check
```

### Contract Test
```typescript
it('blocks dangerous SQL functions', () => {
  expect(validateReadOnlyQuery('SELECT SLEEP(999)')).toBe(false);
  expect(validateReadOnlyQuery('SELECT LOAD_FILE("/etc/passwd")')).toBe(false);
  expect(validateReadOnlyQuery('SELECT BENCHMARK(1000000, SHA1("test"))')).toBe(false);
  expect(validateReadOnlyQuery('SELECT GET_LOCK("x", 100)')).toBe(false);
});

it('blocks locking clauses', () => {
  expect(validateReadOnlyQuery('SELECT * FROM users FOR UPDATE')).toBe(false);
  expect(validateReadOnlyQuery('SELECT * FROM users LOCK IN SHARE MODE')).toBe(false);
});

it('blocks SELECT INTO @variable', () => {
  expect(validateReadOnlyQuery('SELECT id INTO @myvar FROM users')).toBe(false);
});
```

---

## Scenario 4: SSH — Arg sanitization

### Trace
```
handleLogs(args) / handleListService(args)
  → server-tools-mcp-server.ts:105-129 (list_service)
  → server-tools-mcp-server.ts:131-163 (logs)
  → service arg: line 133 → directly pushed to sshArgs line 152
  → since/until: lines 148-149 → directly pushed
  → execFileSync('ssh', sshArgs) → SSH concatenates for remote shell
  → FIX: validate before use
    → service: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
    → since/until: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/ or /^\d+[smhd]$/
```

### Contract Test
```typescript
it('rejects service names with shell metacharacters', () => {
  expect(() => handleLogs({ server: 'prod', service: 'nginx; rm -rf /', tail: 10 }))
    .toThrow(/invalid.*service/i);
  expect(() => handleLogs({ server: 'prod', service: 'nginx$(whoami)', tail: 10 }))
    .toThrow(/invalid.*service/i);
  expect(() => handleListService({ server: 'prod', service: 'test`id`' }))
    .toThrow(/invalid.*service/i);
});

it('rejects since/until with shell metacharacters', () => {
  expect(() => handleLogs({ server: 'prod', service: 'nginx', since: '1h; rm -rf /' }))
    .toThrow(/invalid.*since/i);
});

it('accepts valid Docker container names', () => {
  // Should not throw (execFileSync is mocked)
  handleLogs({ server: 'prod', service: 'my-app_web.1', tail: 10 });
  handleListService({ server: 'prod', service: 'nginx-proxy' });
});
```

---

## Scenario 5: Bug — tail=0 fix

### Trace
```
handleLogs(args)
  → server-tools-mcp-server.ts:134
  → const tail = (args.tail as number) || 100
  → 0 || 100 = 100 (falsy coalescing bug)
  → FIX: (args.tail as number) ?? 100
```

### Contract Test
```typescript
it('passes tail=0 as 0, not 100', () => {
  handleLogs({ server: 'prod', service: 'nginx', tail: 0 });
  expect(execFileSync).toHaveBeenCalledWith(
    'ssh', expect.arrayContaining(['--tail', '0']), expect.any(Object)
  );
});
```

---

## Scenario 6: Test — Export handlers + real handler tests

### Trace
```
CURRENT: handleList, handleListService, handleLogs, handleDbQuery are module-private functions
  → Tests cannot import them → tests re-implement logic inline (tautological)
  → FIX: export all 4 handlers
  → Rewrite tests to call exported handlers with mocked dependencies
  → Delete tautological test blocks
```

### Changes
```
server-tools-mcp-server.ts:
  - function handleList()          → export function handleList()
  - function handleListService()   → export function handleListService()
  - function handleLogs()          → export function handleLogs()
  - async function handleDbQuery() → export async function handleDbQuery()

server-tools-mcp-server.test.ts:
  - import { handleList, handleListService, handleLogs, handleDbQuery } from './server-tools-mcp-server.js'
  - Replace tautological tests with direct handler calls
  - Add MCP error wrapper test (CallToolRequestSchema handler try/catch)
```

---

## Scenario 7: Test — config-builder server-tools wiring

### Trace
```
mcp-config-builder.ts:
  → hasServerToolsConfig() at line 436-445
  → buildServerToolsServer() at line 450-459
  → buildAllowedTools() adds 'mcp__server-tools' at line 422-424
  → buildConfig() checks hasServerToolsConfig() at line 162-164

mcp-config-builder.test.ts:
  → No test for hasServerToolsConfig()
  → No test for mcp__server-tools in allowedTools
  → FIX: Add test with mocked CONFIG_FILE
```

### Contract Test
```typescript
it('includes server-tools server and allowed tool when config has server-tools section', async () => {
  // Mock CONFIG_FILE to return config with server-tools section
  const builder = new McpConfigBuilder(mockMcpManager);
  const config = await builder.buildConfig({ channel: 'C1', user: 'U1' });
  expect(config.mcpServers?.['server-tools']).toBeDefined();
  expect(config.allowedTools).toContain('mcp__server-tools');
});

it('does NOT include server-tools when config has no server-tools section', async () => {
  // Mock CONFIG_FILE to return config WITHOUT server-tools
  const builder = new McpConfigBuilder(mockMcpManager);
  const config = await builder.buildConfig({ channel: 'C1', user: 'U1' });
  expect(config.mcpServers?.['server-tools']).toBeUndefined();
  expect(config.allowedTools).not.toContain('mcp__server-tools');
});
```

---

## Scenario 8: Config — config.example.json update

### Trace
```
config.example.json:
  → Currently has: mcpServers, plugin
  → Missing: server-tools section
  → FIX: Add server-tools example with placeholder values
```

### Change
```json
{
  "server-tools": {
    "example-server": {
      "ssh": { "host": "your-server.example.com" },
      "databases": {
        "main": {
          "type": "mysql",
          "host": "127.0.0.1",
          "port": 3306,
          "user": "readonly_user",
          "password": "your_password"
        }
      }
    }
  }
}
```
