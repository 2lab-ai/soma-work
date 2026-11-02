/**
 * The page's viewer predicates (SSOT 2026-11-02) for the client harnesses that
 * cut functions out of renderDashboardPage()'s template: `viewerOwns`,
 * `viewerCanManage` and `viewerCanInstruct` read the signed-in viewer
 * (`_viewerUserId`), `_viewerIsAdmin` and 관리자 모드 (`_isAdminModeOn`).
 *
 * A harness that loads a function using them gets them too. Unless a test names
 * another viewer, the viewer is the board's user (the harness's
 * `currentUserId`) — what these tests meant by "the owner" when the board
 * filter stood in for the viewer. The manage lock's words default to the
 * read-only words the test injected. The predicates themselves are pinned by
 * dashboard-task-permissions-client.test.ts.
 */
export const VIEWER_FNS = ['viewerOwns', 'viewerCanManage', 'viewerCanInstruct'] as const;

export function viewerScope(
  fns: readonly string[],
  inject: Record<string, unknown>,
): { fns: string[]; inject: Record<string, unknown> } {
  const defaults: Record<string, unknown> = {
    _viewerUserId: typeof inject.currentUserId === 'string' ? inject.currentUserId : '',
    _viewerIsAdmin: false,
    OWNER_ONLY_MSG: inject.READ_ONLY_MSG ?? '소유자나 관리자 모드를 켠 관리자만 할 수 있어요',
  };
  if (!fns.includes('_isAdminModeOn')) defaults._isAdminModeOn = () => false;
  // The page's repaint after the viewer or 관리자 모드 changes: a seam here (the board and panel are not loaded).
  if (!fns.includes('repaintViewerControls')) defaults.repaintViewerControls = () => {};
  return {
    fns: [...VIEWER_FNS.filter((f) => !fns.includes(f)), ...fns],
    inject: { ...defaults, ...inject },
  };
}
