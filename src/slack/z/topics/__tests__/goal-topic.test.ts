import { describe, expect, it } from 'vitest';
import { applyGoal, createGoalTopicBinding, renderGoalCard } from '../goal-topic';

describe('goal-topic.renderGoalCard', () => {
  it('documents the goal command family without set buttons', async () => {
    const result = await renderGoalCard({ issuedAt: 42 });

    expect(result.text).toContain('Goal');
    expect(result.text).toContain('goal set');
    expect(JSON.stringify(result.blocks)).toContain('goal done');
    expect(JSON.stringify(result.blocks)).not.toContain('button.disabled');
  });
});

describe('goal-topic.applyGoal', () => {
  it('always refuses because the topic card is read-only', async () => {
    const result = await applyGoal({ userId: 'U1', value: 'set' });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('goal');
  });
});

describe('goal-topic binding', () => {
  it('exposes topic + apply + renderCard', () => {
    const binding = createGoalTopicBinding();

    expect(binding.topic).toBe('goal');
    expect(typeof binding.apply).toBe('function');
    expect(typeof binding.renderCard).toBe('function');
  });
});
