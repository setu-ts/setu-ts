/**
 * V9-46 through a REAL kernel application (M113e plan §3.3): with a store and
 * form CSRF on, anonymous page views that render a form write NO store rows,
 * while the token they carry still verifies; signing in writes exactly one row,
 * and signing out (by clearing the user key) deletes it so a copy of the
 * signed-in cookie restores nothing.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import type { ISessionStore, SessionData } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { getCsrfToken, getSession, SessionPlugin } from '../../src/index.ts';

const SECRET = 'store-anonymous-traffic-secret-at-least-32-chars';

class RecordingStore implements ISessionStore {
  readonly entries = new Map<string, SessionData>();
  writes = 0;

  read(id: string): Promise<SessionData | null> {
    return Promise.resolve(this.entries.get(id) ?? null);
  }

  write(id: string, data: SessionData): Promise<void> {
    this.writes += 1;
    this.entries.set(id, data);
    return Promise.resolve();
  }

  destroy(id: string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(id));
  }
}

async function start(store: RecordingStore): Promise<IKernelApplication> {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      SessionPlugin({ secret: SECRET, store, cookie: { secure: false }, csrf: {} }),
    ],
  });
  app.router.get('/login', (ctx) => ctx.response.json({ token: getCsrfToken(ctx) }));
  app.router.post('/login', (ctx) => {
    const session = getSession(ctx);
    session.regenerate();
    session.set('user', 'ann');
    return ctx.response.json({ ok: true });
  });
  app.router.get('/me', (ctx) => ctx.response.json({ user: getSession(ctx).get('user') ?? null }));
  app.router.post('/logout', (ctx) => {
    getSession(ctx).delete('user');
    return ctx.response.json({ ok: true });
  });
  await app.start();
  return app;
}

function cookieOf(response: Response): string {
  const raw = response.headers.get('set-cookie');
  expect(raw).not.toBeNull();
  return (raw as string).split(';')[0];
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('anonymous traffic on the store strategy (V9-46)', () => {
  it('writes no store row for 200 anonymous form views', async () => {
    const store = new RecordingStore();
    const app = await start(store);
    try {
      for (let index = 0; index < 200; index += 1) {
        const response = await app.fetch(new Request('http://localhost/login'));
        expect(response.status).toBe(200);
        expect(response.headers.get('set-cookie')).not.toBeNull();
        await response.body?.cancel();
      }
      expect(store.writes).toBe(0);
      expect(store.entries.size).toBe(0);
    } finally {
      await app.stop();
    }
  });

  it('verifies the form token, signs in to one row, and signs out by deleting it', async () => {
    const store = new RecordingStore();
    const app = await start(store);
    try {
      const form = await app.fetch(new Request('http://localhost/login'));
      const anonymous = cookieOf(form);
      const { token } = await json(form);

      const refused = await app.fetch(
        new Request('http://localhost/login', { method: 'POST', headers: { cookie: anonymous } }),
      );
      expect(refused.status).toBe(403);
      await refused.body?.cancel();

      const login = await app.fetch(
        new Request('http://localhost/login', {
          method: 'POST',
          headers: { cookie: anonymous, 'x-csrf-token': token as string },
        }),
      );
      expect(login.status).toBe(200);
      const signedIn = cookieOf(login);
      expect(store.entries.size).toBe(1);
      expect(store.writes).toBe(1);

      const me = await app.fetch(
        new Request('http://localhost/me', { headers: { cookie: signedIn } }),
      );
      expect(await json(me)).toEqual({ user: 'ann' });

      const logout = await app.fetch(
        new Request('http://localhost/logout', {
          method: 'POST',
          headers: { cookie: signedIn, 'x-csrf-token': token as string },
        }),
      );
      expect(logout.status).toBe(200);
      await logout.body?.cancel();
      expect(store.entries.size).toBe(0);

      // A copy of the signed-in cookie no longer restores the user.
      const replay = await app.fetch(
        new Request('http://localhost/me', { headers: { cookie: signedIn } }),
      );
      expect(await json(replay)).toEqual({ user: null });
    } finally {
      await app.stop();
    }
  });

  it('NEGATIVE: an anonymous cookie copied before sign-in stays anonymous after it', async () => {
    const store = new RecordingStore();
    const app = await start(store);
    try {
      const form = await app.fetch(new Request('http://localhost/login'));
      const anonymous = cookieOf(form);
      const { token } = await json(form);
      const login = await app.fetch(
        new Request('http://localhost/login', {
          method: 'POST',
          headers: { cookie: anonymous, 'x-csrf-token': token as string },
        }),
      );
      await login.body?.cancel();
      const copied = await app.fetch(
        new Request('http://localhost/me', { headers: { cookie: anonymous } }),
      );
      expect(await json(copied)).toEqual({ user: null });
    } finally {
      await app.stop();
    }
  });
});
