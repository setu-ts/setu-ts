/**
 * `storeCommit` (V13-137): in `'changes'` mode a store commit applies this request's changes to the
 * current row; in `'snapshot'` mode it writes the request's whole payload. Driven with a store
 * double that orders reads and writes explicitly rather than relying on scheduling.
 */
import { describe, expect, it } from 'vitest';
import type { ISessionStore, SessionData } from '@setu-ts/common';

import { deriveKeyRing } from '../../src/codec/crypto.ts';
import type { SessionPluginOptions } from '../../src/options.ts';
import { resolveSessionConfig } from '../../src/options.ts';
import { SessionService } from '../../src/services/session-service.ts';
import { makeClock, makeContext } from '../fixtures/context.ts';

const SECRET = 's'.repeat(32);

/** A map-backed store whose next row read can be held after it returns its value. */
class OrderingStore implements ISessionStore {
  readonly rows = new Map<string, SessionData>();
  #hold: { read: () => void; gate: Promise<void> } | undefined;

  /** Holds the next row read after it has read; resolves `read` once it has. */
  holdNextRead(): { read: Promise<void>; release: () => void } {
    let readDone: () => void = () => {};
    let release: () => void = () => {};
    const read = new Promise<void>((resolve) => {
      readDone = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#hold = { read: readDone, gate };
    return { read, release };
  }

  async read(id: string): Promise<SessionData | null> {
    const row = this.rows.get(id);
    const value = row === undefined ? null : structuredClone(row);
    const hold = this.#hold;
    if (hold !== undefined && !id.includes(':')) {
      this.#hold = undefined;
      hold.read();
      await hold.gate;
    }
    return value;
  }

  write(id: string, data: SessionData, _ttlMs: number): Promise<void> {
    this.rows.set(id, structuredClone(data));
    return Promise.resolve();
  }

  destroy(id: string): Promise<boolean> {
    return Promise.resolve(this.rows.delete(id));
  }
}

async function createService(
  store: ISessionStore,
  options: Partial<SessionPluginOptions> = {},
): Promise<SessionService> {
  const clock = makeClock();
  const config = resolveSessionConfig({ mode: 'encrypt', store, ...options });
  const ring = await deriveKeyRing(crypto.subtle, [SECRET], 'encrypt');
  return new SessionService(
    config,
    ring,
    {
      subtle: crypto.subtle,
      randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
      now: clock.now,
      uuid: clock.uuid,
    },
    store,
  );
}

async function seeded(service: SessionService, data: Record<string, unknown>): Promise<string> {
  const c = makeContext();
  const s = await service.load(c.ctx);
  for (const [k, v] of Object.entries(data)) s.set(k, v);
  await service.commit(c.ctx, s);
  return c.response.setCookies()[0]!.split(';')[0]!;
}

async function open(service: SessionService, cookie: string) {
  const c = makeContext({ headers: { cookie } });
  return { c, s: await service.load(c.ctx) };
}

async function dataOf(service: SessionService, cookie: string): Promise<Record<string, unknown>> {
  return (await service.load(makeContext({ headers: { cookie } }).ctx)).toJSON();
}

describe("storeCommit: 'changes' (the default)", () => {
  it('keeps disjoint keys when the commits do not interleave', async () => {
    const service = await createService(new OrderingStore());
    const cookie = await seeded(service, { userId: 'u1' });
    const a = await open(service, cookie);
    const b = await open(service, cookie);
    a.s.set('a', 1);
    b.s.set('b', 1);
    await service.commit(a.c.ctx, a.s);
    await service.commit(b.c.ctx, b.s);
    expect(await dataOf(service, cookie)).toEqual({ userId: 'u1', a: 1, b: 1 });
  });

  it('loses one of two disjoint keys when the commits interleave between read and write', async () => {
    const store = new OrderingStore();
    const service = await createService(store);
    const cookie = await seeded(service, { userId: 'u1' });
    const a = await open(service, cookie);
    const b = await open(service, cookie);
    a.s.set('a', 1);
    b.s.set('b', 1);
    const hold = store.holdNextRead();
    const committingA = service.commit(a.c.ctx, a.s);
    await hold.read;
    await service.commit(b.c.ctx, b.s);
    hold.release();
    await committingA;
    // The documented one-round-trip loss: A merged onto the row it read before B wrote.
    expect(await dataOf(service, cookie)).toEqual({ userId: 'u1', a: 1 });
  });

  it('keeps a key a concurrent request deleted deleted', async () => {
    const service = await createService(new OrderingStore());
    const cookie = await seeded(service, { userId: 'u1', pending: 'x' });
    const a = await open(service, cookie);
    const b = await open(service, cookie);
    b.s.delete('pending');
    await service.commit(b.c.ctx, b.s);
    a.s.set('cart', 2);
    await service.commit(a.c.ctx, a.s);
    expect(await dataOf(service, cookie)).toEqual({ userId: 'u1', cart: 2 });
  });

  it('writes the payload whole after clear()', async () => {
    const service = await createService(new OrderingStore());
    const cookie = await seeded(service, { userId: 'u1', cart: 1 });
    const a = await open(service, cookie);
    const b = await open(service, cookie);
    b.s.set('z', 1);
    await service.commit(b.c.ctx, b.s);
    a.s.clear();
    a.s.set('k', 1);
    await service.commit(a.c.ctx, a.s);
    expect(await dataOf(service, cookie)).toEqual({ k: 1 });
  });

  it('refuses the commit when the row is gone, and sends no cookie', async () => {
    const store = new OrderingStore();
    const service = await createService(store);
    const cookie = await seeded(service, { userId: 'u1' });
    const a = await open(service, cookie);
    store.rows.clear();
    a.s.set('cart', 1);
    expect(await service.commit(a.c.ctx, a.s)).toBe('refused');
    expect(a.c.response.setCookies()).toEqual([]);
    expect(store.rows.size).toBe(0);
  });

  it('rewrites the current row on a rolling refresh', async () => {
    const service = await createService(new OrderingStore(), { rolling: true });
    const cookie = await seeded(service, { userId: 'u1' });
    const a = await open(service, cookie);
    const b = await open(service, cookie);
    b.s.set('z', 1);
    await service.commit(b.c.ctx, b.s);
    a.s.get('userId');
    expect(await service.commit(a.c.ctx, a.s)).toBe('written');
    expect(await dataOf(service, cookie)).toEqual({ userId: 'u1', z: 1 });
  });

  it('keeps one of K concurrent read-modify-writes of one key (per-key last writer wins)', async () => {
    const service = await createService(new OrderingStore());
    const cookie = await seeded(service, { userId: 'u1' });
    const requests = await Promise.all(Array.from({ length: 10 }, () => open(service, cookie)));
    for (const { s } of requests) s.set('n', (s.get<number>('n') ?? 0) + 1);
    for (const { c, s } of requests) await service.commit(c.ctx, s);
    expect((await dataOf(service, cookie)).n).toBe(1);
  });
});

describe("storeCommit: 'snapshot'", () => {
  it('writes the whole payload, so a concurrent request loses its untouched keys', async () => {
    const service = await createService(new OrderingStore(), { storeCommit: 'snapshot' });
    const cookie = await seeded(service, { userId: 'u1' });
    const a = await open(service, cookie);
    const b = await open(service, cookie);
    a.s.set('a', 1);
    b.s.set('b', 1);
    await service.commit(a.c.ctx, a.s);
    await service.commit(b.c.ctx, b.s);
    expect(await dataOf(service, cookie)).toEqual({ userId: 'u1', b: 1 });
  });
});
