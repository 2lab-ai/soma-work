const path = require('node:path');

const target = process.env.MCP_ENTRYPOINT_TARGET;
if (!target) {
  throw new Error('MCP_ENTRYPOINT_TARGET is required');
}

const serversDir = path.resolve(__dirname, '..');
process.argv[1] = path.resolve(serversDir, target, `${target}-mcp-server.js`);
require(path.resolve(serversDir, target, `${target}-mcp-server.ts`));
