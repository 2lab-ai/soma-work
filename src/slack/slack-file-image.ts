/**
 * Slack image cards — a PNG uploaded privately and shown through an `image`
 * block's `slack_file`, never as an orphan file message.
 *
 * Slack can refuse a message that names a just-uploaded file with
 * `invalid_blocks` until its file index catches up. `deliverImageCard` retries
 * the image blocks a few times and then sends the card's text fallback, so a
 * slow index or a broken render never leaves the user without a card.
 *
 * Shared by `/usage card` (#usage-card-dark) and the `auth` infographic.
 */

import type { FilesUploadV2Arguments } from '@slack/web-api';
import { Logger } from '../logger';
import { SlackUploadError } from '../metrics/usage-render/errors';

const logger = new Logger('SlackFileImage');

/** Upload a PNG privately and return its Slack file id. */
export type SlackImageUploader = (png: Buffer, filename: string) => Promise<string>;

export interface FilesUploadClient {
  filesUploadV2(args: FilesUploadV2Arguments): Promise<unknown>;
  /** When present, the uploader waits for Slack to finish processing the image (see {@link slackImageUploader}). */
  files?: { info(args: { file: string }): Promise<unknown> };
}

/** Readiness polls after an upload: up to `READY_POLLS` × `READY_POLL_MS`. */
const READY_POLLS = 6;
const READY_POLL_MS = 300;

/** Slack has processed an image once it reports its pixel size or a thumbnail. */
function imageProcessed(info: unknown): boolean {
  const file = (info as { file?: Record<string, unknown> } | null | undefined)?.file;
  return !!file && (typeof file.original_w === 'number' || typeof file.thumb_360 === 'string');
}

/**
 * Defensive `filesUploadV2` response file-id extractor.
 *
 * Bolt v2 normalizes to a nested `{ files: [{ files: [{id}] }] }` shape, but
 * legacy Slack SDK responses use a flat `{ file: { id } }` or
 * `{ files: [{id}] }`. Probe all three before giving up.
 */
export function extractFileId(res: unknown): string {
  const r = res as Record<string, unknown> | null | undefined;
  if (r && Array.isArray(r.files) && r.files.length > 0) {
    const first = r.files[0] as Record<string, unknown>;
    if (first && Array.isArray(first.files) && (first.files as unknown[]).length > 0) {
      const inner = (first.files as unknown[])[0] as Record<string, unknown>;
      if (typeof inner?.id === 'string') return inner.id;
    }
    if (typeof first?.id === 'string') return first.id;
  }
  const f = r?.file as Record<string, unknown> | undefined;
  if (typeof f?.id === 'string') return f.id;
  throw new SlackUploadError('filesUploadV2 response missing file id', res);
}

/**
 * True if `err` is a Slack `invalid_blocks` API rejection. Retryable because
 * it usually indicates the freshly-uploaded file ID hasn't yet propagated
 * through Slack's internal file index.
 *
 * Only the structured `err.data.error` field is trusted — substring-matching
 * `err.message` was rejected because any wrapped error whose stringified
 * message happens to contain the literal (e.g. a log line or a different
 * upstream error) would spuriously trigger retry.
 */
export function isInvalidBlocksError(err: unknown): boolean {
  const e = err as { data?: { error?: string } } | null | undefined;
  return e?.data?.error === 'invalid_blocks';
}

/**
 * Uploader bound to a bot client. NO `channel_id` / `channels` / `thread_ts` /
 * `initial_comment`: Slack would otherwise post the PNG as its own message.
 * The file stays private to the bot that uploaded it, so the same bot must post
 * the card that shows it.
 *
 * With `files.info` available it then waits (≤ ~2 s) until Slack reports the
 * image processed, so a sender that cannot retry (`ZRespond.replace`) rarely
 * meets `invalid_blocks`. A wait that runs out is not an error — the senders
 * that can retry still do (`deliverImageCard`).
 */
export function slackImageUploader(
  client: FilesUploadClient,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): SlackImageUploader {
  return async (png, filename) => {
    let res: unknown;
    try {
      // `request_file_info: false` skips the SDK's own files.info round trip (the
      // readiness wait below does its own); the SDK reads it but does not type it.
      res = await client.filesUploadV2({ filename, file: png, request_file_info: false } as FilesUploadV2Arguments);
    } catch (err) {
      throw new SlackUploadError('filesUploadV2 failed', err);
    }
    const id = extractFileId(res);
    if (client.files?.info) {
      for (let poll = 0; poll < READY_POLLS; poll++) {
        try {
          if (imageProcessed(await client.files.info({ file: id }))) break;
        } catch {
          break; // no files:read or a transient error: send and let the caller's retry decide
        }
        await sleep(READY_POLL_MS);
      }
    }
    return id;
  };
}

export interface ImageCardBlocks {
  blocks: unknown[];
  /** The same card without the image; absent = the card has no image to fall back from. */
  fallbackBlocks?: unknown[];
}

export interface DeliverImageCardOptions {
  /** Which failures another send of the image blocks can fix (default: Slack `invalid_blocks`). */
  retryOn?: (err: unknown) => boolean;
  /**
   * Which failures may be followed by the text fallback (default: a Slack platform
   * rejection — `err.data.error` set — which proves nothing was posted). A transport
   * error (timeout, lost response) may hide a delivered message, so an append-only
   * send propagates it instead of posting a second message. In-place updates
   * (`chat.update`, a replace) are idempotent and pass `() => true`.
   */
  fallbackOn?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** Sends of the image blocks before the fallback, and the wait between them. */
const IMAGE_SEND_ATTEMPTS = 3;
const IMAGE_SEND_DELAY_MS = 500;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Slack answered and refused the request: a platform error carries its code. */
export function isSlackRejection(err: unknown): boolean {
  return typeof (err as { data?: { error?: unknown } } | null | undefined)?.data?.error === 'string';
}

/**
 * Send `card.blocks`; while Slack refuses them with a retryable error, wait and
 * send again; then, when the failure allows it, send `card.fallbackBlocks`. A card
 * without a fallback is sent once, unchanged. Throws the image failure when no
 * fallback may follow it, and the fallback's failure when that send fails too.
 */
export async function deliverImageCard<T>(
  card: ImageCardBlocks,
  send: (blocks: unknown[]) => Promise<T>,
  opts: DeliverImageCardOptions = {},
): Promise<T> {
  if (!card.fallbackBlocks) return send(card.blocks);
  const retryOn = opts.retryOn ?? isInvalidBlocksError;
  const fallbackOn = opts.fallbackOn ?? isSlackRejection;
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt < IMAGE_SEND_ATTEMPTS; attempt++) {
    try {
      return await send(card.blocks);
    } catch (err) {
      lastError = err;
      if (!retryOn(err)) break;
      if (attempt < IMAGE_SEND_ATTEMPTS - 1) await sleep(IMAGE_SEND_DELAY_MS);
    }
  }
  if (!fallbackOn(lastError)) throw lastError;
  logger.warn('image card refused; sending the text fallback', {
    error: (lastError as { data?: { error?: string } })?.data?.error ?? (lastError as Error)?.message,
  });
  return send(card.fallbackBlocks);
}
