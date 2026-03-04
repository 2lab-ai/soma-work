# Trace: Disallow Native Interactive Tools

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| 1 | McpConfig includes disallowedTools field | tiny | GREEN |
| 2 | buildConfig populates disallowedTools for Slack context | small | GREEN |
| 3 | buildConfig omits disallowedTools without Slack context | tiny | GREEN |
| 4 | streamQuery applies disallowedTools to SDK options | small | GREEN |

---

## Scenario 1: McpConfig includes disallowedTools field

### Trace

```
McpConfig interface
  └─ disallowedTools?: string[]  // NEW field
```

### Contract Test

```typescript
// mcp-config-builder.test.ts
it('McpConfig type includes disallowedTools field', () => {
  const config: McpConfig = {
    permissionMode: 'default',
    userBypass: false,
    disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'],
  };
  expect(config.disallowedTools).toEqual(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
});
```

---

## Scenario 2: buildConfig populates disallowedTools for Slack context

### Trace

```
McpConfigBuilder.buildConfig(slackContext)
  └─ slackContext provided?
       └─ YES → config.disallowedTools = NATIVE_INTERACTIVE_TOOLS
       └─ NO  → config.disallowedTools = undefined (Scenario 3)
```

### Contract Test

```typescript
// mcp-config-builder.test.ts
it('populates disallowedTools when slackContext is provided', async () => {
  const slackContext = { channel: 'C123', user: 'U123' };
  const config = await builder.buildConfig(slackContext);
  expect(config.disallowedTools).toContain('AskUserQuestion');
  expect(config.disallowedTools).toContain('EnterPlanMode');
  expect(config.disallowedTools).toContain('ExitPlanMode');
});
```

---

## Scenario 3: buildConfig omits disallowedTools without Slack context

### Trace

```
McpConfigBuilder.buildConfig(undefined)
  └─ slackContext = undefined
       └─ config.disallowedTools = undefined
```

### Contract Test

```typescript
// mcp-config-builder.test.ts
it('does not set disallowedTools without slackContext', async () => {
  const config = await builder.buildConfig();
  expect(config.disallowedTools).toBeUndefined();
});
```

---

## Scenario 4: streamQuery applies disallowedTools to SDK options

### Trace

```
ClaudeHandler.streamQuery(prompt, session, ..., slackContext)
  └─ mcpConfigBuilder.buildConfig(slackContext)
       └─ returns config with disallowedTools
  └─ options.disallowedTools = mcpConfig.disallowedTools  // NEW
  └─ query({ prompt, options })
       └─ SDK removes AskUserQuestion, EnterPlanMode, ExitPlanMode from model context
```

### Contract Test

```typescript
// claude-handler.test.ts
it('passes disallowedTools to SDK options when slackContext provided', async () => {
  // Verify that streamQuery builds options with disallowedTools
  // from mcpConfigBuilder.buildConfig()
});
```
