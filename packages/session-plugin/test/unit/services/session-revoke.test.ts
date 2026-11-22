/**
 * The revocation markers and the commit fence, one store step at a time.
 */
import { describe, expect, it } from 'vitest';
import type { ILogger, ISessionStore, SessionData } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import { deriveKeyRing, seal } from '../../../src/codec/crypto.ts';
import type { SessionPluginOptions } from '../../../src/options.ts';
import { resolveSessionConfig } from '../../../src/options.ts';
import { SessionService } from '../../../src/services/session-service.ts';
import { makeClock, makeContext } from '../../fixtures/context.ts';

const SECRET = 's'.repeat(32);
const NOW = 1_700_000_000_000;

type Step = 'write' | 'destroy' | 'read';

/** A map store that logs each call and can fail one step for keys matching a predicate. */
class ScriptedStore implements ISessionStore {
  readonly rows = new Map<string, SessionData>();
  readonly calls: string[] = [];
  failing: { step: Step; key: (id: string) => boolean } | undefined;

  #fail(step: Step, id: string): void {
    if (this.failing?.step === step && this.failing.key(id)) {
      throw new Error(`${step} failed`);
    }
  }

  read(id: string): Promise<SessionData | null> {
    this.calls.push(`read:${id}`);
    try {
      this.#fail('read', id);
    } catch (error) {
      return Promise.reject(error as Error);
    }
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  write(id: string, data: SessionData, _ttlMs: number): Promise<void> {
    this.calls.push(`write:${id}`);
    try {
      this.#fail('write', id);
    } catch (error) {
      return Promise.reject(error as Error);
    }
    this.rows.set(id, data);
    return Promise.resolve();
  }

  destroy(id: string): Promise<boolean> {
    this.calls.push(`destroy:${id}`);
    try {
      this.#fail('destroy', id);
    } catch (error) {
      return Promise.reject(error as Error);
    }
    return Promise.resolve(this.rows.delete(id));
  }
}

async function makeService(store: ISessionStore, options: Partial<SessionPluginOptions> = {}) {
  const clock = makeClock(NOW);
  const config = resolveSessionConfig({ store, storeCommit: 'snapshot', ...options });
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
  return { service, ring, clock, config };
}

async function signedIn(service: SessionService): Promise<{ cookie: string; id: string }> {
  const c = makeContext();
  const s = await service.load(c.ctx);
  s.set('userId', 'u1');
  await service.commit(c.ctx, s);
  return { cookie: c.response.setCookies()[0]!.split(';')[0]!, id: s.id };
}

describe('revocation markers', () => {
  it('a destroy() writes the marker before it deletes the row', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    store.calls.length = 0;
    s.destroy();
    expect(await service.commit(c.ctx, s)).toBe('written');
    // ...and then reads the id's `superseded` marker for a regeneration to follow.
    expect(store.calls).toEqual([`write:revoked:${id}`, `destroy:${id}`, `read:successor:${id}`]);
    expect(store.rows.get(`revoked:${id}`)).toEqual({ __setu_marker: 'revoked' });
  });

  it('a short maxAge still commits a request that took no time', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store, { maxAge: 1 });
    const { cookie } = await signedIn(service);
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    s.set('cart', 1);
    expect(await service.commit(c.ctx, s)).toBe('written');
  });

  it('markers outlive maxAge by a margin, for stores that round a TTL down', async () => {
    const ttls: number[] = [];
    const store = new ScriptedStore();
    const write = store.write.bind(store);
    store.write = (id, data, ttlMs) => {
      if (id.startsWith('revoked:')) ttls.push(ttlMs);
      return write(id, data, ttlMs);
    };
    const { service, config } = await makeService(store);
    const { cookie } = await signedIn(service);
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    s.destroy();
    await service.commit(c.ctx, s);
    expect(ttls).toEqual([config.maxAgeMs + 1000]);
  });

  it('a regeneration refused for outliving every marker still revokes the old id', async () => {
    const store = new ScriptedStore();
    const { service, clock, config } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    s.regenerate();
    clock.advance(config.maxAgeMs);
    expect(await service.commit(c.ctx, s)).toBe('refused');
    expect(store.rows.has(id)).toBe(false);
    expect(store.rows.get(`superseded:${id}`)).toEqual({ __setu_marker: 'superseded' });
  });

  it('a clear() sign-out refused for outliving every marker still revokes the row', async () => {
    const store = new ScriptedStore();
    const { service, clock, config } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    s.clear();
    clock.advance(config.maxAgeMs);
    expect(await service.commit(c.ctx, s)).toBe('refused');
    expect(store.rows.has(id)).toBe(false);
    expect(store.rows.get(`revoked:${id}`)).toEqual({ __setu_marker: 'revoked' });
  });

  it('an ordinary write refused for outliving every marker revokes nothing', async () => {
    const store = new ScriptedStore();
    const { service, clock, config } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    s.set('cart', 1);
    clock.advance(config.maxAgeMs);
    expect(await service.commit(c.ctx, s)).toBe('refused');
    expect(store.rows.has(`revoked:${id}`)).toBe(false);
  });

  it('a committed regeneration links its new id under its own key, then marks the old id', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    s.regenerate();
    store.calls.length = 0;
    expect(await service.commit(c.ctx, s)).toBe('written');
    expect(store.rows.get(`successor:${id}`)).toEqual({ __setu_marker: 'successor', next: s.id });
    expect(store.rows.get(`superseded:${id}`)).toEqual({ __setu_marker: 'superseded' });
    // After the pre-check: the link, then the marker.
    expect(store.calls.slice(1, 3)).toEqual([`write:successor:${id}`, `write:superseded:${id}`]);
  });

  it('a failed link write still marks and deletes the old id, then rethrows', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    s.regenerate();
    store.failing = { step: 'write', key: (k) => k.startsWith('successor:') };
    await expect(service.commit(c.ctx, s)).rejects.toThrow('write failed');
    expect(store.rows.has(id)).toBe(false);
    expect(store.rows.get(`superseded:${id}`)).toEqual({ __setu_marker: 'superseded' });
    expect(store.rows.has(s.id)).toBe(false);
  });

  it('a link fault is the one rethrown when the marker write fails too', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    s.regenerate();
    let call = 0;
    const write = store.write.bind(store);
    store.write = (key, data, ttlMs) => {
      if (key.startsWith('successor:') || key.startsWith('superseded:')) {
        call += 1;
        return Promise.reject(new Error(`fault ${call}`));
      }
      return write(key, data, ttlMs);
    };
    await expect(service.commit(c.ctx, s)).rejects.toThrow('fault 1');
    expect(store.rows.has(id)).toBe(false);
  });

  it("a failed regeneration's cleanup keeps a committed regeneration's link", async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie } = await signedIn(service);
    const logout = makeContext({ headers: { cookie } });
    const ls = await service.load(logout.ctx);
    // R1 regenerates and commits; R2 regenerates and throws, so the middleware cleans up.
    const r1 = makeContext({ headers: { cookie } });
    const s1 = await service.load(r1.ctx);
    const r2 = makeContext({ headers: { cookie } });
    const s2 = await service.load(r2.ctx);
    s1.regenerate();
    expect(await service.commit(r1.ctx, s1)).toBe('written');
    s2.regenerate();
    await service.revokeSuperseded(s2);
    // The sign-out that loaded the old id still ends R1's session.
    ls.destroy();
    await service.commit(logout.ctx, ls);
    expect(store.rows.has(s1.id)).toBe(false);
    expect(store.rows.get(`revoked:${s1.id}`)).toEqual({ __setu_marker: 'revoked' });
  });

  it.each([
    ['a non-string successor', 42],
    ['a marker id as successor', 'revoked:other'],
    ['a link id as successor', 'successor:other'],
  ] as const)('a sign-out ignores %s', async (_name, next) => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    store.rows.set(`successor:${id}`, { __setu_marker: 'successor', next });
    store.rows.set('other', { userId: 'u2' });
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    store.calls.length = 0;
    s.destroy();
    expect(await service.commit(c.ctx, s)).toBe('written');
    expect(store.calls).toEqual([`write:revoked:${id}`, `destroy:${id}`, `read:successor:${id}`]);
    expect(store.rows.has('other')).toBe(true);
  });

  it('a sign-out follows the whole chain of regenerations', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    const chain = Array.from({ length: 12 }, (_v, i) => `succ-${i}`);
    let previous = id;
    for (const next of chain) {
      store.rows.set(`successor:${previous}`, { __setu_marker: 'successor', next });
      store.rows.set(next, { userId: 'u1' });
      previous = next;
    }
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    s.destroy();
    await service.commit(c.ctx, s);
    expect(chain.map((next) => store.rows.has(next))).toEqual(Array<boolean>(12).fill(false));
  });

  it('a sign-out stops at a cycle a corrupt store forms', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    store.rows.set(`successor:${id}`, { __setu_marker: 'successor', next: 'loop' });
    store.rows.set(`successor:loop`, { __setu_marker: 'successor', next: id });
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    s.destroy();
    expect(await service.commit(c.ctx, s)).toBe('written');
    expect(store.rows.get('revoked:loop')).toEqual({ __setu_marker: 'revoked' });
  });

  it('a fault reading the successor fails the sign-out after its own revocation', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    store.failing = { step: 'read', key: (k) => k.startsWith('successor:') };
    s.destroy();
    await expect(service.commit(c.ctx, s)).rejects.toThrow();
    expect(store.rows.has(id)).toBe(false);
    expect(store.rows.get(`revoked:${id}`)).toEqual({ __setu_marker: 'revoked' });
  });

  it('a marker-write failure still deletes the row, then rethrows', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    store.failing = { step: 'write', key: (k) => k.startsWith('revoked:') };
    s.destroy();
    await expect(service.commit(c.ctx, s)).rejects.toThrow('write failed');
    expect(store.rows.has(id)).toBe(false);
  });

  it('a marker-write failure is the error reported even when the delete fails too', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie } = await signedIn(service);
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    store.failing = { step: 'write', key: (k) => k.startsWith('revoked:') };
    const destroy = store.destroy.bind(store);
    store.destroy = () => Promise.reject(new Error('destroy failed'));
    s.destroy();
    await expect(service.commit(c.ctx, s)).rejects.toThrow('write failed');
    store.destroy = destroy;
  });

  it('a delete failure after the marker keeps the marker, which still fences', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    const inflight = makeContext({ headers: { cookie } });
    const inflightSession = await service.load(inflight.ctx);
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    store.failing = { step: 'destroy', key: (k) => k === id };
    s.destroy();
    await expect(service.commit(c.ctx, s)).rejects.toThrow('destroy failed');
    expect(store.rows.has(`revoked:${id}`)).toBe(true);
    store.failing = undefined;
    inflightSession.set('cart', 1);
    expect(await service.commit(inflight.ctx, inflightSession)).toBe('refused');
    expect(store.rows.has(id)).toBe(false);
  });

  it('writes no marker and deletes nothing for a new, cookie-held or never-written id', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    // A new session, destroyed.
    const fresh = makeContext();
    const fs = await service.load(fresh.ctx);
    fs.regenerate();
    fs.destroy();
    await service.commit(fresh.ctx, fs);
    // A cookie-held session (reserved keys only), destroyed after a regenerate().
    const held = makeContext();
    const hs = await service.load(held.ctx);
    hs.set('__csrf', 'token');
    await service.commit(held.ctx, hs);
    const heldCookie = held.response.setCookies()[0]!.split(';')[0]!;
    const again = makeContext({ headers: { cookie: heldCookie } });
    const as = await service.load(again.ctx);
    as.regenerate();
    as.destroy();
    await service.commit(again.ctx, as);
    expect(store.calls).toEqual([]);
  });

  it('a regenerate() supersedes the old id after checking it was not revoked', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    store.calls.length = 0;
    s.regenerate();
    expect(await service.commit(c.ctx, s)).toBe('written');
    expect(store.calls).toEqual([
      `read:revoked:${id}`,
      `write:successor:${id}`,
      `write:superseded:${id}`,
      `destroy:${id}`,
      `write:${s.id}`,
      `read:revoked:${id}`,
    ]);
  });

  it('revokeSuperseded writes a superseded marker for a store-held source only', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    const s = await service.load(makeContext({ headers: { cookie } }).ctx);
    s.regenerate();
    await service.revokeSuperseded(s);
    expect(store.rows.get(`superseded:${id}`)).toEqual({ __setu_marker: 'superseded' });
    store.calls.length = 0;
    const fresh = await service.load(makeContext().ctx);
    fresh.regenerate();
    await service.revokeSuperseded(fresh);
    expect(store.calls).toEqual([]);
  });
});

describe('revokeSuperseded after a logout that throws', () => {
  it('marks the old id revoked when the session was cleared, so an in-flight regenerate is refused', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    const stepUp = makeContext({ headers: { cookie } });
    const su = await service.load(stepUp.ctx);
    const logout = await service.load(makeContext({ headers: { cookie } }).ctx);
    logout.clear();
    logout.regenerate();
    await service.revokeSuperseded(logout);
    expect(store.rows.get(`revoked:${id}`)).toEqual({ __setu_marker: 'revoked' });
    expect(store.rows.has(`superseded:${id}`)).toBe(false);
    su.regenerate();
    expect(await service.commit(stepUp.ctx, su)).toBe('refused');
  });
});

describe('the commit fence', () => {
  it('a marker row without its payload does not count', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    store.rows.set(`revoked:${id}`, {});
    store.rows.set(`superseded:${id}`, { __setu_marker: 'revoked' });
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    s.set('cart', 1);
    expect(await service.commit(c.ctx, s)).toBe('written');
  });

  it('a fence read that throws deletes the commit’s own write and rethrows', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    store.failing = { step: 'read', key: (k) => k.includes(':') };
    s.set('cart', 1);
    await expect(service.commit(c.ctx, s)).rejects.toThrow('read failed');
    expect(store.rows.has(id)).toBe(false);
    expect(c.response.setCookies()).toEqual([]);
  });

  it('a regenerating commit whose pre-check finds its source revoked writes nothing', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    const c = makeContext({ headers: { cookie } });
    const s = await service.load(c.ctx);
    store.rows.set(`revoked:${id}`, { __setu_marker: 'revoked' });
    store.calls.length = 0;
    s.regenerate();
    expect(await service.commit(c.ctx, s)).toBe('refused');
    expect(store.calls).toEqual([`read:revoked:${id}`]);
  });

  it('logs one debug line on refusal, carrying no id', async () => {
    const store = new ScriptedStore();
    const { service } = await makeService(store);
    const { cookie, id } = await signedIn(service);
    const c = makeContext({ headers: { cookie } });
    const lines: unknown[][] = [];
    c.registry.register(CAPABILITIES.LOGGER, {
      debug: (...args: unknown[]) => lines.push(args),
    } as unknown as ILogger);
    const s = await service.load(c.ctx);
    store.rows.set(`revoked:${id}`, { __setu_marker: 'revoked' });
    s.set('cart', 1);
    expect(await service.commit(c.ctx, s)).toBe('refused');
    expect(lines).toEqual([
      ['session commit refused: the session was revoked or superseded during this request'],
    ]);
    expect(JSON.stringify(lines)).not.toContain(id);
  });
});

describe('restore', () => {
  it.each(['revoked', 'superseded'])(
    'refuses a sealed cookie whose id is a %s marker id before any store read',
    async (kind) => {
      const store = new ScriptedStore();
      const { service, ring } = await makeService(store, { restoreRevocationCheck: true });
      const id = `${kind}:00000000-0000-4000-8000-000000000000`;
      store.rows.set(id, { __setu_marker: kind, userId: 'u1' });
      const sealed = await seal(
        crypto.subtle,
        ring,
        JSON.stringify({ id, data: {}, exp: NOW + 60_000, seen: NOW }),
        (n) => crypto.getRandomValues(new Uint8Array(n)),
      );
      const s = await service.load(
        makeContext({ headers: { cookie: `setu_session=${sealed}` } }).ctx,
      );
      expect(s.isNew).toBe(true);
      expect(store.calls).toEqual([]);
    },
  );
});
