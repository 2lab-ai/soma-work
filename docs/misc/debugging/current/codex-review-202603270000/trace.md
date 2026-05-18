# Bug Trace: Codex Review — server-tools MCP Server Security & Quality Issues

## AS-IS: PR #105 merged with SQL injection bypasses, SSH command injection, tautological tests, missing coverage
## TO-BE: All security holes patched, real handler tests, config-builder integration tests, config.example.json updated

---

## Phase 1: Heuristic Verification of Codex Findings

### Finding A1: MySQL executable comments bypass — ✅ CONFIRMED (CRITICAL)
- `server-tools-mcp-server.ts:79` → `query.trim().replace(/\/\*[\s\S]*?\*\//g, '').trim()`
- Strips ALL block comments including MySQL executable comments `/*!50000 DROP TABLE users */`
- Validator sees only outer safe query; MySQL executes content inside `/*!50000 ... */`
- **Attack**: `SELECT /*!50000 1; DROP TABLE users */` → validator sees `SELECT`, MySQL executes `DROP TABLE users`

### Finding A2: Comment-stripping token glue bypass — ✅ CONFIRMED (CRITICAL)
- `server-tools-mcp-server.ts:79` (comment strip) + `:87` (INTO OUTFILE check)
- `INTO/**/OUTFILE` → after stripping `/**/` → `INTOOUTFILE` (single token, no `\s+` match)
- Regex `/\bINTO\s+(OUTFILE|DUMPFILE)\b/i` requires whitespace — misses glued token
- Original query sent to MySQL, where `/**/` is treated as separator → `INTO OUTFILE` executes
- **Attack**: `SELECT * FROM users INTO/**/OUTFILE '/tmp/data.csv'` → passes validator, MySQL writes file

### Finding A3: Escaped quotes in semicolon scanning — ❌ LOW/FALSE POSITIVE
- `server-tools-mcp-server.ts:84` → `stripped.replace(/'[^']*'/g, '')`
- Tested: `'foo\'; DROP TABLE'` — regex matches `'foo\'`, leaves `; DROP TABLE'` — semicolon CAUGHT
- Not a bypass vector. May cause false-positive blocks on legitimate queries with backslash escapes, but NOT a security hole.

### Finding A4: Dangerous read statements — ✅ CONFIRMED (HIGH)
- No check for: `SELECT SLEEP(999)`, `SELECT LOAD_FILE('/etc/passwd')`, `SELECT ... FOR UPDATE`, `SELECT GET_LOCK()`
- All start with SELECT → pass first-word check
- `SLEEP` = DoS, `LOAD_FILE` = file read from DB server, `FOR UPDATE` = row locks
- **Severity**: HIGH — LOAD_FILE especially dangerous

### Finding A5: SSH command injection — ✅ CONFIRMED (CRITICAL)
- `server-tools-mcp-server.ts:146-158` — `execFileSync('ssh', sshArgs, ...)`
- `execFileSync` passes args as array (no local shell injection)
- BUT SSH concatenates remote args into single string for remote shell
- `service = "nginx; rm -rf /"` → remote executes `docker logs --tail 50 nginx; rm -rf /`
- Same for `since` (line 148) and `until` (line 149) — all user-controlled, unvalidated
- **server name** is safe (validated against config keys at line 109)

### Finding B6: tail=0 bug — ✅ CONFIRMED (LOW)
- `server-tools-mcp-server.ts:134` → `const tail = (args.tail as number) || 100`
- `0 || 100` = `100`. Falsy coalescing. Should use `?? 100` or explicit check.

### Finding C7: Tautological tests — ✅ CONFIRMED (HIGH)
- `server-tools-mcp-server.test.ts:222-227` (list) — re-implements `handleList` logic with `Object.entries(config).map(...)`
- `server-tools-mcp-server.test.ts:284-308` (list_service) — re-implements `handleListService` with inline `execFileSync` call
- `server-tools-mcp-server.test.ts:350-384` (logs) — re-implements `handleLogs` with inline SSH arg building
- `server-tools-mcp-server.test.ts:442-471` (db_query) — re-implements error checks inline
- **None call the actual handler functions.**

### Finding C8-10: No handler tests — ✅ CONFIRMED (HIGH)
- `handleList`, `handleListService`, `handleLogs`, `handleDbQuery` are never invoked in tests
- No MCP error wrapper test (the try/catch in CallToolRequestSchema handler)
- No db_query happy-path test

### Finding D11-12: Missing config-builder integration tests — ✅ CONFIRMED (MEDIUM)
- `mcp-config-builder.test.ts` — no test asserts MCP_SERVERS_DIR paths
- No test for `hasServerToolsConfig()` or `mcp__server-tools` in `buildAllowedTools()`

### Finding D13: config.example.json missing server-tools — ✅ CONFIRMED (LOW)
- File exists at root, has `mcpServers` and `plugin` sections
- No `server-tools` section present — spec required it

---

## Severity Summary

| # | Finding | Severity | Action |
|---|---------|----------|--------|
| A1 | MySQL executable comments bypass | CRITICAL | Validate BEFORE stripping, or detect `/*!` pattern |
| A2 | Comment token glue bypass | CRITICAL | Check INTO OUTFILE on ORIGINAL query |
| A4 | Dangerous read functions | HIGH | Block SLEEP, LOAD_FILE, FOR UPDATE, GET_LOCK |
| A5 | SSH command injection | CRITICAL | Sanitize service/since/until — allowlist chars |
| C7 | Tautological tests | HIGH | Rewrite to call actual handlers |
| C8-10 | No handler tests | HIGH | Export handlers, write proper tests |
| B6 | tail=0 bug | LOW | Use `??` instead of `||` |
| D11-12 | Missing config-builder tests | MEDIUM | Add integration tests |
| D13 | config.example.json | LOW | Add server-tools section |
| A3 | Escaped quotes false positive | LOW | Not a security issue, cosmetic |

## Conclusion

3 CRITICAL, 3 HIGH, 1 MEDIUM, 3 LOW issues confirmed.
Core problems: validateReadOnlyQuery is fundamentally flawed (allowlist approach on stripped text), SSH args unsanitized, tests never call production code.
