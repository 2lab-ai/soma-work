import { isExemptTool } from './hook-policy';
import { hookState } from './hook-state';

const THRESHOLD = parseInt(process.env.TODO_GUARD_THRESHOLD || '5', 10);

interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: { todos?: unknown[] };
}

interface GuardResult {
  blocked: boolean;
  message?: string;
}

export function handlePreToolUse(input: HookInput): GuardResult {
  const { session_id, tool_name, tool_input } = input;

  // TodoWrite: set marker BEFORE exempt check — the proxy forwards TodoWrite
  // specifically so the service can set the marker. Must not be short-circuited.
  if (tool_name === 'TodoWrite') {
    const todos = tool_input?.todos;
    if (session_id && Array.isArray(todos) && todos.length > 0) {
      hookState.markTodoExists(session_id);
    }
    return { blocked: false };
  }

  // Policy check (defense in depth — shell also checks)
  if (isExemptTool(tool_name || '')) return { blocked: false };

  // No session_id → pass (fail-open)
  if (!session_id) return { blocked: false };

  // Already has todos → pass
  const state = hookState.getTodoGuardState(session_id);
  if (state?.todoExists) return { blocked: false };

  // Increment and check threshold
  const updated = hookState.incrementTodoGuard(session_id);
  if (updated.count >= THRESHOLD) {
    return {
      blocked: true,
      message: `\u26a0\ufe0f TodoWrite \uc5c6\uc774 ${THRESHOLD}\ud68c \uc774\uc0c1 tool call\uc774 \uac10\uc9c0\ub418\uc5c8\uc2b5\ub2c8\ub2e4.\n\uba3c\uc800 TodoWrite\ub85c \ud0dc\uc2a4\ud06c\ub97c \ub4f1\ub85d\ud558\uc138\uc694.\n\nTodoWrite \uc608\uc2dc:\n  TodoWrite({ todos: [{ content: "\uc791\uc5c5 \ub0b4\uc6a9", status: "pending", activeForm: "\uc791\uc5c5 \uc911" }] })`,
    };
  }

  return { blocked: false };
}
