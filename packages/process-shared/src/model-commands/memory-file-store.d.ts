import type { MemoryStore } from './catalog';
export declare class MemoryFileStore implements MemoryStore {
  private readonly dataDir;
  constructor(dataDir: string);
  private filePath;
  private charLimit;
  private readEntries;
  private writeEntries;
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
//# sourceMappingURL=memory-file-store.d.ts.map
