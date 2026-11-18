import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY_SERVER_TOOLS, NO_SECRET_SERVER_TOOLS, SERVER_TOOLS_CATALOG } from '../catalog';

/**
 * secret-access WU3 (#1339): the bot's table of server-tools tools is the tools server-tools registers — no more,
 * no fewer. A tool added to `defineTools` without a catalog row would be invisible on the 서버 도구 tab and would
 * count as "uses every secret of its server" at the gate; this test makes that a CI failure instead.
 */

const SERVER_SOURCE = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'mcp-servers',
  'server-tools',
  'server-tools-mcp-server.ts',
);

function registeredTools(): string[] {
  const source = fs.readFileSync(SERVER_SOURCE, 'utf-8');
  const start = source.indexOf('defineTools(): ToolDefinition[] {');
  expect(start, 'defineTools in server-tools').toBeGreaterThan(0);
  const body = source.slice(start, source.indexOf('\n  }\n', start));
  return [...body.matchAll(/^ {8}name: '([a-z_]+)',$/gm)].map((m) => m[1]).sort();
}

describe('server-tools catalog', () => {
  it('names exactly the tools server-tools registers', () => {
    expect(SERVER_TOOLS_CATALOG.map((t) => t.name).sort()).toEqual(registeredTools());
  });

  it('keeps the admin-only set the policy had before the move', () => {
    expect([...ADMIN_ONLY_SERVER_TOOLS.keys()].sort()).toEqual(
      ['cf_api', 'gh_pr', 'gh_read', 'login', 'phone_call', 'ssh_exec'].map((t) => `mcp__server-tools__${t}`),
    );
  });

  it('a tool that uses no secret is never one that reads a secret-bearing section', () => {
    for (const tool of SERVER_TOOLS_CATALOG) {
      if (!NO_SECRET_SERVER_TOOLS.has(tool.name)) continue;
      expect(
        tool.sections.filter((s) => ['databases', 'github', 'web', 'cloudflare'].includes(s)),
        tool.name,
      ).toEqual([]);
    }
    expect([...NO_SECRET_SERVER_TOOLS].sort()).toEqual(
      ['list', 'list_service', 'list_stack', 'logs', 'phone_calls', 'ssh_exec'].sort(),
    );
  });
});
