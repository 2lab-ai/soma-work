import { describe, expect, it } from 'vitest';
import { buildSecretUseMessage, SECRET_NAMES_TEXT_MAX, secretNamesText } from '../secret-use-blocks';

/**
 * secret-access WU2 (#1338): the admins' card. A call can need many secrets (a `login` or `cf_api` call without a
 * narrowing argument uses every one of its server's), and a Slack section holds at most 3,000 characters — a card
 * over that is refused by Slack and nobody would be asked. Each button carries the request's round.
 */

const view = (names: string[]) => ({
  requestId: 'r1',
  round: '1794963000000',
  requesterId: 'U1',
  names,
  tool: 'login',
  server: 'dev2',
  channel: 'C1',
  threadTs: '1.2',
  adminOnlyTool: true,
});

describe('secret-use card', () => {
  it('keeps every section under Slack’s 3,000 characters however many secrets the call needs', () => {
    const names = Array.from(
      { length: 300 },
      (_, i) => `environment-login-secret-number-${String(i).padStart(3, '0')}`,
    );
    const msg = buildSecretUseMessage(view(names));
    for (const block of msg.blocks.filter((b: any) => b.type === 'section')) {
      expect(block.text.text.length).toBeLessThanOrEqual(3000);
    }
    expect(msg.blocks[0].text.text).toMatch(/외 \d+개/);
    expect(secretNamesText(names, SECRET_NAMES_TEXT_MAX).length).toBeLessThanOrEqual(SECRET_NAMES_TEXT_MAX + 16);
  });

  it('lists a few secrets whole', () => {
    expect(secretNamesText(['a', 'b'], SECRET_NAMES_TEXT_MAX)).toBe('`a`, `b`');
  });

  it('each button carries the request and its round, nothing else', () => {
    const actions = buildSecretUseMessage(view(['plain-db'])).blocks.find((b: any) => b.type === 'actions');
    for (const button of actions.elements) {
      expect(Object.keys(JSON.parse(button.value)).sort()).toEqual(['kind', 'requestId', 'round']);
      expect(JSON.parse(button.value)).toMatchObject({ requestId: 'r1', round: '1794963000000' });
    }
  });
});
