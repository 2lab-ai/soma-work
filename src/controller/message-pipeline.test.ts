/**
 * MessagePipeline tests (Issue #411)
 */

import { describe, expect, it, vi } from 'vitest';
import type { InputEvent, MessageInputEvent } from '../view/input.js';
import type { ResponseSession } from '../view/response-session.js';
import type { ViewSurfaceCore } from '../view/surface.js';
import type { ConversationTarget, FeatureSet, MessageHandle } from '../view/types.js';
import type { AgentEvent, AgentProvider } from './agent-provider.js';
import { MessagePipeline, type PipelineEvent } from './message-pipeline.js';
import type { SessionRegistryLike } from './session-controller.js';
import { SessionController } from './session-controller.js';

// ─── Helpers ────────────────────────────────────────────────────

async function* mockEventStream(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const event of events) {
    yield event;
  }
}

function createMockProvider(events: AgentEvent[] = []): AgentProvider {
  return {
    name: 'test',
    query: vi.fn().mockReturnValue(mockEventStream(events)),
    queryOneShot: vi.fn().mockResolvedValue(''),
    validateCredentials: vi.fn().mockResolvedValue(true),
  };
}

function createMockRegistry(): SessionRegistryLike {
  const sessions = new Map<string, any>();

  return {
    getSessionKey: vi.fn((ch, ts) => `${ch}:${ts || 'root'}`),
    getSessionKeyWithUser: vi.fn((uid, ch, ts) => `${uid}:${ch}:${ts || 'root'}`),
    getSession: vi.fn((ch, ts) => sessions.get(`${ch}:${ts || 'root'}`)),
    getSessionWithUser: vi.fn(),
    getSessionByKey: vi.fn((key) => sessions.get(key)),
    findSessionBySourceThread: vi.fn(),
    getAllSessions: vi.fn(() => sessions),
    createSession: vi.fn((ownerId, ownerName, channelId, threadTs, model) => {
      const key = `${channelId}:${threadTs || 'root'}`;
      const session = {
        ownerId,
        ownerName,
        channelId,
        threadTs,
        model,
        state: 'INITIALIZING' as const,
        activityState: 'idle' as const,
        isActive: true,
        lastActivity: new Date(),
        userId: ownerId,
      };
      sessions.set(key, session);
      return session;
    }),
    setSessionTitle: vi.fn(),
    updateSessionTitle: vi.fn(),
    terminateSession: vi.fn().mockReturnValue(true),
    clearSessionId: vi.fn(),
    resetSessionContext: vi.fn().mockReturnValue(true),
    transitionToMain: vi.fn(),
    needsDispatch: vi.fn().mockReturnValue(true),
    isSleeping: vi.fn().mockReturnValue(false),
    wakeFromSleep: vi.fn().mockReturnValue(true),
    transitionToSleep: vi.fn().mockReturnValue(true),
    getSessionWorkflow: vi.fn().mockReturnValue('default'),
    setActivityState: vi.fn(),
    setActivityStateByKey: vi.fn(),
    getActivityState: vi.fn().mockReturnValue('idle'),
    cleanupInactiveSessions: vi.fn().mockResolvedValue(undefined),
    saveSessions: vi.fn(),
    loadSessions: vi.fn().mockReturnValue(5),
    refreshSessionActivityByKey: vi.fn().mockReturnValue(true),
    setSessionLink: vi.fn(),
    setSessionLinks: vi.fn(),
    getSessionLinks: vi.fn(),
    addSourceWorkingDir: vi.fn().mockReturnValue(true),
    getSessionResourceSnapshot: vi.fn().mockReturnValue({ dirs: [], files: [] }),
    updateSessionResources: vi.fn().mockReturnValue({ success: true }),
  };
}

function createMockResponseSession(): ResponseSession {
  return {
    appendText: vi.fn(),
    setStatus: vi.fn(),
    replacePart: vi.fn(),
    attachFile: vi.fn(),
    complete: vi.fn().mockResolvedValue({
      platform: 'slack',
      ref: { channel: 'C123', ts: '1700000000.000000' },
    } as MessageHandle),
    abort: vi.fn(),
  };
}

function createMockView(responseSession?: ResponseSession): ViewSurfaceCore {
  const rs = responseSession ?? createMockResponseSession();
  return {
    platform: 'slack',
    postMessage: vi.fn().mockResolvedValue({
      platform: 'slack',
      ref: { channel: 'C123', ts: '1700000000.000000' },
    }),
    beginResponse: vi.fn().mockReturnValue(rs),
    featuresFor: vi.fn().mockReturnValue({
      canEdit: true,
      canThread: true,
      canReact: true,
      canModal: true,
      canUploadFile: true,
      canEphemeral: true,
      maxMessageLength: 4000,
      maxFileSize: 0,
    } satisfies FeatureSet),
  };
}

function createTarget(channel = 'C123', threadTs?: string): ConversationTarget {
  return {
    platform: 'slack',
    ref: { channel, threadTs },
    userId: 'U456',
  };
}

function createMessageInput(text = 'Hello', channel = 'C123', threadTs?: string): MessageInputEvent {
  return {
    type: 'message',
    target: createTarget(channel, threadTs),
    text,
    timestamp: Date.now(),
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('MessagePipeline', () => {
  describe('input validation', () => {
    it('rejects input without target', async () => {
      const provider = createMockProvider();
      const controller = new SessionController(createMockRegistry());
      const pipeline = new MessagePipeline(provider, controller);
      const view = createMockView();

      const result = await pipeline.handle(
        { type: 'message', target: undefined as any, text: 'Hi', timestamp: Date.now() },
        view,
      );

      expect(result.success).toBe(false);
      expect(result.skipReason).toBe('missing_target');
    });

    it('rejects empty messages', async () => {
      const provider = createMockProvider();
      const controller = new SessionController(createMockRegistry());
      const pipeline = new MessagePipeline(provider, controller);
      const view = createMockView();

      const result = await pipeline.handle(createMessageInput('   '), view);

      expect(result.success).toBe(false);
      expect(result.skipReason).toBe('empty_message');
    });

    it('rejects prompts exceeding max length', async () => {
      const provider = createMockProvider();
      const controller = new SessionController(createMockRegistry());
      const pipeline = new MessagePipeline(provider, controller, { maxPromptLength: 10 });
      const view = createMockView();

      const result = await pipeline.handle(createMessageInput('A'.repeat(20)), view);

      expect(result.success).toBe(false);
      expect(result.skipReason).toContain('prompt_too_long');
    });
  });

  describe('session management', () => {
    it('creates a new session for unknown targets', async () => {
      const events: AgentEvent[] = [
        { type: 'text', text: 'Hi' },
        { type: 'turn_complete', stopReason: 'end_turn' },
      ];
      const provider = createMockProvider(events);
      const registry = createMockRegistry();
      const controller = new SessionController(registry);
      const pipeline = new MessagePipeline(provider, controller);
      const view = createMockView();

      await pipeline.handle(createMessageInput('Hello'), view);

      // Platform-agnostic: passes raw userId as channelId (not pre-resolved key)
      expect(registry.createSession).toHaveBeenCalledWith('U456', 'U456', 'U456', undefined, undefined);
    });

    it('reuses existing session', async () => {
      const events: AgentEvent[] = [
        { type: 'text', text: 'Hi again' },
        { type: 'turn_complete', stopReason: 'end_turn' },
      ];
      const provider = createMockProvider(events);
      const registry = createMockRegistry();
      // Pre-create session with the platform-agnostic key (userId-based)
      // The pipeline resolves session key as getSessionKey(userId) = "U456:root"
      // Mock's createSession stores under "${channelId}:${threadTs || 'root'}"
      // So we pass channelId='U456' to get key "U456:root"
      registry.createSession('U456', 'User', 'U456', undefined);
      const controller = new SessionController(registry);
      const pipeline = new MessagePipeline(provider, controller);
      const view = createMockView();

      await pipeline.handle(createMessageInput('Hello again'), view);

      // createSession should have been called once (the pre-creation), not twice
      expect(registry.createSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('message execution', () => {
    it('processes a message through the full pipeline', async () => {
      const events: AgentEvent[] = [
        { type: 'text', text: 'Response text' },
        { type: 'turn_complete', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50 } },
      ];
      const provider = createMockProvider(events);
      const controller = new SessionController(createMockRegistry());
      const pipeline = new MessagePipeline(provider, controller);
      const rs = createMockResponseSession();
      const view = createMockView(rs);

      const result = await pipeline.handle(createMessageInput('Tell me something'), view);

      expect(result.success).toBe(true);
      expect(result.execution?.textLength).toBe(13);
      expect(result.execution?.usage?.inputTokens).toBe(100);
      expect(view.beginResponse).toHaveBeenCalled();
      expect(rs.appendText).toHaveBeenCalledWith('Response text');
      expect(rs.complete).toHaveBeenCalled();
    });

    it('handles agent errors gracefully', async () => {
      const events: AgentEvent[] = [{ type: 'error', error: new Error('API failure'), isRecoverable: false }];
      const provider = createMockProvider(events);
      const controller = new SessionController(createMockRegistry());
      const pipeline = new MessagePipeline(provider, controller);
      const rs = createMockResponseSession();
      const view = createMockView(rs);

      const result = await pipeline.handle(createMessageInput('Fail'), view);

      expect(result.success).toBe(false);
      expect(result.execution?.stopReason).toBe('error');
      expect(rs.abort).toHaveBeenCalledWith('API failure');
    });

    it('sets activity state to idle on success', async () => {
      const events: AgentEvent[] = [
        { type: 'text', text: 'Done' },
        { type: 'turn_complete', stopReason: 'end_turn' },
      ];
      const provider = createMockProvider(events);
      const registry = createMockRegistry();
      const controller = new SessionController(registry);
      const pipeline = new MessagePipeline(provider, controller);
      const view = createMockView();

      await pipeline.handle(createMessageInput('Work'), view);

      expect(registry.setActivityStateByKey).toHaveBeenCalledWith('U456:root', 'idle');
    });
  });

  describe('command handling', () => {
    it('treats commands as messages for now', async () => {
      const events: AgentEvent[] = [
        { type: 'text', text: 'Status result' },
        { type: 'turn_complete', stopReason: 'end_turn' },
      ];
      const provider = createMockProvider(events);
      const controller = new SessionController(createMockRegistry());
      const pipeline = new MessagePipeline(provider, controller);
      const view = createMockView();

      const input: InputEvent = {
        type: 'command',
        target: createTarget(),
        name: 'status',
        args: '--verbose',
        timestamp: Date.now(),
      };

      const result = await pipeline.handle(input, view);

      expect(result.success).toBe(true);
      expect(provider.query).toHaveBeenCalled();
    });
  });

  describe('action/form handling', () => {
    it('skips action events with reason', async () => {
      const provider = createMockProvider();
      const controller = new SessionController(createMockRegistry());
      const pipeline = new MessagePipeline(provider, controller);
      const view = createMockView();

      const input: InputEvent = {
        type: 'action',
        target: createTarget(),
        actionId: 'btn-1',
        value: 'clicked',
        timestamp: Date.now(),
      };

      const result = await pipeline.handle(input, view);

      expect(result.success).toBe(true);
      expect(result.skipReason).toBe('action_handling_not_yet_implemented');
    });
  });

  describe('pipeline events', () => {
    it('emits lifecycle events', async () => {
      const events: AgentEvent[] = [
        { type: 'text', text: 'Hi' },
        { type: 'turn_complete', stopReason: 'end_turn' },
      ];
      const provider = createMockProvider(events);
      const controller = new SessionController(createMockRegistry());
      const pipelineEvents: PipelineEvent[] = [];
      const pipeline = new MessagePipeline(provider, controller, {
        onEvent: (e) => pipelineEvents.push(e),
      });
      const view = createMockView();

      await pipeline.handle(createMessageInput('Track events'), view);

      const types = pipelineEvents.map((e) => e.type);
      expect(types).toContain('input_received');
      expect(types).toContain('input_validated');
      expect(types).toContain('session_created');
      expect(types).toContain('execution_started');
      expect(types).toContain('execution_completed');
    });

    it('emits pipeline_error on exception', async () => {
      // Simulate a crash in beginResponse (before AgentExecutor catches it)
      const provider = createMockProvider([]);
      const controller = new SessionController(createMockRegistry());
      const pipelineEvents: PipelineEvent[] = [];
      const pipeline = new MessagePipeline(provider, controller, {
        onEvent: (e) => pipelineEvents.push(e),
      });
      const view = createMockView();
      (view.beginResponse as any).mockImplementation(() => {
        throw new Error('View crashed');
      });

      const result = await pipeline.handle(createMessageInput('Crash'), view);

      expect(result.success).toBe(false);
      const errorEvents = pipelineEvents.filter((e) => e.type === 'pipeline_error');
      expect(errorEvents).toHaveLength(1);
    });
  });

  describe('thread support', () => {
    it('uses custom resolveSessionKey for platform-specific keys', async () => {
      const events: AgentEvent[] = [
        { type: 'text', text: 'Thread reply' },
        { type: 'turn_complete', stopReason: 'end_turn' },
      ];
      const provider = createMockProvider(events);
      const registry = createMockRegistry();
      const controller = new SessionController(registry);
      // Provide platform-specific resolvers (e.g. Slack-style).
      // resolveSessionKey and resolveSessionParams must be consistent:
      // getSessionKey(params.channelId, params.threadTs) === resolveSessionKey(target)
      const pipeline = new MessagePipeline(provider, controller, {
        resolveSessionKey: (target) => {
          const ref = target.ref as { channel?: string; threadTs?: string };
          return `${ref?.channel ?? target.userId}:${ref?.threadTs ?? 'root'}`;
        },
        resolveSessionParams: (target) => {
          const ref = target.ref as { channel?: string; threadTs?: string };
          return { channelId: ref?.channel ?? target.userId, threadTs: ref?.threadTs };
        },
      });
      const view = createMockView();

      const result = await pipeline.handle(createMessageInput('In thread', 'C789', '1700000000.000000'), view);

      expect(result.success).toBe(true);
      expect(result.sessionKey).toBe('C789:1700000000.000000');
      // createSession receives raw channelId/threadTs, not the pre-resolved key
      expect(registry.createSession).toHaveBeenCalledWith('U456', 'U456', 'C789', '1700000000.000000', undefined);
    });
  });
});
