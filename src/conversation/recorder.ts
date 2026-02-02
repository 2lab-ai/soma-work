import { randomUUID } from 'crypto';
import { Logger } from '../logger';
import { ConversationStorage } from './storage';
import { ConversationRecord, ConversationTurn } from './types';
import { summarizeResponse } from './summarizer';

const logger = new Logger('ConversationRecorder');

// Singleton storage instance
let storage: ConversationStorage | null = null;

// In-memory cache of active conversations with LRU eviction (keyed by conversationId)
const MAX_CACHE_SIZE = 100;
const activeConversations = new Map<string, ConversationRecord>();

// Per-conversation write locks to serialize disk writes and prevent race conditions
const writeLocks = new Map<string, Promise<void>>();

/**
 * Serialize save operations per conversation to prevent race conditions.
 * Each conversation's writes are queued so only one writeFile runs at a time.
 */
async function serializedSave(conversationId: string, record: ConversationRecord): Promise<void> {
  const previous = writeLocks.get(conversationId) || Promise.resolve();
  const current = previous.then(() => getStorage().save(record));
  writeLocks.set(conversationId, current.catch((err) => {
    logger.error(`Write chain: prior save failed for ${conversationId}, next write will proceed`, err);
  }));
  await current;
}

/**
 * Add a record to the in-memory cache with LRU eviction.
 * Oldest entries are evicted when cache exceeds MAX_CACHE_SIZE.
 */
function cacheRecord(id: string, record: ConversationRecord): void {
  // If already in cache, delete and re-insert to maintain insertion order (LRU)
  if (activeConversations.has(id)) {
    activeConversations.delete(id);
  }
  // Evict oldest entries if at capacity
  while (activeConversations.size >= MAX_CACHE_SIZE) {
    const oldest = activeConversations.keys().next().value;
    if (oldest) {
      activeConversations.delete(oldest);
      writeLocks.delete(oldest);
      logger.debug(`Evicted conversation ${oldest} from cache (LRU)`);
    } else {
      break;
    }
  }
  activeConversations.set(id, record);
}

/**
 * Remove a conversation from the in-memory cache (e.g., on session end).
 */
export function removeFromCache(id: string): void {
  activeConversations.delete(id);
  writeLocks.delete(id);
}

/**
 * Initialize the recorder with optional base directory
 */
export function initRecorder(baseDir?: string): void {
  storage = new ConversationStorage(baseDir);
  logger.info('Conversation recorder initialized', { baseDir: baseDir || 'default' });
}

/**
 * Get or create the storage instance
 */
function getStorage(): ConversationStorage {
  if (!storage) {
    storage = new ConversationStorage();
  }
  return storage;
}

/**
 * Create a new conversation and return its ID
 */
export function createConversation(
  channelId: string,
  threadTs: string,
  ownerId: string,
  ownerName: string,
  title?: string,
  workflow?: string
): string {
  const id = randomUUID();
  const now = Date.now();

  const record: ConversationRecord = {
    id,
    channelId,
    threadTs,
    ownerId,
    ownerName,
    title,
    workflow,
    createdAt: now,
    updatedAt: now,
    turns: [],
  };

  cacheRecord(id, record);

  // Fire-and-forget: persist to disk (serialized per conversation)
  serializedSave(id, record).catch(err => {
    logger.error(`Failed to persist new conversation ${id}`, err);
  });

  logger.info(`Created conversation ${id}`, { channelId, threadTs, ownerName });
  return id;
}

/**
 * Record a user turn (fire-and-forget, non-blocking)
 */
export function recordUserTurn(
  conversationId: string,
  content: string,
  userName?: string,
  userId?: string
): void {
  // Fire-and-forget
  _recordUserTurnAsync(conversationId, content, userName, userId).catch(err => {
    logger.error(`Failed to record user turn for ${conversationId}`, err);
  });
}

async function _recordUserTurnAsync(
  conversationId: string,
  content: string,
  userName?: string,
  userId?: string
): Promise<void> {
  const record = await getOrLoadConversation(conversationId);
  if (!record) {
    logger.warn(`Conversation ${conversationId} not found, skipping user turn recording`);
    return;
  }

  const turn: ConversationTurn = {
    id: randomUUID(),
    role: 'user',
    timestamp: Date.now(),
    userName,
    userId,
    rawContent: content,
  };

  record.turns.push(turn);
  record.updatedAt = Date.now();

  await serializedSave(conversationId, record);
}

/**
 * Record an assistant turn (fire-and-forget, non-blocking).
 * Generates summary asynchronously after saving raw content.
 */
export function recordAssistantTurn(
  conversationId: string,
  content: string
): void {
  // Fire-and-forget
  _recordAssistantTurnAsync(conversationId, content).catch(err => {
    logger.error(`Failed to record assistant turn for ${conversationId}`, err);
  });
}

async function _recordAssistantTurnAsync(
  conversationId: string,
  content: string
): Promise<void> {
  const record = await getOrLoadConversation(conversationId);
  if (!record) {
    logger.warn(`Conversation ${conversationId} not found, skipping assistant turn recording`);
    return;
  }

  const turn: ConversationTurn = {
    id: randomUUID(),
    role: 'assistant',
    timestamp: Date.now(),
    rawContent: content,
    summarized: false,
  };

  record.turns.push(turn);
  record.updatedAt = Date.now();

  // Save immediately with raw content (serialized to prevent race conditions)
  await serializedSave(conversationId, record);

  // Then generate summary asynchronously (don't block)
  generateSummary(conversationId, turn.id, content).catch(err => {
    logger.error(`Failed to generate summary for turn ${turn.id}`, err);
  });
}

/**
 * Generate summary for an assistant turn and update the record
 */
async function generateSummary(
  conversationId: string,
  turnId: string,
  content: string
): Promise<void> {
  const summary = await summarizeResponse(content);
  if (!summary) {
    logger.warn(`Summary generation returned null for turn ${turnId} in conversation ${conversationId}`);
    return;
  }

  const record = await getOrLoadConversation(conversationId);
  if (!record) {
    logger.warn(`Conversation ${conversationId} disappeared during summary generation for turn ${turnId}`);
    return;
  }

  const turn = record.turns.find(t => t.id === turnId);
  if (!turn) {
    logger.warn(`Turn ${turnId} not found in conversation ${conversationId} during summary — possible race condition`);
    return;
  }

  turn.summaryTitle = summary.title;
  turn.summaryBody = summary.body;
  turn.summarized = true;
  record.updatedAt = Date.now();

  await serializedSave(conversationId, record);
  logger.debug(`Summary generated for turn ${turnId}: "${summary.title}"`);
}

/**
 * Get conversation from cache or load from disk
 */
async function getOrLoadConversation(id: string): Promise<ConversationRecord | null> {
  // Check in-memory cache first
  const cached = activeConversations.get(id);
  if (cached) return cached;

  // Load from disk
  const record = await getStorage().load(id);
  if (record) {
    cacheRecord(id, record);
  }
  return record;
}

/**
 * Get a conversation record (for web viewer)
 */
export async function getConversation(id: string): Promise<ConversationRecord | null> {
  return getOrLoadConversation(id);
}

/**
 * List all conversations (for web viewer list page)
 */
export async function listConversations() {
  return getStorage().list();
}

/**
 * Get a specific turn's raw content (for lazy loading)
 */
export async function getTurnRawContent(
  conversationId: string,
  turnId: string
): Promise<string | null> {
  const record = await getOrLoadConversation(conversationId);
  if (!record) return null;

  const turn = record.turns.find(t => t.id === turnId);
  return turn?.rawContent || null;
}

/**
 * Update conversation metadata (title, workflow)
 */
export async function updateConversationMeta(
  conversationId: string,
  updates: { title?: string; workflow?: string }
): Promise<void> {
  const record = await getOrLoadConversation(conversationId);
  if (!record) return;

  if (updates.title !== undefined) record.title = updates.title;
  if (updates.workflow !== undefined) record.workflow = updates.workflow;
  record.updatedAt = Date.now();

  await serializedSave(conversationId, record);
}
