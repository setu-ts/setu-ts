/**
 * One relay lap's state (M107 §3.6): seeded once from failed keys, the
 * 10 000-key blocked-set cap, `capReached`, and a cursor that moves one
 * examined row at a time.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { MAX_BLOCKED_KEYS, OutboxLap } from '../../../src/outbox/lap.ts';
import { blockKey } from '../../../src/outbox/position.ts';

describe('OutboxLap', () => {
  it('seeds keyed failed rows (tenant included) and ignores unkeyed ones', () => {
    const lap = new OutboxLap(
      [{ orderingKey: 'a' }, { tenantId: 't', orderingKey: 'b' }, { tenantId: 't' }, {}],
      100,
    );
    expect(lap.blockedSize).toBe(2);
    expect(lap.isBlocked(blockKey(undefined, 'a'))).toBe(true);
    expect(lap.isBlocked(blockKey('t', 'b'))).toBe(true);
    expect(lap.isBlocked(blockKey(undefined, 'b'))).toBe(false);
    expect(lap.capReached).toBe(false);
    expect(lap.cursor).toBeUndefined();
  });

  it('is capReached for the whole lap when the failed scan came back full', () => {
    const lap = new OutboxLap([{ orderingKey: 'a' }, { orderingKey: 'b' }], 2);
    expect(lap.capReached).toBe(true);
    expect(lap.blockedOverflow).toBe(false);
  });

  it('holds at most 10 000 keys: the next new key sets capReached and blockedOverflow', () => {
    expect(MAX_BLOCKED_KEYS).toBe(10_000);
    const lap = new OutboxLap([], 1_000_000);
    for (let n = 0; n < MAX_BLOCKED_KEYS; n++) lap.block(blockKey(undefined, `k${n}`));
    expect(lap.blockedSize).toBe(10_000);
    expect(lap.capReached).toBe(false);
    lap.block(blockKey(undefined, 'k0')); // already present: no growth, no cap
    expect(lap.capReached).toBe(false);
    lap.block(blockKey(undefined, 'one-more'));
    expect(lap.blockedSize).toBe(10_000);
    expect(lap.isBlocked(blockKey(undefined, 'one-more'))).toBe(false);
    expect(lap.capReached).toBe(true);
    expect(lap.blockedOverflow).toBe(true);
  });

  it('overflows while seeding when the failed keys exceed the cap', () => {
    const lap = new OutboxLap(
      [{ orderingKey: 'a' }, { orderingKey: 'b' }, { orderingKey: 'c' }],
      10,
      2,
    );
    expect(lap.blockedSize).toBe(2);
    expect(lap.blockedOverflow).toBe(true);
    expect(lap.capReached).toBe(true);
  });

  it('moves the cursor onto each examined row', () => {
    const lap = new OutboxLap([], 10);
    lap.advance('p1');
    expect(lap.cursor).toBe('p1');
    lap.advance('p2');
    expect(lap.cursor).toBe('p2');
  });
});
