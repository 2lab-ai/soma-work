import { setTurnSurfaceFiveBlockPhaseProvider } from '@soma/slack/turn-surface';

import { config } from '../config';
import './pipeline/effective-phase';

setTurnSurfaceFiveBlockPhaseProvider(() => config.ui.fiveBlockPhase);

export * from '@soma/slack/turn-surface';
