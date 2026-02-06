import { describe, it, expect } from 'vitest';
import { buildChannelRouteBlocks } from './channel-route-action-handler';

describe('buildChannelRouteBlocks', () => {
  it('includes disabled stay-in-channel button', () => {
    const { blocks } = buildChannelRouteBlocks({
      prUrl: 'https://github.com/acme/repo/pull/1',
      targetChannelName: 'dev',
      targetChannelId: 'C123',
      originalChannel: 'C999',
      originalTs: '111.222',
      originalThreadTs: '333.444',
      userMessage: 'Review this PR',
      userId: 'U123',
    });

    const actionsBlock = blocks.find(block => block.type === 'actions');
    expect(actionsBlock).toBeDefined();
    const actionIds = actionsBlock.elements.map((el: any) => el.action_id);
    expect(actionIds).toContain('channel_route_move');
    expect(actionIds).toContain('channel_route_stop');
    expect(actionIds).toContain('channel_route_stay');

    const stayButton = actionsBlock.elements.find((el: any) => el.action_id === 'channel_route_stay');
    expect(stayButton?.disabled).toBe(true);
  });
});
