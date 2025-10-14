import fs from 'fs';
import path from 'path';
import os from 'os';
import { StderrLogger } from './stderr-logger.js';

const logger = new StderrLogger('SharedStore');

export interface PermissionResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: any;
  message?: string;
}

export interface PendingApproval {
  tool_name: string;
  input: any;
  channel?: string;
  thread_ts?: string;
  user?: string;
  created_at: number;
  expires_at: number;
}

/**
 * File-based shared store for inter-process communication
 * between the permission MCP server and Slack handler
 */
export class SharedStore {
  private storeDir: string;
  private pendingDir: string;
  private responseDir: string;

  constructor() {
    // Use OS temp directory for cross-process communication
    this.storeDir = path.join(os.tmpdir(), 'claude-code-slack-bot-store');
    this.pendingDir = path.join(this.storeDir, 'pending');
    this.responseDir = path.join(this.storeDir, 'responses');
    
    this.ensureDirectories();
  }

  private ensureDirectories() {
    try {
      if (!fs.existsSync(this.storeDir)) {
        fs.mkdirSync(this.storeDir, { recursive: true });
      }
      if (!fs.existsSync(this.pendingDir)) {
        fs.mkdirSync(this.pendingDir, { recursive: true });
      }
      if (!fs.existsSync(this.responseDir)) {
        fs.mkdirSync(this.responseDir, { recursive: true });
      }
    } catch (error) {
      logger.error('Failed to create store directories:', error);
      throw error;
    }
  }

  /**
   * Store a pending approval request
   */
  async storePendingApproval(approvalId: string, approval: PendingApproval): Promise<void> {
    const filePath = path.join(this.pendingDir, `${approvalId}.json`);
    try {
      await fs.promises.writeFile(filePath, JSON.stringify(approval, null, 2));
      logger.debug('Stored pending approval', { approvalId, filePath });
    } catch (error) {
      logger.error('Failed to store pending approval:', error);
      throw error;
    }
  }

  /**
   * Get a pending approval request
   */
  async getPendingApproval(approvalId: string): Promise<PendingApproval | null> {
    const filePath = path.join(this.pendingDir, `${approvalId}.json`);
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      
      const data = await fs.promises.readFile(filePath, 'utf8');
      const approval = JSON.parse(data) as PendingApproval;
      
      // Check if expired
      if (Date.now() > approval.expires_at) {
        await this.deletePendingApproval(approvalId);
        return null;
      }
      
      return approval;
    } catch (error) {
      logger.error('Failed to get pending approval:', error);
      return null;
    }
  }

  /**
   * Store a permission response
   */
  async storePermissionResponse(approvalId: string, response: PermissionResponse): Promise<void> {
    const filePath = path.join(this.responseDir, `${approvalId}.json`);
    try {
      await fs.promises.writeFile(filePath, JSON.stringify(response, null, 2));
      logger.debug('Stored permission response', { approvalId, response: response.behavior });
    } catch (error) {
      logger.error('Failed to store permission response:', error);
      throw error;
    }
  }

  /**
   * Wait for a permission response with polling
   */
  async waitForPermissionResponse(approvalId: string, timeoutMs: number = 5 * 60 * 1000): Promise<PermissionResponse> {
    const filePath = path.join(this.responseDir, `${approvalId}.json`);
    const startTime = Date.now();
    const pollInterval = 500; // 500ms polling interval
    
    return new Promise((resolve, reject) => {
      const poll = async () => {
        try {
          // Check for timeout
          if (Date.now() - startTime > timeoutMs) {
            await this.cleanup(approvalId);
            resolve({
              behavior: 'deny',
              message: 'Permission request timed out'
            });
            return;
          }

          // Check if response exists
          if (fs.existsSync(filePath)) {
            const data = await fs.promises.readFile(filePath, 'utf8');
            const response = JSON.parse(data) as PermissionResponse;
            
            // Cleanup files
            await this.cleanup(approvalId);
            
            resolve(response);
            return;
          }

          // Continue polling
          setTimeout(poll, pollInterval);
        } catch (error) {
          logger.error('Error during polling:', error);
          await this.cleanup(approvalId);
          reject(error);
        }
      };

      poll();
    });
  }

  /**
   * Delete a pending approval
   */
  async deletePendingApproval(approvalId: string): Promise<void> {
    const filePath = path.join(this.pendingDir, `${approvalId}.json`);
    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        logger.debug('Deleted pending approval', { approvalId });
      }
    } catch (error) {
      logger.error('Failed to delete pending approval:', error);
    }
  }

  /**
   * Clean up all files for an approval ID
   */
  async cleanup(approvalId: string): Promise<void> {
    await Promise.all([
      this.deletePendingApproval(approvalId),
      this.deletePermissionResponse(approvalId)
    ]);
  }

  /**
   * Delete a permission response
   */
  async deletePermissionResponse(approvalId: string): Promise<void> {
    const filePath = path.join(this.responseDir, `${approvalId}.json`);
    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        logger.debug('Deleted permission response', { approvalId });
      }
    } catch (error) {
      logger.error('Failed to delete permission response:', error);
    }
  }

  /**
   * Clean up expired approvals
   */
  async cleanupExpired(): Promise<number> {
    let cleaned = 0;
    try {
      const pendingFiles = await fs.promises.readdir(this.pendingDir);
      
      for (const fileName of pendingFiles) {
        if (!fileName.endsWith('.json')) continue;
        
        const approvalId = fileName.replace('.json', '');
        const approval = await this.getPendingApproval(approvalId);
        
        if (!approval) {
          // File was already cleaned up by getPendingApproval if expired
          cleaned++;
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup expired approvals:', error);
    }
    
    return cleaned;
  }

  /**
   * Get count of pending approvals
   */
  async getPendingCount(): Promise<number> {
    try {
      const files = await fs.promises.readdir(this.pendingDir);
      return files.filter(f => f.endsWith('.json')).length;
    } catch (error) {
      logger.error('Failed to get pending count:', error);
      return 0;
    }
  }

  /**
   * List all pending approval IDs
   */
  async listPendingApprovalIds(): Promise<string[]> {
    try {
      const files = await fs.promises.readdir(this.pendingDir);
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
    } catch (error) {
      logger.error('Failed to list pending approval IDs:', error);
      return [];
    }
  }
}

// Singleton instance
export const sharedStore = new SharedStore();