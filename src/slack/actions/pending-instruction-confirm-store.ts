import { setPendingInstructionConfirmStoreDataDirProvider } from '@soma/slack/actions/pending-instruction-confirm-store';
import { DATA_DIR } from '../../env-paths';

setPendingInstructionConfirmStoreDataDirProvider(() => DATA_DIR);

export * from '@soma/slack/actions/pending-instruction-confirm-store';
