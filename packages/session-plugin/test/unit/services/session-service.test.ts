/**
 * Unit tests for SessionService: the accessor, and load/commit on both strategies.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { ISessionStore, SessionData } from '@setu-ts/common';

import { deriveKeyRing } from '../../../src/codec/crypto.ts';
import type { SessionMode } from '../../../src/codec/crypto.ts';
import { SessionMiddlewareMissingError, SessionTooLargeError } from '../../../src/errors.ts';
import { resolveSessionConfig } from '../../../src/options.ts';
import type { SessionPluginOptions } from '../../../src/options.ts';
import { SESSION_STATE_KEY, SessionService } from '../../../src/services/session-service.ts';
import { getSession } from '../../../src/services/get-session.ts';
import { makeClock, makeContext } from '../../fixtures/context.ts';

const SECRET = 's'.repeat(32);
const NOW = 1_700_000_000_000;

/** A recording store, so writes are asserted rather than assumed. */
class RecordingStore implements ISessionStore {
  readonly entries = new Map<string, SessionData>();
  readonly calls: string[] = [];
  healthy: boolean | undefined = true;

  read(id: string): Promise<SessionData | null> {
    this.calls.push(`read:${id}`);
    return Promise.resolve(this.entries.get(id) ?? null);
  }

  write(id: string, data: SessionData, ttlMs: number): Promise<void> {
    this.calls.push(`write:${id}:${ttlMs}`);
    this.entries.set(id, data);
    return Promise.resolve();
  }

  destroy(id: string): Promise<boolean> {
    this.calls.push(`destroy:${id}`);
    return Promise.resolve(this.entries.delete(id));
  }

  isHealthy(): Promise<boolean> {
    return Promise.resolve(this.healthy ?? true);
  }
}

/** Builds a service with an injected clock. */
async function makeService(
  options: SessionPluginOptions = {},
  store?: ISessionStore,
  mode: SessionMode = 'encrypt',
) {
  const clock = makeClock(NOW);
  const config = resolveSessionConfig({ ...options, mode });
  const ring = await deriveKeyRing(crypto.subtle, [SECRET], mode);
  const service = new SessionService(config, ring, {
    subtle: crypto.subtle,
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    now: clock.now,
    uuid: clock.uuid,
  }, store);
  return { service, clock, config };
}

/** Extracts the sealed cookie value from an emitted Set-Cookie header. */
function cookieValue(header: string): string {
  return decodeURIComponent(header.split(';')[0].split('=').slice(1).join('='));
}

describe('SessionService.from', () => {
  it('returns the session the middleware parked in ctx.state', async () => {
    const { service } = await makeService();
    const { ctx } = makeContext();
    const session = await service.load(ctx);
    ctx.state.set(SESSION_STATE_KEY, session);

    expect(service.from(ctx)).toBe(session);
  });

  it('throws when the middleware never ran', async () => {
    const { service } = await makeService();
    const { ctx } = makeContext();
    expect(() => service.from(ctx)).toThrow(SessionMiddlewareMissingError);
  });
});

describe('getSession free function', () => {
  it('resolves the service from the registry and returns the same instance', async () => {
    const { service } = await makeService();
    const { ctx, registry } = makeContext();
    registry.register(CAPABILITIES.SESSION, service);

    const session = await service.load(ctx);
    ctx.state.set(SESSION_STATE_KEY, session);

    // The one-implementation property: the free function and the service method
    // hand back the identical object.
    expect(getSession(ctx)).toBe(session);
    expect(getSession(ctx)).toBe(service.from(ctx));
  });

  it('propagates the missing-middleware error', async () => {
    const { service } = await makeService();
    const { ctx, registry } = makeContext();
    registry.register(CAPABILITIES.SESSION, service);
    expect(() => getSession(ctx)).toThrow(SessionMiddlewareMissingError);
  });

  it('propagates an unregistered-capability error', () => {
    const { ctx } = makeContext();
    expect(() => getSession(ctx)).toThrow();
  });
});

describe('SessionService descriptive getters', () => {
  it('reports the cookie strategy when no store is configured', async () => {
    const { service } = await makeService();
    expect(service.strategy).toBe('cookie');
    expect(service.mode).toBe('encrypt');
    expect(service.keyCount).toBe(1);
  });

  it('reports the store strategy and the mode when configured', async () => {
    const { service } = await makeService({}, new RecordingStore(), 'sign');
    expect(service.strategy).toBe('store');
    expect(service.mode).toBe('sign');
  });
});

describe('SessionService.load', () => {
  it('creates a fresh session when there is no cookie', async () => {
    const { service } = await makeService();
    const session = await service.load(makeContext().ctx);
    expect(session.isNew).toBe(true);
  });

  it('creates a fresh session for an empty cookie value', async () => {
    const { service } = await makeService();
    const { ctx } = makeContext({ headers: { cookie: 'hono_session=' } });
    expect((await service.load(ctx)).isNew).toBe(true);
  });

  it('creates a fresh session for an unrelated cookie', async () => {
    const { service } = await makeService();
    const { ctx } = makeContext({ headers: { cookie: 'other=value' } });
    expect((await service.load(ctx)).isNew).toBe(true);
  });

  it('restores a session written by commit', async () => {
    const { service } = await makeService();

    const write = makeContext();
    const first = await service.load(write.ctx);
    first.set('userId', 'u-1');
    await service.commit(write.ctx, first);

    const header = write.response.setCookies()[0];
    const read = makeContext({ headers: { cookie: header.split(';')[0] } });
    const restored = await service.load(read.ctx);

    expect(restored.isNew).toBe(false);
    expect(restored.get<string>('userId')).toBe('u-1');
    expect(restored.id).toBe(first.id);
  });

  it('falls back to a fresh session when the payload shape is wrong', async () => {
    // Sealed with the right key, so it opens — but its shape is not a snapshot.
    const { service } = await makeService();
    const { seal } = await import('../../../src/codec/crypto.ts');
    const ring = await deriveKeyRing(crypto.subtle, [SECRET], 'encrypt');
    const bogus = await seal(
      crypto.subtle,
      ring,
      JSON.stringify({ unexpected: true }),
      (n) => crypto.getRandomValues(new Uint8Array(n)),
    );

    const { ctx } = makeContext({
      headers: { cookie: `hono_session=${encodeURIComponent(bogus)}` },
    });
    expect((await service.load(ctx)).isNew).toBe(true);
  });

  it('honours a custom cookie name', async () => {
    const { service } = await makeService({ cookie: { name: 'sid' } });
    const write = makeContext();
    const session = await service.load(write.ctx);
    session.set('a', 1);
    await service.commit(write.ctx, session);

    const header = write.response.setCookies()[0];
    expect(header.startsWith('sid=')).toBe(true);

    const read = makeContext({ headers: { cookie: header.split(';')[0] } });
    expect((await service.load(read.ctx)).get<number>('a')).toBe(1);
  });

  describe('store strategy', () => {
    it('reads the payload from the store, not the cookie', async () => {
      const store = new RecordingStore();
      const { service } = await makeService({}, store);

      const write = makeContext();
      const session = await service.load(write.ctx);
      session.set('secret', 'value');
      await service.commit(write.ctx, session);

      const header = write.response.setCookies()[0];
      // The cookie must not carry the payload.
      expect(cookieValue(header)).not.toContain('value');
      expect(store.entries.get(session.id)).toEqual({ secret: 'value' });

      const read = makeContext({ headers: { cookie: header.split(';')[0] } });
      expect((await service.load(read.ctx)).get<string>('secret')).toBe('value');
    });

    it('treats a cookie whose store entry is gone as no session', async () => {
      const store = new RecordingStore();
      const { service } = await makeService({}, store);

      const write = makeContext();
      const session = await service.load(write.ctx);
      session.set('a', 1);
      await service.commit(write.ctx, session);
      const header = write.response.setCookies()[0];

      // Server-side revocation.
      store.entries.clear();

      const read = makeContext({ headers: { cookie: header.split(';')[0] } });
      const restored = await service.load(read.ctx);
      expect(restored.isNew).toBe(true);
      expect(restored.get('a')).toBe(undefined);
    });
  });
});

describe('SessionService.commit', () => {
  it('emits nothing for a clean session', async () => {
    const { service } = await makeService();
    const { ctx, response } = makeContext();
    const session = await service.load(ctx);

    await service.commit(ctx, session);
    expect(response.setCookies().length).toBe(0);
  });

  it('emits exactly one cookie for a dirty session', async () => {
    const { service } = await makeService();
    const { ctx, response } = makeContext();
    const session = await service.load(ctx);
    session.set('a', 1);

    await service.commit(ctx, session);
    expect(response.setCookies().length).toBe(1);
  });

  it('emits a cookie for a regenerated but otherwise unchanged session', async () => {
    const { service } = await makeService();
    const { ctx, response } = makeContext();
    const session = await service.load(ctx);
    session.regenerate();

    await service.commit(ctx, session);
    expect(response.setCookies().length).toBe(1);
  });

  it('emits a deletion cookie and skips the payload when destroyed', async () => {
    const { service } = await makeService();
    const { ctx, response } = makeContext();
    const session = await service.load(ctx);
    session.set('a', 1);
    session.destroy();

    await service.commit(ctx, session);
    const header = response.setCookies()[0];
    expect(header).toContain('Max-Age=0');
    expect(cookieValue(header)).toBe('');
  });

  it('records activity on commit', async () => {
    const { service, clock } = await makeService();
    const { ctx } = makeContext();
    const session = await service.load(ctx);
    session.set('a', 1);

    clock.advance(5_000);
    await service.commit(ctx, session);
    expect(session.lastSeen).toBe(NOW + 5_000);
  });

  describe('rolling', () => {
    it('does not extend expiry when rolling is off', async () => {
      const { service, clock } = await makeService({ rolling: false, maxAge: 100 });
      const { ctx } = makeContext();
      const session = await service.load(ctx);
      const originalExp = session.expiresAt;
      session.set('a', 1);

      clock.advance(10_000);
      await service.commit(ctx, session);
      expect(session.expiresAt).toBe(originalExp);
    });

    it('extends expiry when rolling is on', async () => {
      const { service, clock } = await makeService({ rolling: true, maxAge: 100 });
      const { ctx } = makeContext();
      const session = await service.load(ctx);
      session.set('a', 1);

      clock.advance(10_000);
      await service.commit(ctx, session);
      expect(session.expiresAt).toBe(NOW + 10_000 + 100_000);
    });

    it('re-issues a clean restored session when rolling', async () => {
      const { service } = await makeService({ rolling: true });

      const write = makeContext();
      const session = await service.load(write.ctx);
      session.set('a', 1);
      await service.commit(write.ctx, session);
      const header = write.response.setCookies()[0];

      const read = makeContext({ headers: { cookie: header.split(';')[0] } });
      const restored = await service.load(read.ctx);
      expect(restored.isDirty).toBe(false);

      await service.commit(read.ctx, restored);
      // Rolling commits an untouched restored session, which is the point.
      expect(read.response.setCookies().length).toBe(1);
    });

    it('does not re-issue a brand-new clean session even when rolling', async () => {
      const { service } = await makeService({ rolling: true });
      const { ctx, response } = makeContext();
      const session = await service.load(ctx);

      await service.commit(ctx, session);
      // Nothing to persist, so no cookie on an anonymous request.
      expect(response.setCookies().length).toBe(0);
    });
  });

  describe('store strategy', () => {
    it('writes the payload with a millisecond TTL', async () => {
      const store = new RecordingStore();
      const { service } = await makeService({ maxAge: 60 }, store);
      const { ctx } = makeContext();
      const session = await service.load(ctx);
      session.set('a', 1);

      await service.commit(ctx, session);
      expect(store.calls).toContain(`write:${session.id}:60000`);
    });

    it('deletes the superseded entry after regeneration', async () => {
      const store = new RecordingStore();
      const { service } = await makeService({}, store);

      const write = makeContext();
      const session = await service.load(write.ctx);
      session.set('a', 1);
      await service.commit(write.ctx, session);
      const firstId = session.id;
      const header = write.response.setCookies()[0];

      const next = makeContext({ headers: { cookie: header.split(';')[0] } });
      const restored = await service.load(next.ctx);
      restored.regenerate();
      await service.commit(next.ctx, restored);

      expect(store.calls).toContain(`destroy:${firstId}`);
      expect(store.entries.has(firstId)).toBe(false);
      expect(store.entries.has(restored.id)).toBe(true);
    });

    it('deletes the entry on destroy', async () => {
      const store = new RecordingStore();
      const { service } = await makeService({}, store);
      const { ctx } = makeContext();
      const session = await service.load(ctx);
      session.destroy();

      await service.commit(ctx, session);
      expect(store.calls).toContain(`destroy:${session.id}`);
    });

    it('deletes BOTH ids when a regenerated session is destroyed in the same request', async () => {
      const store = new RecordingStore();
      const { service } = await makeService({}, store);

      const write = makeContext();
      const first = await service.load(write.ctx);
      first.set('a', 1);
      await service.commit(write.ctx, first);
      const originalId = first.id;
      const header = write.response.setCookies()[0];

      const next = makeContext({ headers: { cookie: header.split(';')[0] } });
      const restored = await service.load(next.ctx);
      restored.regenerate();
      restored.destroy();
      await service.commit(next.ctx, restored);

      // The pre-regeneration row must not outlive the destroy: the cookie the
      // client presented still carries `originalId`, so a stolen copy of it
      // would keep authenticating until the row's TTL expired.
      expect(store.calls).toContain(`destroy:${originalId}`);
      expect(store.entries.has(originalId)).toBe(false);
      expect(store.entries.size).toBe(0);
    });
  });

  it('throws rather than emitting a cookie the browser would drop', async () => {
    const { service } = await makeService({ maxCookieBytes: 200 });
    const { ctx, response } = makeContext();
    const session = await service.load(ctx);
    session.set('bulk', 'x'.repeat(500));

    await expect(service.commit(ctx, session)).rejects.toThrow(SessionTooLargeError);
    expect(response.setCookies().length).toBe(0);
  });

  it('leaves no stored row behind when the cookie is rejected as too large', async () => {
    const store = new RecordingStore();
    const { service } = await makeService({ maxCookieBytes: 120 }, store);
    const { ctx } = makeContext();
    const session = await service.load(ctx);
    session.set('bulk', 'x'.repeat(500));

    await expect(service.commit(ctx, session)).rejects.toThrow(SessionTooLargeError);

    // The size guard runs before the store write, so a rejected commit persists
    // nothing — otherwise the row would sit unreachable for its whole TTL.
    expect(store.calls.filter((c) => c.startsWith('write:'))).toEqual([]);
    expect(store.entries.size).toBe(0);
  });
});

describe('idleTimeoutMs', () => {
  it('refreshes the idle window on a read-only request, so an active user stays signed in', async () => {
    const { service, clock } = await makeService({ idleTimeoutMs: 60_000, maxAge: 86_400 });

    const write = makeContext();
    const session = await service.load(write.ctx);
    session.set('user', 'alice');
    await service.commit(write.ctx, session);
    let cookie = write.response.setCookies()[0].split(';')[0];

    // Five read-only requests at 30s intervals: continuously active, always
    // well inside the 60s idle window. `seen` advances only on commit, so
    // without committing here the third request would load a fresh session.
    for (let i = 0; i < 5; i++) {
      clock.advance(30_000);
      const read = makeContext({ headers: { cookie } });
      const restored = await service.load(read.ctx);
      expect(restored.isNew, `request ${i + 1} at ${(i + 1) * 30}s`).toBe(false);
      restored.get('user');
      await service.commit(read.ctx, restored);
      const emitted = read.response.setCookies()[0];
      if (emitted !== undefined) {
        cookie = emitted.split(';')[0];
      }
    }
  });

  it('still expires a session that really has been idle', async () => {
    const { service, clock } = await makeService({ idleTimeoutMs: 60_000, maxAge: 86_400 });

    const write = makeContext();
    const session = await service.load(write.ctx);
    session.set('user', 'alice');
    await service.commit(write.ctx, session);
    const cookie = write.response.setCookies()[0].split(';')[0];

    clock.advance(60_001);
    const read = makeContext({ headers: { cookie } });
    expect((await service.load(read.ctx)).isNew).toBe(true);
  });

  it('refreshes the idle window without extending absolute expiry', async () => {
    const { service, clock } = await makeService({ idleTimeoutMs: 60_000, maxAge: 100 });

    const write = makeContext();
    const session = await service.load(write.ctx);
    const originalExp = session.expiresAt;
    session.set('a', 1);
    await service.commit(write.ctx, session);
    const cookie = write.response.setCookies()[0].split(';')[0];

    clock.advance(30_000);
    const read = makeContext({ headers: { cookie } });
    const restored = await service.load(read.ctx);
    await service.commit(read.ctx, restored);

    // `maxAge` stays absolute unless `rolling` is on — refreshing idleness must
    // not silently turn every session into a rolling one.
    expect(restored.expiresAt).toBe(originalExp);
  });

  it('does not commit a brand-new clean session, so anonymous requests get no cookie', async () => {
    const { service } = await makeService({ idleTimeoutMs: 60_000 });
    const { ctx, response } = makeContext();
    const session = await service.load(ctx);

    await service.commit(ctx, session);
    expect(response.setCookies().length).toBe(0);
  });
});

describe('SessionService.storeHealth / close', () => {
  it('reports undefined with no store', async () => {
    const { service } = await makeService();
    expect(await service.storeHealth()).toBe(undefined);
    await service.close();
  });

  it('reports the store’s own health', async () => {
    const store = new RecordingStore();
    const { service } = await makeService({}, store);
    expect(await service.storeHealth()).toBe(true);

    store.healthy = false;
    expect(await service.storeHealth()).toBe(false);
  });

  it('reports undefined when the store exposes no check', async () => {
    const bare: ISessionStore = {
      read: () => Promise.resolve(null),
      write: () => Promise.resolve(),
      destroy: () => Promise.resolve(false),
    };
    const { service } = await makeService({}, bare);
    expect(await service.storeHealth()).toBe(undefined);
    // close() must tolerate a store with no close().
    await service.close();
  });

  it('closes a store that supports it', async () => {
    let closed = false;
    const store: ISessionStore = {
      read: () => Promise.resolve(null),
      write: () => Promise.resolve(),
      destroy: () => Promise.resolve(false),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
    const { service } = await makeService({}, store);
    await service.close();
    expect(closed).toBe(true);
  });
});
