/**
 * env-access #1242, astra R3: the project config root is checked against every directory the session writes once
 * all of them are known — a deploy grant included. A real grant can never name `/tmp` or `/var`, where the test
 * DATA_DIR lives, so the grant loader is replaced here; the grant still reaches the sandbox through the real
 * `extendSandboxWithGrant`.
 */

import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const APPROVED = 'UAPPROVED1';

vi.mock('../../sandbox/deploy-sandbox-grant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sandbox/deploy-sandbox-grant')>();
  const { DATA_DIR } = await import('../../env-paths');
  return {
    ...actual,
    loadDeploySandboxGrant: () => ({
      users: [APPROVED],
      allowedDomains: [],
      allowWrite: [path.dirname(DATA_DIR)],
    }),
  };
});

import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import type { ConversationSession } from '../../types';
import { type BuildStreamOptionsDeps, buildStreamOptions } from '../claude-code/build-stream-options';

function makeDeps(): BuildStreamOptionsDeps {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getEffectivePluginPaths: () => [],
    buildModelCommandContext: () => undefined,
    mcpConfigBuilder: {
      buildConfig: vi.fn(
        async (): Promise<McpConfig> => ({
          permissionMode: 'bypassPermissions',
          userBypass: true,
          somaPermissionMode: 'bypass',
          allowDangerouslySkipPermissions: true,
          mcpServers: {},
          allowedTools: [],
          disallowedTools: [],
          permissionPromptToolName: 'mcp__permission-prompt__permission_prompt',
        }),
      ),
    },
    compactHookBuilder: undefined,
    promptBuilder: { buildSystemPrompt: vi.fn(() => 'PROMPT') },
    sessionRegistry: {
      getSessionKey: vi.fn(() => 'chan:thread'),
      isDangerousRuleDisabled: vi.fn(() => false),
      getSession: vi.fn(() => undefined),
    } as unknown as BuildStreamOptionsDeps['sessionRegistry'],
    checkMcpToolPermission: vi.fn(() => null),
  };
}

describe('project config root against deploy grants (#1242, astra R3)', () => {
  it('refuses to start when a grant makes a directory above the root writable', async () => {
    await expect(
      buildStreamOptions(
        {
          queryEnv: {},
          session: { workflow: 'deploy', ownerId: APPROVED } as ConversationSession,
          slackContext: { user: APPROVED, channel: 'C1', threadTs: '1.1' } as SlackContext,
        },
        makeDeps(),
      ),
    ).rejects.toThrow(/lies inside/);
  });

  it('starts when the same grant does not apply (not a deploy workflow)', async () => {
    const { options } = await buildStreamOptions(
      {
        queryEnv: {},
        session: { ownerId: APPROVED } as ConversationSession,
        slackContext: { user: APPROVED, channel: 'C1', threadTs: '1.1' } as SlackContext,
      },
      makeDeps(),
    );
    expect(options.projectConfigRoot).toBeDefined();
  });
});
