/**
 * Next actions as buttons (SSOT 2026-11-11, Z): "이렇게 대화 완료(대기)처리된후에 다음 행동을 3개씩 주는데 이걸
 * 버튼으로 표현해줘. 카드 펼쳤을때랑 디테일에 버튼으로 보여줘."
 *
 * Through the real web server: an answer's turn carries the next actions its markdown ends with (`nextActions`), in
 * the conversation route the open card and the detail card read, and in the live push that brings a new answer —
 * which never carries the answer's raw text.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: 'test-token',
  },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: '',
    jwtExpiresIn: 604800,
  },
};

vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../env-paths', () => ({ IS_DEV: true, DATA_DIR: '/tmp/test-data' }));
vi.mock('../recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));
vi.mock('../viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: vi.fn().mockReturnValue([]) }),
}));

const AUTH = { Authorization: 'Bearer test-token' };
const FENCE = '```';
const ANSWER = ['완료했습니다.', '', '## 다음 행동', 'dev에 배포합니다(권장):', FENCE, '$user:dev', FENCE].join('\n');

describe('next actions on the wire', () => {
  let web: any;
  let dashboard: any;

  beforeEach(async () => {
    vi.resetModules();
    web = await import('../web-server');
    dashboard = await import('../dashboard');
    await web.startWebServer({ listen: false });
  });

  afterEach(async () => {
    await web.stopWebServer();
  });

  it('the conversation route: an answer carries its next actions; the user turn and a plain answer carry none', async () => {
    const { getConversation } = await import('../recorder');
    (getConversation as any).mockResolvedValueOnce({
      id: 'conv-na',
      title: 't',
      createdAt: 1,
      updatedAt: 2,
      turns: [
        { id: 'u1', role: 'user', timestamp: 1, userName: 'Z', rawContent: '## 다음 행동\n```\nx\n```' },
        { id: 'a0', role: 'assistant', timestamp: 2, rawContent: 'no steps here' },
        { id: 'a1', role: 'assistant', timestamp: 3, rawContent: ANSWER },
      ],
    });
    const res = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/session/conv-na', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const turns = JSON.parse(res.body).turns;
    expect(turns[0]).not.toHaveProperty('nextActions');
    expect(turns[1]).not.toHaveProperty('nextActions');
    expect(turns[2].rawContent).toBeUndefined();
    expect(turns[2].nextActions).toEqual([{ label: 'dev에 배포합니다', command: '$user:dev', recommended: true }]);
  });

  it('the live push: the answer goes without its raw text, with its next actions', async () => {
    const messages: any[] = [];
    // The viewer token is an admin: it receives a conversation no live session owns.
    // injectWS hands headers to the route as-is (no lowercasing like Node's parser).
    const ws = await web.injectWebServerWS(
      '/ws/dashboard',
      { headers: { authorization: 'Bearer test-token' } },
      (s: any) => {
        s.on('message', (data: any) => messages.push(JSON.parse(data.toString())));
      },
    );
    try {
      dashboard.broadcastConversationUpdate('conv-na', { id: 'a1', role: 'assistant', rawContent: ANSWER });
      await vi.waitFor(() => expect(messages.some((m) => m.type === 'conversation_update')).toBe(true));
    } finally {
      ws.terminate();
    }
    const turn = messages.find((m) => m.type === 'conversation_update').turn;
    expect(turn.rawContent).toBeUndefined();
    expect(turn.nextActions).toEqual([{ label: 'dev에 배포합니다', command: '$user:dev', recommended: true }]);
  });
});
