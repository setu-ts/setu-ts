/**
 * `KvSessionStore` — the ISessionStore contract takes its TTL in milliseconds,
 * which is where a unit conversion bug would live, so the conversion and the
 * 60-second floor are both pinned here.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { KvSessionStore } from '../../../src/index.ts';
import { FakeClock, FakeKv } from '../../fakes.ts';

function store(options?: { prefix?: string }): {
  kv: FakeKv;
  clock: FakeClock;
  sessions: KvSessionStore;
} {
  const kv = new FakeKv();
  const clock = new FakeClock();
  return { kv, clock, sessions: new KvSessionStore(kv, clock, options) };
}

describe('KvSessionStore', () => {
  it('writes and reads a session back', async () => {
    const { sessions } = store();
    await sessions.write('abc', { userId: 42 }, 60_000);
    expect(await sessions.read('abc')).toEqual({ userId: 42 });
  });

  it('reads an unknown id as null', async () => {
    const { sessions } = store();
    expect(await sessions.read('never-written')).toBeNull();
  });

  it('prefixes keys with session: by default, so a shared namespace is safe', async () => {
    const { kv, sessions } = store();
    await sessions.write('abc', {}, 60_000);
    expect([...kv.entries.keys()]).toEqual(['session:abc']);
  });

  it('honors a configured prefix', async () => {
    const { kv, sessions } = store({ prefix: 'sess/' });
    await sessions.write('abc', {}, 60_000);
    expect([...kv.entries.keys()]).toEqual(['sess/abc']);
  });

  it('converts a millisecond TTL to seconds and floors it physically', async () => {
    const { kv, sessions } = store();

    // 1 second, expressed in ms — well under KV's 60s floor.
    await sessions.write('short', { a: 1 }, 1000);

    expect(kv.puts.at(0)?.options?.expirationTtl).toBe(60);
    expect(JSON.parse(kv.puts.at(0)?.value ?? '').e).toBe(new FakeClock().now() + 1000);
  });

  it('expires logically on the millisecond deadline, not on KV floor', async () => {
    const { clock, sessions } = store();
    await sessions.write('short', { a: 1 }, 1000);

    clock.advance(999);
    expect(await sessions.read('short')).toEqual({ a: 1 });

    clock.advance(2);
    expect(await sessions.read('short')).toBeNull();
  });

  it('drops the row when a read finds it logically expired', async () => {
    const { kv, clock, sessions } = store();
    await sessions.write('short', { a: 1 }, 1000);
    clock.advance(2000);

    await sessions.read('short');

    expect(kv.deletes).toEqual(['session:short']);
  });

  it('converts a TTL above the floor without rounding it down', async () => {
    const { kv, sessions } = store();
    await sessions.write('long', {}, 7_200_000); // 2 hours
    expect(kv.puts.at(0)?.options?.expirationTtl).toBe(7200);
  });

  it('reports from destroy() whether a live session was removed', async () => {
    const { kv, sessions } = store();
    await sessions.write('abc', { userId: 1 }, 60_000);

    expect(await sessions.destroy('abc')).toBe(true);
    expect(await sessions.destroy('abc')).toBe(false);
    expect(kv.entries.has('session:abc')).toBe(false);
  });

  it('never deletes a key it does not own', async () => {
    // A cache store with no prefix can share this namespace; reading an id that
    // happens to collide with a foreign key must not remove that key.
    const { kv, sessions } = store({ prefix: '' });
    await kv.put('some-other-row', JSON.stringify({ not: 'ours' }));

    expect(await sessions.read('some-other-row')).toBeNull();
    expect(kv.entries.has('some-other-row')).toBe(true);
    expect(kv.deletes).toEqual([]);
  });

  it('issues exactly one delete when destroying an expired session', async () => {
    const { kv, clock, sessions } = store();
    await sessions.write('abc', { userId: 1 }, 1000);
    clock.advance(2000);

    expect(await sessions.destroy('abc')).toBe(false);
    expect(kv.deletes).toEqual(['session:abc']);
  });

  it('reports destroy() of an expired session as false', async () => {
    const { clock, sessions } = store();
    await sessions.write('abc', { userId: 1 }, 1000);
    clock.advance(2000);

    expect(await sessions.destroy('abc')).toBe(false);
  });
});
