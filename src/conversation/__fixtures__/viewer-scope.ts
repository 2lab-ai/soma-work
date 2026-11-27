/**
 * The page's viewer predicates (SSOT 2026-11-02) for the client harnesses that
 * cut functions out of renderDashboardPage()'s template: `viewerOwns`,
 * `viewerCanManage`, `viewerCanInstruct`, `viewerCanStop` and `viewerAdminMode` read the signed-in viewer
 * (`_viewerUserId`), `_viewerIsAdmin` and 관리자 모드 (`_isAdminModeOn`).
 *
 * A harness that loads a function using them gets them too. Unless a test names
 * another viewer, the viewer is the board's user (the harness's
 * `currentUserId`) — what these tests meant by "the owner" when the board
 * filter stood in for the viewer. The manage lock's words default to the
 * read-only words the test injected. The predicates themselves are pinned by
 * dashboard-task-permissions-client.test.ts.
 */
export const VIEWER_FNS = [
  'viewerOwns',
  'viewerCanManage',
  'viewerCanInstruct',
  'viewerCanStop',
  // Z 2026-11-27 — a signed-in admin with 관리자 모드 on answers anyone's waiting card.
  'viewerAdminMode',
] as const;
/**
 * #1021 — what `cardOf` itself reads for an epic's family (@2lab.ai/ui 0.37.0): an epic's children on its face
 * (`epicFamilyOf` — the cached epic's whole bundle, `_sessionCache`, empty unless a test names one — →
 * `epicChildFace`, which draws each child as its own card would: `epicChildCol`) and a child's tie to its epic
 * (`_epicParentOf`, the board's placement map — empty unless a test names one).
 */
export const CARD_FAMILY_FNS = ['epicChildCol', 'epicChildrenOf', 'epicFamilyOf', 'epicChildFace'] as const;
/**
 * #1474 — what `cardOf` reads for its status words: a turn still holding the session (`turnHolds` — a question open
 * while the run works) and the owner's answer on its way to the model (`answerAwaitsModel`). Pinned by
 * dashboard-question-answer-states-client.test.ts.
 */
export const CARD_STATE_FNS = ['turnHolds', 'answerAwaitsModel'] as const;

/**
 * Next actions as buttons (SSOT 2026-11-11): the open card's body (`renderCardBody` → `cardNextActionsHtml`), its
 * 지시/응답 fetch (`fetchCardIo` → `nextActionsOfTurns`) and the panel's turn paths (`renderPanelNext`) call these. A
 * harness that loads one of those callers without them gets a pass-through seam; one that loads them gets the real
 * function. Pinned by dashboard-next-actions-client.test.ts.
 */
export const NEXT_ACTION_SEAMS: Readonly<Record<string, unknown>> = {
  cardNextActionsHtml: () => '',
  nextActionsOfTurns: () => null,
  renderPanelNext: () => {},
  // SSOT 2026-11-12 — `convPaint` asks what the session's queue adds to the chat (`convQueueTurns`): nothing,
  // unless the test loads the real one (pinned by dashboard-steer-chat-client.test.ts).
  convQueueTurns: () => ({ chips: {}, extra: [], seen: [], drop: [], edits: {} }),
  // #1466 — `convPaint` asks where the instructions sent from here stand (`convProgressChips`): nowhere, unless the
  // test loads the real one (pinned by dashboard-instruction-stage-client.test.ts).
  convProgressChips: () => [],
  // SSOT 2026-11-13 — 입력 필요 as the chat's last message: `convPaint`, `psecClear` and `renderAgentConv` put the zone
  // where it belongs (`placePanelNeeds` — nothing waits, so not in the chat); `renderPanelNeedsHead` and
  // `renderPanelPlan` let it follow its parts (`syncPanelNeeds`). Pinned by dashboard-needs-in-chat-client.test.ts.
  placePanelNeeds: () => false,
  syncPanelNeeds: () => {},
  // 사용자 할 일 (instruct_user): `cardOf` counts required tasks still waiting (`userActionsWaiting`) — none, unless the
  // test loads the real one (pinned by dashboard-user-actions-client.test.ts).
  userActionsWaiting: () => 0,
  // SSOT 2026-11-16 (.prd/28 §3) — the plan is the 작업 계획 tab's: `renderPanelPlan` repaints the bar (`renderPanelMidbar`)
  // — nothing, unless the test loads the real one (pinned by dashboard-detail-zones-client.test.ts).
  renderPanelMidbar: () => {},
  // .prd/34 — task card window controls: `inboxPaint` reads the cards that start on one line (`cardMinSeeds`) and the card
  // in front (`boardCurrentKey`); `openPanel` folds its card (`boardFoldForDetail`) and rings it (`syncBoardCurrent`,
  // also `closePanel`); `deckRemove` brings it back (`boardRestoreFromDetail`); `wireInbox` keeps a fold
  // (`cardMinSave`, `boardNoteReaderFold`); repaints keep the deck's folds (`boardFoldDeck`); a decision unfolds the
  // reader's one line (`boardDecisionHidden`, `boardUnfoldForDecision`); focus comes back to a title (`cardTitleOf`).
  // Nothing, unless the test loads the real one (pinned by dashboard-card-window-client.test.ts).
  cardMinList: () => [],
  cardMinSeeds: () => [],
  cardMinSave: () => {},
  cardMinForget: () => {},
  // Loaded with the real cardMinSeeds in the starred-card and decision suites, which do not load this one.
  cardOthersDefaultFolded: () => false,
  boardOwnerDefaults: () => {},
  boardCurrentKey: () => '',
  syncBoardCurrent: () => {},
  boardFoldForDetail: () => {},
  boardRestoreFromDetail: () => {},
  boardNoteReaderFold: () => {},
  boardFoldDeck: () => {},
  boardSyncDetailFold: () => {},
  boardDecisionHidden: () => false,
  boardUnfoldForDecision: () => {},
  cardTitleOf: () => null,
  // SSOT 2026-11-19 — 중지 while a goal runs: `doAction`'s Stop asks first when the session's goal runs
  // (`stopGoalOf` → `askStopGoal`). No goal runs, unless the test loads the real ones (pinned by
  // dashboard-stop-goal-client.test.ts).
  stopGoalOf: () => null,
  askStopGoal: () => {},
};
export function nextActionSeams(fns: readonly string[], inject: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, seam] of Object.entries(NEXT_ACTION_SEAMS)) {
    if (!fns.includes(name) && !(name in inject)) out[name] = seam;
  }
  return out;
}

export function viewerScope(
  fns: readonly string[],
  inject: Record<string, unknown>,
): { fns: string[]; inject: Record<string, unknown> } {
  const defaults: Record<string, unknown> = {
    _viewerUserId: typeof inject.currentUserId === 'string' ? inject.currentUserId : '',
    _viewerIsAdmin: false,
    OWNER_ONLY_MSG: inject.READ_ONLY_MSG ?? '소유자나 관리자 모드를 켠 관리자만 할 수 있어요',
    STOP_OWNER_ONLY_MSG: inject.READ_ONLY_MSG ?? '소유자나 관리자만 중지할 수 있어요',
  };
  if (!fns.includes('_isAdminModeOn')) defaults._isAdminModeOn = () => false;
  // The page's repaint after the viewer or 관리자 모드 changes: a seam here (the board and panel are not loaded).
  if (!fns.includes('repaintViewerControls')) defaults.repaintViewerControls = () => {};
  // The board's child → epic map: shared by cardOf, withEpicChildren and applyEpicPush.
  defaults._epicParentOf = Object.create(null);
  const family = fns.includes('cardOf') ? [...CARD_FAMILY_FNS, ...CARD_STATE_FNS].filter((f) => !fns.includes(f)) : [];
  if (fns.includes('cardOf')) defaults._sessionCache = Object.create(null);
  Object.assign(defaults, nextActionSeams(fns, inject));
  return {
    fns: [...VIEWER_FNS.filter((f) => !fns.includes(f)), ...family, ...fns],
    inject: { ...defaults, ...inject },
  };
}
