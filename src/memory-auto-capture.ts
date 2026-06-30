/**
 * Automatic hierarchical-memory updates driven by the session lifecycle.
 *
 *   - Turn end  → `captureTurnEpisodic`: append a compact, deterministic
 *     breadcrumb to `episodic/YYYY-MM-DD.md`. No LLM, fire-and-forget, so it
 *     adds negligible latency and cost per turn across all tenants.
 *   - Session sleep/expiry (or idle) → `consolidateUserMemory`: a single,
 *     best-effort LLM "dreaming" pass that reads recent episodic + the current
 *     L1 briefings and rewrites L1 (MEMORY.md / USER.md) so durable facts are
 *     promoted out of the raw episodic log. Writes `.dream-state.json`.
 *
 * Both paths are wrapped so a failure never propagates into the turn or the
 * session-cleanup loop.
 */
import * as fs from 'fs';
import * as path from 'path';
import { memoryRoot } from 'somalib/model-commands/hierarchical-memory-store';
import { runOneShotText } from './agent-runtime';
import { buildOneShotOptions } from './agent-runtime/one-shot-options';
import { buildQueryEnv } from './auth/query-env-builder';
import { config } from './config';
import { ensureActiveSlotAuth, NoHealthySlotError, type SlotAuthLease } from './credentials-manager';
import { DATA_DIR } from './env-paths';
import { hierarchicalMemoryStore } from './hierarchical-memory';
import { Logger } from './logger';
import { getTokenManager } from './token-manager';
import * as userMemoryStore from './user-memory-store';

const logger = new Logger('MemoryAutoCapture');

const TURN_CAPTURE_ENABLED = process.env.MEMORY_TURN_CAPTURE !== '0';
const DREAMING_ENABLED = process.env.MEMORY_DREAMING !== '0';
const USER_TEXT_CAP = 240;
const ASSISTANT_TEXT_CAP = 360;

/** Strip harness wrapper tags/noise so the breadcrumb captures the real ask. */
function cleanUserText(raw: string): string {
  return raw
    .replace(/<speaker>[\s\S]*?<\/speaker>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * Append a per-turn episodic breadcrumb. Deterministic and synchronous-light:
 * scheduled on the microtask queue so it never adds latency to the reply path.
 */
export function captureTurnEpisodic(userId: string, userText: string, assistantText: string): void {
  if (!TURN_CAPTURE_ENABLED) return;
  queueMicrotask(() => {
    try {
      const ask = clip(cleanUserText(userText), USER_TEXT_CAP);
      const did = clip(assistantText, ASSISTANT_TEXT_CAP);
      if (!ask && !did) return;
      const body = [ask ? `**Ask:** ${ask}` : '', did ? `**Did:** ${did}` : ''].filter(Boolean).join('\n');
      hierarchicalMemoryStore.appendEpisodic(userId, body);
    } catch (err) {
      logger.debug('episodic capture failed', { userId, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

interface DreamState {
  lastDreamAt: number;
  turnsSinceLastDream: number;
}

function dreamStatePath(userId: string): string {
  return path.join(memoryRoot(DATA_DIR, userId), '.dream-state.json');
}

function readDreamState(userId: string): DreamState {
  try {
    return JSON.parse(fs.readFileSync(dreamStatePath(userId), 'utf-8')) as DreamState;
  } catch {
    return { lastDreamAt: 0, turnsSinceLastDream: 0 };
  }
}

function writeDreamState(userId: string, state: DreamState): void {
  try {
    fs.mkdirSync(path.dirname(dreamStatePath(userId)), { recursive: true });
    fs.writeFileSync(dreamStatePath(userId), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  } catch {
    /* best-effort */
  }
}

const CONSOLIDATION_SYSTEM_PROMPT = `당신은 Slack AI assistant의 장기기억 정리자(dreaming)다.
입력으로 (1) 현재 L1 MEMORY 엔트리, (2) 현재 L1 USER 엔트리, (3) 최근 episodic 관찰 로그를 받는다.
목표: episodic 로그에서 "세션 시작마다 다시 알아야 할 만큼 durable한 사실"만 추출해 L1을 갱신한다.
규칙:
- MEMORY = 에이전트 운영 사실(도구 quirk, 경로, 컨벤션). USER = 사용자 선호·성향·말투.
- 일회성 작업 진행/결과/TODO는 절대 넣지 않는다.
- 기존 엔트리는 보존하되 명백히 갱신/중복이면 통합한다.
- 출력은 JSON만. 형식: {"memory": ["..."], "user": ["..."]}. 각 항목은 한 줄, MEMORY 250자/USER 200자 이내.
- 새로 배울 게 없으면 기존 엔트리를 그대로 반환한다.`;

async function runConsolidationQuery(prompt: string): Promise<string> {
  let lease: SlotAuthLease | null = null;
  try {
    lease = await ensureActiveSlotAuth(getTokenManager(), 'memory-dreaming');
    const { env } = buildQueryEnv(lease);
    const options = buildOneShotOptions({
      model: config.conversation.summaryModel,
      systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
      env,
      logger,
      stderrLabel: 'MemoryDreaming',
      disableThinking: false,
    });
    return await runOneShotText(prompt, options);
  } finally {
    if (lease) await lease.release();
  }
}

function parseJsonObject(text: string): { memory?: unknown; user?: unknown } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function applyL1(userId: string, target: 'memory' | 'user', proposed: unknown): void {
  if (!Array.isArray(proposed)) return;
  const entries = proposed
    .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
    .map((e) => e.trim());
  if (entries.length === 0) return;
  const result = userMemoryStore.replaceAllMemory(userId, target, entries);
  if (!result.ok) {
    logger.debug('dreaming L1 apply rejected', { userId, target, reason: result.reason });
  }
}

/**
 * Best-effort "dreaming" consolidation. Rebuilds the page index, then runs one
 * LLM pass to refresh L1 from recent episodic observations. Never throws.
 * Returns true when a consolidation pass actually ran.
 */
export async function consolidateUserMemory(userId: string): Promise<boolean> {
  if (!DREAMING_ENABLED) return false;
  try {
    // Always keep the index fresh even if the LLM pass is skipped/fails.
    hierarchicalMemoryStore.readIndex(userId);

    const recentDates = hierarchicalMemoryStore.recentEpisodicDates(userId, 3);
    if (recentDates.length === 0) return false;
    const episodic = recentDates
      .map((d) => hierarchicalMemoryStore.readEpisodic(userId, d))
      .filter((s) => s.trim().length > 0)
      .join('\n\n');
    if (!episodic.trim()) return false;

    const mem = userMemoryStore.loadMemory(userId, 'memory');
    const usr = userMemoryStore.loadMemory(userId, 'user');

    const prompt = [
      '## 현재 L1 MEMORY 엔트리',
      mem.entries.length ? mem.entries.map((e, i) => `${i + 1}. ${e}`).join('\n') : '(없음)',
      '',
      '## 현재 L1 USER 엔트리',
      usr.entries.length ? usr.entries.map((e, i) => `${i + 1}. ${e}`).join('\n') : '(없음)',
      '',
      '## 최근 episodic 관찰',
      episodic.slice(0, 6000),
    ].join('\n');

    const raw = await runConsolidationQuery(prompt);
    const parsed = parseJsonObject(raw);
    if (parsed) {
      applyL1(userId, 'memory', parsed.memory);
      applyL1(userId, 'user', parsed.user);
    } else {
      logger.debug('dreaming produced no parseable JSON', { userId });
    }

    const prev = readDreamState(userId);
    writeDreamState(userId, { lastDreamAt: Date.now(), turnsSinceLastDream: 0 });
    logger.info('memory consolidation complete', {
      userId,
      episodicDays: recentDates.length,
      prevDreamAt: prev.lastDreamAt,
    });
    return true;
  } catch (err) {
    if (err instanceof NoHealthySlotError) {
      logger.debug('dreaming skipped: no healthy auth slot', { userId });
    } else {
      logger.warn('memory consolidation failed', { userId, error: err instanceof Error ? err.message : String(err) });
    }
    return false;
  }
}
