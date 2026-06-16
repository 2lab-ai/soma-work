import { isExemptTool } from './hook-policy';
import { hookState } from './hook-state';

const THRESHOLD = parseInt(process.env.TODO_GUARD_THRESHOLD || '5', 10);

// Task-tracking tools that satisfy the guard.
//
// WHY this guard exists: it forbids planless, aimless drift — racking up tool
// calls without ever registering what you are actually doing. Calling any of
// these tools proves the model is working from a plan, which is exactly what
// the guard wants to see before it lets work continue.
//
// `TodoWrite` is the legacy task-tracking tool name; `TaskCreate` / `TaskUpdate`
// are the harness's current task-tracking tools. Any of them counts.
const TASK_TRACKING_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);

interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: { todos?: unknown[] };
}

interface GuardResult {
  blocked: boolean;
  message?: string;
}

// Whether a task-tracking call actually registers a task (and so should set the
// marker). TodoWrite only counts with a non-empty `todos` array — an empty
// payload registers nothing. TaskCreate/TaskUpdate register/update a task by the
// act of calling them, so they always count.
function registersTask(toolName: string, toolInput?: { todos?: unknown[] }): boolean {
  if (toolName === 'TodoWrite') {
    const todos = toolInput?.todos;
    return Array.isArray(todos) && todos.length > 0;
  }
  return true;
}

export function handlePreToolUse(input: HookInput): GuardResult {
  const { session_id, tool_name, tool_input } = input;

  // Task-tracking tools: set marker BEFORE exempt check — the proxy forwards
  // them specifically so the service can set the marker. Must not be
  // short-circuited.
  if (tool_name && TASK_TRACKING_TOOLS.has(tool_name)) {
    if (session_id && registersTask(tool_name, tool_input)) {
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
      message: `⚠️ TodoWrite/TaskCreate/TaskUpdate 없이 ${THRESHOLD}회 이상 tool call이 감지되었습니다.
이 가드는 계획 없이 정처 없이 드리프트하는 것을 금지하는 룰입니다. 먼저 무엇을 할지 태스크로 등록한 뒤 진행하세요.

TodoWrite 예시:
  TodoWrite({ todos: [{ content: "작업 내용", status: "pending", activeForm: "작업 중" }] })

또는 TaskCreate / TaskUpdate 로 태스크를 등록해도 됩니다.`,
    };
  }

  return { blocked: false };
}
