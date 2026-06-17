/**
 * Production classifier factory wiring (#auto-permission-mode).
 */

import { describe, expect, it } from 'vitest';
import { LlmSafetyClassifier, StaticSafetyClassifier } from '../safety-classifier';
import { buildSafetyClassifier } from '../safety-classifier-factory';

describe('buildSafetyClassifier', () => {
  it('returns the static (always-ask) classifier when disabled via env', () => {
    expect(buildSafetyClassifier({ PERMISSION_AUTO_CLASSIFIER: 'off' })).toBeInstanceOf(StaticSafetyClassifier);
    expect(buildSafetyClassifier({ PERMISSION_AUTO_CLASSIFIER: 'OFF' })).toBeInstanceOf(StaticSafetyClassifier);
  });

  it('returns the LLM classifier by default', () => {
    expect(buildSafetyClassifier({})).toBeInstanceOf(LlmSafetyClassifier);
    expect(buildSafetyClassifier({ PERMISSION_AUTO_CLASSIFIER: 'on' })).toBeInstanceOf(LlmSafetyClassifier);
  });
});
