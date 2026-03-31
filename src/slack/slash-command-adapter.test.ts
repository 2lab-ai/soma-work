import { describe, expect, it, vi } from 'vitest';
import { SlashCommandAdapter } from './slash-command-adapter';

/**
 * Contract Tests for Slash Command feature
 * Trace: docs/slash-commands/trace.md
 */

// ============================================================
// Scenario 1 — SlashCommandAdapter (Trace S1, Section 3c)
// ============================================================

describe('SlashCommandAdapter', () => {
  const makeCommand = (overrides: Record<string, any> = {}) => ({
    command: '/soma',
    text: 'help',
    user_id: 'U094E5L4A15',
    channel_id: 'C0AKY7W2UGZ',
    trigger_id: 'xxx',
    response_url: 'https://hooks.slack.com/commands/xxx',
    token: 'test',
    user_name: 'test',
    team_id: 'T1',
    team_domain: 'test',
    channel_name: 'general',
    api_app_id: 'A1',
    ...overrides,
  });

  // Trace: S1, Section 3c — adapt() transforms payload to CommandContext
  it('adapt: transforms SlashCommand payload to CommandContext', () => {
    const command = makeCommand();
    const respond = vi.fn().mockResolvedValue(undefined);

    const ctx = SlashCommandAdapter.adapt(command as any, respond);

    expect(ctx.user).toBe('U094E5L4A15');
    expect(ctx.channel).toBe('C0AKY7W2UGZ');
    expect(ctx.text).toBe('help');
    expect(ctx.threadTs).toBe('C0AKY7W2UGZ'); // no thread_ts in slash commands
    expect(ctx.say).toBeDefined();
    expect(typeof ctx.say).toBe('function');
  });

  // Trace: S1, Section 3c — wrapRespondAsSay calls respond with correct args
  it('wrapRespondAsSay: calls respond with text and ephemeral response_type', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const command = makeCommand();

    const ctx = SlashCommandAdapter.adapt(command as any, respond);
    await ctx.say({ text: 'Hello world', thread_ts: 'C1' });

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Hello world',
        response_type: 'ephemeral',
      }),
    );
  });

  // Trace: S1, Section 3c — blocks are forwarded through respond
  it('wrapRespondAsSay: forwards blocks to respond', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const command = makeCommand();
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'test' } }];

    const ctx = SlashCommandAdapter.adapt(command as any, respond);
    await ctx.say({ text: 'test', blocks });

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'test',
        blocks,
        response_type: 'ephemeral',
      }),
    );
  });

  // Trace: S1 — empty text is handled
  it('adapt: handles empty text gracefully', () => {
    const command = makeCommand({ text: '' });
    const respond = vi.fn().mockResolvedValue(undefined);

    const ctx = SlashCommandAdapter.adapt(command as any, respond);
    expect(ctx.text).toBe('');
  });

  // Trace: S1 — undefined text is handled
  it('adapt: handles undefined text as empty string', () => {
    const command = makeCommand({ text: undefined });
    const respond = vi.fn().mockResolvedValue(undefined);

    const ctx = SlashCommandAdapter.adapt(command as any, respond);
    expect(ctx.text).toBe('');
  });
});

// ============================================================
// Scenario 2 — /soma with Valid Subcommand (Trace S2)
// ============================================================

describe('/soma slash command — valid subcommand routing', () => {
  // Trace: S2, Section 3c — help subcommand routes through CommandRouter
  it('soma help: CommandRouter handles "help" text', async () => {
    const { CommandRouter } = await import('./commands/command-router');

    const respond = vi.fn().mockResolvedValue(undefined);
    const command = {
      command: '/soma',
      text: 'help',
      user_id: 'U1',
      channel_id: 'C1',
      token: 't',
      user_name: 'u',
      team_id: 'T',
      team_domain: 'd',
      channel_name: 'g',
      api_app_id: 'A',
      trigger_id: 'tr',
      response_url: 'https://hooks.slack.com/commands/xxx',
    };

    const ctx = SlashCommandAdapter.adapt(command as any, respond);

    const deps: any = {
      workingDirManager: {
        parseSetCommand: vi.fn().mockReturnValue(null),
        isGetCommand: vi.fn().mockReturnValue(false),
      },
      mcpManager: { getPluginManager: vi.fn() },
      claudeHandler: {},
      sessionUiManager: {},
      requestCoordinator: {},
      slackApi: {},
      reactionManager: {},
      contextWindowManager: {},
    };
    const router = new CommandRouter(deps);
    const result = await router.route(ctx);

    expect(result.handled).toBe(true);
    expect(respond).toHaveBeenCalled();
  });
});

// ============================================================
// Scenario 3 — /soma with Empty/Unknown Subcommand (Trace S3)
// ============================================================

describe('/soma slash command — empty/unknown subcommand', () => {
  // Trace: S3, Section 3b, Case B — unknown subcommand detected by isPotentialCommand
  it('soma with unknown subcommand: CommandRouter responds with error', async () => {
    const { CommandRouter } = await import('./commands/command-router');

    const respond = vi.fn().mockResolvedValue(undefined);
    const command = {
      command: '/soma',
      text: 'asdf',
      user_id: 'U1',
      channel_id: 'C1',
      token: 't',
      user_name: 'u',
      team_id: 'T',
      team_domain: 'd',
      channel_name: 'g',
      api_app_id: 'A',
      trigger_id: 'tr',
      response_url: 'https://hooks.slack.com/commands/xxx',
    };

    const ctx = SlashCommandAdapter.adapt(command as any, respond);

    const deps: any = {
      workingDirManager: {
        parseSetCommand: vi.fn().mockReturnValue(null),
        isGetCommand: vi.fn().mockReturnValue(false),
      },
      mcpManager: { getPluginManager: vi.fn() },
      claudeHandler: {},
      sessionUiManager: {},
      requestCoordinator: {},
      slackApi: {},
      reactionManager: {},
      contextWindowManager: {},
    };
    const router = new CommandRouter(deps);
    const result = await router.route(ctx);

    // "asdf" is not a known command keyword, so isPotentialCommand returns false
    // CommandRouter returns handled: false, and the EventRouter wrapper shows help
    expect(result.handled).toBe(false);
  });
});

// ============================================================
// Scenario 4 — /session Ephemeral (Trace S4)
// ============================================================

describe('/session slash command', () => {
  // Trace: S4, Section 3c — respond called with ephemeral type
  it('respond is called with response_type ephemeral', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const command = {
      command: '/session',
      text: '',
      user_id: 'U1',
      channel_id: 'C1',
      token: 't',
      user_name: 'u',
      team_id: 'T',
      team_domain: 'd',
      channel_name: 'g',
      api_app_id: 'A',
      trigger_id: 'tr',
      response_url: 'https://hooks.slack.com/commands/xxx',
    };

    const ctx = SlashCommandAdapter.adapt(command as any, respond);
    await ctx.say({ text: 'session list here' });

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        response_type: 'ephemeral',
      }),
    );
  });

  // Trace: S4 — user_id is correctly mapped for session lookup
  it('user_id is correctly mapped to CommandContext.user', () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const command = {
      command: '/session',
      text: '',
      user_id: 'U094E5L4A15',
      channel_id: 'C1',
      token: 't',
      user_name: 'u',
      team_id: 'T',
      team_domain: 'd',
      channel_name: 'g',
      api_app_id: 'A',
      trigger_id: 'tr',
      response_url: 'https://hooks.slack.com/commands/xxx',
    };

    const ctx = SlashCommandAdapter.adapt(command as any, respond);
    expect(ctx.user).toBe('U094E5L4A15');
  });
});

// ============================================================
// Scenario 5 — /new Thread Context Fallback (Trace S5)
// ============================================================

describe('/new slash command — thread context fallback', () => {
  // Trace: S5, Section 3b — respond is ephemeral
  it('respond is called with ephemeral type for fallback', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const command = {
      command: '/new',
      text: '',
      user_id: 'U1',
      channel_id: 'C1',
      token: 't',
      user_name: 'u',
      team_id: 'T',
      team_domain: 'd',
      channel_name: 'g',
      api_app_id: 'A',
      trigger_id: 'tr',
      response_url: 'https://hooks.slack.com/commands/xxx',
    };

    const ctx = SlashCommandAdapter.adapt(command as any, respond);
    await ctx.say({ text: 'fallback message' });

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        response_type: 'ephemeral',
      }),
    );
  });

  // Trace: S5 — no thread_ts means channel used as threadTs
  it('threadTs is set to channel_id (no thread_ts in slash commands)', () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const command = {
      command: '/new',
      text: 'fix the bug',
      user_id: 'U1',
      channel_id: 'C_TEST',
      token: 't',
      user_name: 'u',
      team_id: 'T',
      team_domain: 'd',
      channel_name: 'g',
      api_app_id: 'A',
      trigger_id: 'tr',
      response_url: 'https://hooks.slack.com/commands/xxx',
    };

    const ctx = SlashCommandAdapter.adapt(command as any, respond);
    expect(ctx.threadTs).toBe('C_TEST');
    expect(ctx.text).toBe('fix the bug');
  });
});
