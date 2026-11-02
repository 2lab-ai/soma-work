/**
 * McpConfigBuilder - Builds MCP server configuration for Claude queries
 * Extracted from claude-handler.ts (Phase 5.3)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpSdkServerConfigWithInstance, McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  createPermissionPromptHandler,
  type PermissionAdviceRequest,
  type PermissionRequestContext,
} from '@soma/mcp-server-permission';
import type { ModelCommandContext } from 'somalib/model-commands/types';
import type { PermissionAdvice } from 'somalib/permission/shared-store';
import { z } from 'zod';
import { isAdminUser } from './admin-utils';
import type { ExecutionContext } from './agent-runtime/execution-context';
import { NO_CONTEXT_PERMISSION_MODE, type PermissionMode } from './agent-runtime/policy/permission-mode';
import { substituteEnvVars } from './config-env-substitution';
import { CONFIG_FILE, DATA_DIR } from './env-paths';
import { NATIVE_BYPASS_TOOLS } from './hooks/bypass-permission-guard';
import {
  type InternalMcpServerCommand,
  type InternalMcpServerName,
  resolveInternalMcpServerCommand,
} from './internal-mcp-server-resolver';
import { Logger } from './logger';
import type { McpManager } from './mcp-manager';
import { mcpToolGrantStore } from './mcp-tool-grant-store';
import {
  getPermissionGatedServers,
  levelSatisfies,
  loadMcpToolPermissions,
  type McpToolPermissionConfig,
  type PermissionLevel,
} from './mcp-tool-permission-config';
import { isSafePathSegment, normalizeTmpPath } from './path-utils';
import { attachesEpicServer, buildEpicServer, EPIC_SERVER } from './task-turn/epic-server';
import { userSettingsStore } from './user-settings-store';

/** Native SDK tools that require terminal interaction — disallowed in Slack context */
const NATIVE_INTERACTIVE_TOOLS = ['AskUserQuestion'];

/**
 * Native SDK cron tools — disallowed to prevent conflict with soma's managed CronScheduler.
 * Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 1
 */
const NATIVE_CRON_TOOLS = ['CronCreate', 'CronDelete', 'CronList'];

/**
 * devops-tools calls can wait on an admin approval card: the MCP server stops waiting at 355 s at the
 * latest, so the SDK's per-call wall clock must stay above that.
 */
const DEVOPS_TOOLS_CALL_TIMEOUT_MS = 360_000;

/** True when the bot was mentioned inside an existing thread (not at the root). */
export function isMidThreadMention(ctx?: { mentionTs?: string; threadTs?: string } | null): boolean {
  return !!ctx?.mentionTs && ctx.mentionTs !== ctx.threadTs;
}

/**
 * Slack context for permission prompts
 */
export interface SlackContext {
  channel: string;
  threadTs?: string;
  mentionTs?: string;
  /** Original thread where the mention occurred (before bot-initiated thread migration) */
  sourceThreadTs?: string;
  /** Original channel where the mention occurred (before channel routing) */
  sourceChannel?: string;
  user: string;
  channelDescription?: string;
  /** Structured repo names parsed from channel description (e.g., ["2lab-ai/soma-work"]) */
  repos?: string[];
  /** Confluence wiki URL from channel description */
  confluenceUrl?: string;
}

/**
 * MCP configuration result
 */
export interface McpConfig {
  mcpServers?: Record<string, any>;
  allowedTools?: string[];
  /** Tools to completely remove from the model's context (e.g. native interactive tools in Slack) */
  disallowedTools?: string[];
  permissionPromptToolName?: string;
  permissionMode: 'default' | 'bypassPermissions';
  allowDangerouslySkipPermissions?: boolean;
  /**
   * Whether the SDK should auto-allow native/non-dangerous tools (true for both
   * `auto` and `bypass` modes). Derived as `somaPermissionMode !== 'legacy'`.
   * Kept for the allowedTools assembly + PreToolUse hook that gate on it.
   */
  userBypass: boolean;
  /**
   * The soma tri-state permission mode (`auto` | `bypass` | `legacy`) that the
   * PreToolUse policy hook evaluates. Distinct from the SDK `permissionMode`
   * above (`default` | `bypassPermissions`).
   */
  somaPermissionMode: PermissionMode;
}

/**
 * SSOT 2026-11-02 T2 — the AI's advice for one permission prompt of one turn:
 * the session (`scope`, the key the policy hook used), its user and directory,
 * and the call. Null when there is none. Wired by `ClaudeHandler` to the
 * guardian (`resolvePermissionAdvice`).
 */
export type PermissionAdvisor = (
  req: PermissionAdviceRequest & { scope: string; user: string; cwd?: string },
) => Promise<PermissionAdvice | null>;

/**
 * McpConfigBuilder assembles MCP server configuration
 * - Adds permission prompt server when needed
 * - Manages allowed tools list
 * - Handles bypass permission logic
 */
export class McpConfigBuilder {
  private logger = new Logger('McpConfigBuilder');
  private mcpManager: McpManager;
  /** Agent configs for agent MCP server (Trace: docs/current/plans/multi-agent/trace.md, S4) */
  private agentConfigs?: Record<string, any>;
  private serverCommandRegistry = new Map<InternalMcpServerName, InternalMcpServerCommand>();
  private permissionAdvisor?: PermissionAdvisor;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
  }

  /**
   * Set agent configurations (called from index.ts after loading config).
   * Trace: docs/current/plans/multi-agent/trace.md, Scenario 4
   */
  setAgentConfigs(configs: Record<string, any>): void {
    this.agentConfigs = configs;
  }

  /** SSOT 2026-11-02 T2 — where every permission prompt gets the AI's advice (set once by ClaudeHandler). */
  setPermissionAdvisor(advisor: PermissionAdvisor): void {
    this.permissionAdvisor = advisor;
  }

  /**
   * Build MCP configuration for a query
   */
  async buildConfig(
    slackContext?: SlackContext,
    modelCommandContext?: ModelCommandContext,
    executionContext?: ExecutionContext,
  ): Promise<McpConfig> {
    // Whose turn this is (#597): the execution context when there is one (a
    // Slack-less task, or a Slack turn's context), else the Slack event user.
    const contextUser = executionContext?.userId ?? (slackContext?.user || undefined);
    // Resolve the permission mode (auto | bypass | legacy). With no user at all
    // there is nobody to vouch for the turn: fail closed (NO_CONTEXT_PERMISSION_MODE,
    // the SDK's own checks, no skip) — never the old "no Slack context → bypass".
    const somaPermissionMode: PermissionMode = executionContext
      ? executionContext.permissionMode
      : contextUser
        ? userSettingsStore.getUserPermissionMode(contextUser)
        : NO_CONTEXT_PERMISSION_MODE;

    // `legacy` → SDK prompts the user for every tool (the old accept/reject).
    // `auto` / `bypass` → the SDK runs without its own prompt; the unified
    // PreToolUse policy hook decides allow / deny / classify / pass per `somaPermissionMode`
    // (a `classify` the classifier escalates reaches the user as an SDK `ask`).
    // (`auto` still gets the permission-prompt server below — the classifier may
    // escalate a dangerous command to the Slack UI.)
    const userBypass = somaPermissionMode !== 'legacy';
    const config: McpConfig = userBypass
      ? {
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          userBypass,
          somaPermissionMode,
        }
      : { permissionMode: 'default', userBypass, somaPermissionMode };

    // Get base MCP server configuration
    const mcpServers = await this.mcpManager.getServerConfiguration();
    const internalServers: Record<string, any> = {};

    // Add agent MCP server when agents are configured (Trace: docs/current/plans/multi-agent/trace.md, S4)
    if (this.agentConfigs && Object.keys(this.agentConfigs).length > 0) {
      internalServers['agent'] = this.buildAgentServer();
    }

    if (slackContext) {
      internalServers['model-command'] = this.buildModelCommandServer(slackContext, modelCommandContext);
    }

    // Add slack-mcp server only for mid-thread mentions (mentionTs !== threadTs)
    // When mentionTs === threadTs, the mention IS the thread root — no prior context to explore
    if (isMidThreadMention(slackContext)) {
      internalServers['slack-mcp'] = this.buildSlackMcpServer(slackContext!);
    }

    // Add cron MCP server for cron CRUD (Trace: docs/archive/features/cron-scheduler/trace.md, S2-S3)
    if (slackContext) {
      internalServers['cron'] = this.buildCronServer(slackContext);
    }

    // Conditionally add server-tools when config.json has server-tools section
    if (this.hasServerToolsConfig()) {
      internalServers['server-tools'] = this.buildServerToolsServer();
    }

    // devops-tools relays to the devops broker, which holds the keys and posts the approval cards;
    // the bot side only registers it (.prd/16-devops-tools-architecture.md §2, §8).
    if (slackContext && this.hasDevopsToolsConfig()) {
      internalServers['devops-tools'] = this.buildDevopsToolsServer(slackContext);
    }

    // Add mcp-tool-permission server for permission request/check/revoke
    // Trace: docs/current/plans/mcp-tool-permission/trace.md, S4/S7/S8
    if (slackContext) {
      internalServers['mcp-tool-permission'] = this.buildMcpToolPermissionServer(slackContext);
    }

    // E4 ④a (.prd/19 D3) — the epic's host tools, on an epic's own task turn only (never a
    // child's: depth 1). Allowed below, so a `legacy` task turn (no prompt server) can use them.
    if (attachesEpicServer(executionContext)) {
      internalServers[EPIC_SERVER] = buildEpicServer(executionContext);
    }

    // Always add permission prompt server when in Slack context
    // Even bypass users need the MCP server for dangerous command approval via Slack UI
    if (slackContext) {
      internalServers['permission-prompt'] = this.buildPermissionServer(slackContext, executionContext)[
        'permission-prompt'
      ];
      config.permissionPromptToolName = 'mcp__permission-prompt__permission_prompt';

      this.logger.debug('Configured permission prompts for Slack integration', {
        channel: slackContext.channel,
        user: slackContext.user,
        hasThread: !!slackContext.threadTs,
        userBypass,
      });
    }

    const hasBaseServers = !!mcpServers && Object.keys(mcpServers).length > 0;
    const hasInternalServers = Object.keys(internalServers).length > 0;

    if (hasBaseServers || hasInternalServers) {
      config.mcpServers = {
        ...(mcpServers || {}),
        ...internalServers,
      };
    }

    // Restrict filesystem MCP to user's /tmp/{slackId} directory
    if (contextUser && config.mcpServers?.filesystem) {
      const userId = contextUser;
      // Defense-in-depth: validate userId has no path traversal characters
      if (!isSafePathSegment(userId)) {
        this.logger.warn('slackContext.user contains path traversal characters, skipping filesystem restriction', {
          userId,
        });
      } else {
        const userTmpDir = normalizeTmpPath(path.join('/tmp', userId));
        // A copy per turn: the server entry is shared with the manager's config, and this turn's roots
        // (its user's, a task's folder) must not leak into the next turn's.
        const shared = config.mcpServers.filesystem as { args?: string[] };
        const fsConfig = { ...shared, ...(Array.isArray(shared.args) ? { args: [...shared.args] } : {}) };
        config.mcpServers.filesystem = fsConfig as typeof config.mcpServers.filesystem;
        if (Array.isArray(fsConfig.args)) {
          // Replace ALL /tmp-prefixed args (MCP filesystem accepts multiple dirs)
          let replaced = false;
          for (let i = 0; i < fsConfig.args.length; i++) {
            if (fsConfig.args[i].startsWith('/tmp') || fsConfig.args[i].startsWith('/private/tmp')) {
              fsConfig.args[i] = userTmpDir;
              replaced = true;
            }
          }
          if (!replaced) {
            fsConfig.args.push(userTmpDir);
          }
          // A task turn run by someone other than its owner (SSOT 2026-11-02) works in the owner's task
          // folder: that one folder too (validated by its context), never the owner's whole root.
          const taskDir = executionContext?.origin === 'task' ? executionContext.workingDirectory : undefined;
          if (taskDir && !taskDir.startsWith(`${userTmpDir}/`) && !fsConfig.args.includes(taskDir)) {
            fsConfig.args.push(taskDir);
          }
          this.logger.debug('Filesystem MCP restricted to user directory', {
            user: userId,
            userTmpDir,
          });
        }
      }
    }

    // Build allowed tools list. Always — it also carries native tools (Skill,
    // EnterPlanMode/ExitPlanMode, bypass allow-list), so it must not depend on
    // whether any MCP server happened to be registered (the retired `llm`
    // server used to make that condition unconditionally true).
    config.allowedTools = this.buildAllowedTools(slackContext, userBypass, contextUser, !!executionContext);
    if (internalServers[EPIC_SERVER]) config.allowedTools.push(`mcp__${EPIC_SERVER}`);

    this.logger.debug('Added MCP configuration', {
      serverCount: Object.keys(config.mcpServers ?? {}).length,
      servers: Object.keys(config.mcpServers ?? {}),
      allowedTools: config.allowedTools,
      hasSlackContext: !!slackContext,
      userBypass,
      permissionMode: config.permissionMode,
    });

    // Disallow native interactive tools and SDK cron tools in Slack context
    // Interactive tools expect terminal input; cron tools conflict with soma's CronScheduler
    // Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 1
    // A Slack-less task has neither a terminal nor a Slack thread, so the same holds.
    if (slackContext || executionContext) {
      config.disallowedTools = [...NATIVE_INTERACTIVE_TOOLS, ...NATIVE_CRON_TOOLS];
    }

    if (slackContext && userBypass) {
      this.logger.debug('Bypass ON — dangerous Bash commands intercepted via PreToolUse hook', {
        user: slackContext.user,
      });
    }

    return config;
  }

  /**
   * Build the permission prompt as an in-process SDK MCP server.
   *
   * The handler remains owned by @soma/mcp-server-permission so the SDK and
   * stdio entrypoints share the same Slack approval semantics.
   */
  private buildPermissionServer(
    slackContext: SlackContext,
    executionContext?: ExecutionContext,
  ): Record<string, McpSdkServerConfigWithInstance> {
    // The advice is looked up under the key the policy hook left it at: the turn's session key.
    const advisor = this.permissionAdvisor;
    const scope = executionContext?.sessionKey;
    const user = executionContext?.userId ?? slackContext.user;
    const cwd = executionContext?.workingDirectory;
    const handler = createPermissionPromptHandler({
      slackToken: process.env.SLACK_BOT_TOKEN,
      slackContext: {
        channel: slackContext.channel,
        threadTs: slackContext.threadTs,
        user: slackContext.user,
      },
      ...(advisor && scope ? { resolveAdvice: (req) => advisor({ ...req, scope, user, cwd }) } : {}),
    });
    const permissionPrompt = tool(
      'permission_prompt',
      'Request user permission for tool execution via Slack button',
      {
        tool_name: z.string().describe('Name of the tool requesting permission'),
        input: z.record(z.string(), z.unknown()).describe('Input parameters for the tool'),
        channel: z.string().optional().describe('Slack channel ID'),
        thread_ts: z.string().optional().describe('Slack thread timestamp'),
        user: z.string().optional().describe('User ID requesting permission'),
      },
      async (args, extra) => {
        const context: PermissionRequestContext = {};
        if (typeof extra === 'object' && extra !== null && 'signal' in extra && extra.signal instanceof AbortSignal) {
          context.signal = extra.signal;
        }
        return await handler.handleTool('permission_prompt', args, context);
      },
    );

    return {
      'permission-prompt': createSdkMcpServer({
        name: 'permission-prompt',
        tools: [permissionPrompt],
      }),
    };
  }

  /**
   * Build model-command MCP server configuration
   */
  private buildModelCommandServer(
    slackContext: SlackContext,
    modelCommandContext?: ModelCommandContext,
  ): Record<string, any> {
    const command = this.getInternalServerCommand('model-command');
    const context: ModelCommandContext = modelCommandContext || {
      channel: slackContext.channel,
      threadTs: slackContext.threadTs,
      user: slackContext.user,
    };

    return {
      command: command.command,
      args: command.args,
      env: {
        SOMA_COMMAND_CONTEXT: JSON.stringify(context),
        SOMA_DATA_DIR: DATA_DIR,
      },
    };
  }

  /**
   * Build cron MCP server configuration.
   * Trace: docs/archive/features/cron-scheduler/trace.md, Scenarios 2-3
   */
  private buildCronServer(slackContext: SlackContext): Record<string, any> {
    const command = this.getInternalServerCommand('cron');
    const context = {
      user: slackContext.user,
      channel: slackContext.channel,
      threadTs: slackContext.threadTs,
      // Trusted admin flag — computed here (parent process, ADMIN_USERS env),
      // so the model-facing cron MCP server can scope list/update/delete
      // without being forgeable from the model side.
      isAdmin: isAdminUser(slackContext.user),
    };

    return {
      command: command.command,
      args: command.args,
      env: {
        SOMA_CRON_CONTEXT: JSON.stringify(context),
        SOMA_DATA_DIR: DATA_DIR,
      },
    };
  }

  /**
   * Build slack-mcp server configuration (thread context + file upload)
   */
  private buildSlackMcpServer(slackContext: SlackContext): Record<string, any> {
    const command = this.getInternalServerCommand('slack-mcp');
    if (!slackContext.threadTs) {
      throw new Error('Cannot build slack-mcp server without threadTs');
    }

    // Pass both work thread (current) and source thread (original before migration).
    // The MCP server uses resolveThread() to let tools target either thread.
    const threadContext: Record<string, string> = {
      channel: slackContext.channel,
      threadTs: slackContext.threadTs,
      mentionTs: slackContext.mentionTs ?? '',
    };

    if (slackContext.sourceThreadTs) {
      threadContext.sourceThreadTs = slackContext.sourceThreadTs;
    }
    if (slackContext.sourceChannel) {
      threadContext.sourceChannel = slackContext.sourceChannel;
    }

    return {
      command: command.command,
      args: command.args,
      env: {
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || '',
        SLACK_MCP_CONTEXT: JSON.stringify(threadContext),
      },
    };
  }

  /**
   * Build agent MCP server configuration.
   * Passes agent configs via env so the MCP server can validate agent names.
   * Trace: docs/current/plans/multi-agent/trace.md, Scenario 4
   */
  private buildAgentServer(): Record<string, any> {
    const command = this.getInternalServerCommand('agent');
    // Strip sensitive tokens — only pass metadata needed for MCP tool validation
    const safeConfigs: Record<string, any> = {};
    if (this.agentConfigs) {
      for (const [name, config] of Object.entries(this.agentConfigs)) {
        safeConfigs[name] = {
          promptDir: config.promptDir,
          persona: config.persona,
          description: config.description,
          model: config.model,
        };
      }
    }
    return {
      command: command.command,
      args: command.args,
      env: {
        SOMA_AGENT_CONFIGS: JSON.stringify(safeConfigs),
      },
    };
  }

  /**
   * Build the list of allowed tools.
   * Filters permission-gated MCP servers based on user's active grants.
   * Admin users bypass all permission checks.
   * Trace: docs/current/plans/mcp-tool-permission/trace.md, S2/S3/S5
   */
  private buildAllowedTools(
    slackContext: SlackContext | undefined,
    userBypass: boolean,
    contextUser: string | undefined,
    hasExecutionContext: boolean,
  ): string[] {
    const allowedTools = this.mcpManager.getDefaultAllowedTools();

    // Add Skill tool for local plugins
    allowedTools.push('Skill');

    // Allow agent tools when agents are configured
    if (this.agentConfigs && Object.keys(this.agentConfigs).length > 0) {
      allowedTools.push('mcp__agent');
    }

    if (slackContext) {
      allowedTools.push('mcp__model-command');
    }

    // Allow slack-mcp tools only for mid-thread mentions
    if (isMidThreadMention(slackContext)) {
      allowedTools.push('mcp__slack-mcp');
    }

    // Always add permission prompt tool (even for bypass users, needed for dangerous commands)
    if (slackContext) {
      allowedTools.push('mcp__permission-prompt__permission_prompt');
    }

    // Allow cron MCP tools in Slack context
    if (slackContext) {
      allowedTools.push('mcp__cron');
    }

    // Allow mcp-tool-permission tools (always available in Slack context for requesting permissions)
    if (slackContext) {
      allowedTools.push('mcp__mcp-tool-permission');
    }

    // Generic per-tool permission gating for ALL MCP servers with a `permission` key in config.json.
    // Iterates every gated server (not just server-tools) and applies the same logic:
    //   admin → blanket allow | non-admin with grant → per-tool filter | no grant → blocked
    // Trace: docs/current/plans/mcp-tool-permission/trace.md, S2/S3/S5
    this.applyPermissionGating(allowedTools, contextUser);

    // Auto-approve plan mode tools (no terminal interaction needed)
    allowedTools.push('EnterPlanMode');
    allowedTools.push('ExitPlanMode');

    // Bypass-mode short-circuit for native non-Bash tools.
    //
    // PR #880 installs an explicit `'allow'` PreToolUse hook for these tools
    // when bypass=ON. That hook can silently lose its decision when the SDK's
    // hook-callback transport stream closes (cli.js:8643 `BY8.sendRequest`
    // throws on `inputClosed`; `createHookCallback` catches and returns `{}`;
    // merge then has no `permissionBehavior` to act on). The hook layer is
    // necessary for `'ask'` semantics (dangerous-rule escalation lives in
    // bypass-Bash-gate for Bash only), but the auto-allow path for the
    // non-Bash native tools must NOT depend on the hook transport.
    //
    // Adding these names to `allowedTools` makes the SDK short-circuit at
    // the `alwaysAllowRules` layer (cli.js:5172 `CkY` → `hkY` →
    // `behavior:"allow"`, evaluated before the prompt-tool wrapper at
    // cli.js:18223). PreToolUse deny hooks (sensitive-path, cross-user,
    // ssh-ban, abort-guard, mcp-grant, pr-issue) still run first; SDK
    // precedence keeps deny > allow, so adding the names here does not
    // weaken any existing block.
    //
    // `Bash` is intentionally excluded — its bypass-Bash-gate hook emits
    // `'ask'` for dangerous commands, which would be defeated by an
    // unconditional allowlist entry.
    // A Slack-less task in auto/bypass mode gets the same short-circuit: its
    // policy hook runs first and still denies (deny > allow), as for Slack.
    if ((slackContext || hasExecutionContext) && userBypass) {
      allowedTools.push(...NATIVE_BYPASS_TOOLS);
    }

    return allowedTools;
  }

  /**
   * Apply per-tool permission gating for ALL MCP servers that have a `permission` key in config.json.
   * For each gated server:
   *  - Admin → blanket allow (mcp__{serverName}); no user at all → blocked (#597, fail closed)
   *  - Non-admin with matching grant → per-tool filtering based on level
   *  - Non-admin without grant → server entirely blocked
   */
  private applyPermissionGating(allowedTools: string[], userId: string | undefined): void {
    const toolPermConfig = this.loadToolPermissions();
    const gatedServers = getPermissionGatedServers(toolPermConfig);

    if (gatedServers.length === 0) {
      // No gated servers — allow server-tools blanket if config exists (backward compat)
      if (this.hasServerToolsConfig()) {
        allowedTools.push('mcp__server-tools');
      }
      return;
    }

    // Reload grants once before iterating servers (not per-server)
    if (userId && !isAdminUser(userId)) {
      mcpToolGrantStore.reload();
    }

    for (const serverName of gatedServers) {
      const serverPerms = toolPermConfig[serverName];
      const mcpPrefix = `mcp__${serverName}`;

      // Ensure this server's MCP config actually exists in the build
      // (server-tools has its own hasServerToolsConfig check; other servers checked via raw config)
      if (serverName === 'server-tools' && !this.hasServerToolsConfig()) continue;

      if (!userId) {
        // No user to check a grant for → blocked (#597: no context never means full access)
        continue;
      }
      if (isAdminUser(userId)) {
        // Admin → full access
        allowedTools.push(mcpPrefix);
        continue;
      }

      // Non-admin: check grants
      const hasWriteGrant = mcpToolGrantStore.hasActiveGrant(userId, serverName, 'write');
      const hasReadGrant = mcpToolGrantStore.hasActiveGrant(userId, serverName, 'read');
      const userLevel: PermissionLevel | null = hasWriteGrant ? 'write' : hasReadGrant ? 'read' : null;

      if (!userLevel) {
        this.logger.debug('Permission-gated server blocked — no active grant', {
          user: userId,
          server: serverName,
        });
        continue;
      }

      // Per-tool filtering: allow tools whose required level is satisfied by user's grant
      const allowedForServer: string[] = [];
      for (const [toolName, requiredLevel] of Object.entries(serverPerms)) {
        if (levelSatisfies(userLevel, requiredLevel)) {
          const fullToolName = `${mcpPrefix}__${toolName}`;
          allowedTools.push(fullToolName);
          allowedForServer.push(fullToolName);
        }
      }

      this.logger.debug('Permission-gated server per-tool filtering applied', {
        user: userId,
        server: serverName,
        userLevel,
        allowed: allowedForServer,
      });
    }
  }

  /**
   * Load tool permission config from config.json (cached per build).
   */
  private toolPermConfigCache: McpToolPermissionConfig | null = null;
  private loadToolPermissions(): McpToolPermissionConfig {
    if (!this.toolPermConfigCache) {
      this.toolPermConfigCache = CONFIG_FILE ? loadMcpToolPermissions(CONFIG_FILE) : {};
    }
    return this.toolPermConfigCache;
  }

  /**
   * Check if config.json has a server-tools section with at least one server.
   * The "permission" key is reserved for tool-level permission config — not counted as a server.
   * Uses cached raw config to avoid redundant file reads (Fix Issue 6).
   */
  private rawConfigCache: Record<string, any> | null | undefined = undefined;
  private getRawConfig(): Record<string, any> | null {
    if (this.rawConfigCache === undefined) {
      if (!CONFIG_FILE) {
        this.rawConfigCache = null;
        return null;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        // Substitute ${VAR} placeholders so server-tools entries (DB
        // credentials etc.) honor the same env-var contract documented
        // for mcpServers headers. Missing-var warnings are deduped at
        // the module level — already emitted by loadConfig at
        // boot, so we silence them here to avoid double-logs.
        this.rawConfigCache = substituteEnvVars(parsed).value;
      } catch {
        this.rawConfigCache = null;
      }
    }
    return this.rawConfigCache ?? null;
  }

  private hasServerToolsConfig(): boolean {
    const raw = this.getRawConfig();
    if (!raw) return false;
    const serverTools = raw['server-tools'];
    if (!serverTools || typeof serverTools !== 'object') return false;
    const serverKeys = Object.keys(serverTools).filter((k) => k !== 'permission');
    return serverKeys.length > 0;
  }

  /**
   * Check if config.json has a devops-tools section with a non-empty `permission` map. Unlike
   * server-tools the section carries no server keys. Without the map the server would not be
   * grant-gated (`applyPermissionGating` and the PreToolUse deny tier only gate servers that have
   * one), so it is not registered at all.
   */
  private hasDevopsToolsConfig(): boolean {
    const devopsTools = this.getRawConfig()?.['devops-tools'];
    if (!devopsTools || typeof devopsTools !== 'object') return false;
    if (!this.loadToolPermissions()['devops-tools']) {
      this.logger.warn('devops-tools section has no valid permission map — server not registered');
      return false;
    }
    return true;
  }

  /**
   * Build devops-tools MCP server configuration. The env carries the requester context and,
   * optionally, the broker socket path — never a token: the broker alone holds the keys.
   */
  private buildDevopsToolsServer(slackContext: SlackContext): McpStdioServerConfig {
    const command = this.getInternalServerCommand('devops-tools');
    const env: Record<string, string> = { SLACK_CONTEXT: JSON.stringify(slackContext) };
    const socketPath = this.getRawConfig()?.['devops-tools']?.socketPath;
    if (typeof socketPath === 'string' && path.isAbsolute(socketPath)) {
      // = BROKER_SOCKET_ENV in packages/process-shared/src/devops/protocol.ts
      env.SOMA_DEVOPS_BROKER_SOCKET = socketPath;
    }
    return {
      command: command.command,
      args: command.args,
      env,
      timeout: DEVOPS_TOOLS_CALL_TIMEOUT_MS,
    };
  }

  /**
   * Build server-tools MCP server configuration
   */
  private buildServerToolsServer(): Record<string, any> {
    const command = this.getInternalServerCommand('server-tools');
    return {
      command: command.command,
      args: command.args,
      env: {
        SOMA_CONFIG_FILE: CONFIG_FILE,
      },
    };
  }

  /**
   * Build mcp-tool-permission MCP server configuration.
   * Provides tools for requesting, checking, and revoking MCP tool permissions.
   * Trace: docs/current/plans/mcp-tool-permission/trace.md, S4/S7/S8
   */
  private buildMcpToolPermissionServer(slackContext: SlackContext): Record<string, any> {
    const command = this.getInternalServerCommand('mcp-tool-permission');
    return {
      command: command.command,
      args: command.args,
      env: {
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || '',
        SLACK_CONTEXT: JSON.stringify(slackContext),
        SOMA_CONFIG_FILE: CONFIG_FILE,
        // One grants file: the child resolves DATA_DIR from SOMA_DATA_DIR, like cron and model-command.
        SOMA_DATA_DIR: DATA_DIR,
      },
    };
  }

  private getInternalServerCommand(serverName: InternalMcpServerName): InternalMcpServerCommand {
    const cached = this.serverCommandRegistry.get(serverName);
    if (cached) return cached;

    const command = resolveInternalMcpServerCommand(serverName);
    this.serverCommandRegistry.set(serverName, command);
    return command;
  }
}
