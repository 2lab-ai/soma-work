import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StderrLogger } from './stderr-logger.js';

/**
 * Tool definition for MCP servers
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

/**
 * Standard MCP tool result
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } | { type: 'resource'; resource: unknown }>;
  isError?: boolean;
}

/**
 * Base class for all MCP servers.
 *
 * Handles: Server creation, StdioTransport, ListTools/CallTool dispatch,
 * error formatting, and signal cleanup.
 *
 * Subclasses implement only:
 *   - defineTools(): tool definitions
 *   - handleTool(name, args): tool execution logic
 */
export abstract class BaseMcpServer {
  protected server: Server;
  protected logger: StderrLogger;

  constructor(name: string, version: string = '1.0.0') {
    this.logger = new StderrLogger(name);
    this.server = new Server(
      { name, version },
      { capabilities: { tools: {} } },
    );
    this.setupHandlers();
  }

  /**
   * Return tool definitions for this server.
   */
  abstract defineTools(): ToolDefinition[];

  /**
   * Handle a tool call. Throw to produce an error response.
   */
  abstract handleTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;

  /**
   * Format an error into a standard MCP error response.
   * Override in subclasses for enriched error formats (e.g. slack-mcp).
   */
  protected formatError(toolName: string, error: unknown): ToolResult {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`Tool ${toolName} failed`, error);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }

  /**
   * Start the MCP server: register handlers, connect transport, setup signals.
   */
  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.logger.info(`${(this.server as any).serverInfo?.name || 'MCP server'} started`);
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  /**
   * Cleanup hook. Override for custom shutdown logic (e.g. stopping child processes).
   */
  protected async shutdown(): Promise<void> {
    this.logger.info('Shutting down...');
    process.exit(0);
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.defineTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      const { name, arguments: args } = request.params;
      this.logger.debug(`Tool call: ${name}`, args);
      try {
        return await this.handleTool(name, args as Record<string, unknown>);
      } catch (error) {
        return this.formatError(name, error);
      }
    });
  }
}
