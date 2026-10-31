import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #640 R3 (fable P3): the models the new-task dialog offers and the models a
 * dashboard task's launcher accepts come from one source. Two copies of the
 * catalog read would drift (a filter added to one), and the dialog would offer
 * a nickname the launcher refuses with 400, or the other way round.
 */
const SOURCE = readFileSync(join(__dirname, '..', 'new-task-provider.ts'), 'utf-8');

describe('new-task models — one source for the dialog and the task launcher (#640 R3)', () => {
  it('reads the model catalog in one place, used by both the context and offeredNewTaskModels', () => {
    expect(SOURCE.match(/listRepresentativeModels\(/g)).toHaveLength(1);
    expect(SOURCE.match(/userSettingsStore\.getUserDefaultModel\(/g)).toHaveLength(1);
    expect(SOURCE.match(/newTaskModelInputs\(userId\)/g)).toHaveLength(2);
  });
});
