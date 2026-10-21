/**
 * cron manage skill — contract test.
 * Trace: session goal "cron/schedule 입력 시 크론잡 관리 UI".
 * Asserts the skill artifact exists, triggers on the right keywords, and
 * wires the flow to the cron MCP tools + UIAskUserQuestion select UI.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const SKILL_PATH = path.join(__dirname, '..', 'local', 'skills', 'cron', 'SKILL.md');

describe('local cron skill', () => {
  it('exists', () => {
    expect(fs.existsSync(SKILL_PATH)).toBe(true);
  });

  it('triggers on cron/schedule keywords (en+ko) in frontmatter description', () => {
    const raw = fs.readFileSync(SKILL_PATH, 'utf-8');
    const fm = raw.split('---')[1] ?? '';
    for (const kw of ['cron', 'schedule', '크론', '스케줄', '스케쥴']) {
      expect(fm).toContain(kw);
    }
  });

  it('wires list → select (UIAskUserQuestion) → cron_update flow', () => {
    const raw = fs.readFileSync(SKILL_PATH, 'utf-8');
    expect(raw).toContain('cron_list');
    expect(raw).toContain('cron_update');
    expect(raw).toContain('UIAskUserQuestion');
    // model override semantics: default = creator's current model
    expect(raw).toContain('만든 사람');
    // output target semantics
    for (const t of ['channel', 'thread', 'dm']) {
      expect(raw).toContain(t);
    }
    // admin scoping documented
    expect(raw.toLowerCase()).toContain('admin');
  });
});
