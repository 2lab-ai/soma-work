import * as fs from 'fs';
import fetch from 'node-fetch';
import * as os from 'os';
import * as path from 'path';
import { getA2tService } from './a2t/a2t-service';
import { config } from './config';
import { Logger } from './logger';

export interface ProcessedFile {
  path: string;
  name: string;
  mimetype: string;
  isImage: boolean;
  isText: boolean;
  isVideo: boolean;
  isAudio: boolean;
  size: number;
  tempPath?: string;
  /** Slack file id and permalink — the dashboard keeps them with the user turn (user media). */
  slackFileId?: string;
  permalink?: string;
  /** The bot could not fetch the file: over the download cap, or the download failed. `path` is ''. */
  unavailable?: 'too_large' | 'download_failed';
}

/** A text file's characters inlined into the prompt; a longer one is previewed and its path given. */
const TEXT_PREVIEW_CHARS = 10_000;

/**
 * The name the dashboard's new task composer gives a paste too long for the instruction
 * (dashboard.ts `ntPastedTextName`): the text is part of the user's message, not a file to analyse.
 */
const PASTED_TEXT_NAME = /^pasted-text-\d{8}-\d{6}\.txt$/;

/**
 * The prefix of the directory each long text file is kept in for the agent to read past the turn: a fresh
 * `mkdtemp` directory (mode 0700) under the OS temp dir, outside every directory a session may write (its working
 * directory and /tmp/{userId}, native-write-boundary.ts) — so a session cannot point it anywhere else. The OS clears
 * its temp dir in time; the download itself is deleted when the turn ends (cleanupTempFiles).
 */
const KEPT_TEXT_PREFIX = 'soma-text-';

/** The Slack file's id and permalink, when the event carries them (strings only). */
function slackRef(file: any): { slackFileId?: string; permalink?: string } {
  const id = typeof file?.id === 'string' && file.id ? file.id : undefined;
  const permalink = typeof file?.permalink === 'string' && file.permalink ? file.permalink : undefined;
  return { ...(id ? { slackFileId: id } : {}), ...(permalink ? { permalink } : {}) };
}

export class FileHandler {
  private logger = new Logger('FileHandler');

  async downloadAndProcessFiles(files: any[]): Promise<ProcessedFile[]> {
    const processedFiles: ProcessedFile[] = [];

    for (const file of files) {
      try {
        const processed = await this.downloadFile(file);
        if (processed) {
          processedFiles.push(processed);
        }
      } catch (error) {
        this.logger.error(`Failed to process file ${file.name}`, error);
      }
    }

    return processedFiles;
  }

  /**
   * A file the bot could not fetch, kept as metadata (no path) so the turn —
   * and the dashboard — still shows that the user attached it.
   */
  private unavailableFile(file: any, reason: 'too_large' | 'download_failed'): ProcessedFile {
    const name = String(file?.name || 'file');
    const mimetype = String(file?.mimetype || 'application/octet-stream');
    return {
      path: '',
      name,
      mimetype,
      isImage: this.isImageFile(mimetype, name),
      isText: this.isTextFile(mimetype),
      isVideo: this.isVideoFile(mimetype, name),
      isAudio: this.isAudioFile(mimetype, name),
      size: Number(file?.size) || 0,
      unavailable: reason,
      ...slackRef(file),
    };
  }

  private async downloadFile(file: any): Promise<ProcessedFile | null> {
    // Video and audio are downloaded like any other file (same 50 MB cap), so
    // the dashboard keeps a copy it can play (user media, SSOT 2026-10-25).
    // The model's prompt still never carries a video's path, nor an audio
    // file's unless it was transcribed (formatFilePrompt).
    // Check file size limit (50MB)
    if (file.size > 50 * 1024 * 1024) {
      this.logger.warn('File too large, skipping', { name: file.name, size: file.size });
      return this.unavailableFile(file, 'too_large');
    }

    try {
      this.logger.debug('Downloading file', {
        name: file.name,
        mimetype: file.mimetype,
        url: file.url_private_download?.substring(0, 100),
      });

      const response = await fetch(file.url_private_download, {
        headers: {
          Authorization: `Bearer ${config.slack.botToken}`,
        },
        redirect: 'follow',
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Check response content-type
      const responseContentType = response.headers.get('content-type') || '';
      this.logger.debug('Response content-type', {
        responseContentType,
        expectedMimetype: file.mimetype,
      });

      // Get buffer using arrayBuffer (buffer() is deprecated)
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Validate image content by checking magic bytes
      if (this.isImageFile(file.mimetype, file.name)) {
        const validation = this.validateImageContent(buffer, file.mimetype);
        if (!validation.valid) {
          this.logger.error('Downloaded content is not a valid image', {
            name: file.name,
            expectedMimetype: file.mimetype,
            responseContentType,
            reason: validation.reason,
            bufferPreview: buffer.slice(0, 100).toString('utf-8').substring(0, 50),
          });
          throw new Error(`Downloaded content is not a valid image: ${validation.reason}`);
        }
        this.logger.debug('Image validation passed', {
          name: file.name,
          detectedFormat: validation.detectedFormat,
        });
      }

      const tempDir = os.tmpdir();
      // basename: a Slack file name is user input and must not move the path out of the temp dir.
      const tempPath = path.join(tempDir, `slack-file-${Date.now()}-${path.basename(String(file.name || 'file'))}`);

      fs.writeFileSync(tempPath, buffer);

      const processed: ProcessedFile = {
        path: tempPath,
        name: file.name,
        mimetype: file.mimetype,
        isImage: this.isImageFile(file.mimetype, file.name),
        isText: this.isTextFile(file.mimetype),
        isVideo: this.isVideoFile(file.mimetype, file.name),
        isAudio: this.isAudioFile(file.mimetype, file.name),
        size: buffer.length,
        tempPath,
        ...slackRef(file),
      };

      this.logger.info('File downloaded successfully', {
        name: file.name,
        tempPath,
        isImage: processed.isImage,
        isText: processed.isText,
        actualSize: buffer.length,
      });

      return processed;
    } catch (error) {
      this.logger.error('Failed to download file', error);
      return this.unavailableFile(file, 'download_failed');
    }
  }

  /**
   * Validate image content by checking magic bytes (file signatures)
   */
  private validateImageContent(
    buffer: Buffer,
    expectedMimetype: string,
  ): { valid: boolean; reason?: string; detectedFormat?: string } {
    if (buffer.length < 8) {
      return { valid: false, reason: 'Buffer too small' };
    }

    // Check if content starts with HTML
    const textPreview = buffer.slice(0, 20).toString('utf-8').toLowerCase();
    if (textPreview.includes('<!doctype') || textPreview.includes('<html')) {
      return { valid: false, reason: 'Content is HTML, not an image (possible auth issue)' };
    }

    // Image magic bytes
    const magicBytes = {
      png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // PNG
      jpeg: [0xff, 0xd8, 0xff], // JPEG/JPG
      gif87: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a
      gif89: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
      webp: [0x52, 0x49, 0x46, 0x46], // RIFF (WebP starts with RIFF)
    };

    // Check for known image formats
    if (this.matchMagicBytes(buffer, magicBytes.png)) {
      return { valid: true, detectedFormat: 'png' };
    }
    if (this.matchMagicBytes(buffer, magicBytes.jpeg)) {
      return { valid: true, detectedFormat: 'jpeg' };
    }
    if (this.matchMagicBytes(buffer, magicBytes.gif87) || this.matchMagicBytes(buffer, magicBytes.gif89)) {
      return { valid: true, detectedFormat: 'gif' };
    }
    if (this.matchMagicBytes(buffer, magicBytes.webp)) {
      // WebP also needs to check for WEBP signature at offset 8
      if (buffer.length >= 12 && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
        return { valid: true, detectedFormat: 'webp' };
      }
    }

    // If no known image format detected, report the first few bytes for debugging
    const firstBytes = Array.from(buffer.slice(0, 8))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
    return { valid: false, reason: `Unknown image format. First bytes: ${firstBytes}` };
  }

  private matchMagicBytes(buffer: Buffer, magic: number[]): boolean {
    if (buffer.length < magic.length) return false;
    for (let i = 0; i < magic.length; i++) {
      if (buffer[i] !== magic[i]) return false;
    }
    return true;
  }

  private static IMAGE_EXTENSIONS = new Set([
    'jpg',
    'jpeg',
    'png',
    'gif',
    'webp',
    'svg',
    'bmp',
    'ico',
    'tiff',
    'tif',
    'heic',
    'heif',
    'avif',
  ]);
  private static VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp']);

  private isImageFile(mimetype: string, filename?: string): boolean {
    if (mimetype.startsWith('image/')) return true;
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      if (FileHandler.IMAGE_EXTENSIONS.has(ext)) return true;
    }
    return false;
  }
  private static AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma']);

  private isVideoFile(mimetype: string, filename?: string): boolean {
    if (mimetype.startsWith('video/')) return true;
    // An explicit audio type wins over the extension: a browser voice note in
    // a .webm container (dashboard recorder) is audio and goes to transcription.
    if (mimetype.startsWith('audio/')) return false;
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      if (FileHandler.VIDEO_EXTENSIONS.has(ext)) return true;
    }
    return false;
  }

  private isAudioFile(mimetype: string, filename?: string): boolean {
    if (mimetype.startsWith('audio/')) return true;
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      if (FileHandler.AUDIO_EXTENSIONS.has(ext)) return true;
    }
    return false;
  }

  private isTextFile(mimetype: string): boolean {
    const textTypes = [
      'text/',
      'application/json',
      'application/javascript',
      'application/typescript',
      'application/xml',
      'application/yaml',
      'application/x-yaml',
    ];

    return textTypes.some((type) => mimetype.startsWith(type));
  }

  /**
   * A copy of a long text file that outlives the turn — a plan turn is followed by the turn that does the work — or
   * its download's path when none can be made. The copy goes into a directory this call creates (KEPT_TEXT_PREFIX),
   * never into one a session can write.
   */
  private keepTextFile(file: ProcessedFile): string {
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), KEPT_TEXT_PREFIX));
      // The download's own name (slack-file-<ts>-<basename>), never a path out of dir.
      const kept = path.join(dir, path.basename(file.path));
      fs.copyFileSync(file.path, kept, fs.constants.COPYFILE_EXCL);
      return kept;
    } catch (error) {
      this.logger.warn('Could not keep a long text file past the turn — giving its download path', {
        name: file.name,
        error,
      });
      return file.path;
    }
  }

  async formatFilePrompt(files: ProcessedFile[], userText: string): Promise<string> {
    // Only the dashboard's pasted text: it is the user's message, not files to analyse.
    const onlyPasted = files.length > 0 && files.every((f) => f.isText && PASTED_TEXT_NAME.test(f.name));
    let prompt =
      userText || (onlyPasted ? "The user's message is the pasted text below." : 'Please analyze the uploaded files.');

    if (files.length > 0) {
      prompt += '\n\nUploaded files:\n';

      for (const file of files) {
        if (file.unavailable) {
          prompt += `\n## File: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          prompt += `Size: ${file.size} bytes\n`;
          prompt += `Note: This file could not be downloaded (${file.unavailable === 'too_large' ? 'over the 50 MB limit' : 'the download failed'}). Acknowledge it by name and ask the user to share it another way if you need its content.\n`;
        } else if (file.isImage) {
          // Include path so the agent can view the image via Read tool.
          // Claude Code's Read tool supports reading images natively (multimodal).
          prompt += `\n## Image: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          prompt += `Size: ${file.size} bytes\n`;
          prompt += `Path: ${file.path}\n`;
          prompt += `Note: This is an image file. Use the Read tool to view it (Claude Code supports reading images natively).\n`;
        } else if (file.isVideo) {
          prompt += `\n## Video: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          prompt += `Size: ${file.size} bytes\n`;
          prompt += `Note: This is a video file. The file path is intentionally withheld. Acknowledge the file by name and metadata.\n`;
        } else if (file.isAudio) {
          prompt += `\n## Audio: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          prompt += `Size: ${file.size} bytes\n`;

          // Attempt A2T transcription if file was downloaded (has path)
          if (file.path) {
            const a2t = getA2tService();
            if (a2t?.isReady()) {
              try {
                const result = await a2t.transcribe(file.path);
                prompt += `Language: ${result.language} (${(result.languageProbability * 100).toFixed(1)}%)\n`;
                prompt += `Duration: ${result.duration.toFixed(1)}s\n`;
                prompt += `Transcription:\n\`\`\`\n${result.text}\n\`\`\`\n`;
                this.logger.info('Audio transcribed successfully', {
                  name: file.name,
                  language: result.language,
                  duration: result.duration,
                  textLength: result.text.length,
                });
              } catch (error) {
                this.logger.error('Audio transcription failed', { name: file.name, error });
                prompt += `Note: Transcription failed: ${(error as Error).message}\n`;
              }
            } else {
              prompt += `Note: A2T service not available — ${a2t?.getStatusMessage() || 'not initialized'}. Voice content could not be transcribed.\n`;
            }
          } else {
            const a2t = getA2tService();
            prompt += `Note: This is an audio file. ${a2t ? a2t.getStatusMessage() : 'A2T service not loaded — voice transcription unavailable.'}\n`;
          }
        } else if (file.isText) {
          prompt += `\n## File: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          if (PASTED_TEXT_NAME.test(file.name)) {
            prompt += `Note: The user pasted this text into the message field. It was too long for the field, so it was attached as a file — treat it as part of the user's message.\n`;
          }

          try {
            const content = fs.readFileSync(file.path, 'utf-8');
            if (content.length > TEXT_PREVIEW_CHARS) {
              // The preview alone loses the rest of the file: say how long it is and where, so the agent reads all of it.
              prompt += `Size: ${content.length} characters\n`;
              prompt += `Path: ${this.keepTextFile(file)}\n`;
              prompt += `Note: Only the first ${TEXT_PREVIEW_CHARS} characters are shown below. Read the whole file at the path above with the Read tool before you act on it.\n`;
              prompt += `Content (truncated to first ${TEXT_PREVIEW_CHARS} characters):\n\`\`\`\n${content.substring(0, TEXT_PREVIEW_CHARS)}...\n\`\`\`\n`;
            } else {
              prompt += `Content:\n\`\`\`\n${content}\n\`\`\`\n`;
            }
          } catch (error) {
            prompt += `Error reading file content: ${error}\n`;
          }
        } else {
          prompt += `\n## File: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          prompt += `Size: ${file.size} bytes\n`;
          prompt += `Path: ${file.path}\n`;
          if (file.mimetype === 'application/pdf') {
            prompt += `Note: This is a PDF file. You can read it using the Read tool at the path above.\n`;
          } else {
            prompt += `Note: This is a binary file. You may try reading it with the Read tool at the path above.\n`;
          }
        }
      }

      if (!onlyPasted) {
        prompt += '\nPlease analyze these files and provide insights or assistance based on their content.';
      }
    }

    return prompt;
  }

  async cleanupTempFiles(files: ProcessedFile[]): Promise<void> {
    for (const file of files) {
      if (file.tempPath) {
        try {
          fs.unlinkSync(file.tempPath);
          this.logger.debug('Cleaned up temp file', { path: file.tempPath });
        } catch (error) {
          this.logger.warn('Failed to cleanup temp file', { path: file.tempPath, error });
        }
      }
    }
  }
}
