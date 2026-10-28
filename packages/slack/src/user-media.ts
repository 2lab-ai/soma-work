/**
 * User media — the files a user attached to an instruction (the SSOT's media):
 * screenshots, PDFs, text, voice notes, video. The fixed seam between the
 * stream executor, which sees the downloaded files of a turn, and the
 * dashboard store (`src/conversation/user-media.ts`), which keeps a copy and
 * files the attachments on the user turn they came with. Types only.
 */

/** Why the bot holds no bytes for an attachment it was given (FileHandler gave up on it). */
export type UserMediaUnavailable = 'too_large' | 'download_failed';

/** What a dashboard can show for the file. Same set as a session artifact's kind. */
export type UserMediaKind = 'image' | 'audio' | 'video' | 'html' | 'markdown' | 'pdf' | 'text' | 'file';

/** One attachment of a user turn, as the conversation record keeps it. */
export interface TurnAttachment {
  /** Id of the stored copy (ulid); unique within the conversation. */
  id: string;
  /** The Slack file name. */
  name: string;
  kind: UserMediaKind;
  /** The MIME type the dashboard serves the copy as. */
  mime: string;
  /** Bytes of the original. */
  size: number;
  /** A copy exists and the dashboard can show it. False: metadata (and the Slack link) only. */
  stored: boolean;
  slackFileId?: string;
  /** Slack permalink — where a file without a copy can still be opened. */
  permalink?: string;
  /** Set when the bot never had the bytes: the download was over the cap or failed. */
  unavailable?: UserMediaUnavailable;
}
