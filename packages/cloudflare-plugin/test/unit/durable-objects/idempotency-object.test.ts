/**
 * `IdempotencyObjectCore` on a gated fake (M109a §3.15).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  IdempotencyObjectCore,
  type IIdempotencyObjectState,
} from '../../../src/durable-objects/idempotency-object.ts';

/** A fake `state.storage` recording alarms. */
class FakeStorage {
  readonly map = new Map<string, unknown>();
  readonly alarms: number[] = [];
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.map.get(key) as T | undefined);
  }
  put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.map.delete(key));
  }
  setAlarm(ms: number): Promise<void> {
    this.alarms.push(ms);
    return Promise.resolve();
  }
}

/** Builds a core with a controllable clock. */
function build(now = 0) {
  const storage = new FakeStorage();
  let clock = now;
  const core = new IdempotencyObjectCore({ storage } as IIdempotencyObjectState, {
    now: () => clock,
  });
  return { core, storage, advance: (ms: number) => void (clock += ms) };
}

/** POSTs a JSON body. */
function post(core: IdempotencyObjectCore, path: string, body: unknown): Promise<Response> {
  return core.fetch(
    new Request(`https://idempotency.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('IdempotencyObjectCore (M109a §3.15)', () => {
  it('returns 404 for an unknown path', async () => {
    const { core } = build();
    expect((await post(core, '/nope', {})).status).toBe(404);
  });

  it('answers 400 for a malformed body with NO storage access', async () => {
    const { core, storage } = build();
    for (
      const body of [
        {},
        { token: 't' },
        { token: 't', fingerprint: 'f', leaseMs: 0, ttlMs: 1 },
        'x',
      ]
    ) {
      expect((await post(core, '/claim', body)).status).toBe(400);
    }
    expect(storage.map.size).toBe(0);
    expect(storage.alarms).toEqual([]);
  });

  it('claims a fresh key and arms the alarm', async () => {
    const { core, storage } = build(1_000);
    const answer = await (await post(core, '/claim', {
      token: 't1',
      fingerprint: 'f',
      leaseMs: 100,
      ttlMs: 5_000,
    })).json();
    expect(answer).toEqual({ outcome: 'claimed', takeover: false });
    expect(storage.alarms).toEqual([6_000]);
  });

  it('refuses a different fingerprint before the state check', async () => {
    const { core } = build();
    await post(core, '/claim', { token: 't1', fingerprint: 'f', leaseMs: 100, ttlMs: 5_000 });
    expect(
      await (await post(core, '/claim', {
        token: 't2',
        fingerprint: 'g',
        leaseMs: 100,
        ttlMs: 5_000,
      })).json(),
    )
      .toEqual({ outcome: 'fingerprint-mismatch' });
  });

  it('answers in-progress inside the lease and takes over a lapsed one', async () => {
    const { core, storage, advance } = build(0);
    await post(core, '/claim', { token: 't1', fingerprint: 'f', leaseMs: 100, ttlMs: 5_000 });
    expect(
      await (await post(core, '/claim', {
        token: 't2',
        fingerprint: 'f',
        leaseMs: 100,
        ttlMs: 5_000,
      })).json(),
    )
      .toEqual({ outcome: 'in-progress' });
    advance(150);
    expect(
      await (await post(core, '/claim', {
        token: 't2',
        fingerprint: 'f',
        leaseMs: 100,
        ttlMs: 5_000,
      })).json(),
    )
      .toEqual({ outcome: 'claimed', takeover: true });
    // A new claim and a takeover each arm the alarm.
    expect(storage.alarms.length).toBeGreaterThanOrEqual(2);
  });

  it('completes with the record and replays it; a stale token is lost', async () => {
    const { core, storage } = build();
    await post(core, '/claim', { token: 't1', fingerprint: 'f', leaseMs: 100, ttlMs: 5_000 });
    expect(
      await (await post(core, '/complete', { token: 't1', record: 'rec', ttlMs: 5_000 })).json(),
    )
      .toEqual({ result: 'settled' });
    expect(
      await (await post(core, '/complete', { token: 'nope', record: 'x', ttlMs: 5_000 })).json(),
    )
      .toEqual({ result: 'lost' });
    expect(
      await (await post(core, '/claim', {
        token: 't2',
        fingerprint: 'f',
        leaseMs: 100,
        ttlMs: 5_000,
      })).json(),
    )
      .toEqual({ outcome: 'completed', record: 'rec' });
    // A complete arms the alarm; a lost one does not add to it.
    const alarmsAfterComplete = storage.alarms.length;
    await post(core, '/complete', { token: 'nope', record: 'x', ttlMs: 5_000 });
    expect(storage.alarms.length).toBe(alarmsAfterComplete);
  });

  it('releases a held claim and does NOT arm the alarm', async () => {
    const { core, storage } = build();
    await post(core, '/claim', { token: 't1', fingerprint: 'f', leaseMs: 100, ttlMs: 5_000 });
    const before = storage.alarms.length;
    expect(await (await post(core, '/release', { token: 't1' })).json()).toEqual({
      result: 'settled',
    });
    expect(storage.alarms.length).toBe(before);
    expect(storage.map.size).toBe(0);
    expect(await (await post(core, '/release', { token: 't1' })).json()).toEqual({
      result: 'lost',
    });
  });

  it('treats an expired record as absent', async () => {
    const { core, advance } = build(0);
    await post(core, '/claim', { token: 't1', fingerprint: 'f', leaseMs: 100, ttlMs: 50 });
    advance(100);
    expect(
      await (await post(core, '/claim', { token: 't2', fingerprint: 'f', leaseMs: 100, ttlMs: 50 }))
        .json(),
    )
      .toEqual({ outcome: 'claimed', takeover: false });
  });

  it('alarm(): no-op with no record, deletes an expired one, re-arms an unexpired one', async () => {
    const { core, storage, advance } = build(0);
    await core.alarm();
    expect(storage.map.size).toBe(0);

    await post(core, '/claim', { token: 't1', fingerprint: 'f', leaseMs: 100, ttlMs: 5_000 });
    await core.alarm();
    expect(storage.alarms.length).toBe(2); // the claim's arm, then the re-arm

    advance(6_000);
    await core.alarm();
    expect(storage.map.size).toBe(0);
  });
});
