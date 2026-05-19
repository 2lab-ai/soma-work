import { setPendingFormStoreDataDirProvider } from '@soma/slack/actions/pending-form-store';
import { DATA_DIR } from '../../env-paths';

setPendingFormStoreDataDirProvider(() => DATA_DIR);

export * from '@soma/slack/actions/pending-form-store';
