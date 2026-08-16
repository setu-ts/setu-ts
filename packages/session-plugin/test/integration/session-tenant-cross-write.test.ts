/**
 * Integration test — the cross-tenant session write (X4-3) through a REAL
 * kernel app.
 *
 * The register's reproduction: sign in under tenant `acme`, then replay the
 * resulting session cookie with tenant `globex` and attempt a write. With
 * tenant binding (the default) the request is refused with `403` before the
 * handler runs and the write does not land. Without the fix the same request
 * writes into `globex`'s data — the session authenticated a cross-tenant
 * mutation.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IRequestContext } from '@setu-ts/common';

import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';

import { getSession, SessionPlugin } from '../../src/index.ts';

const SECRET = 'x'.repeat(32);

interface Item {
  tenant: string;
  item: string;
}

describe('session tenant cross-write (X4-3) — real kernel app', () => {
  it('refuses an acme session replayed under globex and the write does not land', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MultiTenancyPlugin({ resolver: 'header' }),
        SessionPlugin({ secret: SECRET, store: 'memory' }),
      ],
    });

    // Server-side record of what actually landed — the write target.
    const items: Item[] = [];

    app.router.post('/items', async (ctx: IRequestContext) => {
      const body = await ctx.request.json<{ item: string }>();
      const tenant = ctx.request.tenant?.id ?? 'none';
      items.push({ tenant, item: body.item });
      // The session is reachable in the handler; under a mismatch it never
      // gets here, which is the point.
      const session = getSession(ctx);
      return ctx.response.json({ ok: true, tenant, sessionId: session.id });
    });

    await app.start();

    // Sign in under acme: the first request seals the session to acme.
    const signIn = await app.inject({
      method: 'POST',
      url: 'http://localhost/items',
      headers: { 'x-tenant-id': 'acme', 'content-type': 'application/json' },
      body: JSON.stringify({ item: 'acme-item' }),
    });
    expect(signIn.statusCode).toBe(200);
    const setCookie = signIn.headers.get('set-cookie');
    expect(setCookie).not.toBe(null);
    const cookie = setCookie!.split(';')[0];
    expect(items).toEqual([{ tenant: 'acme', item: 'acme-item' }]);

    // Replay the acme cookie under globex and attempt a write.
    const crossWrite = await app.inject({
      method: 'POST',
      url: 'http://localhost/items',
      headers: { 'x-tenant-id': 'globex', cookie },
      body: JSON.stringify({ item: 'globex-item' }),
    });

    expect(crossWrite.statusCode).toBe(403);
    const crossBody = crossWrite.json<{ error: string }>();
    expect(crossBody.error).toBe('Tenant Mismatch');

    // The write did NOT land: the handler never ran for the cross-tenant
    // request, so the record is unchanged.
    expect(items).toEqual([{ tenant: 'acme', item: 'acme-item' }]);

    // A same-tenant replay still works: the binding matches, the handler runs
    // and the write lands under acme.
    const sameTenant = await app.inject({
      method: 'POST',
      url: 'http://localhost/items',
      headers: { 'x-tenant-id': 'acme', cookie },
      body: JSON.stringify({ item: 'acme-item-2' }),
    });
    expect(sameTenant.statusCode).toBe(200);
    expect(items).toEqual([
      { tenant: 'acme', item: 'acme-item' },
      { tenant: 'acme', item: 'acme-item-2' },
    ]);

    await app.stop();
  });
});
