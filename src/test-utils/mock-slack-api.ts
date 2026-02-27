import { vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn<(...args: any[]) => any>>;

export interface MockSlackApi {
  postMessage: MockFn;
  updateMessage: MockFn;
  deleteMessage: MockFn;
  postEphemeral: MockFn;
  postSystemMessage: MockFn;
  addReaction: MockFn;
  removeReaction: MockFn;
  getMessage: MockFn;
  getUserName: MockFn;
  getChannelName: MockFn;
  getPermalink: MockFn;
  getBotUserId: MockFn;
  getChannelInfo: MockFn;
  setAssistantStatus: MockFn;
  setAssistantTitle: MockFn;
  openModal: MockFn;
  deleteThreadBotMessages: MockFn;
}

/**
 * SlackApiHelper mock factory.
 * 모든 public 메서드의 기본 mock을 제공하며, overrides로 개별 메서드 교체 가능.
 */
export function createMockSlackApi(overrides: Partial<MockSlackApi> = {}): MockSlackApi {
  return {
    // Core messaging
    postMessage: vi.fn().mockResolvedValue({ ts: '123.456', channel: 'C123' }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    postEphemeral: vi.fn().mockResolvedValue({ ts: '999.000' }),
    postSystemMessage: vi.fn().mockResolvedValue({ ts: '888.000' }),

    // Reactions
    addReaction: vi.fn().mockResolvedValue(true),
    removeReaction: vi.fn().mockResolvedValue(undefined),

    // Queries
    getMessage: vi.fn().mockResolvedValue({ ts: '111.222', user: 'U123' }),
    getUserName: vi.fn().mockResolvedValue('Test User'),
    getChannelName: vi.fn().mockResolvedValue('general'),
    getPermalink: vi.fn().mockResolvedValue('https://slack.com/archives/C123/p111222'),
    getBotUserId: vi.fn().mockResolvedValue('B999'),
    getChannelInfo: vi.fn().mockResolvedValue({ id: 'C123', name: 'general' }),

    // Assistant
    setAssistantStatus: vi.fn().mockResolvedValue(undefined),
    setAssistantTitle: vi.fn().mockResolvedValue(undefined),

    // Modal
    openModal: vi.fn().mockResolvedValue(undefined),

    // Thread
    deleteThreadBotMessages: vi.fn().mockResolvedValue(undefined),

    ...overrides,
  };
}
