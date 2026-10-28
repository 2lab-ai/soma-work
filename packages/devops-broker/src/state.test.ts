import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SerialQueue, StateDurabilityError, StateStore, writeFileAtomic, writeJsonAtomic } from './state.js';

// Fault injection: a pass-through `open` whose handle's `sync` fails for the paths `failSync` picks.
const faults = vi.hoisted(() => ({ failSync: null as ((target: string) => boolean) | null, injected: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const open = async (...args: Parameters<typeof real.open>) => {
    const handle = await real.open(...args);
    if (faults.failSync?.(String(args[0]))) {
      Object.assign(handle, {
        sync: async () => {
          faults.injected += 1;
          throw Object.assign(new Error('EIO: injected sync failure'), { code: 'EIO' });
        },
      });
    }
    return handle;
  };
  return { ...real, open };
});

const MARKER = 'test-secret-0001';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devops-state-'));
  faults.failSync = null;
  faults.injected = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('writeJsonAtomic', () => {
  it('writes a 0600 file and leaves no temp files', async () => {
    const file = path.join(dir, 'state.json');
    await writeJsonAtomic(file, { a: 1 });
    await writeJsonAtomic(file, { a: 2 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 2 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['state.json']);
  });

  it('tightens a file that was looser before', async () => {
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    await writeJsonAtomic(file, { a: 1 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('creates a missing parent directory as 0700', async () => {
    const file = path.join(dir, 'nested', 'state.json');
    await writeJsonAtomic(file, []);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('rejects a value with no JSON form and writes nothing', async () => {
    const file = path.join(dir, 'state.json');
    await expect(writeJsonAtomic(file, undefined)).rejects.toThrow(TypeError);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('cleans up its temp file when the rename fails', async () => {
    const file = path.join(dir, 'state.json');
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, 'occupant'), 'x');
    await expect(writeJsonAtomic(file, { a: 1 })).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual(['state.json']);
  });

  it('replaces a symlink at the destination instead of writing through it', async () => {
    const target = path.join(dir, 'target.json');
    fs.writeFileSync(target, '"untouched"');
    const file = path.join(dir, 'state.json');
    fs.symlinkSync(target, file);
    await writeJsonAtomic(file, 1);
    expect(fs.readFileSync(target, 'utf8')).toBe('"untouched"');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
  });
});

describe('writeFileAtomic', () => {
  it('writes raw text with the requested mode', async () => {
    const file = path.join(dir, 'raw.txt');
    await writeFileAtomic(file, 'plain');
    expect(fs.readFileSync(file, 'utf8')).toBe('plain');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('SerialQueue', () => {
  it('runs tasks one at a time in submission order', async () => {
    const queue = new SerialQueue();
    const events: string[] = [];
    const task = (name: string, ms: number) => async () => {
      events.push(`start ${name}`);
      await delay(ms);
      events.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([queue.run(task('a', 20)), queue.run(task('b', 1)), queue.run(task('c', 5))]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('keeps going after a task rejects or throws synchronously', async () => {
    const queue = new SerialQueue();
    const failing = queue.run(async () => {
      throw new Error('boom');
    });
    const throwing = queue.run(() => {
      throw new Error('sync boom');
    });
    const next = queue.run(async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(throwing).rejects.toThrow('sync boom');
    await expect(next).resolves.toBe('ok');
  });
});

describe('StateStore', () => {
  it('serializes 50 parallel read-modify-write updates without losing one', async () => {
    const file = path.join(dir, 'counter.json');
    const store = new StateStore(file, { count: 0 });
    await store.load();
    await Promise.all(
      Array.from({ length: 50 }, () =>
        store.update(async (draft) => {
          const seen = draft.count;
          await delay(Math.random() * 3);
          draft.count = seen + 1;
        }),
      ),
    );
    expect(store.get().count).toBe(50);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ count: 50 });
    expect(fs.readdirSync(dir)).toEqual(['counter.json']);
  }, 15_000);

  it('returns the callback result and persists before resolving', async () => {
    const file = path.join(dir, 'state.json');
    const store = new StateStore(file, { items: [] as string[] });
    const result = await store.update((draft) => {
      draft.items.push('x');
      return draft.items.length;
    });
    expect(result).toBe(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ items: ['x'] });
  });

  it('hands out deep copies', async () => {
    const store = new StateStore(path.join(dir, 'state.json'), { items: ['a'] });
    store.get().items.push('mutated');
    let kept: { items: string[] } | undefined;
    await store.update((draft) => {
      kept = draft;
    });
    kept?.items.push('late');
    expect(store.get()).toEqual({ items: ['a'] });
  });

  it('leaves state untouched when the callback throws', async () => {
    const file = path.join(dir, 'state.json');
    const store = new StateStore(file, { count: 0 });
    await store.update((draft) => {
      draft.count = 1;
    });
    await expect(
      store.update((draft) => {
        draft.count = 99;
        throw new Error('callback failed');
      }),
    ).rejects.toThrow('callback failed');
    expect(store.get().count).toBe(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ count: 1 });
    await store.update((draft) => {
      draft.count += 1;
    });
    expect(store.get().count).toBe(2);
  });

  // ENOTDIR fails for every uid, root included, unlike a chmod-based trick.
  it('rolls the in-memory value back when persisting fails', async () => {
    const stateDir = path.join(dir, 'state');
    const store = new StateStore(path.join(stateDir, 'state.json'), { count: 0 });
    await store.update((draft) => {
      draft.count = 1;
    });
    fs.rmSync(stateDir, { recursive: true });
    fs.writeFileSync(stateDir, 'not a directory');
    await expect(
      store.update((draft) => {
        draft.count = 2;
        return 'unreached';
      }),
    ).rejects.toThrow();
    expect(store.get().count).toBe(1);
    fs.rmSync(stateDir);
    await store.update((draft) => {
      draft.count += 10;
    });
    expect(store.get().count).toBe(11);
  });

  it('survives a reload', async () => {
    const file = path.join(dir, 'state.json');
    const first = new StateStore(file, { leases: {} as Record<string, string> });
    await first.update((draft) => {
      draft.leases.a = 'active';
    });
    const second = new StateStore(file, { leases: {} as Record<string, string> });
    expect(second.get()).toEqual({ leases: {} });
    await second.load();
    expect(second.get()).toEqual({ leases: { a: 'active' } });
  });

  it('keeps the initial value when there is no file yet', async () => {
    const store = new StateStore(path.join(dir, 'absent.json'), { count: 7 });
    await store.load();
    expect(store.get()).toEqual({ count: 7 });
    expect(fs.existsSync(path.join(dir, 'absent.json'))).toBe(false);
  });

  it('refuses corrupt JSON without quoting it and without resetting', async () => {
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, `{"token": "${MARKER}"`, { mode: 0o600 });
    const store = new StateStore(file, { count: 0 });
    const err = await store.load().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/not valid JSON/);
    expect(err?.message).not.toContain(MARKER);
    expect(fs.readFileSync(file, 'utf8')).toBe(`{"token": "${MARKER}"`);
  });

  it('removes its own temp files left by a crash on load, and only those', async () => {
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(path.join(dir, '.state.json.0123456789ab.tmp'), 'partial');
    fs.writeFileSync(path.join(dir, '.state.json.extra.0123456789ab.tmp'), 'other store');
    fs.writeFileSync(path.join(dir, 'unrelated.tmp'), 'keep');
    await new StateStore(file, {}).load();
    expect(fs.readdirSync(dir).sort()).toEqual(['.state.json.extra.0123456789ab.tmp', 'unrelated.tmp']);
  });
});

describe('durability failures', () => {
  const isDir = (target: string) => target === dir;
  const isTemp = (target: string) => path.basename(target).startsWith('.state.json.');

  it('writeFileAtomic: a directory fsync failure after the rename is a StateDurabilityError and the file is new', async () => {
    const file = path.join(dir, 'state.json');
    await writeJsonAtomic(file, { a: 1 });
    faults.failSync = isDir;
    const err = await writeJsonAtomic(file, { a: 2 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(faults.injected).toBe(1);
    expect(err).toBeInstanceOf(StateDurabilityError);
    expect((err as StateDurabilityError).file).toBe(file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 2 });
    expect(fs.readdirSync(dir)).toEqual(['state.json']);
  });

  it('a directory fsync failure after the rename: memory = disk, typed rejection, then fail-stop', async () => {
    const file = path.join(dir, 'state.json');
    const store = new StateStore(file, { count: 0 });
    await store.update((draft) => {
      draft.count = 1;
    });

    faults.failSync = isDir;
    const failing = store.update((draft) => {
      draft.count = 2;
      return 'unreached';
    });
    let queuedRan = false;
    const queued = store.update((draft) => {
      queuedRan = true;
      draft.count = 3;
    });
    await expect(failing).rejects.toBeInstanceOf(StateDurabilityError);
    await expect(queued).rejects.toBeInstanceOf(StateDurabilityError);
    faults.failSync = null;
    expect(faults.injected).toBe(1);
    expect(queuedRan).toBe(false);

    // The rename happened: the new document is on disk, and memory says the same.
    const onDisk = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(onDisk)).toEqual({ count: 2 });
    expect(store.get()).toEqual({ count: 2 });

    // Poisoned: later updates reject without running the callback or touching the file.
    const before = fs.statSync(file);
    let laterRan = false;
    await expect(
      store.update((draft) => {
        laterRan = true;
        draft.count = 4;
      }),
    ).rejects.toBeInstanceOf(StateDurabilityError);
    expect(laterRan).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(onDisk);
    expect(fs.statSync(file).ino).toBe(before.ino);
    expect(fs.readdirSync(dir)).toEqual(['state.json']);
    expect(store.get()).toEqual({ count: 2 });

    // A restarted broker loads what was written and can update again.
    const fresh = new StateStore(file, { count: 0 });
    await fresh.load();
    expect(fresh.get()).toEqual({ count: 2 });
    await fresh.update((draft) => {
      draft.count += 1;
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ count: 3 });
  });

  it('a temp-file fsync failure before the rename: memory and disk unchanged, temp removed, store keeps working', async () => {
    const file = path.join(dir, 'state.json');
    const store = new StateStore(file, { count: 0 });
    await store.update((draft) => {
      draft.count = 1;
    });

    faults.failSync = isTemp;
    const err = await store
      .update((draft) => {
        draft.count = 2;
      })
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    faults.failSync = null;
    expect(faults.injected).toBe(1);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(StateDurabilityError);
    expect(store.get()).toEqual({ count: 1 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ count: 1 });
    expect(fs.readdirSync(dir)).toEqual(['state.json']);

    await store.update((draft) => {
      draft.count += 10;
    });
    expect(store.get()).toEqual({ count: 11 });
  });
});
