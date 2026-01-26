import { sharedStore, PermissionResponse } from '../../shared-store';
import { Logger } from '../../logger';
import { RespondFn } from './types';

/**
 * 권한 승인/거부 액션 핸들러
 */
export class PermissionActionHandler {
  private logger = new Logger('PermissionActionHandler');

  async handleApprove(body: any, respond: RespondFn): Promise<void> {
    try {
      const approvalId = body.actions[0].value;
      const user = body.user?.id;

      this.logger.info('Tool approval granted', { approvalId, user });

      const response: PermissionResponse = {
        behavior: 'allow',
        message: 'Approved by user',
      };
      await sharedStore.storePermissionResponse(approvalId, response);

      await respond({
        response_type: 'ephemeral',
        text: '✅ Tool execution approved. Claude will now proceed with the operation.',
        replace_original: false,
      });
    } catch (error) {
      this.logger.error('Error processing tool approval', error);
      await respond({
        response_type: 'ephemeral',
        text: '❌ Error processing approval. The request may have already been handled.',
        replace_original: false,
      });
    }
  }

  async handleDeny(body: any, respond: RespondFn): Promise<void> {
    try {
      const approvalId = body.actions[0].value;
      const user = body.user?.id;

      this.logger.info('Tool approval denied', { approvalId, user });

      const response: PermissionResponse = {
        behavior: 'deny',
        message: 'Denied by user',
      };
      await sharedStore.storePermissionResponse(approvalId, response);

      await respond({
        response_type: 'ephemeral',
        text: '❌ Tool execution denied. Claude will not proceed with this operation.',
        replace_original: false,
      });
    } catch (error) {
      this.logger.error('Error processing tool denial', error);
      await respond({
        response_type: 'ephemeral',
        text: '❌ Error processing denial. The request may have already been handled.',
        replace_original: false,
      });
    }
  }
}
