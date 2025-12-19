import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReactionManager } from './reaction-manager';
import { SlackApiHelper } from './slack-api-helper';
import { Todo } from '../todo-manager';

// Mock SlackApiHelper
const createMockSlackApi = () => ({
  addReaction: vi.fn().mockResolvedValue(true),
  removeReaction: vi.fn().mockResolvedValue(undefined),
});

describe('ReactionManager', () => {
  let mockSlackApi: ReturnType<typeof createMockSlackApi>;
  let manager: ReactionManager;

  beforeEach(() => {
    mockSlackApi = createMockSlackApi();
    manager = new ReactionManager(mockSlackApi as unknown as SlackApiHelper);
  });

  describe('setOriginalMessage / getOriginalMessage', () => {
    it('should store and retrieve original message info', () => {
      manager.setOriginalMessage('session1', 'C123', '123.456');

      const result = manager.getOriginalMessage('session1');
      expect(result).toEqual({ channel: 'C123', ts: '123.456' });
    });

    it('should return undefined for unknown session', () => {
      const result = manager.getOriginalMessage('unknown');
      expect(result).toBeUndefined();
    });
  });

  describe('updateReaction', () => {
    it('should not update if no original message exists', async () => {
      await manager.updateReaction('unknown', 'thumbsup');

      expect(mockSlackApi.addReaction).not.toHaveBeenCalled();
      expect(mockSlackApi.removeReaction).not.toHaveBeenCalled();
    });

    it('should add reaction when no previous reaction exists', async () => {
      manager.setOriginalMessage('session1', 'C123', '123.456');

      await manager.updateReaction('session1', 'thumbsup');

      expect(mockSlackApi.addReaction).toHaveBeenCalledWith('C123', '123.456', 'thumbsup');
      expect(mockSlackApi.removeReaction).not.toHaveBeenCalled();
    });

    it('should remove old and add new reaction', async () => {
      manager.setOriginalMessage('session1', 'C123', '123.456');

      await manager.updateReaction('session1', 'thumbsup');
      await manager.updateReaction('session1', 'white_check_mark');

      expect(mockSlackApi.removeReaction).toHaveBeenCalledWith('C123', '123.456', 'thumbsup');
      expect(mockSlackApi.addReaction).toHaveBeenCalledWith('C123', '123.456', 'white_check_mark');
    });

    it('should skip if same reaction is already set', async () => {
      manager.setOriginalMessage('session1', 'C123', '123.456');

      await manager.updateReaction('session1', 'thumbsup');
      mockSlackApi.addReaction.mockClear();
      mockSlackApi.removeReaction.mockClear();

      await manager.updateReaction('session1', 'thumbsup');

      expect(mockSlackApi.addReaction).not.toHaveBeenCalled();
      expect(mockSlackApi.removeReaction).not.toHaveBeenCalled();
    });

    it('should not update state when addReaction fails', async () => {
      manager.setOriginalMessage('session1', 'C123', '123.456');
      mockSlackApi.addReaction.mockResolvedValue(false);

      await manager.updateReaction('session1', 'thumbsup');

      expect(mockSlackApi.addReaction).toHaveBeenCalled();
      expect(manager.getCurrentReaction('session1')).toBeUndefined();
    });

    it('should allow retry when previous addReaction failed', async () => {
      manager.setOriginalMessage('session1', 'C123', '123.456');

      // First call fails
      mockSlackApi.addReaction.mockResolvedValue(false);
      await manager.updateReaction('session1', 'thumbsup');
      expect(manager.getCurrentReaction('session1')).toBeUndefined();

      // Second call succeeds (same emoji should not be skipped since state wasn't updated)
      mockSlackApi.addReaction.mockResolvedValue(true);
      await manager.updateReaction('session1', 'thumbsup');
      expect(manager.getCurrentReaction('session1')).toBe('thumbsup');
    });
  });

  describe('updateTaskProgressReaction', () => {
    beforeEach(() => {
      manager.setOriginalMessage('session1', 'C123', '123.456');
    });

    it('should not update for empty todos', async () => {
      await manager.updateTaskProgressReaction('session1', []);

      expect(mockSlackApi.addReaction).not.toHaveBeenCalled();
    });

    it('should show white_check_mark when all completed', async () => {
      const todos: Todo[] = [
        { id: '1', content: 'Task 1', status: 'completed', priority: 'medium' },
        { id: '2', content: 'Task 2', status: 'completed', priority: 'medium' },
      ];

      await manager.updateTaskProgressReaction('session1', todos);

      expect(mockSlackApi.addReaction).toHaveBeenCalledWith('C123', '123.456', 'white_check_mark');
    });

    it('should show arrows_counterclockwise when in progress', async () => {
      const todos: Todo[] = [
        { id: '1', content: 'Task 1', status: 'completed', priority: 'medium' },
        { id: '2', content: 'Task 2', status: 'in_progress', priority: 'medium' },
        { id: '3', content: 'Task 3', status: 'pending', priority: 'medium' },
      ];

      await manager.updateTaskProgressReaction('session1', todos);

      expect(mockSlackApi.addReaction).toHaveBeenCalledWith('C123', '123.456', 'arrows_counterclockwise');
    });

    it('should show clipboard when all pending', async () => {
      const todos: Todo[] = [
        { id: '1', content: 'Task 1', status: 'pending', priority: 'medium' },
        { id: '2', content: 'Task 2', status: 'pending', priority: 'medium' },
      ];

      await manager.updateTaskProgressReaction('session1', todos);

      expect(mockSlackApi.addReaction).toHaveBeenCalledWith('C123', '123.456', 'clipboard');
    });
  });

  describe('cleanup', () => {
    it('should remove all state for session', async () => {
      manager.setOriginalMessage('session1', 'C123', '123.456');
      await manager.updateReaction('session1', 'thumbsup');

      manager.cleanup('session1');

      expect(manager.getOriginalMessage('session1')).toBeUndefined();
      expect(manager.getCurrentReaction('session1')).toBeUndefined();
    });
  });

  describe('getCurrentReaction', () => {
    it('should return current reaction', async () => {
      manager.setOriginalMessage('session1', 'C123', '123.456');
      await manager.updateReaction('session1', 'thumbsup');

      expect(manager.getCurrentReaction('session1')).toBe('thumbsup');
    });

    it('should return undefined for unknown session', () => {
      expect(manager.getCurrentReaction('unknown')).toBeUndefined();
    });
  });
});
