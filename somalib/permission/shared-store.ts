import fs from 'fs';
import os from 'os';
import path from 'path';
import { StderrLogger } from '../stderr-logger';

const logger = new StderrLogger('SharedStore');

export interface PermissionResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: any;
  message?: string;
  /** MCP grant answers: the outcome line every admin DM copy is rewritten to (by the answer, and again by the child). */
  promptText?: string;
}

/**
 * Marker the permission MCP server stamps on the approvals it writes.
 *
 * The pending directory is shared: mcp-tool-permission stores its
 * admin-approved grant requests there too, with `user` = the (non-admin)
 * requester. Only records carrying this marker are permission prompts that
 * their requester may answer (Slack buttons, dashboard) — anything else is
 * invisible to and unanswerable through `answerPermissionPrompt`.
 */
export const PERMISSION_PROMPT_KIND = 'tool_permission' as const;

/**
 * Marker mcp-tool-permission stamps on its admin-approved grant requests
 * (`tool_name: 'request_permission'`). Older records carry no kind; readers
 * treat a kind-less `request_permission` record the same way.
 */
export const MCP_GRANT_KIND = 'mcp_grant' as const;

export interface PendingApproval {
  /** {@link PERMISSION_PROMPT_KIND} on permission prompts, {@link MCP_GRANT_KIND} on MCP grant requests. */
  kind?: typeof PERMISSION_PROMPT_KIND | typeof MCP_GRANT_KIND;
  tool_name: string;
  input: any;
  channel?: string;
  thread_ts?: string;
  user?: string;
  /**
   * #599 ⑤ — a Slack-less task's prompt is bound to the task (its session key)
   * and the turn that raised it, not to a Slack thread (it has none).
   */
  task_key?: string;
  turn_id?: string;
  created_at: number;
  expires_at: number;
  /**
   * Overridable dangerous-rule ids matched by this approval request.
   * Populated for a Bash approval request: permission-mcp-server re-runs
   * `overridableMatchedRuleIds()` on the command when the request arrives.
   *
   * Consumed by the Slack action handler to know which rule(s) to silence
   * for the session when the user clicks "Approve & disable rule for this
   * session". Absent for non-Bash tools and non-dangerous commands.
   */
  rule_ids?: string[];
  /** MCP grant requests: where each admin's DM prompt landed, so any answer can rewrite every copy. */
  prompts?: Array<{ channel: string; ts: string }>;
  /**
   * MCP grant requests: the data directory of the instance whose child wrote
   * the record. The store sits in the OS temp directory, which co-hosted
   * instances (dev and prod on one host) share; a dashboard lists and answers
   * only its own instance's requests.
   */
  owner?: string;
}

/** How long an answer claim is kept after it was made. */
const CLAIM_TTL_MS = 60 * 60 * 1000;

/**
 * File-based shared store for inter-process communication
 * between the permission MCP server and Slack handler
 */
class SharedStore {
  private storeDir: string;
  private pendingDir: string;
  private responseDir: string;
  private claimDir: string;

  constructor() {
    // Use OS temp directory for cross-process communication
    this.storeDir = path.join(os.tmpdir(), 'soma-work-store');
    this.pendingDir = path.join(this.storeDir, 'pending');
    this.responseDir = path.join(this.storeDir, 'responses');
    this.claimDir = path.join(this.storeDir, 'claims');

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
      if (!fs.existsSync(this.claimDir)) {
        fs.mkdirSync(this.claimDir, { recursive: true });
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
      await this.writeAtomic(filePath, JSON.stringify(approval, null, 2));
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
    return this.readPendingApproval(approvalId, false);
  }

  /** `quiet`: an unreadable record is skipped without an error log (the dashboard re-reads every second). */
  private async readPendingApproval(approvalId: string, quiet: boolean): Promise<PendingApproval | null> {
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
      if (quiet) logger.debug('Skipped an unreadable pending approval', { approvalId });
      else logger.error('Failed to get pending approval:', error);
      return null;
    }
  }

  /**
   * Store a permission response
   */
  async storePermissionResponse(approvalId: string, response: PermissionResponse): Promise<void> {
    const filePath = path.join(this.responseDir, `${approvalId}.json`);
    try {
      await this.writeAtomic(filePath, JSON.stringify(response, null, 2));
      logger.debug('Stored permission response', {
        approvalId,
        response: response.behavior,
      });
    } catch (error) {
      logger.error('Failed to store permission response:', error);
      throw error;
    }
  }

  /**
   * Claim the right to answer an approval. True exactly once per approval id,
   * across processes: the claim is an exclusive create (`wx`), so of two
   * surfaces answering at the same moment (Slack button, dashboard) one wins.
   *
   * The claim is a tombstone — `cleanup()` does not remove it — so a contender
   * that loaded the pending record before the MCP server consumed the answer
   * still loses. Claims older than {@link CLAIM_TTL_MS} (well past the 5 min
   * approval expiry) are swept on the next claim.
   *
   * Claim first, then perform any side effect, then `storePermissionResponse`.
   */
  async claimPermissionResponse(approvalId: string): Promise<boolean> {
    const filePath = path.join(this.claimDir, `${approvalId}.json`);
    try {
      await fs.promises.writeFile(filePath, JSON.stringify({ claimed_at: Date.now() }), { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      logger.error('Failed to claim permission response:', error);
      throw error;
    }
    void this.sweepClaims();
    return true;
  }

  /** Whether an answer has claimed this approval (it is being, or has been, answered). */
  async isPermissionClaimed(approvalId: string): Promise<boolean> {
    return fs.promises
      .access(path.join(this.claimDir, `${approvalId}.json`))
      .then(() => true)
      .catch(() => false);
  }

  /** Give a claim back — only when the answer that took it failed before its response was stored. */
  async releasePermissionClaim(approvalId: string): Promise<void> {
    await fs.promises.unlink(path.join(this.claimDir, `${approvalId}.json`)).catch(() => {});
  }

  private async sweepClaims(): Promise<void> {
    try {
      const cutoff = Date.now() - CLAIM_TTL_MS;
      for (const name of await fs.promises.readdir(this.claimDir)) {
        const filePath = path.join(this.claimDir, name);
        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) await fs.promises.unlink(filePath).catch(() => {});
      }
    } catch (error) {
      logger.warn('Failed to sweep permission claims:', error);
    }
  }

  /**
   * Write via a same-directory temp file + rename, so a reader polling for the
   * file never sees it half-written.
   */
  private async writeAtomic(filePath: string, data: string): Promise<void> {
    const tmp = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    try {
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, filePath);
    } catch (error) {
      await fs.promises.unlink(tmp).catch(() => {});
      throw error;
    }
  }

  /**
   * Wait for a permission response with polling
   */
  async waitForPermissionResponse(
    approvalId: string,
    timeoutMs: number = 5 * 60 * 1000,
    signal?: AbortSignal,
  ): Promise<PermissionResponse> {
    const filePath = path.join(this.responseDir, `${approvalId}.json`);
    const startTime = Date.now();
    const pollInterval = 500; // 500ms polling interval

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const finish = () => {
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        if (settled) return;
        const reason = signal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
        finish();
        void this.cleanup(approvalId).finally(() => reject(reason));
      };

      const poll = async () => {
        if (settled) return;
        try {
          // Check for timeout
          if (Date.now() - startTime > timeoutMs) {
            finish();
            await this.cleanup(approvalId);
            resolve({
              behavior: 'deny',
              message: 'Permission request timed out',
            });
            return;
          }

          // Check if response exists
          if (fs.existsSync(filePath)) {
            const data = await fs.promises.readFile(filePath, 'utf8');
            const response = JSON.parse(data) as PermissionResponse;

            finish();
            await this.cleanup(approvalId);

            resolve(response);
            return;
          }

          // Continue polling
          timer = setTimeout(poll, pollInterval);
        } catch (error) {
          finish();
          logger.error('Error during polling:', error);
          await this.cleanup(approvalId);
          reject(error);
        }
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      } else {
        void poll();
      }
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
    await Promise.all([this.deletePendingApproval(approvalId), this.deletePermissionResponse(approvalId)]);
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
      return files.filter((f) => f.endsWith('.json')).length;
    } catch (error) {
      logger.error('Failed to get pending count:', error);
      return 0;
    }
  }

  /**
   * Every live pending approval with its id. Expired records are dropped (and
   * deleted, as `getPendingApproval` does); unreadable ones are skipped.
   */
  async listPendingApprovals(): Promise<Array<{ approvalId: string; approval: PendingApproval }>> {
    const out: Array<{ approvalId: string; approval: PendingApproval }> = [];
    for (const approvalId of await this.listPendingApprovalIds()) {
      const approval = await this.readPendingApproval(approvalId, true);
      if (approval) out.push({ approvalId, approval });
    }
    return out;
  }

  /**
   * List all pending approval IDs
   */
  async listPendingApprovalIds(): Promise<string[]> {
    try {
      const files = await fs.promises.readdir(this.pendingDir);
      return files.filter((f) => f.endsWith('.json') && !f.startsWith('.')).map((f) => f.replace('.json', ''));
    } catch (error) {
      logger.error('Failed to list pending approval IDs:', error);
      return [];
    }
  }
}

// Singleton instance
export const sharedStore = new SharedStore();
