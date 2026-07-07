/**
 * cron-blocks — Block Kit card builder for the `cron` command.
 * Trace: cron 관리 UI drift #4 — "리스트 나오고 각각 편집 버튼/드랍박스로 쉽게 변경"
 */

import type { CronJob } from 'somalib/cron/cron-storage';
import { describe, expect, it } from 'vitest';
import { AVAILABLE_MODELS } from '../../user-settings-store';
import { buildCronCard, cronActionId, parseCronActionId } from '../cron-blocks';

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: 'id-1',
    name: 'daily-report',
    expression: '0 9 * * 1-5',
    prompt: 'morning report',
    owner: 'U_ALICE',
    channel: 'C111',
    threadTs: null,
    createdAt: '2026-01-01T00:00:00Z',
    lastRunAt: null,
    lastRunMinute: null,
    ...over,
  };
}

describe('cronActionId round-trip', () => {
  it('encodes and parses kind/owner/name', () => {
    const id = cronActionId('model', 'U_ALICE', 'daily-report');
    expect(id).toBe('cron_model::U_ALICE::daily-report');
    expect(parseCronActionId(id)).toEqual({ kind: 'model', owner: 'U_ALICE', name: 'daily-report' });
  });

  it('rejects foreign action ids', () => {
    expect(parseCronActionId('autoskill_remove')).toBeNull();
    expect(parseCronActionId('cron_bogus::U::n')).toBeNull();
  });
});

describe('buildCronCard', () => {
  it('renders per-job section + actions (model select, target select, delete button)', () => {
    const { blocks } = buildCronCard({ jobs: [job()], isAdmin: false });
    const actions = blocks.find((b: any) => b.type === 'actions');
    expect(actions).toBeDefined();
    const ids = actions.elements.map((e: any) => e.action_id);
    expect(ids).toEqual([
      'cron_model::U_ALICE::daily-report',
      'cron_target::U_ALICE::daily-report',
      'cron_delete::U_ALICE::daily-report',
    ]);
    // model select contains default, fast, and every AVAILABLE_MODELS entry
    const modelSelect = actions.elements[0];
    const values = modelSelect.options.map((o: any) => o.value);
    expect(values).toContain('default');
    expect(values).toContain('fast');
    for (const m of AVAILABLE_MODELS) {
      expect(values).toContain(`custom:${m}`);
    }
    // delete button has a native confirm dialog
    expect(actions.elements[2].confirm).toBeDefined();
  });

  it('preselects the current model and target', () => {
    const { blocks } = buildCronCard({
      jobs: [job({ modelConfig: { type: 'custom', model: 'gpt-5.5' }, target: 'dm' })],
      isAdmin: false,
    });
    const actions = blocks.find((b: any) => b.type === 'actions');
    expect(actions.elements[0].initial_option.value).toBe('custom:gpt-5.5');
    expect(actions.elements[1].initial_option.value).toBe('dm');
  });

  it('defaults preselect: model=default, target=channel', () => {
    const { blocks } = buildCronCard({ jobs: [job()], isAdmin: false });
    const actions = blocks.find((b: any) => b.type === 'actions');
    expect(actions.elements[0].initial_option.value).toBe('default');
    expect(actions.elements[1].initial_option.value).toBe('channel');
  });

  it('admin view shows owner; non-admin does not', () => {
    const adminCard = buildCronCard({ jobs: [job()], isAdmin: true });
    expect(JSON.stringify(adminCard.blocks)).toContain('<@U_ALICE>');
    expect(adminCard.blocks[0].text.text).toContain('admin view');
    const userCard = buildCronCard({ jobs: [job()], isAdmin: false });
    expect(
      JSON.stringify(userCard.blocks.find((b: any) => b.type === 'section' && b.text.text.includes('daily-report'))),
    ).not.toContain('owner');
  });

  it('empty list renders guidance', () => {
    const { text, blocks } = buildCronCard({ jobs: [], isAdmin: false });
    expect(text).toContain('없습니다');
    expect(JSON.stringify(blocks)).toContain('크론으로 등록');
  });

  it('caps jobs to stay under the 50-block message limit', () => {
    const many = Array.from({ length: 25 }, (_, i) => job({ name: `job-${i}`, id: `id-${i}` }));
    const { blocks } = buildCronCard({ jobs: many, isAdmin: false });
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(blocks)).toContain('생략');
  });
});
