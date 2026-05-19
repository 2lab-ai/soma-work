import { setDirectoryFormatterBaseDirectoryProvider } from '@soma/slack/formatters/directory-formatter';
import { config } from '../../config';

setDirectoryFormatterBaseDirectoryProvider(() => config.baseDirectory);

export * from '@soma/slack/formatters/directory-formatter';
