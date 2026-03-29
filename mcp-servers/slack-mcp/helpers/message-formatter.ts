/**
 * Format raw Slack API message into ThreadMessage shape.
 */
import type { ThreadMessage } from '../types.js';
import { isImageFile, isMediaFile } from './file-validator.js';

export function formatSingleMessage(m: any): ThreadMessage {
  return {
    ts: m.ts,
    user: m.user || m.bot_id || 'unknown',
    user_name:
      m.user_profile?.display_name ||
      m.user_profile?.real_name ||
      m.username ||
      m.user ||
      'unknown',
    text: m.text || '',
    timestamp: m.ts
      ? new Date(parseFloat(m.ts) * 1000).toISOString()
      : new Date().toISOString(),
    files: (m.files || []).map((f: any) => {
      const fileIsImage = isImageFile(f.mimetype, f.name);
      const fileIsNonImageMedia = !fileIsImage && isMediaFile(f.mimetype, f.name || '');
      return {
        id: f.id,
        name: f.name,
        mimetype: f.mimetype,
        size: f.size,
        // Images: include download URL so agent can download and view via Read tool
        // Non-image media (video/audio): still blocked — no tool can process them
        ...(!fileIsNonImageMedia && f.url_private_download ? { url_private_download: f.url_private_download } : {}),
        ...(f.thumb_360 ? { thumb_360: f.thumb_360 } : {}),
        ...(fileIsImage ? {
          is_image: true,
          image_note: 'Image file — download with download_thread_file, then use Read tool to view it.',
        } : {}),
        ...(fileIsNonImageMedia ? {
          is_media: true,
          media_note: 'Media file (video/audio) — cannot be viewed. Reference by name only.',
        } : {}),
      };
    }),
    reactions: (m.reactions || []).map((r: any) => ({
      name: r.name,
      count: r.count,
    })),
    is_bot: !!m.bot_id,
    subtype: m.subtype || null,
  };
}
