import { describe, expect, it } from 'vitest';
import { applyUsage, createUsageTopicBinding, renderUsageCard } from './usage-topic';

describe('usage-topic.renderUsageCard', () => {
  it('renders a header + context describing every usage subcommand', async () => {
    const { blocks, text } = await renderUsageCard({ issuedAt: 1 });

    expect(text).toContain('usage');
    expect(text).toContain('usage card');

    const asAny = blocks as any[];
    const header = asAny.find((b) => b.type === 'header');
    expect(header?.text?.text).toContain('Token Usage');

    // The 5 documented subcommands must all appear in the card body so users
    // discover them from the help card without running anything.
    const body = JSON.stringify(blocks);
    for (const cmd of ['usage', 'usage week', 'usage month', 'usage @user', 'usage card']) {
      expect(body, `missing documentation for \`${cmd}\``).toContain(cmd);
    }
  });

  it('has no `set` buttons — read-only card', async () => {
    const { blocks } = await renderUsageCard({ issuedAt: 1 });
    let hasSet = false;
    for (const b of blocks as any[]) {
      if (b.type === 'actions') {
        for (const e of b.elements ?? []) {
          if (typeof e.action_id === 'string' && e.action_id.startsWith('z_setting_usage_set_')) {
            hasSet = true;
          }
        }
      }
    }
    expect(hasSet).toBe(false);
  });
});

describe('usage-topic.applyUsage', () => {
  it('always refuses — read-only topic', async () => {
    const r = await applyUsage({ userId: 'U1', value: 'anything' });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/설정 항목이 없|변경/);
  });
});

describe('createUsageTopicBinding', () => {
  it('exposes topic id + apply + renderCard', () => {
    const b = createUsageTopicBinding();
    expect(b.topic).toBe('usage');
    expect(typeof b.apply).toBe('function');
    expect(typeof b.renderCard).toBe('function');
  });
});
