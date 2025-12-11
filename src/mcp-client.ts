import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { Logger } from './logger';

/**
 * JSON-RPC 2.0 types
 */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

/**
 * MCP Server Configuration
 */
export interface McpClientConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * MCP Tool Definition
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: any;
}

/**
 * MCP Tool Call Result
 */
export interface McpToolResult {
  content: Array<{
    type: string;
    text?: string;
    [key: string]: any;
  }>;
  isError?: boolean;
}

/**
 * Pending request tracker
 */
interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Minimal MCP Client for stdio-based MCP servers
 * Supports real-time notifications via EventEmitter
 */
export class McpClient extends EventEmitter {
  private config: McpClientConfig;
  private process: ChildProcess | null = null;
  private logger: Logger;
  private requestId = 0;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private buffer = '';
  private initialized = false;
  private serverInfo: any = null;
  private tools: McpTool[] = [];

  constructor(config: McpClientConfig, name: string = 'McpClient') {
    super();
    this.config = config;
    this.logger = new Logger(name);
  }

  /**
   * Start the MCP server process and initialize
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error('MCP client already started');
    }

    this.logger.info('Starting MCP server', {
      command: this.config.command,
      args: this.config.args,
    });

    this.process = spawn(this.config.command, this.config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
      cwd: this.config.cwd,
    });

    // Handle stdout - JSON-RPC messages
    this.process.stdout?.on('data', (data: Buffer) => {
      this.handleData(data.toString());
    });

    // Handle stderr - logging
    this.process.stderr?.on('data', (data: Buffer) => {
      this.logger.debug('MCP stderr', { data: data.toString() });
      this.emit('stderr', data.toString());
    });

    // Handle process errors
    this.process.on('error', (error) => {
      this.logger.error('MCP process error', error);
      this.emit('error', error);
    });

    // Handle process exit
    this.process.on('close', (code) => {
      this.logger.info('MCP process exited', { code });
      this.process = null;
      this.initialized = false;
      this.emit('close', code);
    });

    // Initialize MCP handshake
    await this.initialize();
  }

  /**
   * Stop the MCP server process
   */
  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    this.logger.info('Stopping MCP server');

    // Clear pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('MCP client stopped'));
    }
    this.pendingRequests.clear();

    // Kill process
    this.process.kill();
    this.process = null;
    this.initialized = false;
  }

  /**
   * Check if client is running and initialized
   */
  isReady(): boolean {
    return this.process !== null && this.initialized;
  }

  /**
   * Get server info
   */
  getServerInfo(): any {
    return this.serverInfo;
  }

  /**
   * Get available tools
   */
  getTools(): McpTool[] {
    return this.tools;
  }

  /**
   * Call a tool on the MCP server
   */
  async callTool(name: string, args: any, timeout = 120000): Promise<McpToolResult> {
    if (!this.isReady()) {
      throw new Error('MCP client not ready');
    }

    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    }, timeout);

    return result as McpToolResult;
  }

  /**
   * Initialize MCP handshake
   */
  private async initialize(): Promise<void> {
    // Step 1: Send initialize request
    const initResult = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        // We support receiving notifications
      },
      clientInfo: {
        name: 'slack-bot-mcp-client',
        version: '1.0.0',
      },
    });

    this.serverInfo = initResult;
    this.logger.info('MCP server initialized', {
      serverInfo: this.serverInfo?.serverInfo,
    });

    // Step 2: Send initialized notification
    this.sendNotification('notifications/initialized');

    // Step 3: Get available tools
    const toolsResult = await this.sendRequest('tools/list', {});
    this.tools = toolsResult?.tools || [];
    this.logger.info('MCP tools loaded', {
      count: this.tools.length,
      tools: this.tools.map(t => t.name),
    });

    this.initialized = true;
    this.emit('ready', { serverInfo: this.serverInfo, tools: this.tools });
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  private sendRequest(method: string, params: any, timeout = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        return reject(new Error('MCP process not running'));
      }

      const id = ++this.requestId;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeout}ms`));
      }, timeout);

      // Track pending request
      this.pendingRequests.set(id, {
        resolve,
        reject,
        timeout: timeoutHandle,
      });

      // Send request
      const message = JSON.stringify(request) + '\n';
      this.logger.debug('Sending request', { method, id });
      this.process.stdin.write(message);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  private sendNotification(method: string, params?: any): void {
    if (!this.process?.stdin) {
      this.logger.warn('Cannot send notification, process not running');
      return;
    }

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const message = JSON.stringify(notification) + '\n';
    this.logger.debug('Sending notification', { method });
    this.process.stdin.write(message);
  }

  /**
   * Handle incoming data from stdout
   */
  private handleData(data: string): void {
    this.buffer += data;

    // Process complete lines
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line) {
        this.handleLine(line);
      }
    }
  }

  /**
   * Handle a single JSON-RPC message line
   */
  private handleLine(line: string): void {
    try {
      const message: JsonRpcMessage = JSON.parse(line);

      if ('id' in message && message.id !== undefined) {
        // This is a response
        this.handleResponse(message as JsonRpcResponse);
      } else if ('method' in message) {
        // This is a notification
        this.handleNotification(message as JsonRpcNotification);
      }
    } catch (error) {
      this.logger.warn('Failed to parse JSON-RPC message', { line, error });
    }
  }

  /**
   * Handle a JSON-RPC response
   */
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      this.logger.warn('Received response for unknown request', { id: response.id });
      return;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Handle a JSON-RPC notification
   */
  private handleNotification(notification: JsonRpcNotification): void {
    const { method, params } = notification;

    this.logger.debug('Received notification', { method });

    // Emit generic notification event
    this.emit('notification', { method, params });

    // Emit method-specific event
    this.emit(method, params);

    // Special handling for common notification patterns
    if (method.includes('/')) {
      // e.g., "codex/event" -> emit "codex:event" and params.msg
      const [namespace, event] = method.split('/');
      this.emit(`${namespace}:${event}`, params);

      // For codex events, also emit the specific message type
      if (params?.msg?.type) {
        this.emit(`${namespace}:${params.msg.type}`, params);
      }
    }
  }
}

/**
 * Convenience function to create a Codex MCP client
 */
export function createCodexClient(options?: {
  cwd?: string;
  model?: string;
}): McpClient {
  const args = ['mcp-server'];

  if (options?.model) {
    args.push('-c', `model="${options.model}"`);
  }

  return new McpClient({
    command: 'codex',
    args,
    cwd: options?.cwd,
  }, 'CodexMcpClient');
}
