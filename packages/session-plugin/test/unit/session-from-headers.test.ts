/**
 * Unit tests for `SessionService.fromHeaders` — the headers-only read for
 * non-HTTP entry points (a WebSocket `onOpen` handler, an auth strategy).
 *
 * One case per "no usable session" condition, the success projection, and the
 * read-only guarantees: no `seen` advance, no store write.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ISessionStore, SessionData } from '@setu-ts/common';

import { deriveKeyRing, seal } from '../../src/codec/crypto.ts';
import type { SessionMode } from '../../src/codec/crypto.ts';
import { resolveSessionConfig } from '../../src/options.ts';
import type { SessionPluginOptions } from '../../src/options.ts';
import { SessionService } from '../../src/services/session-service.ts';
import { TENANT_BINDING_KEY } from '../../src/services/session-tenant-binding.ts';
import { MemorySessionStore } from '../../src/stores/memory-session-store.ts';
import type { FakeClock } from '../fixtures/context.ts';
import { makeClock, makeContext } from '../fixtures/context.ts';

const SECRET = 's'.repeat(32);
const NOW = 1_700_000_000_000;

/** Random bytes for sealing in tests. */
const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

/** A recording store: every call is logged, so "never writes" is assertable. */
class RecordingStore implements ISessionStore {
  readonly entries = new Map<string, SessionData>();
  readonly calls: string[] = [];

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
}

/** Builds a service with an injected clock and, optionally, a store. */
async function makeService(
  options: SessionPluginOptions = {},
  store?: ISessionStore,
  mode: SessionMode = 'encrypt',
  clock: FakeClock = makeClock(NOW),
) {
  const config = resolveSessionConfig({ ...options, mode });
  const ring = await deriveKeyRing(crypto.subtle, [SECRET], mode);
  const service = new SessionService(config, ring, {
    subtle: crypto.subtle,
    randomBytes,
    now: clock.now,
    uuid: clock.uuid,
  }, store);
  return { service, clock };
}

/** A real MemorySessionStore on the test clock; its sweep timers are no-ops. */
function makeMemoryStore(clock: FakeClock): MemorySessionStore {
  return new MemorySessionStore({
    now: clock.now,
    setInterval: () => undefined,
    clearInterval: () => {},
  });
}

/** Commits a session and returns the `name=value` cookie pair and its id. */
async function committedCookie(
  service: SessionService,
  data: Record<string, unknown>,
): Promise<{ cookie: string; id: string }> {
  const { ctx, response } = makeContext();
  const session = await service.load(ctx);
  for (const [key, value] of Object.entries(data)) {
    session.set(key, value);
  }
  await service.commit(ctx, session);
  const header = response.setCookies()[0];
  if (header === undefined) {
    throw new Error('expected a Set-Cookie header');
  }
  return { cookie: header.split(';')[0], id: session.id };
}

describe('SessionService.fromHeaders', () => {
  describe('success', () => {
    it('returns the id and payload verbatim for a cookie-strategy session', async () => {
      const { service } = await makeService();
      const { cookie, id } = await committedCookie(service, { userId: 'u-1', plan: 'pro' });

      const view = await service.fromHeaders(new Headers({ cookie }));

      expect(view).not.toBeNull();
      expect(view?.id).toBe(id);
      expect(view?.data).toEqual({ userId: 'u-1', plan: 'pro' });
    });

    it('reads the store-backed payload under sign mode and a custom cookie name', async () => {
      const clock = makeClock(NOW);
      const store = new RecordingStore();
      const { service } = await makeService({ cookie: { name: 'sid' } }, store, 'sign', clock);
      const { cookie, id } = await committedCookie(service, { userId: 'u-1' });

      expect(cookie.startsWith('sid=')).toBe(true);
      const view = await service.fromHeaders(new Headers({ cookie }));

      expect(view?.id).toBe(id);
      expect(view?.data).toEqual({ userId: 'u-1' });
      // The payload came from the store, not the cookie.
      expect(store.entries.get(id)).toEqual({ userId: 'u-1' });
    });

    it('returns the reserved tenant key verbatim', async () => {
      const { service } = await makeService();
      const { cookie } = await committedCookie(
        service,
        { [TENANT_BINDING_KEY]: 'acme', userId: 'u-1' },
      );

      const view = await service.fromHeaders(new Headers({ cookie }));

      expect(view?.data[TENANT_BINDING_KEY]).toBe('acme');
    });
  });

  describe('null conditions', () => {
    it('returns null when no cookie header is present', async () => {
      const { service } = await makeService();
      expect(await service.fromHeaders(new Headers())).toBeNull();
    });

    it('returns null when the header carries no session cookie', async () => {
      const { service } = await makeService();
      expect(await service.fromHeaders(new Headers({ cookie: 'other=x' }))).toBeNull();
    });

    it('returns null for an empty cookie value', async () => {
      const { service } = await makeService({ cookie: { name: 'sid' } });
      expect(await service.fromHeaders(new Headers({ cookie: 'sid=' }))).toBeNull();
    });

    it('returns null for a cookie that cannot be opened', async () => {
      const { service } = await makeService();
      const view = await service.fromHeaders(new Headers({ cookie: 'setu_session=garbage' }));
      expect(view).toBeNull();
    });

    it('returns null for a cookie sealed with a different secret', async () => {
      const { service } = await makeService();
      const otherRing = await deriveKeyRing(crypto.subtle, ['t'.repeat(32)], 'encrypt');
      const bogus = await seal(
        crypto.subtle,
        otherRing,
        JSON.stringify({ id: 'x', data: {}, exp: NOW + 1_000, seen: NOW }),
        randomBytes,
      );
      const view = await service.fromHeaders(
        new Headers({ cookie: `setu_session=${encodeURIComponent(bogus)}` }),
      );
      expect(view).toBeNull();
    });

    it('returns null for a sealed payload that is not a snapshot', async () => {
      const { service } = await makeService();
      const ring = await deriveKeyRing(crypto.subtle, [SECRET], 'encrypt');
      const bogus = await seal(
        crypto.subtle,
        ring,
        JSON.stringify({ unexpected: true }),
        randomBytes,
      );
      const view = await service.fromHeaders(
        new Headers({ cookie: `setu_session=${encodeURIComponent(bogus)}` }),
      );
      expect(view).toBeNull();
    });

    it('returns null once the absolute expiry has passed', async () => {
      const { service, clock } = await makeService({ maxAge: 100 });
      const { cookie } = await committedCookie(service, { a: 1 });
      clock.advance(100_001);
      expect(await service.fromHeaders(new Headers({ cookie }))).toBeNull();
    });

    it('returns null once the idle timeout has passed', async () => {
      const { service, clock } = await makeService({ idleTimeoutMs: 60_000, maxAge: 86_400 });
      const { cookie } = await committedCookie(service, { a: 1 });
      clock.advance(60_001);
      expect(await service.fromHeaders(new Headers({ cookie }))).toBeNull();
    });

    it('returns null when the store entry has been revoked', async () => {
      const clock = makeClock(NOW);
      const store = makeMemoryStore(clock);
      const { service } = await makeService({ maxAge: 60 }, store, 'sign', clock);
      const { cookie, id } = await committedCookie(service, { a: 1 });

      await store.destroy(id);

      expect(await service.fromHeaders(new Headers({ cookie }))).toBeNull();
    });
  });

  describe('read-only guarantees', () => {
    it('never advances the seen stamp, so a later load still sees the original activity', async () => {
      const { service, clock } = await makeService({ idleTimeoutMs: 60_000, maxAge: 86_400 });
      const { cookie } = await committedCookie(service, { a: 1 });

      // 40s in: the headers read succeeds...
      clock.advance(40_000);
      expect(await service.fromHeaders(new Headers({ cookie }))).not.toBeNull();

      // ...but it must not have refreshed activity. At 80s the original stamp
      // is outside the 60s idle window, so the HTTP path starts fresh. Had the
      // read advanced `seen` to 40s, this load would have restored.
      clock.advance(40_000);
      const { ctx } = makeContext({ headers: { cookie } });
      expect((await service.load(ctx)).isNew).toBe(true);
    });

    it('never writes to the store', async () => {
      const clock = makeClock(NOW);
      const store = new RecordingStore();
      const { service } = await makeService({ maxAge: 60 }, store, 'sign', clock);
      const { cookie, id } = await committedCookie(service, { a: 1 });
      store.calls.length = 0;

      const view = await service.fromHeaders(new Headers({ cookie }));

      expect(view).not.toBeNull();
      expect(store.calls).toEqual([`read:${id}`]);
      expect(store.entries.get(id)).toEqual({ a: 1 });
    });
  });
});
