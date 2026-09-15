import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DATA_DIR } from '@soma/common/env-paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FollowupItem, FollowupQueue, type FollowupQueueSnapshot } from '../followup-queue';
import { FollowupQueueStore, parseFollowupQueueSnapshot } from '../followup-queue-store';
import type { MessageEvent } from '../pipeline/types';

/**
 * Contract tests for the durable side of the follow-up queue (U2b of
 * `.prd/slack-agent-ui`).
 *
 * Everything runs against a real temp directory: the failure modes that matter
 * here (truncated live file, healthy `.bak`, unwritable directory) are
 * filesystem behaviour, and a mocked `fs` would only test the mock. The store
 * is also the trust boundary for *untrusted persisted JSON* — a file that was
 * hand-edited, half-written by a crash, or produced by an older schema — so the
 * bulk of the cases below write bytes to disk directly and assert the loader
 * fails closed instead of quietly repairing them.
 */

const SESSION = 'C1:1700.000000';

function message(over: Partial<MessageEvent> = {}): MessageEvent {
  return { user: 'U1', channel: 'C1', ts: '1700.000100', text: '진행중인거 알려줘?', ...over };
}

/**
 * A valid item. `id` and `eventKey` are DERIVED from sessionKey/seq/message so
 * fixtures are self-consistent by construction; the negative cases below break
 * one derived field on purpose by passing it explicitly.
 */
function item(over: Partial<FollowupItem> = {}): FollowupItem {
  const sessionKey = over.sessionKey ?? SESSION;
  const seq = over.seq ?? 1;
  const payload = over.message ?? message({ ts: `1700.00010${seq}` });
  return {
    id: `${sessionKey}#${seq}`,
    sessionKey,
    seq,
    epoch: 0,
    state: 'queued',
    eventKey: `${payload.channel}:${payload.ts}`,
    message: payload,
    context: { workingDirectory: '/repo' },
    enqueuedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

/**
 * `turnEpoch` is typed loosely on purpose: the store must REJECT the on-disk
 * shapes the domain type cannot even express (`undefined`, `'3'`, `2.5`). The
 * field is required in the persisted schema — this format has never shipped, so
 * a file without it is broken, not legacy.
 */
type SessionOverrides = Partial<Omit<FollowupQueueSnapshot['sessions'][number], 'turnEpoch'>> & { turnEpoch?: unknown };

function snapshot(items: FollowupItem[], over: SessionOverrides = {}): FollowupQueueSnapshot {
  const maxSeq = items.reduce((max, candidate) => Math.max(max, candidate.seq), 0);
  const session = { sessionKey: SESSION, nextSeq: maxSeq + 1, turnEpoch: 0, items, ...over };
  return { version: 1, sessions: [session as FollowupQueueSnapshot['sessions'][number]] };
}

function collectWarnings() {
  const warnings: string[] = [];
  return {
    warnings,
    warn: (msg: string) => {
      warnings.push(msg);
    },
  };
}

describe('FollowupQueueStore', () => {
  let dir: string;
  let file: string;
  let backup: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-followup-store-'));
    file = path.join(dir, 'followup-queue.json');
    backup = `${file}.bak`;
  });

  afterEach(() => {
    // Only ever removes the directory this test created.
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write raw bytes to the live file, bypassing the store (simulates tampering/crash). */
  function writeLive(contents: unknown): void {
    fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf-8');
  }

  function store(warn?: (msg: string) => void): FollowupQueueStore {
    return new FollowupQueueStore({ path: file, warn });
  }

  describe('path resolution', () => {
    it('defaults to the single DATA_DIR path source', () => {
      expect(new FollowupQueueStore().path).toBe(path.join(DATA_DIR, 'followup-queue.json'));
    });

    it('is not a singleton — each instance owns its own file', () => {
      const other = path.join(dir, 'other.json');
      const a = new FollowupQueueStore({ path: file });
      const b = new FollowupQueueStore({ path: other });

      a.save(snapshot([item({ seq: 1 })]));
      b.save(snapshot([item({ seq: 2, message: message({ ts: '1700.000200' }) })]));

      expect(a.load()?.sessions[0].items[0].seq).toBe(1);
      expect(b.load()?.sessions[0].items[0].seq).toBe(2);
    });

    it('does not touch the filesystem in the constructor', () => {
      new FollowupQueueStore({ path: file });

      expect(fs.readdirSync(dir)).toEqual([]);
    });
  });

  describe('load', () => {
    it('returns undefined only for a genuinely new store (no live, no backup)', () => {
      const { warn, warnings } = collectWarnings();

      expect(store(warn).load()).toBeUndefined();
      expect(warnings).toEqual([]);
    });

    it('round-trips the raw Slack payload verbatim (text, files, team, routeContext) and the context', () => {
      const raw = message({
        team: 'T123',
        thread_ts: '1700.000000',
        text: '이 파일 봐줘',
        synthetic: false,
        inlineDirectiveRawText: '%model opus 이 파일 봐줘',
        routeContext: { sourceChannel: 'C9', goalContinuation: true },
        files: [
          {
            id: 'F1',
            name: 'log.txt',
            mimetype: 'text/plain',
            filetype: 'text',
            url_private: 'https://files.slack.com/p',
            url_private_download: 'https://files.slack.com/d',
            size: 42,
          },
        ],
      });
      const original = snapshot([item({ message: raw })], {
        freeze: { reason: 'process restart', at: 1_700_000_001_000 },
      });

      store().save(original);

      expect(store().load()).toEqual(original);
    });

    it('accepts a full history of settled states', () => {
      const original = snapshot([
        item({ seq: 1, message: message({ ts: '1.1' }), state: 'resolved', epoch: 3 }),
        item({ seq: 2, message: message({ ts: '1.2' }), state: 'failed', epoch: 2, stateReason: 'executor error' }),
        item({ seq: 3, message: message({ ts: '1.3' }), state: 'paused', epoch: 1, stateReason: 'stop' }),
        item({ seq: 4, message: message({ ts: '1.4' }), state: 'uncertain', epoch: 4, stateReason: 'process restart' }),
        item({ seq: 5, message: message({ ts: '1.5' }), state: 'cancelled', epoch: 1 }),
      ]);

      store().save(original);

      expect(store().load()).toEqual(original);
    });

    it('accepts a dispatched item alongside a Send-now reservation (A12)', () => {
      const original = snapshot([
        item({ seq: 1, message: message({ ts: '1.1' }), state: 'dispatched', epoch: 2 }),
        item({ seq: 2, message: message({ ts: '1.2' }), state: 'reserved', epoch: 1 }),
      ]);

      store().save(original);

      expect(store().load()).toEqual(original);
    });

    it('round-trips the per-session turnEpoch', () => {
      const original = snapshot([item()], { turnEpoch: 7 });

      store().save(original);

      expect(store().load()).toEqual(original);
    });

    it('accepts an item with no files field', () => {
      const original = snapshot([item({ message: { user: 'U1', channel: 'C1', ts: '1700.000100' } })]);

      store().save(original);

      expect(store().load()?.sessions[0].items[0].message.files).toBeUndefined();
    });

    it('restores stored states as-is — recovery is the caller’s explicit step, never the loader’s', () => {
      store().save(
        snapshot([
          item({ state: 'dispatched', epoch: 2 }),
          item({ seq: 2, message: message({ ts: '1.2' }), state: 'queued' }),
        ]),
      );

      const loaded = store().load();

      expect(loaded?.sessions[0].items.map((entry) => entry.state)).toEqual(['dispatched', 'queued']);
      expect(loaded?.sessions[0].freeze).toBeUndefined();
    });

    it('falls back to the healthy backup with a WARN when the live file is truncated', () => {
      const good = snapshot([item({ seq: 1, message: message({ ts: '1.1' }) })]);
      const newer = snapshot([
        item({ seq: 1, message: message({ ts: '1.1' }) }),
        item({ seq: 2, message: message({ ts: '1.2' }) }),
      ]);
      store().save(good);
      store().save(newer); // .bak = good
      writeLive('{"version": 1, "sessions": [');
      const { warn, warnings } = collectWarnings();

      expect(store(warn).load()).toEqual(good);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(file);
    });

    it('falls back to the backup when the live file parses but violates the schema', () => {
      const good = snapshot([item()]);
      store().save(good);
      store().save(snapshot([item({ seq: 1 }), item({ seq: 2, message: message({ ts: '1.2' }) })])); // .bak = good
      writeLive({
        version: 1,
        sessions: [{ sessionKey: SESSION, nextSeq: 2, turnEpoch: 0, items: [item({ state: 'exploded' as never })] }],
      });
      const { warn, warnings } = collectWarnings();

      expect(store(warn).load()).toEqual(good);
      expect(warnings).toHaveLength(1);
    });

    it('does not repair the live file on read (read never writes)', () => {
      store().save(snapshot([item()]));
      store().save(snapshot([item(), item({ seq: 2, message: message({ ts: '1.2' }) })]));
      writeLive('garbage');
      const { warn } = collectWarnings();

      store(warn).load();

      expect(fs.readFileSync(file, 'utf-8')).toBe('garbage');
    });

    it('throws instead of reporting an empty queue when live and backup are both unusable', () => {
      store().save(snapshot([item()]));
      store().save(snapshot([item(), item({ seq: 2, message: message({ ts: '1.2' }) })]));
      writeLive('garbage');
      fs.writeFileSync(backup, 'also garbage', 'utf-8');
      const { warn } = collectWarnings();

      expect(() => store(warn).load()).toThrow(/unusable|refusing/i);
    });

    it('throws when the live file is corrupt and no backup exists', () => {
      writeLive('garbage');

      expect(() => store(collectWarnings().warn).load()).toThrow();
    });
  });

  describe('fail-closed validation of untrusted persisted JSON', () => {
    /** `[what is broken, the bytes on disk, the reason the loader must give]`. */
    const rejected: Array<[string, unknown, string]> = [
      ['not an object', '"nope"', 'snapshot is not an object'],
      ['unknown schema version', { version: 2, sessions: [] }, 'snapshot.version is not 1'],
      ['sessions not an array', { version: 1, sessions: {} }, 'snapshot.sessions is not an array'],
      [
        'session key empty',
        { version: 1, sessions: [{ sessionKey: '', nextSeq: 1, items: [] }] },
        'sessions[0].sessionKey is not a non-empty string',
      ],
      [
        'duplicate session keys',
        {
          version: 1,
          sessions: [
            { sessionKey: SESSION, nextSeq: 1, turnEpoch: 0, items: [] },
            { sessionKey: SESSION, nextSeq: 1, turnEpoch: 0, items: [] },
          ],
        },
        'sessions[1].sessionKey is a duplicate',
      ],
      [
        'freeze without a reason',
        snapshot([item()], { freeze: { at: 1 } as never }),
        'freeze.reason is not a non-empty string',
      ],
      [
        'freeze timestamp not finite',
        snapshot([item()], { freeze: { reason: 'stop', at: Number.NaN } as never }),
        'freeze.at is not a non-negative finite number',
      ],
      ['unknown item state', snapshot([item({ state: 'exploded' as never })]), 'items[0].state is not one of'],
      ['negative epoch', snapshot([item({ epoch: -1 })]), 'items[0].epoch is not a safe integer >= 0'],
      ['non-integer epoch', snapshot([item({ epoch: 1.5 })]), 'items[0].epoch is not a safe integer >= 0'],
      ['seq below 1', snapshot([item({ seq: 0, id: `${SESSION}#0` })]), 'items[0].seq is not a safe integer >= 1'],
      [
        'nextSeq colliding with an existing seq',
        snapshot([item({ seq: 2, id: `${SESSION}#2` })], { nextSeq: 2 }),
        'nextSeq (2) collides with an existing seq',
      ],
      [
        'nextSeq below an existing seq',
        snapshot([item({ seq: 5, id: `${SESSION}#5` })], { nextSeq: 3 }),
        'nextSeq (3) collides with an existing seq',
      ],
      [
        'negative timestamp',
        snapshot([item({ enqueuedAt: -1 })]),
        'items[0].enqueuedAt is not a non-negative finite number',
      ],
      [
        'non-finite timestamp',
        snapshot([item({ updatedAt: Number.POSITIVE_INFINITY })]),
        'items[0].updatedAt is not a non-negative finite number',
      ],
      [
        'duplicate item id',
        snapshot([item({ seq: 1 }), item({ seq: 1, message: message({ ts: '1.2' }) })], { nextSeq: 2 }),
        'items[1].id is a duplicate',
      ],
      [
        // A reused seq hidden behind a hand-edited id: the identity rule catches
        // it before the duplicate-seq check ever sees two rows.
        'a duplicate seq behind a tampered id',
        snapshot([item({ seq: 1 }), item({ seq: 1, id: `${SESSION}#1-dup`, message: message({ ts: '1.2' }) })], {
          nextSeq: 2,
        }),
        'items[1].id is not "<sessionKey>#<seq>"',
      ],
      // Same Slack event stored twice: the A3 dedup key is already broken on
      // disk, and replaying both is the double-answer this queue exists to stop.
      [
        'duplicate event key',
        snapshot([item({ seq: 1 }), item({ seq: 2, id: `${SESSION}#2`, message: message({ ts: '1700.000101' }) })]),
        'items[1].eventKey is a duplicate',
      ],
      [
        'id inconsistent with sessionKey#seq',
        snapshot([item({ id: 'C9:0#7' })]),
        'items[0].id is not "<sessionKey>#<seq>"',
      ],
      [
        'item sessionKey not matching its session',
        snapshot([item({ sessionKey: 'C9:1.1', id: `${SESSION}#1` })]),
        'items[0].sessionKey does not match its session',
      ],
      [
        'event key not matching channel:ts',
        snapshot([item({ eventKey: 'C9:9.9' })]),
        'items[0].eventKey does not match its message channel:ts',
      ],
      [
        'two items setting up a dispatch at once',
        snapshot([
          item({ seq: 1, state: 'reserved' }),
          item({ seq: 2, id: `${SESSION}#2`, message: message({ ts: '1.2' }), state: 'claimed' }),
        ]),
        'items has 2 items in reserved/claimed',
      ],
      // markDispatched enforces a single in-flight turn; two on disk means a
      // skewed or hand-edited file, and replaying both double-answers the user.
      [
        'two dispatched turns at once',
        snapshot([
          item({ seq: 1, state: 'dispatched' }),
          item({ seq: 2, id: `${SESSION}#2`, message: message({ ts: '1.2' }), state: 'dispatched' }),
        ]),
        'items has 2 items in dispatched',
      ],
      // Required, not optional: `FollowupQueue`'s own constructor rejects a
      // restored session whose turnEpoch is not an integer
      // (`followup-queue.ts:221-223`), and this format has never shipped, so a
      // missing field is a broken file — not a legacy generation to migrate.
      [
        'session with no turnEpoch',
        snapshot([item()], { turnEpoch: undefined }),
        'turnEpoch is not a safe integer >= 0',
      ],
      ['negative turnEpoch', snapshot([item()], { turnEpoch: -1 }), 'turnEpoch is not a safe integer >= 0'],
      ['non-integer turnEpoch', snapshot([item()], { turnEpoch: 2.5 }), 'turnEpoch is not a safe integer >= 0'],
      ['turnEpoch not a number', snapshot([item()], { turnEpoch: '3' }), 'turnEpoch is not a safe integer >= 0'],
      [
        'message user missing',
        snapshot([item({ message: { channel: 'C1', ts: '1700.000100' } as never })]),
        'message.user is not a non-empty string',
      ],
      [
        'message channel empty',
        snapshot([item({ message: message({ channel: '' }) })]),
        'message.channel is not a non-empty string',
      ],
      [
        'message ts not a string',
        snapshot([item({ message: message({ ts: 1700 as never }) })]),
        'message.ts is not a non-empty string',
      ],
      [
        'message text not a string',
        snapshot([item({ message: message({ text: 42 as never }) })]),
        'message.text is not a string',
      ],
      [
        'message team not a string',
        snapshot([item({ message: message({ team: 7 as never }) })]),
        'message.team is not a string',
      ],
      [
        'files not an array',
        snapshot([item({ message: message({ files: {} as never }) })]),
        'message.files is not an array',
      ],
      [
        'file entry with a non-string name',
        snapshot([
          item({
            message: message({
              files: [
                {
                  id: 'F1',
                  name: 7 as never,
                  mimetype: 'text/plain',
                  filetype: 'text',
                  url_private: 'u',
                  url_private_download: 'd',
                  size: 1,
                },
              ],
            }),
          }),
        ]),
        'message.files[0].name is not a non-empty string',
      ],
      [
        'file entry with a non-numeric size',
        snapshot([
          item({
            message: message({
              files: [
                {
                  id: 'F1',
                  name: 'log.txt',
                  mimetype: 'text/plain',
                  filetype: 'text',
                  url_private: 'u',
                  url_private_download: 'd',
                  size: '42' as never,
                },
              ],
            }),
          }),
        ]),
        'message.files[0].size is not a finite number',
      ],
      ['context not an object', snapshot([item({ context: 'cwd' as never })]), 'items[0].context is not an object'],
      [
        'context workingDirectory not a string',
        snapshot([item({ context: { workingDirectory: 3 as never } })]),
        'context.workingDirectory is not a string',
      ],
      [
        'stateReason not a string',
        snapshot([item({ stateReason: 5 as never })]),
        'items[0].stateReason is not a string',
      ],
    ];

    it.each(rejected)('rejects %s rather than repairing it', (_label, payload, reason) => {
      // The reason is asserted, not just the throw: a validator that rejected
      // everything (or rejected the right file for the wrong field) would still
      // pass a bare `toThrow()`.
      expect(() => parseFollowupQueueSnapshot(typeof payload === 'string' ? JSON.parse(payload) : payload)).toThrow(
        reason,
      );

      writeLive(payload);
      expect(() => store(collectWarnings().warn).load()).toThrow(reason);
    });

    it('refuses to persist a snapshot it would refuse to load', () => {
      const bad = snapshot([item({ state: 'exploded' as never })]);

      expect(() => store().save(bad)).toThrow();
      expect(fs.existsSync(file)).toBe(false);
    });

    it('leaves a previously good live file untouched when an invalid save is rejected', () => {
      const good = snapshot([item()]);
      store().save(good);

      expect(() => store().save(snapshot([item({ epoch: -3 })]))).toThrow();
      expect(store().load()).toEqual(good);
    });
  });

  describe('save', () => {
    it('never lets a corrupt live file displace a healthy backup', () => {
      const v1 = snapshot([item({ seq: 1, message: message({ ts: '1.1' }) })]);
      const v2 = snapshot([
        item({ seq: 1, message: message({ ts: '1.1' }) }),
        item({ seq: 2, message: message({ ts: '1.2' }) }),
      ]);
      store().save(v1);
      store().save(v2); // .bak = v1
      // A crash leaves the live file parseable but schema-broken.
      writeLive({
        version: 1,
        sessions: [{ sessionKey: SESSION, nextSeq: 1, turnEpoch: 0, items: [item({ epoch: -9 })] }],
      });
      const { warn, warnings } = collectWarnings();

      const v3 = snapshot([
        item({ seq: 1, message: message({ ts: '1.1' }) }),
        item({ seq: 3, message: message({ ts: '1.3' }) }),
      ]);
      new FollowupQueueStore({ path: file, warn }).save(v3);

      expect(parseFollowupQueueSnapshot(JSON.parse(fs.readFileSync(backup, 'utf-8')))).toEqual(v1);
      expect(store().load()).toEqual(v3);
      expect(warnings).toHaveLength(1);
    });

    it('promotes the previous healthy live file to the backup', () => {
      const v1 = snapshot([item({ seq: 1, message: message({ ts: '1.1' }) })]);
      const v2 = snapshot([
        item({ seq: 1, message: message({ ts: '1.1' }) }),
        item({ seq: 2, message: message({ ts: '1.2' }) }),
      ]);

      store().save(v1);
      store().save(v2);

      expect(parseFollowupQueueSnapshot(JSON.parse(fs.readFileSync(backup, 'utf-8')))).toEqual(v1);
    });

    it('throws when the directory cannot be written', () => {
      fs.chmodSync(dir, 0o500);

      expect(() => store().save(snapshot([item()]))).toThrow();
    });
  });

  /**
   * A `.bak` fallback is a *generation rollback*: by contract the backup holds
   * the state before the last committed write, so the newest enqueue is gone.
   * The user was already told "Queue"-ed, so the UI must be able to say why one
   * message is missing (A16) — hence a reason the host can render, not just a
   * line in the server log.
   */
  describe('recovery warning', () => {
    function rollbackState(): { good: FollowupQueueSnapshot } {
      const good = snapshot([item({ seq: 1, message: message({ ts: '1.1' }) })]);
      const newer = snapshot([
        item({ seq: 1, message: message({ ts: '1.1' }) }),
        item({ seq: 2, message: message({ ts: '1.2' }) }),
      ]);
      store().save(good);
      store().save(newer); // .bak = good
      writeLive('{"version": 1, "sessions": [');
      return { good };
    }

    it('is undefined before any load and after a clean load', () => {
      store().save(snapshot([item()]));
      const reader = store();

      expect(reader.recoveryWarning).toBeUndefined();
      reader.load();
      expect(reader.recoveryWarning).toBeUndefined();
    });

    it('is undefined for a genuinely new store', () => {
      const reader = store();

      reader.load();

      expect(reader.recoveryWarning).toBeUndefined();
    });

    it('names the rolled-back file after a .bak fallback, and still calls the user sink', () => {
      rollbackState();
      const { warn, warnings } = collectWarnings();
      const reader = store(warn);

      reader.load();

      expect(reader.recoveryWarning).toContain(file);
      expect(reader.recoveryWarning).toContain('.bak');
      expect(warnings).toEqual([reader.recoveryWarning]);
    });

    it('resets on the next load rather than sticking to a repaired store', () => {
      rollbackState();
      const reader = store(collectWarnings().warn);
      reader.load();
      expect(reader.recoveryWarning).toBeDefined();

      store().save(snapshot([item()])); // operator restored a healthy live file
      reader.load();

      expect(reader.recoveryWarning).toBeUndefined();
    });

    it('is load-scoped — a save-time backup rejection does not masquerade as a recovery', () => {
      store().save(snapshot([item()]));
      writeLive({
        version: 1,
        sessions: [{ sessionKey: SESSION, nextSeq: 1, turnEpoch: 0, items: [item({ epoch: -9 })] }],
      });
      const reader = store(collectWarnings().warn);

      reader.save(snapshot([item({ seq: 2, message: message({ ts: '1.2' }) })]));

      expect(reader.recoveryWarning).toBeUndefined();
    });

    it('surfaces the enqueue that the generation rollback dropped (A16)', () => {
      const live = store();
      const queue = new FollowupQueue({ save: (state) => live.save(state) });
      queue.enqueue(SESSION, message({ ts: '1.1' }));
      queue.enqueue(SESSION, message({ ts: '1.2' })); // committed to live, .bak still holds only 1.1
      writeLive('{"version": 1, "sessions": [');
      const { warn, warnings } = collectWarnings();
      const reopened = store(warn);

      const restored = reopened.load();

      // The second message is genuinely gone — the point is that the loss is
      // reported, not repaired and not silently rendered as an empty queue.
      expect(restored?.sessions[0].items.map((entry) => entry.message.ts)).toEqual(['1.1']);
      expect(reopened.recoveryWarning).toContain(file);
      expect(warnings).toHaveLength(1);
    });
  });

  describe('wired to FollowupQueue', () => {
    function queueOn(target: FollowupQueueStore, restored?: FollowupQueueSnapshot): FollowupQueue {
      return new FollowupQueue({ save: (state) => target.save(state), snapshot: restored });
    }

    it('survives a restart: reload + explicit recover() persists paused/uncertain (A16, A21)', () => {
      const live = store();
      const queue = queueOn(live);
      queue.enqueue(SESSION, message({ ts: '1.1' }), { workingDirectory: '/repo' });
      queue.enqueue(SESSION, message({ ts: '1.2' }));
      const claimed = queue.claimNext(SESSION);
      if (!claimed.ok) throw new Error(`claim failed: ${claimed.reason}`);
      queue.markDispatched(SESSION, claimed.item.id, claimed.item.epoch);

      // Process restart: a brand-new store and queue, then the host's explicit recover().
      const reopened = store();
      const restoredSnapshot = reopened.load();
      expect(restoredSnapshot).toBeDefined();
      const restarted = queueOn(reopened, restoredSnapshot);
      restarted.recover('process restart');

      expect(restarted.list(SESSION).map((entry) => entry.state)).toEqual(['uncertain', 'paused']);
      expect(restarted.freezeReason(SESSION)).toBe('process restart');
      // The recovery itself was committed durably, so a second restart sees it.
      const afterRecovery = store().load();
      expect(afterRecovery?.sessions[0].items.map((entry) => entry.state)).toEqual(['uncertain', 'paused']);
      expect(afterRecovery?.sessions[0].freeze?.reason).toBe('process restart');
      expect(afterRecovery?.sessions[0].items[0].message.text).toBe('진행중인거 알려줘?');
    });

    it('leaves queue memory unchanged when the durable sink throws', () => {
      const live = store();
      const queue = queueOn(live);
      queue.enqueue(SESSION, message({ ts: '1.1' }));
      const before = queue.snapshot();
      fs.chmodSync(dir, 0o500); // the next write cannot land

      expect(() => queue.enqueue(SESSION, message({ ts: '1.2' }))).toThrow();

      fs.chmodSync(dir, 0o700);
      expect(queue.snapshot()).toEqual(before);
      expect(queue.list(SESSION)).toHaveLength(1);
      expect(store().load()).toEqual(before);
    });
  });
});
