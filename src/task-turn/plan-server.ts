/**
 * Plan mode (SSOT 2026-11-02) — the plan's host tool: an in-process SDK MCP
 * server `plan`, on a task turn whose plan is not started yet
 * (`attachesPlanServer`). Its one tool, `plan_submit`, takes the structured
 * plan (four levels, task-plan.ts) and saves it through the host as the next
 * revision awaiting the owner; the server draws it (task-plan-html.ts).
 *
 * - The tool carries no identity: the task id comes from the turn's own
 *   context, and every call re-reads the task through the host.
 * - The host (the registry's `submitTaskPlan`) is set by `index.ts` through
 *   `setPlanHost` — no import of the registry here (the epic server's shape).
 */
import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ExecutionContext, TaskExecutionContext } from '../agent-runtime/execution-context';
import { TaskPlanError, type TaskPlanGate } from './task-plan';

/** The server key and name: its tool is `mcp__plan__plan_submit`. */
export const PLAN_SERVER = 'plan';

/** What the plan tool needs from the host process. */
export interface PlanHost {
  /** The registry's strict submit: checked, the next revision, saved — or a throw that changed nothing. */
  submitTaskPlan(taskId: string, input: unknown): TaskPlanGate;
}

let host: PlanHost | undefined;

/** Set (or clear, in tests) the host the plan tool calls. `index.ts` sets it once at startup. */
export function setPlanHost(next: PlanHost | undefined): void {
  host = next;
}

/** The plan server rides a task turn whose plan is not started yet (the context's `planPending`). */
export function attachesPlanServer(ctx: ExecutionContext | undefined): ctx is TaskExecutionContext {
  if (!ctx || ctx.origin !== 'task') return false;
  return (ctx as TaskExecutionContext).planPending === true;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const reply = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const refuse = (code: string, error: string): ToolResult => ({ ...reply({ ok: false, code, error }), isError: true });

const text = z.string();
const list = z.array(z.string()).optional();
const step = z.object({
  title: text,
  detail: z.string().optional(),
  deliverable: z.string().optional(),
  refs: z.array(z.string()).optional(),
});
const phase = z.object({ title: text, goal: z.string().optional(), steps: z.array(step) });

/** The plan tool for one task turn. `ctx` is the turn's own context: the task id comes from it. */
export function planTools(ctx: TaskExecutionContext) {
  const taskId = ctx.taskId;
  const submit = tool(
    'plan_submit',
    [
      "Submit this task's work plan for the owner's start (plan mode). Nothing runs as work before they start it.",
      'High level to detail: summary (the one-line conclusion, ≤ 300), intent (≤ 1,500), ssot (the instruction quoted',
      'as given, no paraphrase), intents ({id: I1, text, source}), then phases (1–10, each {title, goal?, steps}) →',
      'steps (1–15 per phase, each {title, detail?, deliverable?, refs?: ["T1", "I1.2"]}), and assumptions, risks,',
      'outOfScope, questions (what the owner should settle). A new call replaces the waiting plan (the next revision).',
      'After it succeeds, say the plan in a line or two and end your turn: the owner starts, cancels, or writes back.',
    ].join(' '),
    {
      summary: text,
      intent: text,
      ssot: list,
      intents: z.array(z.object({ id: text, text, source: z.string().optional() })).optional(),
      phases: z.array(phase),
      assumptions: list,
      risks: list,
      outOfScope: list,
      questions: list,
    },
    async (args) => {
      if (!host) return refuse('not-ready', 'the plan tool is not ready yet — try again');
      try {
        const gate = host.submitTaskPlan(taskId, args);
        return reply({
          ok: true,
          state: gate.state,
          revision: gate.revision,
          next: `계획 v${gate.revision}을 제출했다. 한두 줄로 요약하고 이 턴을 끝낸다 — 유저가 대시보드에서 시작 · 취소 · 직접 입력 중 하나를 고른다. 시작 전에는 작업하지 않는다.`,
        });
      } catch (error) {
        if (error instanceof TaskPlanError) return refuse(error.code, error.message);
        if (/not a plan-mode task/.test((error as Error)?.message ?? '')) {
          return refuse('not-a-plan-task', 'this task has no plan waiting to be written');
        }
        return refuse('not-saved', 'the plan could not be saved — nothing changed; try again');
      }
    },
  );
  return [submit] as const;
}

/** The `plan` server for one task turn (its tool: `planTools`). */
export function buildPlanServer(ctx: TaskExecutionContext): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: PLAN_SERVER, tools: [...planTools(ctx)] });
}
