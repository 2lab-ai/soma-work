import { Logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';

interface McpCallRecord {
  serverName: string;
  toolName: string;
  startTime: number;
  endTime?: number;
  duration?: number;
}

interface McpCallStats {
  serverName: string;
  toolName: string;
  callCount: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  lastCalls: number[]; // Last N durations
}

const MAX_HISTORY = 100; // Keep last 100 calls per server/tool combination
const DATA_FILE = path.join(process.cwd(), 'data', 'mcp-call-stats.json');

/**
 * MCP Call Tracker - Tracks MCP tool call durations and provides predictions
 */
export class McpCallTracker {
  private static instance: McpCallTracker;
  private logger = new Logger('McpCallTracker');
  private activeCalls: Map<string, McpCallRecord> = new Map();
  private stats: Map<string, McpCallStats> = new Map();

  private constructor() {
    this.loadStats();
  }

  static getInstance(): McpCallTracker {
    if (!McpCallTracker.instance) {
      McpCallTracker.instance = new McpCallTracker();
    }
    return McpCallTracker.instance;
  }

  /**
   * Start tracking an MCP call
   * Returns a unique call ID
   */
  startCall(serverName: string, toolName: string): string {
    const callId = `${serverName}__${toolName}__${Date.now()}__${Math.random().toString(36).substring(7)}`;

    this.activeCalls.set(callId, {
      serverName,
      toolName,
      startTime: Date.now(),
    });

    this.logger.debug('MCP call started', { callId, serverName, toolName });
    return callId;
  }

  /**
   * End tracking an MCP call and record the duration
   */
  endCall(callId: string): number | null {
    const call = this.activeCalls.get(callId);
    if (!call) {
      this.logger.warn('Attempted to end unknown call', { callId });
      return null;
    }

    const endTime = Date.now();
    const duration = endTime - call.startTime;

    call.endTime = endTime;
    call.duration = duration;

    this.activeCalls.delete(callId);

    // Update stats
    this.updateStats(call.serverName, call.toolName, duration);

    this.logger.debug('MCP call ended', {
      callId,
      serverName: call.serverName,
      toolName: call.toolName,
      duration,
    });

    return duration;
  }

  /**
   * Get the elapsed time for an active call
   */
  getElapsedTime(callId: string): number | null {
    const call = this.activeCalls.get(callId);
    if (!call) {
      return null;
    }
    return Date.now() - call.startTime;
  }

  /**
   * Get active call info
   */
  getActiveCall(callId: string): McpCallRecord | null {
    return this.activeCalls.get(callId) || null;
  }

  /**
   * Get predicted duration for a tool based on historical data
   */
  getPredictedDuration(serverName: string, toolName: string): number | null {
    const key = this.getStatsKey(serverName, toolName);
    const stat = this.stats.get(key);

    if (!stat || stat.callCount === 0) {
      return null;
    }

    return stat.avgDuration;
  }

  /**
   * Get stats for a specific tool
   */
  getToolStats(serverName: string, toolName: string): McpCallStats | null {
    const key = this.getStatsKey(serverName, toolName);
    return this.stats.get(key) || null;
  }

  /**
   * Get all stats
   */
  getAllStats(): McpCallStats[] {
    return Array.from(this.stats.values());
  }

  /**
   * Format duration as human readable string
   */
  static formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(1)}s`;
    } else {
      const minutes = Math.floor(ms / 60000);
      const seconds = ((ms % 60000) / 1000).toFixed(0);
      return `${minutes}m ${seconds}s`;
    }
  }

  /**
   * Get status message for an active MCP call
   */
  getStatusMessage(callId: string): string | null {
    const call = this.activeCalls.get(callId);
    if (!call) {
      return null;
    }

    const elapsed = Date.now() - call.startTime;
    const predicted = this.getPredictedDuration(call.serverName, call.toolName);

    let message = `⏳ *MCP: ${call.serverName} → ${call.toolName}*\n`;
    message += `경과 시간: ${McpCallTracker.formatDuration(elapsed)}`;

    if (predicted) {
      const remaining = Math.max(0, predicted - elapsed);
      const progress = Math.min(100, (elapsed / predicted) * 100);
      message += `\n예상 시간: ${McpCallTracker.formatDuration(predicted)}`;
      message += `\n남은 시간: ~${McpCallTracker.formatDuration(remaining)}`;
      message += `\n진행률: ${progress.toFixed(0)}%`;
    }

    return message;
  }

  private getStatsKey(serverName: string, toolName: string): string {
    return `${serverName}__${toolName}`;
  }

  private updateStats(serverName: string, toolName: string, duration: number): void {
    const key = this.getStatsKey(serverName, toolName);
    let stat = this.stats.get(key);

    if (!stat) {
      stat = {
        serverName,
        toolName,
        callCount: 0,
        avgDuration: 0,
        minDuration: Infinity,
        maxDuration: 0,
        lastCalls: [],
      };
      this.stats.set(key, stat);
    }

    // Add to lastCalls
    stat.lastCalls.push(duration);
    if (stat.lastCalls.length > MAX_HISTORY) {
      stat.lastCalls.shift();
    }

    // Update stats
    stat.callCount++;
    stat.minDuration = Math.min(stat.minDuration, duration);
    stat.maxDuration = Math.max(stat.maxDuration, duration);

    // Recalculate average from lastCalls
    stat.avgDuration = stat.lastCalls.reduce((a, b) => a + b, 0) / stat.lastCalls.length;

    // Save stats periodically
    this.saveStats();
  }

  private loadStats(): void {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const data = fs.readFileSync(DATA_FILE, 'utf-8');
        const parsed = JSON.parse(data);

        for (const [key, value] of Object.entries(parsed)) {
          this.stats.set(key, value as McpCallStats);
        }

        this.logger.info('Loaded MCP call stats', { count: this.stats.size });
      }
    } catch (error) {
      this.logger.warn('Failed to load MCP call stats', error);
    }
  }

  private saveStats(): void {
    try {
      // Ensure data directory exists
      const dataDir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const data: Record<string, McpCallStats> = {};
      for (const [key, value] of this.stats) {
        data[key] = value;
      }

      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      this.logger.warn('Failed to save MCP call stats', error);
    }
  }
}

// Export singleton instance
export const mcpCallTracker = McpCallTracker.getInstance();
