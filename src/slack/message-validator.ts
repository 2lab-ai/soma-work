import { setMessageValidatorBaseDirectoryProvider } from '@soma/slack/message-validator';
import { config } from '../config';

setMessageValidatorBaseDirectoryProvider(() => config.baseDirectory);

export * from '@soma/slack/message-validator';
