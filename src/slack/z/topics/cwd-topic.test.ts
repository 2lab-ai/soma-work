import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyCwd, createCwdTopicBinding, renderCwdCard } from './cwd-topic';

describe('cwd-topic.renderCwdCard', () => {
  const origBase = process.env.BASE_DIRECTORY;
  beforeEach(() => {
    process.env.BASE_DIRECTORY = '/tmp/base';
  });
  afterEach(() => {
    if (origBase === undefined) delete process.env.BASE_DIRECTORY;
    else process.env.BASE_DIRECTORY = origBase;
  });

  it('renders the fixed path for a user', async () => {
    const { blocks, text } = await renderCwdCard({ userId: 'U123', issuedAt: 1 });
    expect(text).toContain('/tmp/base/U123');
    // No set buttons — only cancel.
    let hasSet = false;
    for (const b of blocks as any[]) {
      if (b.type === 'actions') {
        for (const e of b.elements) {
          if (e.action_id?.startsWith('z_setting_cwd_set_')) hasSet = true;
        }
      }
    }
    expect(hasSet).toBe(false);
  });

  it('warns when BASE_DIRECTORY is not set', async () => {
    delete process.env.BASE_DIRECTORY;
    const { blocks } = await renderCwdCard({ userId: 'U1', issuedAt: 1 });
    const ctxBlock = (blocks as any[]).find(
      (b) => b.type === 'context' && b.elements?.[0]?.text?.includes('BASE_DIRECTORY'),
    );
    expect(ctxBlock).toBeDefined();
  });
});

describe('cwd-topic.applyCwd', () => {
  it('always refuses (read-only)', async () => {
    const r = await applyCwd({ userId: 'U1', value: 'anything' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('변경할 수 없');
  });
});

describe('createCwdTopicBinding', () => {
  it('exposes topic + apply + renderCard', () => {
    const b = createCwdTopicBinding();
    expect(b.topic).toBe('cwd');
    expect(typeof b.apply).toBe('function');
    expect(typeof b.renderCard).toBe('function');
  });
});
