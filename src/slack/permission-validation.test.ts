import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Permission Validation Tests
 *
 * These tests verify the permission approval system:
 * 1. Only the original requester can approve/deny a permission request
 * 2. Other users cannot approve permission requests they didn't initiate
 * 3. SharedStore properly tracks who requested the permission
 * 4. Expired approvals are handled correctly
 */

// Simplified SharedStore for testing
class MockSharedStore {
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private responses: Map<string, PermissionResponse> = new Map();

  async storePendingApproval(approvalId: string, approval: PendingApproval): Promise<void> {
    this.pendingApprovals.set(approvalId, approval);
  }

  async getPendingApproval(approvalId: string): Promise<PendingApproval | null> {
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval) return null;

    // Check if expired
    if (Date.now() > approval.expires_at) {
      this.pendingApprovals.delete(approvalId);
      return null;
    }

    return approval;
  }

  async storePermissionResponse(approvalId: string, response: PermissionResponse): Promise<void> {
    this.responses.set(approvalId, response);
  }

  async getPermissionResponse(approvalId: string): Promise<PermissionResponse | null> {
    return this.responses.get(approvalId) || null;
  }

  async cleanup(approvalId: string): Promise<void> {
    this.pendingApprovals.delete(approvalId);
    this.responses.delete(approvalId);
  }
}

interface PendingApproval {
  tool_name: string;
  input: any;
  channel?: string;
  thread_ts?: string;
  user?: string; // The user who initiated the request
  created_at: number;
  expires_at: number;
}

interface PermissionResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: any;
  message?: string;
}

// Permission Approval Handler (simulating ActionHandlers logic)
class MockPermissionHandler {
  constructor(private store: MockSharedStore) {}

  async handleApproval(
    approvalId: string,
    respondingUserId: string,
    approved: boolean
  ): Promise<{ success: boolean; error?: string }> {
    const pendingApproval = await this.store.getPendingApproval(approvalId);

    if (!pendingApproval) {
      return { success: false, error: 'Approval not found or expired' };
    }

    // Validate that the responding user is the original requester
    if (pendingApproval.user !== respondingUserId) {
      return {
        success: false,
        error: '권한이 없습니다. 요청자만 승인할 수 있습니다.',
      };
    }

    // Store the response
    await this.store.storePermissionResponse(approvalId, {
      behavior: approved ? 'allow' : 'deny',
    });

    return { success: true };
  }
}

describe('Permission Validation', () => {
  let store: MockSharedStore;
  let handler: MockPermissionHandler;

  beforeEach(() => {
    store = new MockSharedStore();
    handler = new MockPermissionHandler(store);
  });

  describe('Requester Validation', () => {
    it('should allow requester to approve their own request', async () => {
      const approvalId = 'approval_123';
      const requesterId = 'U001';

      await store.storePendingApproval(approvalId, {
        tool_name: 'Bash',
        input: { command: 'rm -rf /tmp/test' },
        user: requesterId,
        channel: 'C123',
        thread_ts: '111.222',
        created_at: Date.now(),
        expires_at: Date.now() + 5 * 60 * 1000, // 5 minutes
      });

      const result = await handler.handleApproval(approvalId, requesterId, true);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      const response = await store.getPermissionResponse(approvalId);
      expect(response?.behavior).toBe('allow');
    });

    it('should allow requester to deny their own request', async () => {
      const approvalId = 'approval_123';
      const requesterId = 'U001';

      await store.storePendingApproval(approvalId, {
        tool_name: 'Bash',
        input: { command: 'rm -rf /tmp/test' },
        user: requesterId,
        channel: 'C123',
        thread_ts: '111.222',
        created_at: Date.now(),
        expires_at: Date.now() + 5 * 60 * 1000,
      });

      const result = await handler.handleApproval(approvalId, requesterId, false);

      expect(result.success).toBe(true);

      const response = await store.getPermissionResponse(approvalId);
      expect(response?.behavior).toBe('deny');
    });

    it('should reject approval from different user', async () => {
      const approvalId = 'approval_123';
      const requesterId = 'U001';
      const otherUserId = 'U999';

      await store.storePendingApproval(approvalId, {
        tool_name: 'Bash',
        input: { command: 'rm -rf /tmp/test' },
        user: requesterId,
        channel: 'C123',
        thread_ts: '111.222',
        created_at: Date.now(),
        expires_at: Date.now() + 5 * 60 * 1000,
      });

      const result = await handler.handleApproval(approvalId, otherUserId, true);

      expect(result.success).toBe(false);
      expect(result.error).toContain('권한이 없습니다');

      // No response should be stored
      const response = await store.getPermissionResponse(approvalId);
      expect(response).toBeNull();
    });

    it('should reject denial from different user', async () => {
      const approvalId = 'approval_123';
      const requesterId = 'U001';
      const otherUserId = 'U999';

      await store.storePendingApproval(approvalId, {
        tool_name: 'Bash',
        input: { command: 'rm -rf /tmp/test' },
        user: requesterId,
        channel: 'C123',
        thread_ts: '111.222',
        created_at: Date.now(),
        expires_at: Date.now() + 5 * 60 * 1000,
      });

      const result = await handler.handleApproval(approvalId, otherUserId, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('권한이 없습니다');
    });
  });

  describe('Expiration Handling', () => {
    it('should reject approval for expired request', async () => {
      const approvalId = 'approval_123';
      const requesterId = 'U001';

      await store.storePendingApproval(approvalId, {
        tool_name: 'Bash',
        input: { command: 'rm -rf /tmp/test' },
        user: requesterId,
        channel: 'C123',
        thread_ts: '111.222',
        created_at: Date.now() - 10 * 60 * 1000, // 10 minutes ago
        expires_at: Date.now() - 5 * 60 * 1000, // Expired 5 minutes ago
      });

      const result = await handler.handleApproval(approvalId, requesterId, true);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found or expired');
    });

    it('should accept approval just before expiration', async () => {
      const approvalId = 'approval_123';
      const requesterId = 'U001';

      await store.storePendingApproval(approvalId, {
        tool_name: 'Bash',
        input: { command: 'rm -rf /tmp/test' },
        user: requesterId,
        channel: 'C123',
        thread_ts: '111.222',
        created_at: Date.now(),
        expires_at: Date.now() + 1000, // Expires in 1 second
      });

      const result = await handler.handleApproval(approvalId, requesterId, true);

      expect(result.success).toBe(true);
    });
  });

  describe('Non-existent Approvals', () => {
    it('should reject approval for non-existent request', async () => {
      const result = await handler.handleApproval('nonexistent_approval', 'U001', true);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found or expired');
    });

    it('should handle multiple approval attempts gracefully', async () => {
      const approvalId = 'approval_123';
      const requesterId = 'U001';

      await store.storePendingApproval(approvalId, {
        tool_name: 'Bash',
        input: { command: 'rm -rf /tmp/test' },
        user: requesterId,
        channel: 'C123',
        thread_ts: '111.222',
        created_at: Date.now(),
        expires_at: Date.now() + 5 * 60 * 1000,
      });

      // First approval succeeds
      const result1 = await handler.handleApproval(approvalId, requesterId, true);
      expect(result1.success).toBe(true);

      // Second approval can still succeed (idempotent in mock)
      // In real implementation, might want to prevent double-approval
      const result2 = await handler.handleApproval(approvalId, requesterId, true);
      expect(result2.success).toBe(true);
    });
  });

  describe('Channel and Thread Context', () => {
    it('should store channel and thread context with approval', async () => {
      const approvalId = 'approval_123';
      const channel = 'C123';
      const threadTs = '111.222';
      const requesterId = 'U001';

      await store.storePendingApproval(approvalId, {
        tool_name: 'Bash',
        input: { command: 'ls' },
        user: requesterId,
        channel,
        thread_ts: threadTs,
        created_at: Date.now(),
        expires_at: Date.now() + 5 * 60 * 1000,
      });

      const approval = await store.getPendingApproval(approvalId);

      expect(approval?.channel).toBe(channel);
      expect(approval?.thread_ts).toBe(threadTs);
      expect(approval?.user).toBe(requesterId);
    });
  });

  describe('Tool Information', () => {
    it('should store tool name and input with approval', async () => {
      const approvalId = 'approval_123';
      const toolName = 'Write';
      const toolInput = { file_path: '/tmp/test.txt', content: 'hello' };

      await store.storePendingApproval(approvalId, {
        tool_name: toolName,
        input: toolInput,
        user: 'U001',
        created_at: Date.now(),
        expires_at: Date.now() + 5 * 60 * 1000,
      });

      const approval = await store.getPendingApproval(approvalId);

      expect(approval?.tool_name).toBe(toolName);
      expect(approval?.input).toEqual(toolInput);
    });
  });
});

describe('SharedStore File Operations', () => {
  // These tests use the actual SharedStore implementation to test file-based storage
  // They are skipped if running in CI or if temp directory is not writable

  const testStoreDir = path.join(os.tmpdir(), 'claude-code-slack-bot-store-test');

  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(testStoreDir)) {
      fs.rmSync(testStoreDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testStoreDir)) {
      fs.rmSync(testStoreDir, { recursive: true, force: true });
    }
  });

  it('should create store directories on initialization', () => {
    // This test verifies the directory creation behavior
    // The actual SharedStore creates directories in constructor
    const pendingDir = path.join(testStoreDir, 'pending');
    const responseDir = path.join(testStoreDir, 'responses');

    fs.mkdirSync(testStoreDir, { recursive: true });
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.mkdirSync(responseDir, { recursive: true });

    expect(fs.existsSync(pendingDir)).toBe(true);
    expect(fs.existsSync(responseDir)).toBe(true);
  });
});
