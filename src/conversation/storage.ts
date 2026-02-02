import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logger';
import { ConversationRecord, ConversationMeta } from './types';

const logger = new Logger('ConversationStorage');

/**
 * File-system based conversation storage.
 * Stores each conversation as a JSON file in data/conversations/{id}.json
 */
export class ConversationStorage {
  private dataDir: string;

  constructor(baseDir?: string) {
    this.dataDir = baseDir || path.join(process.cwd(), 'data', 'conversations');
    this.ensureDir();
  }

  /** Throws if directory cannot be created — caller must know storage is unusable */
  private ensureDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      logger.info(`Created conversations directory: ${this.dataDir}`);
    }
  }

  private filePath(id: string): string {
    // Sanitize ID to prevent path traversal
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.dataDir, `${safeId}.json`);
  }

  /**
   * Save a conversation record to disk.
   * Uses atomic write-to-temp-then-rename to prevent corruption on crash.
   * Errors are propagated — callers must handle failures.
   */
  async save(record: ConversationRecord): Promise<void> {
    const filePath = this.filePath(record.id);
    const tmpPath = filePath + '.tmp';
    const data = JSON.stringify(record, null, 2);
    await fs.promises.writeFile(tmpPath, data, 'utf-8');
    await fs.promises.rename(tmpPath, filePath);
  }

  /**
   * Load a conversation record from disk
   */
  async load(id: string): Promise<ConversationRecord | null> {
    try {
      const filePath = this.filePath(id);
      if (!fs.existsSync(filePath)) {
        return null;
      }
      const data = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(data) as ConversationRecord;
    } catch (error) {
      logger.error(`Failed to load conversation ${id}`, error);
      return null;
    }
  }

  /**
   * List all conversations (metadata only, sorted by updatedAt desc)
   */
  async list(): Promise<ConversationMeta[]> {
    try {
      const files = await fs.promises.readdir(this.dataDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      const metas: ConversationMeta[] = [];

      for (const file of jsonFiles) {
        try {
          const filePath = path.join(this.dataDir, file);
          const data = await fs.promises.readFile(filePath, 'utf-8');
          const record = JSON.parse(data) as ConversationRecord;

          metas.push({
            id: record.id,
            ownerName: record.ownerName,
            title: record.title,
            workflow: record.workflow,
            turnCount: record.turns.length,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          });
        } catch (error) {
          logger.warn(`Failed to parse conversation file: ${file}`, error);
        }
      }

      // Sort by updatedAt descending (newest first)
      metas.sort((a, b) => b.updatedAt - a.updatedAt);
      return metas;
    } catch (error) {
      logger.error('Failed to list conversations', error);
      return [];
    }
  }

  /**
   * Check if a conversation exists
   */
  exists(id: string): boolean {
    return fs.existsSync(this.filePath(id));
  }

  /**
   * Delete a conversation
   */
  async delete(id: string): Promise<boolean> {
    try {
      const filePath = this.filePath(id);
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        return true;
      }
      return false;
    } catch (error) {
      logger.error(`Failed to delete conversation ${id}`, error);
      return false;
    }
  }
}
