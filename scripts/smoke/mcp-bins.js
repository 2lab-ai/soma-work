#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const bins = [
  ['agent', '@soma/mcp-server-agent/bin', 'agent-mcp-server.js'],
  ['cron', '@soma/mcp-server-cron/bin', 'cron-mcp-server.js'],
  ['llm', '@soma/mcp-server-llm/bin', 'llm-mcp-server.js'],
  ['mcp-tool-permission', '@soma/mcp-server-mcp-tool-permission/bin', 'mcp-tool-permission-mcp-server.js'],
  ['model-command', '@soma/mcp-server-model-command/bin', 'model-command-mcp-server.js'],
  ['permission', '@soma/mcp-server-permission/bin', 'permission-mcp-server.js'],
  ['server-tools', '@soma/mcp-server-server-tools/bin', 'server-tools-mcp-server.js'],
  ['slack-mcp', '@soma/mcp-server-slack-mcp/bin', 'slack-mcp-server.js'],
];

let failures = 0;

for (const [name, specifier, expectedFile] of bins) {
  try {
    const resolved = require.resolve(specifier);
    const normalized = resolved.split(path.sep).join('/');
    if (!normalized.endsWith(`/dist/${expectedFile}`)) {
      console.error(`INVALID ${name}: expected dist/${expectedFile}, got ${resolved}`);
      failures++;
      continue;
    }
    if (!fs.existsSync(resolved)) {
      console.error(`MISSING ${name}: ${resolved}`);
      failures++;
      continue;
    }
    console.log(`OK ${name}: ${resolved}`);
  } catch (error) {
    console.error(`UNRESOLVED ${name}: ${specifier}`);
    console.error(error instanceof Error ? error.message : String(error));
    failures++;
  }
}

if (failures > 0) {
  process.exit(1);
}
