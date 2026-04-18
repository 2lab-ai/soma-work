import { type Options, query } from '@anthropic-ai/claude-agent-sdk';
import { buildQueryEnv } from '../../../auth/query-env-builder';
import { config } from '../../../config';
import { ensureActiveSlotAuth, NoHealthySlotError, type SlotAuthLease } from '../../../credentials-manager';
import { Logger } from '../../../logger';
import { getTokenManager } from '../../../token-manager';
import { getPerEntryCap } from '../../../user-memory-store';

const logger = new Logger('MemoryImprove');

const MEMORY_ENTRY_PROMPT =
  '당신은 Slack AI assistant의 장기 기억(기술 사실·경로·팩트) 편집자다. 주어진 entry를 더 명확·간결·정확하게 다시 쓰되 기술적 사실은 보존하라. 출력은 본문만, 250자 이내.';
const USER_ENTRY_PROMPT =
  '당신은 사용자 페르소나(말투·선호·성향) 편집자다. 주어진 entry를 더 명확·자연스럽게 다시 쓰되 개성은 보존하라. 출력은 본문만, 200자 이내.';
const MEMORY_ALL_PROMPT =
  '당신은 Slack AI assistant의 장기 기억(기술 사실·경로·팩트)의 여러 entries를 정리하는 편집자다. 중복제거·통합해 더 짧은 entries로 재구성하되 기술적 사실은 보존하라. 출력은 JSON array of strings로만, 다른 텍스트 없이, 각 항목 250자 이내.';
const USER_ALL_PROMPT =
  '당신은 사용자 페르소나(말투·선호·성향)의 여러 entries를 정리하는 편집자다. 중복제거·통합해 더 짧은 entries로 재구성하되 개성은 보존하라. 출력은 JSON array of strings로만, 다른 텍스트 없이, 각 항목 200자 이내.';

async function runQuery(prompt: string, systemPrompt: string): Promise<string> {
  let lease: SlotAuthLease | null = null;
  try {
    try {
      lease = await ensureActiveSlotAuth(getTokenManager(), 'memory-improve');
    } catch (credErr) {
      if (credErr instanceof NoHealthySlotError) {
        throw new Error(`credentials invalid: ${credErr.message}`);
      }
      throw credErr;
    }

    // Pass the fresh lease token via options.env (built by `buildQueryEnv`)
    // so this call and any concurrent Claude spawn each use their own
    // lease's token.
    const { env } = buildQueryEnv(lease);
    const options: Options = {
      model: config.conversation.summaryModel,
      maxTurns: 1,
      tools: [],
      systemPrompt,
      settingSources: [],
      plugins: [],
      env,
      stderr: (data: string) => {
        logger.warn('MemoryImprove stderr', { data: data.trimEnd() });
      },
    };

    let assistantText = '';
    for await (const message of query({ prompt, options })) {
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            assistantText += block.text;
          }
        }
      }
    }

    return assistantText;
  } finally {
    if (lease) await lease.release();
  }
}

export async function improveEntry(entry: string, target: 'memory' | 'user'): Promise<string> {
  const systemPrompt = target === 'memory' ? MEMORY_ENTRY_PROMPT : USER_ENTRY_PROMPT;
  const prompt = `원본:\n${entry}\n\n개선본만 출력:`;
  const raw = await runQuery(prompt, systemPrompt);
  const text = raw.replace(/[\r\n]+/g, ' ').trim();
  if (!text) throw new Error('empty LLM output');
  const cap = getPerEntryCap(target);
  return text.substring(0, cap);
}

export async function improveAll(entries: string[], target: 'memory' | 'user'): Promise<string[]> {
  const systemPrompt = target === 'memory' ? MEMORY_ALL_PROMPT : USER_ALL_PROMPT;
  const prompt = `다음 ${entries.length}개 항목을 정리·중복제거·통합해 더 짧은 entries로 재구성.\n출력: JSON array of strings, 다른 텍스트 없이.\n\n---\n${entries.join('\n---\n')}`;
  const raw = await runQuery(prompt, systemPrompt);
  const trimmed = raw.trim();

  // Try JSON array first; unreachable/malformed falls through to split.
  // A parseable-but-wrong-shape array (e.g. `[1,2,3]`) MUST throw — silently
  // stringifying it via the split fallback would persist model garbage.
  let arr: string[] | null = null;
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (err) {
      logger.warn('improveAll JSON parse failed, trying split fallback', {
        target,
        error: (err as Error).message,
      });
    }
    if (Array.isArray(parsed)) {
      if (parsed.every((x): x is string => typeof x === 'string')) {
        arr = parsed;
      } else {
        throw new Error(
          `improveAll rejected malformed LLM output: array has non-string members (${parsed.length} items)`,
        );
      }
    }
  }

  if (!arr) {
    arr = trimmed
      .split(/\n-{3,}\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  if (arr.length === 0) throw new Error('improveAll returned empty');

  const cap = getPerEntryCap(target);
  return arr.map((s) => s.substring(0, cap));
}
