import { Logger } from '../../logger';
import { decideNewUser, type NewUserDecision, type NewUserSlackApi } from '../new-user-decision';
import type { RespondFn } from './types';

interface UserAcceptanceDeps {
  slackApi: NewUserSlackApi;
}

/**
 * Accept / Deny on the admins' new-user DM. The decision is
 * {@link decideNewUser} — the same one the dashboard's admin approvals take
 * (#622): only an admin, exactly once, every admin's DM copy rewritten, the
 * user told the outcome.
 */
export class UserAcceptanceActionHandler {
  private logger = new Logger('UserAcceptanceActionHandler');

  constructor(private deps: UserAcceptanceDeps) {}

  async handleAccept(body: any, respond: RespondFn): Promise<void> {
    await this.handle(body, respond, 'accept');
  }

  async handleDeny(body: any, respond: RespondFn): Promise<void> {
    await this.handle(body, respond, 'deny');
  }

  private async handle(body: any, respond: RespondFn, decision: NewUserDecision): Promise<void> {
    const targetUser = body.actions?.[0]?.value;
    const adminUser = body.user?.id;
    if (!targetUser || !adminUser) {
      this.logger.warn(`Invalid ${decision} payload`, { targetUser, adminUser });
      return;
    }
    const result = decideNewUser({
      userId: targetUser,
      decision,
      actor: adminUser,
      via: 'slack',
      slackApi: this.deps.slackApi,
    });
    if (!result.ok) {
      await respond({ text: result.message, response_type: 'ephemeral', replace_original: false });
      return;
    }
    // The clicked copy now (a prompt sent before its location was recorded is reached only here).
    await respond({ text: result.text, replace_original: true });
    await result.effects;
  }
}
