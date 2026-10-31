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
    const raw: unknown = body.actions?.[0]?.value;
    const adminUser = body.user?.id;
    // A button names its round ({userId, round}); one from before rounds carries only the user id.
    let targetUser: string | undefined;
    let round: number | undefined;
    if (typeof raw === 'string' && raw.startsWith('{')) {
      try {
        const v = JSON.parse(raw) as { userId?: unknown; round?: unknown };
        if (typeof v.userId === 'string') targetUser = v.userId;
        if (typeof v.round === 'number') round = v.round;
      } catch {
        /* malformed — refused below */
      }
    } else if (typeof raw === 'string') {
      targetUser = raw;
    }
    if (!targetUser || !adminUser) {
      this.logger.warn(`Invalid ${decision} payload`, { targetUser, adminUser });
      return;
    }
    const result = decideNewUser({
      userId: targetUser,
      ...(round !== undefined ? { round } : {}),
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
