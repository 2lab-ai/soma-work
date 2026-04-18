import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UserChoice } from 'somalib/model-commands/session-types';
import type { AskUserQuestionParams } from 'somalib/model-commands/types';
import { checkAskUserQuestionQuality, validateModelCommandRunArgs } from 'somalib/model-commands/validator';
import { describe, expect, it } from 'vitest';

/**
 * Defect C — 6 UIAskUserQuestion templates.
 *
 * Each template must pass BOTH:
 *   1. Hard gate: `validateModelCommandRunArgs({ commandId, params: { payload } })`
 *      returns `{ ok: true }` — i.e. the schema validator accepts the shape.
 *   2. Soft gate: `checkAskUserQuestionQuality({ question })` returns `[]` —
 *      i.e. all six quality rules (options 2..4, tier prefix, context ≥ 80,
 *      forbidden labels, Recommended marker, non-empty question) are clean.
 *
 * Metadata keys (`_comment`, `$schema`) in each template file are stripped
 * before validation — they document intent and never reach the wire.
 */

const TEMPLATE_NAMES = [
  'z-phase1-plan-approval',
  'z-phase2.9-pr-approval',
  'zcheck-pr-approve',
  'ztrace-ambiguous-scenario',
  'zexplore-research-scope',
  'decision-gate-tier-medium',
] as const;

type TemplateName = (typeof TEMPLATE_NAMES)[number];

interface RawTemplate {
  $schema?: string;
  _comment?: string;
  type: 'user_choice' | 'user_choice_group';
  question: string;
  context?: string;
  choices: Array<{ id: string; label: string; description?: string }>;
}

function loadTemplate(name: TemplateName): RawTemplate {
  const path = join(__dirname, `${name}.json`);
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as RawTemplate;
  return parsed;
}

function stripMetadata(raw: RawTemplate): UserChoice {
  // Drop documentation keys. The remaining shape must be a valid UserChoice.
  const { $schema: _schema, _comment: _note, ...payload } = raw;
  void _schema;
  void _note;
  return payload as unknown as UserChoice;
}

describe('UIAskUserQuestion caller templates', () => {
  for (const name of TEMPLATE_NAMES) {
    describe(name, () => {
      const raw = loadTemplate(name);
      const payload = stripMetadata(raw);

      it('parses as valid JSON', () => {
        expect(raw).toBeTypeOf('object');
        expect(raw.type).toBe('user_choice');
      });

      it('passes hard gate (validateModelCommandRunArgs)', () => {
        const result = validateModelCommandRunArgs({
          commandId: 'ASK_USER_QUESTION',
          params: { payload },
        });
        if (!result.ok) {
          throw new Error(`validateModelCommandRunArgs failed: ${result.error.message}`);
        }
        expect(result.ok).toBe(true);
        expect(result.request.commandId).toBe('ASK_USER_QUESTION');
      });

      it('passes soft gate (checkAskUserQuestionQuality — 0 warnings)', () => {
        const askParams: AskUserQuestionParams = { question: payload };
        const warnings = checkAskUserQuestionQuality(askParams);
        expect(warnings).toEqual([]);
      });
    });
  }

  it('exports exactly 6 templates', () => {
    expect(TEMPLATE_NAMES).toHaveLength(6);
  });

  it('zcheck-pr-approve has 4 options (per zcheck/SKILL.md Step 4 spec)', () => {
    const raw = loadTemplate('zcheck-pr-approve');
    expect(raw.choices).toHaveLength(4);
  });

  it('other approval templates have 2 options (z-phase1, z-phase2.9, decision-gate)', () => {
    const twoOptionTemplates: TemplateName[] = [
      'z-phase1-plan-approval',
      'z-phase2.9-pr-approval',
      'decision-gate-tier-medium',
    ];
    for (const name of twoOptionTemplates) {
      const raw = loadTemplate(name);
      expect(raw.choices, `${name} must have 2 options`).toHaveLength(2);
    }
  });
});
