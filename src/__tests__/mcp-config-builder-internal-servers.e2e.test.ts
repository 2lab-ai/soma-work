import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WebClient } from '@slack/web-api';
import { describe, expect, it, vi } from 'vitest';
import type { McpManager } from '../mcp-manager';

const { sharedStore } =
  require('@soma/process-shared/permission/shared-store.js') as typeof import('somalib/permission/shared-store');
const { SlackPermissionMessenger } =
  require('@soma/process-shared/permission/slack-messenger.js') as typeof import('somalib/permission/slack-messenger');

vi.mock('../env-paths', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../env-paths')>();
  return {
    ...orig,
    CONFIG_FILE: '/tmp/__nonexistent_packages_srp_e2e_config__.json',
    DATA_DIR: '/tmp/packages-srp-e2e-data',
  };
});

import { McpConfigBuilder } from '../mcp-config-builder';

function createMockMcpManager(): McpManager {
  return {
    getServerConfiguration: vi.fn().mockResolvedValue({}),
    getDefaultAllowedTools: vi.fn().mockReturnValue([]),
  } as unknown as McpManager;
}

function executablePath(server: { args?: string[] }): string {
  const args = server.args ?? [];
  return args[args.length - 1] ?? '';
}

describe('McpConfigBuilder internal MCP servers e2e', () => {
  it('wires the main Slack-context MCP capabilities with stable env and allowed-tool contracts', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    builder.setAgentConfigs({
      reviewer: {
        promptDir: '/tmp/prompts',
        persona: 'reviewer',
        description: 'Review agent',
        model: 'sonnet',
        token: 'must-not-leak',
      },
    });

    const config = await builder.buildConfig({
      channel: 'C123',
      threadTs: '1700000000.000000',
      mentionTs: '1700000010.000000',
      sourceThreadTs: '1699999999.000000',
      sourceChannel: 'C999',
      user: 'U123',
    });

    expect(Object.keys(config.mcpServers ?? {}).sort()).toEqual([
      'agent',
      'cron',
      'llm',
      'mcp-tool-permission',
      'model-command',
      'permission-prompt',
      'slack-mcp',
    ]);

    expect(config.allowedTools).toEqual(
      expect.arrayContaining([
        'Skill',
        'mcp__agent',
        'mcp__cron',
        'mcp__llm',
        'mcp__mcp-tool-permission',
        'mcp__model-command',
        'mcp__permission-prompt__permission_prompt',
        'mcp__slack-mcp',
        'EnterPlanMode',
        'ExitPlanMode',
      ]),
    );
    expect(config.disallowedTools).toEqual(['AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList']);

    const servers = config.mcpServers;
    if (!servers) {
      throw new Error('Expected internal MCP servers to be configured');
    }
    expect(path.basename(executablePath(servers.llm))).toMatch(/^llm-mcp-server\.(ts|js)$/);
    expect(path.basename(executablePath(servers.agent))).toMatch(/^agent-mcp-server\.(ts|js)$/);
    expect(path.basename(executablePath(servers.cron))).toMatch(/^cron-mcp-server\.(ts|js)$/);
    expect(path.basename(executablePath(servers['model-command']))).toMatch(/^model-command-mcp-server\.(ts|js)$/);
    expect(path.basename(executablePath(servers['slack-mcp']))).toMatch(/^slack-mcp-server\.(ts|js)$/);
    expect(servers['permission-prompt']).toMatchObject({
      type: 'sdk',
      name: 'permission-prompt',
      instance: expect.any(Object),
    });
    expect(path.basename(executablePath(servers['mcp-tool-permission']))).toMatch(
      /^mcp-tool-permission-mcp-server\.(ts|js)$/,
    );

    expect(JSON.parse(servers['model-command'].env.SOMA_COMMAND_CONTEXT)).toEqual({
      channel: 'C123',
      threadTs: '1700000000.000000',
      user: 'U123',
    });
    expect(JSON.parse(servers.cron.env.SOMA_CRON_CONTEXT)).toEqual({
      channel: 'C123',
      threadTs: '1700000000.000000',
      user: 'U123',
      isAdmin: false,
    });
    expect(JSON.parse(servers['slack-mcp'].env.SLACK_MCP_CONTEXT)).toEqual({
      channel: 'C123',
      threadTs: '1700000000.000000',
      mentionTs: '1700000010.000000',
      sourceThreadTs: '1699999999.000000',
      sourceChannel: 'C999',
    });
    expect(JSON.parse(servers.agent.env.SOMA_AGENT_CONFIGS)).toEqual({
      reviewer: {
        promptDir: '/tmp/prompts',
        persona: 'reviewer',
        description: 'Review agent',
        model: 'sonnet',
      },
    });
    expect(servers.agent.env.SOMA_AGENT_CONFIGS).not.toContain('must-not-leak');
  });

  it('exposes and invokes permission_prompt immediately through the live in-process MCP server', async () => {
    const sendPermissionRequest = vi
      .spyOn(SlackPermissionMessenger.prototype, 'sendPermissionRequest')
      .mockResolvedValue({});
    const storePendingApproval = vi.spyOn(sharedStore, 'storePendingApproval').mockResolvedValue();
    const waitForPermissionResponse = vi
      .spyOn(sharedStore, 'waitForPermissionResponse')
      .mockResolvedValue({ behavior: 'allow' });
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({
      channel: 'C123',
      threadTs: '1700000000.000000',
      user: 'U123',
    });
    const permissionServer = config.mcpServers?.['permission-prompt'];

    expect(permissionServer).toMatchObject({
      type: 'sdk',
      instance: expect.any(Object),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: 'permission-prompt-options-test',
      version: '1.0.0',
    });
    try {
      await Promise.all([permissionServer.instance.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.listTools();
      expect(result.tools.map((listedTool) => listedTool.name)).toEqual(['permission_prompt']);

      const input = { command: 'rm -rf /tmp/demo' };
      const callResult = await client.callTool({
        name: 'permission_prompt',
        arguments: { tool_name: 'Bash', input },
      });
      expect(callResult.content).toEqual([{ type: 'text', text: JSON.stringify({ behavior: 'allow' }) }]);
      expect(sendPermissionRequest).toHaveBeenCalledWith(
        { channel: 'C123', threadTs: '1700000000.000000', user: 'U123' },
        expect.any(Array),
        'Bash',
      );
      expect(storePendingApproval).toHaveBeenCalledWith(
        expect.stringMatching(/^approval_/),
        expect.objectContaining({
          tool_name: 'Bash',
          input,
          channel: 'C123',
          thread_ts: '1700000000.000000',
          user: 'U123',
        }),
      );
      expect(waitForPermissionResponse).toHaveBeenCalledWith(
        expect.stringMatching(/^approval_/),
        5 * 60 * 1000,
        expect.any(AbortSignal),
      );
    } finally {
      sendPermissionRequest.mockRestore();
      storePendingApproval.mockRestore();
      waitForPermissionResponse.mockRestore();
      await client.close().catch(() => undefined);
      await permissionServer?.instance?.close().catch(() => undefined);
    }
  });

  it('cleans up a posted permission request when waiting fails closed', async () => {
    const sendPermissionRequest = vi
      .spyOn(SlackPermissionMessenger.prototype, 'sendPermissionRequest')
      .mockResolvedValue({ channel: 'C-ERROR', ts: '1700000888.000000' });
    const deletePermissionMessage = vi.spyOn(WebClient.prototype, 'apiCall').mockResolvedValue({ ok: true });
    const storePendingApproval = vi.spyOn(sharedStore, 'storePendingApproval');
    const waitForPermissionResponse = vi
      .spyOn(sharedStore, 'waitForPermissionResponse')
      .mockImplementation(async (approvalId) => {
        await sharedStore.storePermissionResponse(approvalId, { behavior: 'deny', message: 'stale response' });
        throw new Error('permission response read failed');
      });
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({
      channel: 'C-ERROR',
      threadTs: '1700000000.000000',
      user: 'U-ERROR',
    });
    const permissionServer = config.mcpServers?.['permission-prompt'];
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: 'permission-prompt-error-cleanup-test',
      version: '1.0.0',
    });
    let approvalId: string | undefined;

    try {
      await Promise.all([permissionServer.instance.connect(serverTransport), client.connect(clientTransport)]);
      const callResult = await client.callTool({
        name: 'permission_prompt',
        arguments: {
          tool_name: 'Bash',
          input: { command: 'rm -rf /tmp/demo' },
        },
      });
      approvalId = storePendingApproval.mock.calls[storePendingApproval.mock.calls.length - 1]?.[0];

      expect(approvalId).toMatch(/^approval_/);
      expect(callResult.content).toEqual([
        {
          type: 'text',
          text: JSON.stringify({
            behavior: 'deny',
            message: 'Error occurred while requesting permission',
          }),
        },
      ]);
      expect(await sharedStore.getPendingApproval(approvalId as string)).toBeNull();
      expect(fs.existsSync(path.join(os.tmpdir(), 'soma-work-store', 'responses', `${approvalId}.json`))).toBe(false);
      expect(deletePermissionMessage).toHaveBeenCalledWith('chat.delete', {
        channel: 'C-ERROR',
        ts: '1700000888.000000',
      });
    } finally {
      if (approvalId) await sharedStore.cleanup(approvalId);
      sendPermissionRequest.mockRestore();
      deletePermissionMessage.mockRestore();
      storePendingApproval.mockRestore();
      waitForPermissionResponse.mockRestore();
      await client.close().catch(() => undefined);
      await permissionServer?.instance?.close().catch(() => undefined);
    }
  });

  it('cancels a pending permission request through the live in-process MCP server', async () => {
    const sendPermissionRequest = vi
      .spyOn(SlackPermissionMessenger.prototype, 'sendPermissionRequest')
      .mockResolvedValue({ channel: 'C-CANCEL', ts: '1700000999.000000' });
    const deletePermissionMessage = vi.spyOn(WebClient.prototype, 'apiCall').mockResolvedValue({ ok: true });
    const storePendingApproval = vi.spyOn(sharedStore, 'storePendingApproval');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({
      channel: 'C-CANCEL',
      threadTs: '1700000000.000000',
      user: 'U-CANCEL',
    });
    const permissionServer = config.mcpServers?.['permission-prompt'];
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: 'permission-prompt-cancellation-test',
      version: '1.0.0',
    });
    let approvalId: string | undefined;

    try {
      await Promise.all([permissionServer.instance.connect(serverTransport), client.connect(clientTransport)]);
      const abortController = new AbortController();
      const call = client.callTool(
        {
          name: 'permission_prompt',
          arguments: {
            tool_name: 'Bash',
            input: { command: 'rm -rf /tmp/demo' },
          },
        },
        undefined,
        { signal: abortController.signal, timeout: 5 * 60 * 1000 },
      );

      await vi.waitFor(() => {
        expect(storePendingApproval).toHaveBeenCalled();
      });
      approvalId = storePendingApproval.mock.calls[storePendingApproval.mock.calls.length - 1]?.[0];
      expect(approvalId).toMatch(/^approval_/);

      const startedAt = Date.now();
      abortController.abort(new Error('permission request cancelled'));
      await expect(call).rejects.toThrow('permission request cancelled');
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(
        setTimeoutSpy.mock.results.find((result) => result.type === 'return')?.value,
      );
      await vi.waitFor(async () => {
        expect(await sharedStore.getPendingApproval(approvalId as string)).toBeNull();
      });
      await vi.waitFor(() => {
        expect(deletePermissionMessage).toHaveBeenCalledWith('chat.delete', {
          channel: 'C-CANCEL',
          ts: '1700000999.000000',
        });
      });
    } finally {
      if (approvalId) await sharedStore.cleanup(approvalId);
      sendPermissionRequest.mockRestore();
      deletePermissionMessage.mockRestore();
      storePendingApproval.mockRestore();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      await client.close().catch(() => undefined);
      await permissionServer?.instance?.close().catch(() => undefined);
    }
  });

  it('isolates Slack context and SDK server instances per query', async () => {
    const sendPermissionRequest = vi
      .spyOn(SlackPermissionMessenger.prototype, 'sendPermissionRequest')
      .mockResolvedValue({});
    const storePendingApproval = vi.spyOn(sharedStore, 'storePendingApproval').mockResolvedValue();
    const waitForPermissionResponse = vi
      .spyOn(sharedStore, 'waitForPermissionResponse')
      .mockResolvedValue({ behavior: 'allow' });
    const builder = new McpConfigBuilder(createMockMcpManager());
    const [firstConfig, secondConfig] = await Promise.all([
      builder.buildConfig({
        channel: 'C-FIRST',
        threadTs: '171.1',
        user: 'U-FIRST',
      }),
      builder.buildConfig({
        channel: 'C-SECOND',
        threadTs: '172.2',
        user: 'U-SECOND',
      }),
    ]);
    const firstServer = firstConfig.mcpServers?.['permission-prompt'];
    const secondServer = secondConfig.mcpServers?.['permission-prompt'];
    const [firstClientTransport, firstServerTransport] = InMemoryTransport.createLinkedPair();
    const [secondClientTransport, secondServerTransport] = InMemoryTransport.createLinkedPair();
    const firstClient = new Client({
      name: 'permission-prompt-first-query',
      version: '1.0.0',
    });
    const secondClient = new Client({
      name: 'permission-prompt-second-query',
      version: '1.0.0',
    });

    try {
      expect(firstServer.instance).not.toBe(secondServer.instance);
      await Promise.all([
        firstServer.instance.connect(firstServerTransport),
        firstClient.connect(firstClientTransport),
        secondServer.instance.connect(secondServerTransport),
        secondClient.connect(secondClientTransport),
      ]);
      await Promise.all([
        firstClient.callTool({
          name: 'permission_prompt',
          arguments: { tool_name: 'Bash', input: { command: 'first' } },
        }),
        secondClient.callTool({
          name: 'permission_prompt',
          arguments: { tool_name: 'Bash', input: { command: 'second' } },
        }),
      ]);

      expect(sendPermissionRequest).toHaveBeenCalledTimes(2);
      expect(sendPermissionRequest.mock.calls.map(([context]) => context)).toEqual(
        expect.arrayContaining([
          { channel: 'C-FIRST', threadTs: '171.1', user: 'U-FIRST' },
          { channel: 'C-SECOND', threadTs: '172.2', user: 'U-SECOND' },
        ]),
      );
    } finally {
      sendPermissionRequest.mockRestore();
      storePendingApproval.mockRestore();
      waitForPermissionResponse.mockRestore();
      await Promise.all([
        firstClient.close().catch(() => undefined),
        secondClient.close().catch(() => undefined),
        firstServer?.instance?.close().catch(() => undefined),
        secondServer?.instance?.close().catch(() => undefined),
      ]);
    }
  });

  it('does not register permission-prompt or its prompt tool without Slack context', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig();

    expect(config.mcpServers?.['permission-prompt']).toBeUndefined();
    expect(config.permissionPromptToolName).toBeUndefined();
    expect(config.allowedTools).not.toContain('mcp__permission-prompt__permission_prompt');
  });
});
