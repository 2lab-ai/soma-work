/**
 * The line both kinds of work queue share (.prd/36 v2 §2): claims, places, records.
 */
import { describe, expect, it } from 'vitest';
import {
  appendRecords,
  claimsOn,
  LINE_RECORDS_KEEP,
  type LineItem,
  type LineRecord,
  personQueueId,
  splitKeys,
  waitingPlace,
} from './line';

const h = (t: string) => ({ user: 'U', channel: 'C', threadTs: t });
const items: LineItem[] = [
  { id: 'a', keys: ['ABC-1', 'ABC-2'], state: 'running', holder: h('1'), enteredAt: 1 },
  { id: 'b', keys: ['ABC-3'], state: 'waiting', holder: h('2'), enteredAt: 2 },
  { id: 'c', keys: ['ABC-2', 'ABC-4'], state: 'waiting', holder: h('3'), enteredAt: 3 },
];

describe('line', () => {
  it('a claimed key names the first live entry that has it', () => {
    expect(claimsOn(items, ['ABC-2', 'ABC-9', 'ABC-3'])).toEqual([
      { key: 'ABC-2', entry: 'a', state: 'running', holder: h('1') },
      { key: 'ABC-3', entry: 'b', state: 'waiting', holder: h('2') },
    ]);
  });

  it('splits keys into free and claimed', () => {
    expect(splitKeys(items, ['ABC-9', 'ABC-1'])).toEqual({
      free: ['ABC-9'],
      claimed: [{ key: 'ABC-1', entry: 'a', state: 'running', holder: h('1') }],
    });
    expect(splitKeys(items, ['ABC-1', 'ABC-4']).free).toEqual([]);
  });

  it('a waiting place is 1-based in line order; a running or absent entry is 0', () => {
    expect(waitingPlace(items, 'b')).toBe(1);
    expect(waitingPlace(items, 'c')).toBe(2);
    expect(waitingPlace(items, 'a')).toBe(0);
    expect(waitingPlace(items, 'x')).toBe(0);
  });

  it('records keep the newest LINE_RECORDS_KEEP', () => {
    const rec = (i: number): LineRecord => ({
      id: `r${i}`,
      queue: 'q',
      keys: [],
      holder: h('1'),
      enteredAt: i,
      endedAt: i,
      end: 'done',
    });
    let list: LineRecord[] = [];
    for (let i = 0; i < LINE_RECORDS_KEEP + 3; i++) list = appendRecords(list, rec(i));
    expect(list).toHaveLength(LINE_RECORDS_KEEP);
    expect(list[0].id).toBe('r3');
  });

  it('a person queue goes by user:<id>', () => {
    expect(personQueueId('U1')).toBe('user:U1');
  });
});
