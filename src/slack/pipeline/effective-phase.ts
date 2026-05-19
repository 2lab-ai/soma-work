import { configureEffectivePhase } from '@soma/slack/pipeline/effective-phase';
import { config } from '../../config';
import { emitUiPhaseClamped } from '../../metrics/ui-metrics';

configureEffectivePhase({
  getFiveBlockPhase: () => config.ui.fiveBlockPhase,
  emitUiPhaseClamped,
});

export * from '@soma/slack/pipeline/effective-phase';
