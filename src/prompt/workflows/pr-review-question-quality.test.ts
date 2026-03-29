/**
 * Regression tests for Issue #37: PR review question quality
 *
 * These tests verify that prompt files do NOT contain patterns that cause
 * the model to regress to Fix/Defer/Skip yes/no questions instead of
 * concrete implementation alternative questions.
 *
 * Red test strategy: if someone re-introduces Fix/Defer/Skip as a
 * recommended pattern (not in a "BAD" or "NEVER" context), these tests fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../../..');

function readPromptFile(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf-8');
}

describe('PR Review Question Quality — Regression Guard (#37)', () => {
  describe('UIAskUserQuestion/SKILL.md', () => {
    let content: string;

    beforeAll(() => {
      content = readPromptFile('src/local/skills/UIAskUserQuestion/SKILL.md');
    });

    it('should NOT recommend Fix/Defer/Skip as a USE case', () => {
      // Extract only "USE this skill when" section (between USE and DO NOT)
      const useSection = content.match(
        /### USE this skill when:([\s\S]*?)### DO NOT use when:/,
      );
      expect(useSection).toBeTruthy();
      const useSectionText = useSection![1];

      // Fix/Defer/Skip should NOT appear as recommended pattern
      expect(useSectionText).not.toMatch(/Fix\/Defer\/Skip/i);
      expect(useSectionText).not.toMatch(/fix_now.*defer_to_followup/i);
    });

    it('should explicitly ban Fix/Defer/Skip in DO NOT section', () => {
      const doNotSection = content.match(
        /### DO NOT use when:([\s\S]*?)---/,
      );
      expect(doNotSection).toBeTruthy();
      // Must mention the ban
      expect(doNotSection![1]).toMatch(/Fix\/Defer\/Skip/);
    });

    it('should have Fix/Defer/Skip as BAD example', () => {
      const badSection = content.match(
        /## Bad Examples[\s\S]*?## Good Example/,
      );
      expect(badSection).toBeTruthy();
      expect(badSection![0]).toMatch(/Fix\/Defer\/Skip.*금지|절대 금지/);
    });

    it('Good Example choices should use Option A/B pattern, not Fix/Defer/Skip', () => {
      const goodSection = content.match(
        /## Good Example([\s\S]*?)## Key Principles/,
      );
      expect(goodSection).toBeTruthy();
      const goodText = goodSection![1];

      // Should have Option A / Option B
      expect(goodText).toMatch(/Option A/);
      expect(goodText).toMatch(/Option B/);

      // Should NOT have fix/defer/skip as choice labels
      expect(goodText).not.toMatch(/"label":\s*".*이 PR에서 수정/);
      expect(goodText).not.toMatch(/"label":\s*"별도 이슈로 분리"/);
      expect(goodText).not.toMatch(/"label":\s*"Skip"/);
    });

    it('should not allow plain text fallback for PR review context', () => {
      expect(content).toMatch(
        /PR review.*plain text.*금지|plain text 절대 금지/,
      );
    });
  });

  describe('decision-gate/SKILL.md', () => {
    let content: string;

    beforeAll(() => {
      content = readPromptFile('src/local/skills/decision-gate/SKILL.md');
    });

    it('should reference 구현 방식 선택, not Fix/Defer/Skip for code review', () => {
      const reviewLine = content
        .split('\n')
        .find((l) => l.includes('코드 리뷰'));
      expect(reviewLine).toBeTruthy();
      expect(reviewLine).toMatch(/구현 방식 선택/);
      expect(reviewLine).not.toMatch(
        /Fix\/Defer\/Skip 결정 시 이 게이트로 판별$/,
      );
    });
  });

  describe('pr-review.prompt', () => {
    let content: string;

    beforeAll(() => {
      content = readPromptFile('src/prompt/workflows/pr-review.prompt');
    });

    it('should enforce UIAskUserQuestion Skill usage for medium+ issues', () => {
      expect(content).toMatch(/반드시.*UIAskUserQuestion.*Skill/);
      expect(content).toMatch(/plain text.*금지/);
    });

    it('should enforce mcp__model-command__run → ASK_USER_QUESTION', () => {
      expect(content).toMatch(/mcp__model-command__run.*ASK_USER_QUESTION/);
    });

    it('should ban Fix/Defer/Skip pattern in questions', () => {
      expect(content).toMatch(
        /fix\/defer\/skip.*금지|고칠까요.*금지/i,
      );
    });

    it('should have quality checklist with 6 items', () => {
      const checklist = content.match(
        /질문 품질 자체 검증 체크리스트[\s\S]*?(?=\n\n[^-])/,
      );
      expect(checklist).toBeTruthy();
      const checkItems = checklist![0].match(/- \[ \]/g);
      expect(checkItems).toBeTruthy();
      expect(checkItems!.length).toBeGreaterThanOrEqual(6);
    });

    it('should use Option A/B pattern in output format, not single suggestion', () => {
      // The output format should show multiple implementation options
      expect(content).toMatch(/구현 옵션 A/);
      expect(content).toMatch(/구현 옵션 B/);
    });

    it('should ban defer variants in question choices', () => {
      expect(content).toMatch(
        /별도 이슈로 분리.*defer.*선택지에 포함하지 않/,
      );
    });
  });
});
