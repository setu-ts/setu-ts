/**
 * A `destroy()` or `regenerate()` on the store strategy stays in force whatever request on that
 * session was already in flight (V13-135, V13-136). Each race runs 50 times on the memory store and
 * on the cache store over cache-plugin's memory cache, under both `storeCommit` modes: a `'changes'`
 * commit also refuses when it finds the row gone, so `'snapshot'` is what isolates the marker fence.
 */
import { describe, expect, it } from 'vitest';
import type { ISessionStore, SessionData } from '@setu-ts/common';
import { MemoryStore } from '@setu-ts/cache-plugin';

import { deriveKeyRing } from '../../src/codec/crypto.ts';
import type { SessionPluginOptions } from '../../src/options.ts';
import { resolveSessionConfig } from '../../src/options.ts';
import { SessionService } from '../../src/services/session-service.ts';
import { CacheSessionStore } from '../../src/stores/cache-session-store.ts';
import { MemorySessionStore } from '../../src/stores/memory-session-store.ts';
import { makeClock, makeContext } from '../fixtures/context.ts';

const SECRET = 's'.repeat(32);
const RUNS = 50;

type StoreFactory = () => Promise<ISessionStore>;

const STORES: ReadonlyArray<readonly [string, StoreFactory]> = [
  [
    'memory store',
    () =>
      Promise.resolve(
        new MemorySessionStore({
          now: () => 1_000,
          setInterval: () => 0 as never,
          clearInterval: () => {},
        }),
      ),
  ],
  [
    'cache store over the memory cache',
    async () => {
      const cache = new MemoryStore('');
      await cache.connect();
      return new CacheSessionStore(cache);
    },
  ],
];

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

function cookieOf(setCookies: readonly string[]): string {
  return setCookies[0]!.split(';')[0]!;
}

async function signedIn(service: SessionService): Promise<string> {
  const c = makeContext();
  const s = await service.load(c.ctx);
  s.set('userId', 'u1');
  await service.commit(c.ctx, s);
  return cookieOf(c.response.setCookies());
}

async function userOf(service: SessionService, cookie: string): Promise<unknown> {
  return (await service.load(makeContext({ headers: { cookie } }).ctx)).get('userId');
}

const CASES = STORES.flatMap(([name, make]) =>
  (['changes', 'snapshot'] as const).map((mode) => [name, mode, make] as const),
);

describe.each(CASES)('revocation races on the %s, %s commits', (_name, storeCommit, makeStore) => {
  it('destroy() is not undone by an in-flight write', async () => {
    let resurrected = 0;
    let replanted = 0;
    for (let i = 0; i < RUNS; i++) {
      const service = await createService(await makeStore(), { storeCommit });
      const cookie = await signedIn(service);
      const inflight = makeContext({ headers: { cookie } });
      const inflightSession = await service.load(inflight.ctx);
      const logout = makeContext({ headers: { cookie } });
      const ls = await service.load(logout.ctx);
      ls.destroy();
      await service.commit(logout.ctx, ls);
      inflightSession.set('cart', i);
      expect(await service.commit(inflight.ctx, inflightSession)).toBe('refused');
      if (inflight.response.setCookies().length > 0) replanted++;
      if ((await userOf(service, cookie)) === 'u1') resurrected++;
    }
    expect(resurrected).toBe(0);
    expect(replanted).toBe(0);
  });

  it('destroy() is not undone by an in-flight rolling read', async () => {
    let resurrected = 0;
    for (let i = 0; i < RUNS; i++) {
      const service = await createService(await makeStore(), { rolling: true, storeCommit });
      const cookie = await signedIn(service);
      const inflight = makeContext({ headers: { cookie } });
      const inflightSession = await service.load(inflight.ctx);
      const logout = makeContext({ headers: { cookie } });
      const ls = await service.load(logout.ctx);
      ls.destroy();
      await service.commit(logout.ctx, ls);
      inflightSession.get('userId');
      await service.commit(inflight.ctx, inflightSession);
      expect(inflight.response.setCookies()).toEqual([]);
      if ((await userOf(service, cookie)) === 'u1') resurrected++;
    }
    expect(resurrected).toBe(0);
  });

  it('regenerate() is not undone by an in-flight write', async () => {
    let resurrected = 0;
    for (let i = 0; i < RUNS; i++) {
      const service = await createService(await makeStore(), { storeCommit });
      const oldCookie = await signedIn(service);
      const inflight = makeContext({ headers: { cookie: oldCookie } });
      const inflightSession = await service.load(inflight.ctx);
      const stepUp = makeContext({ headers: { cookie: oldCookie } });
      const su = await service.load(stepUp.ctx);
      su.regenerate();
      su.set('mfa', true);
      expect(await service.commit(stepUp.ctx, su)).toBe('written');
      inflightSession.set('cart', i);
      expect(await service.commit(inflight.ctx, inflightSession)).toBe('refused');
      expect(inflight.response.setCookies()).toEqual([]);
      if ((await userOf(service, oldCookie)) === 'u1') resurrected++;
      // The step-up's new id is untouched.
      expect(await userOf(service, cookieOf(stepUp.response.setCookies()))).toBe('u1');
    }
    expect(resurrected).toBe(0);
  });

  it('an in-flight regenerate() cannot carry a logged-out session to a new id', async () => {
    let signedInNewId = 0;
    for (let i = 0; i < RUNS; i++) {
      const service = await createService(await makeStore(), { storeCommit });
      const cookie = await signedIn(service);
      const signIn = makeContext({ headers: { cookie } });
      const si = await service.load(signIn.ctx);
      const logout = makeContext({ headers: { cookie } });
      const ls = await service.load(logout.ctx);
      ls.destroy();
      await service.commit(logout.ctx, ls);
      si.regenerate();
      si.set('stepUp', true);
      expect(await service.commit(signIn.ctx, si)).toBe('refused');
      expect(signIn.response.setCookies()).toEqual([]);
      if ((await userOf(service, cookie)) === 'u1') signedInNewId++;
    }
    expect(signedInNewId).toBe(0);
  });

  it('a logout by clear() and regenerate() is not undone by an in-flight regenerate()', async () => {
    let signedInNewId = 0;
    for (let i = 0; i < RUNS; i++) {
      const service = await createService(await makeStore(), { storeCommit });
      const cookie = await signedIn(service);
      const stepUp = makeContext({ headers: { cookie } });
      const su = await service.load(stepUp.ctx);
      const logout = makeContext({ headers: { cookie } });
      const ls = await service.load(logout.ctx);
      ls.clear();
      ls.regenerate();
      await service.commit(logout.ctx, ls);
      su.regenerate();
      su.set('mfa', true);
      expect(await service.commit(stepUp.ctx, su)).toBe('refused');
      expect(stepUp.response.setCookies()).toEqual([]);
      if ((await userOf(service, cookie)) === 'u1') signedInNewId++;
    }
    expect(signedInNewId).toBe(0);
  });
});

/** A store whose next `write` of a given id pauses after it lands, until released. */
class PausingStore implements ISessionStore {
  readonly #inner: ISessionStore;
  #armed = false;
  #landed: () => void = () => {};
  #release: () => void = () => {};
  #gate: Promise<void> = Promise.resolve();

  constructor(inner: ISessionStore) {
    this.#inner = inner;
  }

  /** Arms a pause on the next write of a non-marker id; resolves when that write has landed. */
  pauseNextWrite(): { landed: Promise<void>; release: () => void } {
    this.#armed = true;
    const landed = new Promise<void>((resolve) => {
      this.#landed = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    this.#gate = gate;
    return { landed, release: () => this.#release() };
  }

  read(id: string): Promise<SessionData | null> {
    return this.#inner.read(id);
  }

  async write(id: string, data: SessionData, ttlMs: number): Promise<void> {
    await this.#inner.write(id, data, ttlMs);
    if (this.#armed && !id.includes(':')) {
      this.#armed = false;
      this.#landed();
      await this.#gate;
    }
  }

  destroy(id: string): Promise<boolean> {
    return this.#inner.destroy(id);
  }
}

describe('the one-round-trip window', () => {
  async function windowRace(restoreRevocationCheck: boolean): Promise<unknown> {
    const store = new PausingStore(
      new MemorySessionStore({
        now: () => 1_000,
        setInterval: () => 0 as never,
        clearInterval: () => {},
      }),
    );
    // 'snapshot' mode: a 'changes' commit reads the row first and refuses when it is gone.
    const service = await createService(store, { restoreRevocationCheck, storeCommit: 'snapshot' });
    const cookie = await signedIn(service);
    const inflight = makeContext({ headers: { cookie } });
    const inflightSession = await service.load(inflight.ctx);
    const logout = makeContext({ headers: { cookie } });
    const ls = await service.load(logout.ctx);
    ls.destroy();
    await service.commit(logout.ctx, ls);
    // The racing commit writes the revoked row back and pauses between its write and its fence.
    inflightSession.set('cart', 1);
    const pause = store.pauseNextWrite();
    const committing = service.commit(inflight.ctx, inflightSession);
    await pause.landed;
    // A request that starts after destroy() returned, during the pause.
    const during = await userOf(service, cookie);
    pause.release();
    expect(await committing).toBe('refused');
    // After the fence, nothing restores whatever the option.
    expect(await userOf(service, cookie)).toBeUndefined();
    return during;
  }

  it('by default a request started during a racing commit restores the session (the window)', async () => {
    expect(await windowRace(false)).toBe('u1');
  });

  it('with restoreRevocationCheck it restores nothing', async () => {
    expect(await windowRace(true)).toBeUndefined();
  });
});

describe('an evicted marker', () => {
  it('reverts that revocation to an unfenced write, as the README documents', async () => {
    const cache = new MemoryStore('');
    await cache.connect();
    const store = new CacheSessionStore(cache);
    const service = await createService(store, { storeCommit: 'snapshot' });
    const cookie = await signedIn(service);
    const inflight = makeContext({ headers: { cookie } });
    const inflightSession = await service.load(inflight.ctx);
    const logout = makeContext({ headers: { cookie } });
    const ls = await service.load(logout.ctx);
    ls.destroy();
    await service.commit(logout.ctx, ls);
    // An evicting cache drops the marker, the coldest entry.
    expect(await cache.delete(`session:revoked:${inflightSession.id}`)).toBe(true);
    inflightSession.set('cart', 1);
    expect(await service.commit(inflight.ctx, inflightSession)).toBe('written');
    expect(await userOf(service, cookie)).toBe('u1');
  });
});

/** A store that pauses after the `nth` read of one id, until released. */
class ReadPausingStore implements ISessionStore {
  readonly #inner: ISessionStore;
  #target: { id: string; remaining: number } | undefined;
  #landed: () => void = () => {};
  #gate: Promise<void> = Promise.resolve();
  #release: () => void = () => {};

  constructor(inner: ISessionStore) {
    this.#inner = inner;
  }

  pauseAfterRead(id: string, nth: number): { landed: Promise<void>; release: () => void } {
    this.#target = { id, remaining: nth };
    const landed = new Promise<void>((resolve) => {
      this.#landed = resolve;
    });
    this.#gate = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    return { landed, release: () => this.#release() };
  }

  async read(id: string): Promise<SessionData | null> {
    const row = await this.#inner.read(id);
    if (this.#target?.id === id && --this.#target.remaining === 0) {
      this.#target = undefined;
      this.#landed();
      await this.#gate;
    }
    return row;
  }

  write(id: string, data: SessionData, ttlMs: number): Promise<void> {
    return this.#inner.write(id, data, ttlMs);
  }

  destroy(id: string): Promise<boolean> {
    return this.#inner.destroy(id);
  }
}

const memoryStore = (): MemorySessionStore =>
  new MemorySessionStore({
    now: () => 1_000,
    setInterval: () => 0 as never,
    clearInterval: () => {},
  });

describe('a sign-out racing a regeneration past its fence', () => {
  it('also ends the session the regeneration moved to', async () => {
    const store = new ReadPausingStore(memoryStore());
    const service = await createService(store);
    const cookie = await signedIn(service);
    // The sign-out request loaded the old id before the regeneration superseded it.
    const logout = makeContext({ headers: { cookie } });
    const ls = await service.load(logout.ctx);
    const stepUp = makeContext({ headers: { cookie } });
    const su = await service.load(stepUp.ctx);
    su.regenerate();
    // The regeneration reads `revoked:<old>` twice (pre-check, fence): pause after the fence.
    const pause = store.pauseAfterRead(`revoked:${su.loadedId}`, 2);
    const committing = service.commit(stepUp.ctx, su);
    await pause.landed;
    ls.destroy();
    await service.commit(logout.ctx, ls);
    pause.release();
    expect(await committing).toBe('written');
    expect(await userOf(service, cookieOf(stepUp.response.setCookies()))).toBeUndefined();
  });
});

describe('a commit that outlives every marker', () => {
  it('is refused, so a sign-out whose marker has expired still holds', async () => {
    const store = memoryStore();
    const clock = makeClock();
    const config = resolveSessionConfig({
      mode: 'encrypt',
      store,
      storeCommit: 'snapshot',
      rolling: true,
    });
    const ring = await deriveKeyRing(crypto.subtle, [SECRET], 'encrypt');
    const service = new SessionService(
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
    const cookie = await signedIn(service);
    const inflight = makeContext({ headers: { cookie } });
    const inflightSession = await service.load(inflight.ctx);
    const logout = makeContext({ headers: { cookie } });
    const ls = await service.load(logout.ctx);
    ls.destroy();
    await service.commit(logout.ctx, ls);
    // The marker's lifetime passes (its TTL is `maxAgeMs`) while the request is still running.
    await store.destroy(`revoked:${inflightSession.id}`);
    clock.advance(config.maxAgeMs);
    expect(await service.commit(inflight.ctx, inflightSession)).toBe('refused');
    expect(await userOf(service, cookie)).toBeUndefined();
  });
});

describe('a commit that stalls past every marker after its age check', () => {
  async function stalledService() {
    const store = new PausingStore(memoryStore());
    const clock = makeClock();
    const config = resolveSessionConfig({
      mode: 'encrypt',
      store,
      storeCommit: 'snapshot',
      rolling: true,
    });
    const ring = await deriveKeyRing(crypto.subtle, [SECRET], 'encrypt');
    const service = new SessionService(
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
    return { store, clock, config, service };
  }

  it('is refused at its fence and leaves no row', async () => {
    const { store, clock, config, service } = await stalledService();
    const cookie = await signedIn(service);
    const inflight = makeContext({ headers: { cookie } });
    const inflightSession = await service.load(inflight.ctx);
    const logout = makeContext({ headers: { cookie } });
    const ls = await service.load(logout.ctx);
    ls.destroy();
    await service.commit(logout.ctx, ls);
    // The commit passes its age check, writes, and stalls; meanwhile the marker's lifetime passes.
    inflightSession.set('cart', 1);
    const pause = store.pauseNextWrite();
    const committing = service.commit(inflight.ctx, inflightSession);
    await pause.landed;
    await store.destroy(`revoked:${inflightSession.id}`);
    clock.advance(config.maxAgeMs);
    pause.release();
    expect(await committing).toBe('refused');
    expect(await store.read(inflightSession.id)).toBeNull();
  });

  // No marker can tell a stalled commit whether its session was signed out, so it ends the session
  // under a `revoked` marker: a concurrent commit and a regeneration in another tab are refused.
  it('ends an unrevoked session; a concurrent commit and a regeneration are refused', async () => {
    const { store, clock, config, service } = await stalledService();
    const cookie = await signedIn(service);
    const inflight = makeContext({ headers: { cookie } });
    const inflightSession = await service.load(inflight.ctx);
    inflightSession.set('cart', 1);
    const pause = store.pauseNextWrite();
    const committing = service.commit(inflight.ctx, inflightSession);
    await pause.landed;
    // Two requests that load during the stall, well inside their own windows.
    clock.advance(config.maxAgeMs - 1000);
    const other = makeContext({ headers: { cookie } });
    const otherSession = await service.load(other.ctx);
    const stepUp = makeContext({ headers: { cookie } });
    const stepUpSession = await service.load(stepUp.ctx);
    clock.advance(1000);
    pause.release();
    expect(await committing).toBe('refused');
    expect(await store.read(inflightSession.id)).toBeNull();
    expect(await store.read(`revoked:${inflightSession.id}`)).toEqual({ __setu_marker: 'revoked' });
    otherSession.set('cart', 2);
    expect(await service.commit(other.ctx, otherSession)).toBe('refused');
    // A regeneration cannot carry a row the stalled write may have put back to a new id.
    stepUpSession.regenerate();
    expect(await service.commit(stepUp.ctx, stepUpSession)).toBe('refused');
  });

  it('a stale fence follows no successor link: it signed nobody out', async () => {
    const { store, clock, config, service } = await stalledService();
    const cookie = await signedIn(service);
    const inflight = makeContext({ headers: { cookie } });
    const inflightSession = await service.load(inflight.ctx);
    await store.write(
      `successor:${inflightSession.id}`,
      { __setu_marker: 'successor', next: 'elsewhere' },
      60_000,
    );
    await store.write('elsewhere', { userId: 'u1' }, 60_000);
    inflightSession.set('cart', 1);
    const pause = store.pauseNextWrite();
    const committing = service.commit(inflight.ctx, inflightSession);
    await pause.landed;
    clock.advance(config.maxAgeMs);
    pause.release();
    expect(await committing).toBe('refused');
    expect(await store.read('elsewhere')).toEqual({ userId: 'u1' });
  });

  it('a stalled regeneration deletes only its new row', async () => {
    const { store, clock, config, service } = await stalledService();
    const cookie = await signedIn(service);
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    const oldId = s.id;
    s.regenerate();
    const pause = store.pauseNextWrite();
    const committing = service.commit(c.ctx, s);
    await pause.landed;
    clock.advance(config.maxAgeMs);
    pause.release();
    expect(await committing).toBe('refused');
    expect(await store.read(s.id)).toBeNull();
    expect(await store.read(oldId)).toBeNull();
    expect(await store.read(`superseded:${oldId}`)).toEqual({ __setu_marker: 'superseded' });
    expect(await store.read(`revoked:${oldId}`)).toBeNull();
  });
});
