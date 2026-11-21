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
  return { service, ring };
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
    expect(store.calls).toEqual([`write:revoked:${id}`, `destroy:${id}`]);
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
