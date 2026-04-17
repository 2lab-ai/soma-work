import { type Options, query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../../../config';
import { ensureValidCredentials } from '../../../credentials-manager';
import { Logger } from '../../../logger';

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
  const credentialResult = await ensureValidCredentials();
  if (!credentialResult.valid) {
    throw new Error(`credentials invalid: ${credentialResult.error}`);
  }

  const options: Options = {
    model: config.conversation.summaryModel,
    maxTurns: 1,
    tools: [],
    systemPrompt,
    settingSources: [],
    plugins: [],
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
}

export async function improveEntry(entry: string, target: 'memory' | 'user'): Promise<string> {
  const systemPrompt = target === 'memory' ? MEMORY_ENTRY_PROMPT : USER_ENTRY_PROMPT;
  const prompt = `원본:\n${entry}\n\n개선본만 출력:`;
  const raw = await runQuery(prompt, systemPrompt);
  const text = raw.replace(/[\r\n]+/g, ' ').trim();
  if (!text) throw new Error('empty LLM output');
  const cap = target === 'memory' ? 660 : 412;
  return text.substring(0, cap);
}

export async function improveAll(entries: string[], target: 'memory' | 'user'): Promise<string[]> {
  const systemPrompt = target === 'memory' ? MEMORY_ALL_PROMPT : USER_ALL_PROMPT;
  const prompt = `다음 ${entries.length}개 항목을 정리·중복제거·통합해 더 짧은 entries로 재구성.\n출력: JSON array of strings, 다른 텍스트 없이.\n\n---\n${entries.join('\n---\n')}`;
  const raw = await runQuery(prompt, systemPrompt);
  const trimmed = raw.trim();

  let arr: string[] | null = null;
  try {
    const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
        arr = parsed as string[];
      }
    }
  } catch {
    // fall through to split
  }

  if (!arr) {
    arr = trimmed
      .split(/\n-{3,}\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  if (arr.length === 0) throw new Error('improveAll returned empty');

  const cap = target === 'memory' ? 660 : 412;
  return arr.map((s) => s.substring(0, cap));
}
