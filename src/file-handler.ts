import * as fs from 'fs';
import fetch from 'node-fetch';
import * as os from 'os';
import * as path from 'path';
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
  /** Transcript text extracted from Slack's built-in voice transcription */
  transcript?: string;
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

  private async downloadFile(file: any): Promise<ProcessedFile | null> {
    // Audio files: extract Slack's built-in transcription instead of downloading binary.
    if (this.isAudioFile(file.mimetype, file.name)) {
      const transcript = this.extractSlackTranscription(file);
      this.logger.info('Audio file detected', {
        name: file.name,
        mimetype: file.mimetype,
        hasTranscript: !!transcript,
      });
      return {
        path: '',
        name: file.name,
        mimetype: file.mimetype,
        isImage: false,
        isText: false,
        isVideo: false,
        isAudio: true,
        size: file.size || 0,
        transcript,
      };
    }

    // Video files: metadata only — skip download entirely.
    if (this.isVideoFile(file.mimetype, file.name)) {
      this.logger.info('Video file detected, skipping download (metadata only)', {
        name: file.name,
        mimetype: file.mimetype,
      });
      return {
        path: '',
        name: file.name,
        mimetype: file.mimetype,
        isImage: false,
        isText: false,
        isVideo: true,
        isAudio: false,
        size: file.size || 0,
      };
    }

    // Check file size limit (50MB)
    if (file.size > 50 * 1024 * 1024) {
      this.logger.warn('File too large, skipping', { name: file.name, size: file.size });
      return null;
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
      const tempPath = path.join(tempDir, `slack-file-${Date.now()}-${file.name}`);

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
      return null;
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

  /**
   * Extract transcription text from Slack's built-in voice transcription.
   * Slack auto-transcribes voice clips and includes the result in the file metadata.
   */
  private extractSlackTranscription(file: any): string | undefined {
    const transcription = file.transcription;
    if (!transcription || transcription.status !== 'complete') {
      return undefined;
    }
    const preview = transcription.preview;
    if (!preview?.content) {
      return undefined;
    }
    return preview.content;
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

  async formatFilePrompt(files: ProcessedFile[], userText: string): Promise<string> {
    let prompt = userText || 'Please analyze the uploaded files.';

    if (files.length > 0) {
      prompt += '\n\nUploaded files:\n';

      for (const file of files) {
        if (file.isImage) {
          // Include path so the agent can view the image via Read tool.
          // Claude Code's Read tool supports reading images natively (multimodal).
          prompt += `\n## Image: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          prompt += `Size: ${file.size} bytes\n`;
          prompt += `Path: ${file.path}\n`;
          prompt += `Note: This is an image file. Use the Read tool to view it (Claude Code supports reading images natively).\n`;
        } else if (file.isAudio && file.transcript) {
          // Voice message with Slack-provided transcription — include the spoken text directly.
          prompt += `\n## Voice Message: ${file.name}\n`;
          prompt += `[The user sent a voice message. Here is what they said: "${file.transcript}"]\n`;
        } else if (file.isVideo || file.isAudio) {
          // Video or audio without transcription — metadata only.
          const mediaCategory = file.isVideo ? 'video' : 'audio';
          prompt += `\n## Media: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          prompt += `Size: ${file.size} bytes\n`;
          prompt += `Note: This is a ${mediaCategory} file. The file path is intentionally withheld. Acknowledge the file by name and metadata.\n`;
        } else if (file.isText) {
          prompt += `\n## File: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;

          try {
            const content = fs.readFileSync(file.path, 'utf-8');
            if (content.length > 10000) {
              prompt += `Content (truncated to first 10000 characters):\n\`\`\`\n${content.substring(0, 10000)}...\n\`\`\`\n`;
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

      prompt += '\nPlease analyze these files and provide insights or assistance based on their content.';
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

  getSupportedFileTypes(): string[] {
    return [
      'Images: jpg, png, gif, webp, svg',
      'Text files: txt, md, json, js, ts, py, java, etc.',
      'Documents: pdf, docx (limited support)',
      'Code files: most programming languages',
    ];
  }
}
