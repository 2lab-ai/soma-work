import { setTodoDisplayFiveBlockPhaseProvider } from '@soma/slack/todo-display-manager';

import { config } from '../config';

setTodoDisplayFiveBlockPhaseProvider(() => config.ui.fiveBlockPhase);

export * from '@soma/slack/todo-display-manager';
