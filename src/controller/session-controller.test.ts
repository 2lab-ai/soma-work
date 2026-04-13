/**
 * SessionController tests (Issue #410)
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionController, type SessionRegistryLike } from './session-controller.js';

// ─── Mock SessionRegistry ────────────────────────────────────────

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

// ─── Tests ───────────────────────────────────────────────────────

describe('SessionController', () => {
  it('delegates getSessionKey to registry', () => {
    const registry = createMockRegistry();
    const controller = new SessionController(registry);

    const key = controller.getSessionKey('C123', '1700000000.000000');

    expect(registry.getSessionKey).toHaveBeenCalledWith('C123', '1700000000.000000');
    expect(key).toBe('C123:1700000000.000000');
  });

  it('creates sessions through registry', () => {
    const registry = createMockRegistry();
    const controller = new SessionController(registry);

    const session = controller.createSession('U123', 'John', 'C456', '1700000000.000000');

    expect(registry.createSession).toHaveBeenCalledWith('U123', 'John', 'C456', '1700000000.000000', undefined);
    expect(session.ownerId).toBe('U123');
    expect(session.channelId).toBe('C456');
  });

  it('terminates sessions through registry', () => {
    const registry = createMockRegistry();
    const controller = new SessionController(registry);

    const result = controller.terminateSession('C456:1700000000.000000');

    expect(registry.terminateSession).toHaveBeenCalledWith('C456:1700000000.000000');
    expect(result).toBe(true);
  });

  it('manages state transitions', () => {
    const registry = createMockRegistry();
    const controller = new SessionController(registry);

    controller.transitionToMain('C456', '1700000000.000000', 'default', 'Test Session');

    expect(registry.transitionToMain).toHaveBeenCalledWith('C456', '1700000000.000000', 'default', 'Test Session');
  });

  it('manages activity state', () => {
    const registry = createMockRegistry();
    const controller = new SessionController(registry);

    controller.setActivityState('C456', '1700000000.000000', 'working');

    expect(registry.setActivityState).toHaveBeenCalledWith('C456', '1700000000.000000', 'working');
  });

  it('persists sessions', () => {
    const registry = createMockRegistry();
    const controller = new SessionController(registry);

    controller.saveSessions();
    expect(registry.saveSessions).toHaveBeenCalled();

    const loaded = controller.loadSessions();
    expect(registry.loadSessions).toHaveBeenCalled();
    expect(loaded).toBe(5);
  });

  it('exposes registry for legacy compatibility', () => {
    const registry = createMockRegistry();
    const controller = new SessionController(registry);

    expect(controller.getRegistry()).toBe(registry);
  });

  it('checks dispatch need', () => {
    const registry = createMockRegistry();
    const controller = new SessionController(registry);

    const needs = controller.needsDispatch('C456', '1700000000.000000');

    expect(registry.needsDispatch).toHaveBeenCalledWith('C456', '1700000000.000000');
    expect(needs).toBe(true);
  });

  it('handles sleep transitions', () => {
    const registry = createMockRegistry();
    const controller = new SessionController(registry);

    expect(controller.transitionToSleep('C456')).toBe(true);
    expect(controller.wakeFromSleep('C456')).toBe(true);
  });
});
