// Broker state on disk (.prd/16-devops-tools-architecture.md §5, §6): approvals and leases survive a
// restart, so every write is atomic and every read-modify-write runs one at a time. State files can
// hold short-lived key values — errors name the file, never its contents.

import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function tempPath(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
}

/** fsync a directory, so a file created or renamed in it survives a crash. */
export async function syncDir(dir: string): Promise<void> {
  const handle = await fs.open(dir, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * The new file is in place (the rename happened) but the directory fsync after it failed, so whether
 * the replacement survives a crash is unknown. A StateStore that sees this stops accepting updates.
 */
export class StateDurabilityError extends Error {
  readonly file: string;

  constructor(file: string, problem: string, options?: { cause?: unknown }) {
    super(`${file}: ${problem}`, options);
    this.name = 'StateDurabilityError';
    this.file = file;
  }
}

function serialize(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new TypeError('value has no JSON form');
  return `${text}\n`;
}

/**
 * Same-directory temp file (exclusive, never through a symlink) → write → fsync → rename → fsync the
 * directory. A missing parent is created 0700. A failure before the rename removes the temp file and
 * leaves the old file as it was; a failure after it is a StateDurabilityError (the new file is in place).
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array, mode = FILE_MODE): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  const temp = tempPath(file);
  const handle = await fs.open(
    temp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    mode,
  );
  let renamed = false;
  try {
    try {
      await handle.chmod(mode);
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
    renamed = true;
  } finally {
    if (!renamed) await fs.rm(temp, { force: true }).catch(() => undefined);
  }
  try {
    await syncDir(dir);
  } catch (err) {
    const code = errorCode(err) ?? 'error';
    throw new StateDurabilityError(file, `replaced, but syncing its directory failed (${code})`, { cause: err });
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, serialize(value));
}

/** Runs tasks one at a time in submission order; a failed task does not stop the ones after it. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => fn());
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Temp files `writeFileAtomic` leaves behind when the process dies between create and rename. */
async function removeStaleTemps(file: string): Promise<void> {
  const dir = path.dirname(file);
  const base = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\.${base}\\.[0-9a-f]{12}\\.tmp$`);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return;
    throw err;
  }
  await Promise.all(
    names.filter((name) => pattern.test(name)).map((name) => fs.rm(path.join(dir, name), { force: true })),
  );
}

/**
 * One JSON document, read-modify-written through a queue. `update` hands the callback a copy and only
 * replaces the live value after that copy is on disk, so a failed callback or write leaves memory and
 * disk as they were. The live value is always what the file holds (a JSON round trip).
 *
 * Fail-stop: when a write lands but its directory fsync fails, the live value becomes the written one
 * (memory = disk), that update rejects with StateDurabilityError, and every later update rejects
 * without running its callback or writing, until the process restarts and `load()`s.
 */
export class StateStore<T> {
  private value: T;
  private readonly queue = new SerialQueue();
  private stopped: StateDurabilityError | null = null;

  constructor(
    private readonly file: string,
    initial: T,
  ) {
    this.value = structuredClone(initial);
  }

  /** Reads the file if it exists (otherwise keeps the initial value). Corrupt JSON is an error, not a reset. */
  load(): Promise<void> {
    return this.queue.run(async () => {
      await removeStaleTemps(this.file);
      let text: string;
      try {
        text = await fs.readFile(this.file, 'utf8');
      } catch (err) {
        if (errorCode(err) === 'ENOENT') return;
        throw err;
      }
      try {
        this.value = JSON.parse(text) as T;
      } catch {
        throw new Error(`state file ${this.file} is not valid JSON; refusing to start from an empty state`);
      }
    });
  }

  get(): T {
    return structuredClone(this.value);
  }

  update<R>(fn: (draft: T) => R | Promise<R>): Promise<R> {
    return this.queue.run(async () => {
      if (this.stopped !== null) {
        throw new StateDurabilityError(this.file, 'updates are stopped after an earlier durability failure; restart', {
          cause: this.stopped,
        });
      }
      const draft = structuredClone(this.value);
      const result = await fn(draft);
      const text = serialize(draft);
      try {
        await writeFileAtomic(this.file, text);
      } catch (err) {
        if (err instanceof StateDurabilityError) {
          this.value = JSON.parse(text) as T;
          this.stopped = err;
        }
        throw err;
      }
      this.value = JSON.parse(text) as T;
      return result;
    });
  }
}
