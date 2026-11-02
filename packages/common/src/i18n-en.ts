/**
 * The English catalogs (#771): load once at the entry point (`src/index.ts`)
 * — importing this module registers them. `en-text.json` is the output-side
 * catalog (Slack messages, server errors: whole strings, lines and `{n}`
 * templates); `en-page.json` is the page catalog (the dashboard's and other
 * pages' HTML, script and CSS strings). Both are keyed by the Korean source
 * text and regenerated with `npm run i18n:extract`.
 */

import { registerDisplayCatalog } from './i18n';
import page from './i18n-catalog/en-page.json';
import text from './i18n-catalog/en-text.json';
import { registerPageCatalog } from './i18n-page';

registerDisplayCatalog('en', text as Record<string, string>);
registerPageCatalog(page as Record<string, string>);
