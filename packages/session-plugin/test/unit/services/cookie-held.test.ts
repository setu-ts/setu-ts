/**
 * Cookie-held sessions on the store strategy (M113e plan §3.3, V9-46): a
 * session holding only reserved keys is sealed into the cookie and writes no
 * store row; any other key moves it into the store; moving a stored session
 * back into the cookie deletes its row.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { SESSION_TENANT_BINDING_KEY } from '@setu-ts/common';
import type { ISessionStore, SessionData } from '@setu-ts/common';

import { deriveKeyRing, open, seal } from '../../../src/codec/crypto.ts';
import type { SessionMode } from '../../../src/codec/crypto.ts';
import { CSRF_SESSION_KEY } from '../../../src/csrf/token.ts';
import { resolveSessionConfig } from '../../../src/options.ts';
import { SessionService } from '../../../src/services/session-service.ts';
import { parseSnapshot } from '../../../src/services/session.ts';
import { makeClock, makeContext } from '../../fixtures/context.ts';

const SECRET = 'c'.repeat(32);
const NOW = 1_700_000_000_000;

class RecordingStore implements ISessionStore {
  readonly entries = new Map<string, SessionData>();
  readonly calls: string[] = [];

  read(id: string): Promise<SessionData | null> {
    this.calls.push(`read:${id}`);
    return Promise.resolve(this.entries.get(id) ?? null);
  }

  write(id: string, data: SessionData): Promise<void> {
    this.calls.push(`write:${id}`);
    this.entries.set(id, data);
    return Promise.resolve();
  }

  destroy(id: string): Promise<boolean> {
    this.calls.push(`destroy:${id}`);
    return Promise.resolve(this.entries.delete(id));
  }

  writes(): number {
    return this.calls.filter((call) => call.startsWith('write:')).length;
  }

  reads(): number {
    return this.calls.filter((call) => call.startsWith('read:')).length;
  }
}

async function harness(
  mode: SessionMode = 'encrypt',
  store: ISessionStore | null = new RecordingStore(),
) {
  const ring = await deriveKeyRing(crypto.subtle, [SECRET], mode);
  const clock = makeClock(NOW);
  const service = new SessionService(
    resolveSessionConfig({ mode }),
    ring,
    {
      subtle: crypto.subtle,
      randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
      now: clock.now,
      uuid: clock.uuid,
    },
    store ?? undefined,
  );
  return { service, ring, store: store as RecordingStore };
}

/** Commits `mutate` on a session loaded with `cookie`, returning the new cookie. */
async function round(
  service: SessionService,
  cookie: string | undefined,
  mutate: (session: Awaited<ReturnType<SessionService['load']>>) => void,
) {
  const { ctx, response } = makeContext(cookie === undefined ? {} : { headers: { cookie } });
  const session = await service.load(ctx);
  mutate(session);
  await service.commit(ctx, session);
  const header = response.setCookies()[0];
  return { session, cookie: header?.split(';')[0] };
}

async function payloadOf(ring: Awaited<ReturnType<typeof deriveKeyRing>>, cookie: string) {
  const raw = decodeURIComponent(cookie.split('=').slice(1).join('='));
  const plaintext = await open(crypto.subtle, ring, raw);
  return JSON.parse(plaintext as string) as Record<string, unknown>;
}

describe('cookie-held sessions (store strategy)', () => {
  it('seals a CSRF-only session into the cookie and writes no store row', async () => {
    const { service, ring, store } = await harness();
    const { cookie } = await round(service, undefined, (s) => s.set(CSRF_SESSION_KEY, 'tok'));
    expect(store.writes()).toBe(0);
    const payload = await payloadOf(ring, cookie as string);
    expect(payload.held).toBe('cookie');
    expect(payload.data).toEqual({ [CSRF_SESSION_KEY]: 'tok' });
  });

  it('keeps a tenant-bound anonymous session in the cookie too', async () => {
    const { service, store } = await harness();
    await round(service, undefined, (s) => {
      s.set(CSRF_SESSION_KEY, 'tok');
      s.set(SESSION_TENANT_BINDING_KEY, 'acme');
    });
    expect(store.writes()).toBe(0);
  });

  it('restores a cookie-held session with no store read', async () => {
    const { service, store } = await harness();
    const first = await round(service, undefined, (s) => s.set(CSRF_SESSION_KEY, 'tok'));
    const { ctx } = makeContext({ headers: { cookie: first.cookie as string } });
    const restored = await service.load(ctx);
    expect(restored.get(CSRF_SESSION_KEY)).toBe('tok');
    expect(restored.isNew).toBe(false);
    expect(restored.wasStoreHeld).toBe(false);
    expect(store.reads()).toBe(0);
  });

  it('opens the same cookie through fromHeaders with no store read', async () => {
    const { service, store } = await harness();
    const first = await round(service, undefined, (s) => s.set(CSRF_SESSION_KEY, 'tok'));
    const view = await service.fromHeaders(new Headers({ cookie: first.cookie as string }));
    expect(view?.data).toEqual({ [CSRF_SESSION_KEY]: 'tok' });
    expect(store.reads()).toBe(0);
  });

  it('moves the session into the store on its first non-reserved write', async () => {
    const { service, ring, store } = await harness();
    const first = await round(service, undefined, (s) => s.set(CSRF_SESSION_KEY, 'tok'));
    const second = await round(service, first.cookie, (s) => s.set('user', 'ann'));
    expect(store.writes()).toBe(1);
    expect(store.entries.get(second.session.id)).toEqual({
      [CSRF_SESSION_KEY]: 'tok',
      user: 'ann',
    });
    const payload = await payloadOf(ring, second.cookie as string);
    expect(payload.held).toBeUndefined();
    expect(payload.data).toEqual({});
  });

  it('deletes the row when a stored session moves back into the cookie', async () => {
    const { service, store } = await harness();
    const signedIn = await round(service, undefined, (s) => s.set('user', 'ann'));
    expect(store.entries.has(signedIn.session.id)).toBe(true);
    const signedOut = await round(service, signedIn.cookie, (s) => s.delete('user'));
    expect(store.entries.has(signedIn.session.id)).toBe(false);
    expect(signedOut.session.wasStoreHeld).toBe(true);

    // A copy of the signed-in, id-only cookie no longer restores anything.
    const { ctx } = makeContext({ headers: { cookie: signedIn.cookie as string } });
    const replayed = await service.load(ctx);
    expect(replayed.isNew).toBe(true);
    expect(replayed.get('user')).toBeUndefined();
  });

  it('refuses a cookie-held marker over non-reserved data rather than trusting it', async () => {
    const { service, ring } = await harness();
    const forged = JSON.stringify({
      id: 'x',
      data: { user: 'ann' },
      exp: NOW + 1_000,
      seen: NOW,
      held: 'cookie',
    });
    const sealed = await seal(crypto.subtle, ring, forged, (n) =>
      crypto.getRandomValues(new Uint8Array(n)),
    );
    const { ctx } = makeContext({
      headers: { cookie: `setu_session=${encodeURIComponent(sealed)}` },
    });
    const loaded = await service.load(ctx);
    expect(loaded.isNew).toBe(true);
    expect(loaded.get('user')).toBeUndefined();
  });

  it('applies under mode: sign as well', async () => {
    const { service, store } = await harness('sign');
    await round(service, undefined, (s) => s.set(CSRF_SESSION_KEY, 'tok'));
    expect(store.writes()).toBe(0);
  });

  it('never marks a cookie on the cookie strategy, where the cookie always holds the data', async () => {
    const { service, ring } = await harness('encrypt', null);
    const { cookie } = await round(service, undefined, (s) => s.set(CSRF_SESSION_KEY, 'tok'));
    expect((await payloadOf(ring, cookie as string)).held).toBeUndefined();
  });
});

describe('parseSnapshot — the held marker', () => {
  const base = { id: 'a', data: {}, exp: 2, seen: 1 };

  it('keeps held: cookie', () => {
    expect(parseSnapshot(JSON.stringify({ ...base, held: 'cookie' }))?.held).toBe('cookie');
  });

  it('omits the member when absent', () => {
    expect(parseSnapshot(JSON.stringify(base))).not.toHaveProperty('held');
  });

  it('refuses any other value', () => {
    expect(parseSnapshot(JSON.stringify({ ...base, held: 'store' }))).toBeNull();
    expect(parseSnapshot(JSON.stringify({ ...base, held: true }))).toBeNull();
  });
});
