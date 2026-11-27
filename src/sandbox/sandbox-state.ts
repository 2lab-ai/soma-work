/**
 * Whether a user's sessions run without the sandbox — one answer for every place that must agree on it: the options
 * a turn runs with (`build-stream-options.ts`) and the upload roots its slack-mcp server accepts
 * (`mcp-config-builder.ts`). A sandboxed session reads only its work area, admin or not, so it uploads only from there.
 */

import { isAdminUser } from '../admin-utils';
import { getSandboxOffAllowed } from '../config';
import { isEnvironmentUser } from '../env-users';
import { userSettingsStore } from '../user-settings-store';
import { isSandboxOffInEffect } from './admin-sandbox-profile';

export function sandboxOffFor(user: string): boolean {
  return isSandboxOffInEffect({
    isAdmin: isAdminUser(user),
    requested: userSettingsStore.getUserSandboxDisabled(user),
    hostAllows: getSandboxOffAllowed(),
    // An environment user (`env:<name>`) runs without a sandbox on every host — the deploy and QA work an admin
    // approved for another user. Its skills, crons and requests are gated before its session starts.
    environmentUser: isEnvironmentUser(user),
  });
}
