export interface ConversationSession {
  ownerId: string;           // User who started the session
  ownerName?: string;        // Display name of owner
  currentInitiatorId?: string; // User who triggered the current response
  currentInitiatorName?: string; // Display name of current initiator
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  isActive: boolean;
  lastActivity: Date;
  workingDirectory?: string;
  // Session expiry warning tracking
  warningMessageTs?: string;
  lastWarningSentAt?: number; // Which warning interval was last sent (in ms)
  // Legacy field for backward compatibility
  userId: string;
}

export interface WorkingDirectoryConfig {
  channelId: string;
  threadTs?: string;
  userId?: string;
  directory: string;
  setAt: Date;
}