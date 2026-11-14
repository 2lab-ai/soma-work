/**
 * The dashboard's copy of a session's user actions (`instruct_user`): what the panel's "사용자 할 일" section and the
 * card badge read. Validated record by record (the same parser the registry restores with); the Slack message ts stays
 * server-side.
 */
import { restoreUserActions, type UserActionRecord } from 'somalib/user-action/user-action';

export type DashboardUserAction = Omit<UserActionRecord, 'slackTs'>;

/** The board's list, or undefined when there is nothing to show (the serializer then writes no field). */
export function dashboardUserActions(raw: unknown): DashboardUserAction[] | undefined {
  return restoreUserActions(raw)?.map(({ slackTs: _ts, ...view }) => view);
}
