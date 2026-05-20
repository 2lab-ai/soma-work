import type {
  SessionInstruction,
  SessionInstructionOperation,
  SessionResourceSnapshot,
  SessionResourceUpdateRequest,
} from './session-types';
export interface MemoryStore {
  addMemory(
    user: string,
    target: string,
    content: string,
  ): {
    ok: boolean;
    message: string;
  };
  replaceMemory(
    user: string,
    target: string,
    oldText: string,
    content: string,
  ): {
    ok: boolean;
    message: string;
  };
  removeMemory(
    user: string,
    target: string,
    oldText: string,
  ): {
    ok: boolean;
    message: string;
  };
  loadMemory(
    user: string,
    target: string,
  ): {
    entries: string[];
    charLimit: number;
    totalChars: number;
    percentUsed: number;
  };
}
/** Register the memory store implementation. Must be called before SAVE_MEMORY/GET_MEMORY commands. */
export declare function registerMemoryStore(store: MemoryStore): void;
export interface SkillStore {
  listSkills(user: string): Array<{
    name: string;
    description: string;
  }>;
  createSkill(
    user: string,
    name: string,
    content: string,
  ): {
    ok: boolean;
    message: string;
  };
  updateSkill(
    user: string,
    name: string,
    content: string,
  ): {
    ok: boolean;
    message: string;
  };
  deleteSkill(
    user: string,
    name: string,
  ): {
    ok: boolean;
    message: string;
  };
}
/** Register the skill store implementation. Must be called before MANAGE_SKILL commands. */
export declare function registerSkillStore(store: SkillStore): void;
export interface RatingStore {
  getUserRating(userId: string): number;
}
/** Register the rating store implementation. Must be called before RATE command. */
export declare function registerRatingStore(store: RatingStore): void;
import type {
  ModelCommandContext,
  ModelCommandDescriptor,
  ModelCommandError,
  ModelCommandRunRequest,
  ModelCommandRunResponse,
} from './types';
export declare function getDefaultSessionSnapshot(): SessionResourceSnapshot;
export declare function normalizeSessionSnapshot(
  snapshot: SessionResourceSnapshot | undefined,
): SessionResourceSnapshot;
export declare function listModelCommands(context: ModelCommandContext): ModelCommandDescriptor[];
export declare function applySessionUpdateToSnapshot(
  snapshot: SessionResourceSnapshot,
  request: SessionResourceUpdateRequest,
):
  | {
      ok: true;
      snapshot: SessionResourceSnapshot;
    }
  | {
      ok: false;
      error: ModelCommandError;
    };
export declare function runModelCommand(
  request: ModelCommandRunRequest,
  context: ModelCommandContext,
): ModelCommandRunResponse;
/**
 * Apply instruction operations (add/remove/clear) to a mutable instructions array.
 * Shared between catalog (snapshot) and session-registry (host-side).
 * Returns true if any mutation occurred.
 */
export declare function applyInstructionOperations(
  instructions: SessionInstruction[],
  ops: SessionInstructionOperation[] | undefined,
): boolean;
//# sourceMappingURL=catalog.d.ts.map
