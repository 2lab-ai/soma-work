import { setClickClassifierFiveBlockPhaseProvider } from '@soma/slack/actions/click-classifier';
import { config } from '../../config';

setClickClassifierFiveBlockPhaseProvider(() => config.ui.fiveBlockPhase);

export * from '@soma/slack/actions/click-classifier';
