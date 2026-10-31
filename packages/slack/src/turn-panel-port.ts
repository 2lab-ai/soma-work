/**
 * The turn's output panel, as StreamExecutor uses it (#598 ④b, .prd/17 D7).
 *
 * Exactly the ThreadPanel methods the executor calls on a turn — nothing the
 * host's TurnRunner, the todo display or the action handlers call
 * (`finalizeOnEndTurn`, `renderTasks`, `resolveChoice`, `clearChoice`, `close`, …). The Slack implementation is
 * `ThreadPanel` (today's behaviour); a Slack-less task's executor gets a
 * dashboard implementation. Picked from ThreadPanel so the signatures cannot
 * drift from the Slack panel.
 */
import type { ThreadPanel } from './thread-panel';

export type TurnPanelPort = Pick<
  ThreadPanel,
  | 'beginTurn'
  | 'appendText'
  | 'isTurnSurfaceActive'
  | 'endTurn'
  | 'failTurn'
  | 'isCompletionMarkerActive'
  | 'setStatus'
  | 'updatePanel'
  | 'attachChoice'
  | 'askUser'
  | 'askUserForm'
>;
