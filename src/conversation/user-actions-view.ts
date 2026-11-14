/**
 * The dashboard's copy of a session's user actions (`instruct_user`): what the panel's "사용자 할 일" section and the
 * card badge read. Validated record by record; the Slack message ts stays server-side.
 */
import { parseUserActionRecord, USER_ACTIONS_KEPT, type UserActionRecord } from 'somalib/user-action/user-action';

export type DashboardUserAction = Omit<UserActionRecord, 'slackTs'>;

/** The serializer's spread: `{ userActions }` when there is something to show, else nothing. */
export function dashboardUserActionsField(raw: unknown): { userActions?: DashboardUserAction[] } {
  const list = dashboardUserActions(raw);
  return list ? { userActions: list } : {};
}

/** The board's list, or undefined when there is nothing to show. */
export function dashboardUserActions(raw: unknown): DashboardUserAction[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: DashboardUserAction[] = [];
  for (const item of raw.slice(-USER_ACTIONS_KEPT)) {
    const rec = parseUserActionRecord(item);
    if (!rec) continue;
    const { slackTs: _ts, ...view } = rec;
    out.push(view);
  }
  return out.length ? out : undefined;
}
