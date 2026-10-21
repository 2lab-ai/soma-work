export type StatusType = 'thinking' | 'working' | 'waiting' | 'completed' | 'error' | 'cancelled';

/** The reaction emoji the turn shows on the user's message for each status. */
const STATUS_EMOJI: Record<StatusType, string> = {
  thinking: 'thinking_face',
  working: 'gear',
  waiting: 'raised_hand',
  completed: 'white_check_mark',
  error: 'x',
  cancelled: 'octagonal_sign',
};

/**
 * Maps a turn status to its reaction emoji. The status-message lifecycle this
 * class used to own (create → update → cleanup) was replaced by the single
 * ThreadSurface renderer in b24ad18d.
 */
export class StatusReporter {
  /**
   * Get the reaction emoji for a status type
   */
  getStatusEmoji(status: StatusType): string {
    return STATUS_EMOJI[status];
  }
}
