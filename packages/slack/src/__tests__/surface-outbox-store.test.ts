import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DATA_DIR } from '@soma/common/env-paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DeliveryIntentRecord,
  parseSurfaceOutboxSnapshot,
  type SurfaceOutboxSnapshot,
  SurfaceOutboxStore,
  threadPanelSurfaceKey,
} from '../surface-outbox-store';

/**
 * Contract tests for the A24a delivery-intent store.
 *
 * The hazard under test is the ack-before-persist window in
 * `thread-surface.ts:867-873`: the panel message is posted to Slack at :867 and
 * the returned `ts` is only ever written to *memory* at :873. A process that
 * dies in between has delivered a card it has no record of, and the next render
 * posts a second one. Every case below is about that window, so everything runs
 * against a real temp directory — the failure modes are filesystem behaviour
 * (crash between write and ack, truncated live file, healthy `.bak`, unwritable
 * directory) and a mocked `fs` would only test the mock.
 *
 * The store is also the trust boundary for *untrusted persisted JSON*, so the
 * validation block writes bytes to disk directly and asserts the loader fails
 * closed instead of quietly repairing them.
 */

const SESSION = 'C1:1700.000000';
const SURFACE = `${SESSION}::thread-panel`;
const CHANNEL = 'C1';
const THREAD_TS = '1700.000000';

function address(over: { sessionKey?: string; channelId?: string; threadTs?: string } = {}) {
  return { sessionKey: SESSION, channelId: CHANNEL, threadTs: THREAD_TS, ...over };
}

/**
 * A valid record. `surfaceKey` is DERIVED from `sessionKey` so fixtures are
 * self-consistent by construction; the negative cases below break one derived
 * field on purpose by passing it explicitly.
 */
function record(over: Partial<DeliveryIntentRecord> = {}): DeliveryIntentRecord {
  const sessionKey = over.sessionKey ?? SESSION;
  return {
    surfaceKey: `${sessionKey}::thread-panel`,
    sessionKey,
    channelId: CHANNEL,
    threadTs: THREAD_TS,
    intentId: '11111111-1111-4111-8111-111111111111',
    state: 'pending',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

function snapshot(records: DeliveryIntentRecord[]): SurfaceOutboxSnapshot {
  return { version: 1, records };
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

describe('SurfaceOutboxStore', () => {
  let dir: string;
  let file: string;
  let backup: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-surface-outbox-'));
    file = path.join(dir, 'surface-outbox.json');
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

  function store(warn?: (msg: string) => void, now?: () => number): SurfaceOutboxStore {
    return new SurfaceOutboxStore({ path: file, warn, now });
  }

  /** A loaded store — the only legal starting state for the delivery API. */
  function opened(warn?: (msg: string) => void, now?: () => number): SurfaceOutboxStore {
    const instance = store(warn, now);
    instance.load();
    return instance;
  }

  describe('path and lifecycle', () => {
    it('defaults to the single DATA_DIR path source', () => {
      expect(new SurfaceOutboxStore().path).toBe(path.join(DATA_DIR, 'surface-outbox.json'));
    });

    it('does not touch the filesystem in the constructor', () => {
      new SurfaceOutboxStore({ path: file });

      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('refuses every delivery operation until load() has succeeded', () => {
      const unopened = store();

      expect(() => unopened.get(SURFACE)).toThrow(/load\(\)/);
      expect(() => unopened.beginPost(address())).toThrow(/load\(\)/);
      expect(() => unopened.markSent(SURFACE, 'i1', '1.1')).toThrow(/load\(\)/);
      expect(() => unopened.markRejected(SURFACE, 'i1', 'channel_not_found')).toThrow(/load\(\)/);
      expect(() => unopened.markDeleted(SURFACE, 'i1', '1.1')).toThrow(/load\(\)/);
    });

    it('stays unloaded — and therefore closed — when live and backup are both unusable', () => {
      writeLive('garbage');
      fs.writeFileSync(backup, 'also garbage', 'utf-8');
      const unopened = store(collectWarnings().warn);

      expect(() => unopened.load()).toThrow(/unusable|refusing/i);
      // Fail closed: a store that could not read its state must not hand out
      // "no record here, go ahead and post".
      expect(() => unopened.beginPost(address())).toThrow(/load\(\)/);
    });

    it('throws rather than reporting an empty outbox when the live file is corrupt and no backup exists', () => {
      writeLive('garbage');

      expect(() => store(collectWarnings().warn).load()).toThrow();
    });

    it('is a genuinely new store when neither file exists, and allows a first post', () => {
      const { warn, warnings } = collectWarnings();
      const outbox = opened(warn);

      const begun = outbox.beginPost(address());

      expect(begun.status).toBe('begin');
      expect(outbox.recoveryWarning).toBeUndefined();
      expect(warnings).toEqual([]);
    });
  });

  describe('intent before post', () => {
    it('persists the pending intent BEFORE the caller posts, and exposes it as pending', () => {
      const outbox = opened();

      const begun = outbox.beginPost(address());
      if (begun.status !== 'begin') throw new Error(`expected begin, got ${begun.status}`);

      // Durable at the moment beginPost returns — i.e. before the post that the
      // caller has not made yet. This is the whole point of the unit.
      const onDisk = parseSurfaceOutboxSnapshot(JSON.parse(fs.readFileSync(file, 'utf-8')));
      expect(onDisk.records).toHaveLength(1);
      expect(onDisk.records[0]).toMatchObject({
        surfaceKey: SURFACE,
        sessionKey: SESSION,
        channelId: CHANNEL,
        threadTs: THREAD_TS,
        intentId: begun.record.intentId,
        state: 'pending',
      });
      expect(onDisk.records[0].messageTs).toBeUndefined();
    });

    it('stores no message text, blocks, or credentials — only the address and the intent', () => {
      opened().beginPost(address());

      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { records: Array<Record<string, unknown>> };

      expect(Object.keys(raw.records[0]).sort()).toEqual(
        ['channelId', 'createdAt', 'intentId', 'sessionKey', 'state', 'surfaceKey', 'threadTs', 'updatedAt'].sort(),
      );
    });

    it('keeps memory unchanged when the pending intent cannot be persisted (no phantom intent)', () => {
      const outbox = opened();
      fs.chmodSync(dir, 0o500); // the next write cannot land

      expect(() => outbox.beginPost(address())).toThrow();

      fs.chmodSync(dir, 0o700);
      // Persist-before-swap: a failed write leaves the in-memory map as it was,
      // so the caller sees "no intent" and can retry cleanly rather than
      // believing it owns an intent nothing on disk knows about.
      expect(outbox.get(SURFACE)).toBeUndefined();
      expect(fs.existsSync(file)).toBe(false);
    });
  });

  describe('restart', () => {
    it('recovers a pending intent and refuses to begin a duplicate post', () => {
      const first = opened();
      const begun = first.beginPost(address());
      if (begun.status !== 'begin') throw new Error(`expected begin, got ${begun.status}`);
      // The process dies HERE — between the post at thread-surface.ts:867 and
      // the memory-only ack at :873. Whether Slack accepted the card is unknown.

      const restarted = opened();
      const again = restarted.beginPost(address());

      expect(again.status).toBe('pending');
      if (again.status !== 'pending') throw new Error('unreachable');
      // Same intent, not a new one: an ambiguous outcome must never be resolved
      // by blindly posting again, which is exactly how a thread gets two cards.
      expect(again.record.intentId).toBe(begun.record.intentId);
      expect(again.record.state).toBe('pending');
      expect(restarted.get(SURFACE)?.intentId).toBe(begun.record.intentId);
      expect(parseSurfaceOutboxSnapshot(JSON.parse(fs.readFileSync(file, 'utf-8'))).records).toHaveLength(1);
    });

    it('recovers the exact message ts of a delivered card so the next render updates it', () => {
      const first = opened();
      const begun = first.beginPost(address());
      if (begun.status !== 'begin') throw new Error(`expected begin, got ${begun.status}`);
      first.markSent(SURFACE, begun.record.intentId, '1700.000900');

      const restarted = opened();

      expect(restarted.get(SURFACE)).toMatchObject({ state: 'sent', messageTs: '1700.000900' });
      const again = restarted.beginPost(address());
      expect(again.status).toBe('sent');
      if (again.status !== 'sent') throw new Error('unreachable');
      expect(again.record.messageTs).toBe('1700.000900');
      expect(again.record.intentId).toBe(begun.record.intentId);
    });

    it('hands back the STORED address, not the caller’s, for an existing card', () => {
      const first = opened();
      const begun = first.beginPost(address());
      if (begun.status !== 'begin') throw new Error(`expected begin, got ${begun.status}`);
      first.markSent(SURFACE, begun.record.intentId, '1700.000900');

      // The session moved channel (re-route, rename, caller bug): the record
      // still describes where the card actually is.
      const moved = opened().beginPost(address({ channelId: 'C-OTHER', threadTs: '1700.009999' }));

      expect(moved.status).toBe('sent');
      if (moved.status !== 'sent') throw new Error('unreachable');
      // `messageTs` is only meaningful together with the channel it was posted
      // in, so the consumer MUST compare the returned address with its own
      // before issuing chat.update — updating C-OTHER with a C1 ts either 404s
      // or, worse, hits an unrelated message.
      expect(moved.record.channelId).toBe(CHANNEL);
      expect(moved.record.threadTs).toBe(THREAD_TS);
      expect(moved.record.messageTs).toBe('1700.000900');
    });
  });

  describe('acknowledgement', () => {
    it('leaves the intent pending — and un-resent — when the ack cannot be persisted', () => {
      const outbox = opened();
      const begun = outbox.beginPost(address());
      if (begun.status !== 'begin') throw new Error(`expected begin, got ${begun.status}`);
      fs.chmodSync(dir, 0o500); // the ack write cannot land

      expect(() => outbox.markSent(SURFACE, begun.record.intentId, '1700.000900')).toThrow();

      fs.chmodSync(dir, 0o700);
      // Memory must not have swapped to `sent` either: reporting a durable ack
      // that is not durable is the lie this ordering exists to prevent.
      expect(outbox.get(SURFACE)).toMatchObject({ state: 'pending' });
      expect(outbox.get(SURFACE)?.messageTs).toBeUndefined();
      const restarted = opened();
      expect(restarted.get(SURFACE)?.state).toBe('pending');
      // Still ambiguous, so still no repost.
      expect(restarted.beginPost(address()).status).toBe('pending');
    });

    it('refuses a stale ack from an older intent and leaves the record untouched', () => {
      const outbox = opened();
      const begun = outbox.beginPost(address());
      if (begun.status !== 'begin') throw new Error(`expected begin, got ${begun.status}`);
      outbox.markSent(SURFACE, begun.record.intentId, '1700.000900');

      expect(() => outbox.markSent(SURFACE, 'a-previous-intent', '1700.001100')).toThrow(/intent/i);

      // A24/A28: a late ack from a dead turn must not repoint the surface at a
      // different message.
      expect(outbox.get(SURFACE)).toMatchObject({ state: 'sent', messageTs: '1700.000900' });
      expect(opened().get(SURFACE)).toMatchObject({ state: 'sent', messageTs: '1700.000900' });
    });

    it('refuses an ack for a surface it has no record of', () => {
      expect(() => opened().markSent(SURFACE, 'whatever', '1700.000900')).toThrow(/no record/i);
    });

    it('refuses to ack an intent that is no longer pending', () => {
      const outbox = opened();
      const begun = outbox.beginPost(address());
      if (begun.status !== 'begin') throw new Error(`expected begin, got ${begun.status}`);
      outbox.markRejected(SURFACE, begun.record.intentId, 'channel_not_found');

      expect(() => outbox.markSent(SURFACE, begun.record.intentId, '1700.000900')).toThrow(/pending/i);
    });

    it('advances updatedAt without rewriting createdAt', () => {
      let clock = 1_700_000_000_000;
      const outbox = opened(undefined, () => clock);
      const begun = outbox.beginPost(address());
      if (begun.status !== 'begin') throw new Error(`expected begin, got ${begun.status}`);
      clock = 1_700_000_005_000;

      const sent = outbox.markSent(SURFACE, begun.record.intentId, '1700.000900');

      expect(sent.createdAt).toBe(1_700_000_000_000);
      expect(sent.updatedAt).toBe(1_700_000_005_000);
    });
  });

  describe('explicit rejection', () => {
    it('permits a fresh intent only after the delivery was definitively rejected', () => {
      const outbox = opened();
      const begun = outbox.beginPost(address());
      if (begun.status !== 'begin') throw new Error(`expected begin, got ${begun.status}`);

      const rejected = outbox.markRejected(SURFACE, begun.record.intentId, 'channel_not_found');
      expect(rejected).toMatchObject({ state: 'rejected', reason: 'channel_not_found' });

      const retry = outbox.beginPost(address());
      expect(retry.status).toBe('begin');
      if (retry.status !== 'begin') throw new Error('unreachable');
      // A new intent id, so a late ack for the rejected one can never be
      // mistaken for this delivery.
      expect(retry.record.intentId).not.toBe(begun.record.intentId);
      expect(retry.record.state).toBe('pending');
      // Still exactly one record for the surface — the retry replaces, never accumulates.
      expect(parseSurfaceOutboxSnapshot(JSON.parse(fs.readFileSync(file, 'utf-8'))).records).toHaveLength(1);
    });

    it('refuses a rejection that names a different intent', () => {
      const outbox = opened();
      const begun = outbox.beginPost(address());
      if (begun.status !== 'begin') throw new Error(`expected begin, got ${begun.status}`);

      expect(() => outbox.markRejected(SURFACE, 'a-previous-intent', 'channel_not_found')).toThrow(/intent/i);
      expect(outbox.get(SURFACE)).toMatchObject({ state: 'pending' });
    });
  });

  /**
   * A delivered card can disappear afterwards — a user deletes the message, a
   * channel is pruned — and `chat.update` then answers `message_not_found`.
   *
   * That record is `sent`, which `markRejected` refuses, so without this
   * transition the surface clears its in-memory ts, re-enters the post branch,
   * is handed the SAME dead ts back by `beginPost`, and loops on a message that
   * no longer exists until a human intervenes.
   *
   * The CAS is one field tighter than `markSent`'s: the caller must also name
   * the exact `ts` it watched fail. A 404 about any other ts is evidence about
   * some other message, and acting on it would throw away a live card's address.
   */
  describe('observed deletion', () => {
    /** A delivered card: the intent that owns the surface and the ts it holds. */
    function delivered(outbox: SurfaceOutboxStore): { intentId: string; messageTs: string } {
      const begun = outbox.beginPost(address());
      if (begun.status !== 'begin') throw new Error(`expected begin, got ${begun.status}`);
      const messageTs = '1700.000900';
      outbox.markSent(SURFACE, begun.record.intentId, messageTs);
      return { intentId: begun.record.intentId, messageTs };
    }

    it('releases a sent surface for a fresh intent once its message is gone', () => {
      const outbox = opened();
      const { intentId, messageTs } = delivered(outbox);

      const deleted = outbox.markDeleted(SURFACE, intentId, messageTs);

      // `rejected` is the only state that re-authorises a post, and the dead ts
      // is cleared so nothing can address the vanished message again.
      expect(deleted).toMatchObject({ state: 'rejected', reason: 'message_not_found' });
      expect(deleted.messageTs).toBeUndefined();

      const retry = outbox.beginPost(address());
      expect(retry.status).toBe('begin');
      if (retry.status !== 'begin') throw new Error('unreachable');
      expect(retry.record.intentId).not.toBe(intentId);
      // Durable, and still exactly one record for the surface.
      expect(opened().get(SURFACE)?.intentId).toBe(retry.record.intentId);
      expect(parseSurfaceOutboxSnapshot(JSON.parse(fs.readFileSync(file, 'utf-8'))).records).toHaveLength(1);
    });

    it('advances updatedAt without rewriting createdAt', () => {
      let clock = 1_700_000_000_000;
      const outbox = opened(undefined, () => clock);
      const { intentId, messageTs } = delivered(outbox);
      clock = 1_700_000_005_000;

      const deleted = outbox.markDeleted(SURFACE, intentId, messageTs);

      expect(deleted.createdAt).toBe(1_700_000_000_000);
      expect(deleted.updatedAt).toBe(1_700_000_005_000);
    });

    it('refuses a deletion naming a ts the record does not hold', () => {
      const outbox = opened();
      const { intentId } = delivered(outbox);

      // A 404 about `1700.001100` says nothing about the card at `1700.000900`.
      expect(() => outbox.markDeleted(SURFACE, intentId, '1700.001100')).toThrow(/ts/i);

      expect(outbox.get(SURFACE)).toMatchObject({ state: 'sent', messageTs: '1700.000900' });
      expect(opened().get(SURFACE)).toMatchObject({ state: 'sent', messageTs: '1700.000900' });
    });

    it('refuses a deletion naming a stale intent', () => {
      const outbox = opened();
      const { messageTs } = delivered(outbox);

      expect(() => outbox.markDeleted(SURFACE, 'a-previous-intent', messageTs)).toThrow(/intent/i);
      expect(outbox.get(SURFACE)).toMatchObject({ state: 'sent', messageTs });
    });

    it('refuses to delete an intent that was never sent', () => {
      const outbox = opened();
      const begun = outbox.beginPost(address());
      if (begun.status !== 'begin') throw new Error(`expected begin, got ${begun.status}`);

      // A pending intent's outcome is UNKNOWN; a 404 about some ts we never
      // recorded cannot resolve it, and releasing it here would repost.
      expect(() => outbox.markDeleted(SURFACE, begun.record.intentId, '1700.000900')).toThrow(/sent/i);
      expect(outbox.get(SURFACE)).toMatchObject({ state: 'pending' });
    });

    it('refuses a deletion for a surface it has no record of', () => {
      expect(() => opened().markDeleted(SURFACE, 'whatever', '1700.000900')).toThrow(/no record/i);
    });

    it('keeps the card addressable when the deletion cannot be persisted', () => {
      const outbox = opened();
      const { intentId, messageTs } = delivered(outbox);
      fs.chmodSync(dir, 0o500); // the transition write cannot land

      expect(() => outbox.markDeleted(SURFACE, intentId, messageTs)).toThrow();

      fs.chmodSync(dir, 0o700);
      // Persist-before-swap: memory must not have swapped to `rejected`, which
      // would authorise a post that disk still calls delivered.
      expect(outbox.get(SURFACE)).toMatchObject({ state: 'sent', messageTs });
      expect(opened().get(SURFACE)).toMatchObject({ state: 'sent', messageTs });
    });
  });

  /**
   * A `.bak` fallback is a *generation rollback*: the backup holds the state
   * before the last committed write, so the newest intent is simply not in it.
   * An absent record therefore no longer means "never posted" — it may mean
   * "posted, and the proof was in the generation we lost". Minting a fresh
   * intent on that reading is how the duplicate card gets posted, so the whole
   * store is quarantined for *new* deliveries until an operator resolves it.
   */
  describe('recovery quarantine after a .bak fallback', () => {
    /** live = [A sent, B pending] (corrupted); .bak = [A sent] — B's generation is gone. */
    function rollbackState(): { sentTs: string } {
      const outbox = opened();
      const a = outbox.beginPost(address());
      if (a.status !== 'begin') throw new Error(`expected begin, got ${a.status}`);
      outbox.markSent(SURFACE, a.record.intentId, '1700.000900');
      outbox.beginPost(address({ sessionKey: 'C9:1700.000001', channelId: 'C9' })); // .bak = [A sent]
      writeLive('{"version": 1, "records": [');
      return { sentTs: '1700.000900' };
    }

    it('names the rolled-back file and still calls the user sink', () => {
      rollbackState();
      const { warn, warnings } = collectWarnings();

      const outbox = opened(warn);

      expect(outbox.recoveryWarning).toContain(file);
      expect(outbox.recoveryWarning).toContain('.bak');
      expect(warnings).toEqual([outbox.recoveryWarning]);
    });

    it('blocks a new post for a key the rollback dropped', () => {
      rollbackState();
      const outbox = opened(collectWarnings().warn);

      // B's pending intent was in the lost generation: the card may well be in
      // the thread already.
      const blocked = outbox.beginPost(address({ sessionKey: 'C9:1700.000001', channelId: 'C9' }));

      expect(blocked.status).toBe('blocked');
      if (blocked.status !== 'blocked') throw new Error('unreachable');
      expect(blocked.reason).toContain('.bak');
    });

    it('blocks a new post for a surface it has never heard of', () => {
      rollbackState();
      const outbox = opened(collectWarnings().warn);

      // Absence is no longer evidence, so the quarantine is global — not scoped
      // to the keys that happen to be in the rolled-back file.
      expect(outbox.beginPost(address({ sessionKey: 'C7:1700.000777', channelId: 'C7' })).status).toBe('blocked');
    });

    it('still serves a known sent ts so live surfaces keep updating in place', () => {
      const { sentTs } = rollbackState();
      const outbox = opened(collectWarnings().warn);

      // Reading a surviving record is always safe: it can only prevent a
      // duplicate post, never cause one.
      expect(outbox.get(SURFACE)).toMatchObject({ state: 'sent', messageTs: sentTs });
      expect(outbox.beginPost(address()).status).toBe('sent');
    });

    it('records an observed deletion but still refuses the re-mint', () => {
      const { sentTs } = rollbackState();
      const outbox = opened(collectWarnings().warn);
      const current = outbox.get(SURFACE);
      if (!current) throw new Error('expected the surviving sent record');

      // Recording a loss is always safe under quarantine: it only ever removes
      // an address, so it cannot be the thing that posts a duplicate.
      const deleted = outbox.markDeleted(SURFACE, current.intentId, sentTs);
      expect(deleted).toMatchObject({ state: 'rejected', reason: 'message_not_found' });

      // What it must NOT do is smuggle a post past the quarantine: `rejected`
      // normally re-authorises one, and the generation is still unconfirmed.
      const blocked = outbox.beginPost(address());
      expect(blocked.status).toBe('blocked');
      if (blocked.status !== 'blocked') throw new Error('unreachable');
      expect(blocked.reason).toContain('.bak');
    });

    it('is not lifted by a reload that fails — the store closes instead', () => {
      rollbackState();
      const outbox = opened(collectWarnings().warn);
      expect(outbox.beginPost(address({ sessionKey: 'C7:1700.000777', channelId: 'C7' })).status).toBe('blocked');

      // Now even the backup is gone. `load()` clears the warning before it
      // reads, so a non-transactional loader would drop the quarantine while
      // keeping the stale records — and start minting fresh intents against a
      // generation it can no longer confirm.
      writeLive('garbage');
      fs.writeFileSync(backup, 'also garbage', 'utf-8');

      expect(() => outbox.load()).toThrow(/unusable|refusing/i);
      expect(() => outbox.beginPost(address({ sessionKey: 'C7:1700.000777', channelId: 'C7' }))).toThrow(/load\(\)/);
      expect(() => outbox.beginPost(address())).toThrow(/load\(\)/);
      expect(() => outbox.get(SURFACE)).toThrow(/load\(\)/);
    });

    it('lifts once a healthy live file loads again', () => {
      rollbackState();
      const outbox = opened(collectWarnings().warn);
      expect(outbox.beginPost(address({ sessionKey: 'C7:1700.000777', channelId: 'C7' })).status).toBe('blocked');

      // An operator restored the live file from the backup.
      fs.copyFileSync(backup, file);
      outbox.load();

      expect(outbox.recoveryWarning).toBeUndefined();
      expect(outbox.beginPost(address({ sessionKey: 'C7:1700.000777', channelId: 'C7' })).status).toBe('begin');
    });
  });

  describe('fail-closed validation of untrusted persisted JSON', () => {
    /** `[what is broken, the bytes on disk, the reason the loader must give]`. */
    const rejected: Array<[string, unknown, string]> = [
      ['not an object', '"nope"', 'snapshot is not an object'],
      ['unknown schema version', { version: 2, records: [] }, 'snapshot.version is not 1'],
      ['records not an array', { version: 1, records: {} }, 'snapshot.records is not an array'],
      [
        'surfaceKey not derived from sessionKey',
        snapshot([record({ surfaceKey: `${SESSION}::turn-surface` })]),
        'records[0].surfaceKey is not "<sessionKey>::thread-panel"',
      ],
      [
        'two records for one surface',
        snapshot([record(), record({ intentId: '22222222-2222-4222-8222-222222222222' })]),
        'records[1].surfaceKey is a duplicate',
      ],
      [
        'one intent id on two surfaces',
        snapshot([record(), record({ sessionKey: 'C9:1700.000001' })]),
        'records[1].intentId is a duplicate',
      ],
      ['malformed state', snapshot([record({ state: 'delivered' as never })]), 'records[0].state is not one of'],
      [
        'sent without a message ts',
        snapshot([record({ state: 'sent' })]),
        'records[0].messageTs is not a non-empty string',
      ],
      [
        'sent with an empty message ts',
        snapshot([record({ state: 'sent', messageTs: '' })]),
        'records[0].messageTs is not a non-empty string',
      ],
      [
        // A pending record carrying a ts means an ack half-landed — the writer
        // never produces it, so it is skew or tampering, not a repair job.
        'pending carrying a message ts',
        snapshot([record({ messageTs: '1700.000900' })]),
        'records[0].messageTs is set on a pending record',
      ],
      [
        'rejected without a reason',
        snapshot([record({ state: 'rejected' })]),
        'records[0].reason is not a non-empty string',
      ],
      ['empty sessionKey', snapshot([record({ sessionKey: '' })]), 'records[0].sessionKey is not a non-empty string'],
      ['empty channelId', snapshot([record({ channelId: '' })]), 'records[0].channelId is not a non-empty string'],
      ['empty threadTs', snapshot([record({ threadTs: '' })]), 'records[0].threadTs is not a non-empty string'],
      ['empty intentId', snapshot([record({ intentId: '' })]), 'records[0].intentId is not a non-empty string'],
      [
        'negative createdAt',
        snapshot([record({ createdAt: -1 })]),
        'records[0].createdAt is not a non-negative finite number',
      ],
      [
        'non-finite updatedAt',
        snapshot([record({ updatedAt: Number.POSITIVE_INFINITY })]),
        'records[0].updatedAt is not a non-negative finite number',
      ],
      [
        'updatedAt before createdAt',
        snapshot([record({ createdAt: 1_700_000_005_000, updatedAt: 1_700_000_000_000 })]),
        'records[0].updatedAt is before createdAt',
      ],
    ];

    it.each(rejected)('rejects %s rather than repairing it', (_label, payload, reason) => {
      // The reason is asserted, not just the throw: a validator that rejected
      // everything (or rejected the right file for the wrong field) would still
      // pass a bare `toThrow()`.
      expect(() => parseSurfaceOutboxSnapshot(typeof payload === 'string' ? JSON.parse(payload) : payload)).toThrow(
        reason,
      );

      writeLive(payload);
      expect(() => store(collectWarnings().warn).load()).toThrow(reason);
    });

    it('accepts a record with no threadTs (a top-level surface)', () => {
      writeLive(snapshot([record({ threadTs: undefined })]));

      expect(opened().get(SURFACE)).toMatchObject({ state: 'pending' });
    });

    it('falls back to the healthy backup when the live file violates the schema', () => {
      const outbox = opened();
      const begun = outbox.beginPost(address());
      if (begun.status !== 'begin') throw new Error(`expected begin, got ${begun.status}`);
      outbox.markSent(SURFACE, begun.record.intentId, '1700.000900'); // .bak = the pending generation
      writeLive(snapshot([record({ state: 'sent' })])); // parses, but a sent record with no ts
      const { warn, warnings } = collectWarnings();

      const restarted = opened(warn);

      expect(restarted.get(SURFACE)).toMatchObject({ state: 'pending' });
      expect(warnings).toHaveLength(1);
    });

    it('does not repair the live file on read (read never writes)', () => {
      const outbox = opened();
      const begun = outbox.beginPost(address());
      if (begun.status !== 'begin') throw new Error(`expected begin, got ${begun.status}`);
      outbox.markSent(SURFACE, begun.record.intentId, '1700.000900');
      writeLive('garbage');

      opened(collectWarnings().warn);

      expect(fs.readFileSync(file, 'utf-8')).toBe('garbage');
    });

    it('never lets a corrupt live file displace a healthy backup', () => {
      const outbox = opened();
      const begun = outbox.beginPost(address());
      if (begun.status !== 'begin') throw new Error(`expected begin, got ${begun.status}`);
      outbox.markSent(SURFACE, begun.record.intentId, '1700.000900'); // .bak = pending generation
      const healthyBackup = fs.readFileSync(backup, 'utf-8');
      writeLive(snapshot([record({ state: 'sent' })])); // schema-broken live file
      const { warn, warnings } = collectWarnings();

      const repaired = opened(warn);

      // The backup's pending generation is what we now hold — and the broken
      // live file did not overwrite the only healthy generation left.
      expect(repaired.get(SURFACE)).toMatchObject({ state: 'pending' });
      expect(fs.readFileSync(backup, 'utf-8')).toBe(healthyBackup);
      expect(warnings).toHaveLength(1);
    });
  });

  describe('surface key', () => {
    it('derives one key per session for the single thread-panel surface', () => {
      expect(threadPanelSurfaceKey(SESSION)).toBe(SURFACE);
    });
  });
});
