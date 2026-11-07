import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Code, ConnectError } from '@connectrpc/connect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceDiscovery } from '@setu-ts/common';
import { HttpError } from '@setu-ts/exceptions';
import { createTestApp, overrideCapability } from '@setu-ts/testing';
import { createApp } from '../setu.config.ts';
import type { BillingClient } from '../src/clients/billing.client.ts';
import { createOrders } from '../src/services/orders.service.ts';
import { startFakeBilling } from './support/fake-billing.ts';

const ITEMS = [
  { sku: 'widget', quantity: 2 },
  { sku: 'gadget', quantity: 1 },
] as const;
// Two widgets (999 each) and one gadget (1499), priced by the shared table.
const EXPECTED_TOTAL = 2 * 999 + 1499;

/** A billing client whose `quote` the test controls. */
function fakeQuote(
  quote: (items: readonly { sku: string; quantity: number }[]) => Promise<bigint>,
): BillingClient {
  return {
    quote: async (request: { items: readonly { sku: string; quantity: number }[] }) => ({
      $typeName: 'billing.v1.QuoteResponse',
      totalCents: await quote(request.items),
    }),
  } as unknown as BillingClient;
}

function fakeDiscovery(baseUrl: string | null): IServiceDiscovery {
  return {
    resolve: () => Promise.resolve([]),
    pick: () => Promise.resolve(null),
    resolveUrl: (_serviceName, path) =>
      Promise.resolve(baseUrl === null ? null : `${baseUrl}${path ?? ''}`),
    report: () => {},
    watch: () => Promise.resolve(() => {}),
  };
}

describe('orders', () => {
  it('stores the quoted total and answers an unknown SKU with a 400 at the service seam', async () => {
    const created = await createOrders(
      { items: [...ITEMS] },
      fakeQuote(() => Promise.resolve(3497n)),
    );
    assert.deepStrictEqual(created.totalCents, 3497);
    assert.deepStrictEqual(created.items, [...ITEMS]);
    assert.ok(created.id.length > 0);

    const rejected = await createOrders(
      { items: [{ sku: 'nope', quantity: 1 }] },
      fakeQuote(() => Promise.reject(new ConnectError("unknown SKU 'nope'", Code.InvalidArgument))),
    ).catch((error: unknown) => error);
    assert.ok(rejected instanceof HttpError);
    // The mapping answers with its own message — no upstream detail.
    assert.deepStrictEqual((rejected as HttpError).statusCode, 400);
    assert.deepStrictEqual((rejected as HttpError).message, 'billing rejected the request.');
  });

  it('answers an unreachable billing (Unavailable, or a refused fetch) with a 503 and other codes with the default 500', async () => {
    const unavailable = await createOrders(
      { items: [...ITEMS] },
      fakeQuote(() => Promise.reject(new ConnectError('the upstream says no', Code.Unavailable))),
    ).catch((error: unknown) => error);
    assert.ok(unavailable instanceof HttpError);
    assert.deepStrictEqual((unavailable as HttpError).statusCode, 503);
    assert.deepStrictEqual((unavailable as HttpError).message, 'billing is unavailable.');

    // Over fetch, a refused connection is Connect `Unknown` caused by fetch's TypeError.
    const refused = await createOrders(
      { items: [...ITEMS] },
      fakeQuote(() =>
        Promise.reject(
          new ConnectError(
            'fetch failed',
            Code.Unknown,
            undefined,
            undefined,
            new TypeError('fetch failed'),
          ),
        ),
      ),
    ).catch((error: unknown) => error);
    assert.ok(refused instanceof HttpError);
    assert.deepStrictEqual((refused as HttpError).statusCode, 503);

    const late = await createOrders(
      { items: [...ITEMS] },
      fakeQuote(() => Promise.reject(new ConnectError('too slow', Code.DeadlineExceeded))),
    ).catch((error: unknown) => error);
    assert.deepStrictEqual((late as HttpError).statusCode, 503);

    // A TypeError that is not a failed fetch (a malformed URL, a bug) is not an outage.
    const malformed = await createOrders(
      { items: [...ITEMS] },
      fakeQuote(() =>
        Promise.reject(
          new ConnectError(
            'bad url',
            Code.Unknown,
            undefined,
            undefined,
            new TypeError('Failed to parse URL from not a url'),
          ),
        ),
      ),
    ).catch((error: unknown) => error);
    assert.ok(malformed instanceof ConnectError);
    assert.ok(!(malformed instanceof HttpError));

    const other = await createOrders(
      { items: [...ITEMS] },
      fakeQuote(() => Promise.reject(new ConnectError('internal', Code.Unknown))),
    ).catch((error: unknown) => error);
    // Not remapped: the error handler's default (a 500) owns it.
    assert.ok(other instanceof ConnectError);
    assert.ok(!(other instanceof HttpError));
  });

  it('lists records and reads a created record back', async () => {
    const fake = await startFakeBilling();
    const app = await createTestApp({
      app: await createApp(),
      overrides: [overrideCapability(CAPABILITIES.SERVICE_DISCOVERY, fakeDiscovery(fake.baseUrl))],
    });
    try {
      const list = await app.inject({ method: 'GET', url: '/orders' });
      assert.deepStrictEqual(list.statusCode, 200);
      assert.deepStrictEqual(Array.isArray(list.json<{ items: unknown[] }>().items), true);

      const created = await app.inject({
        method: 'POST',
        url: '/orders',
        body: { items: [...ITEMS] },
      });
      assert.deepStrictEqual(created.statusCode, 201);
      const record = created.json<{ id: string; items: unknown[]; totalCents: number }>();
      assert.deepStrictEqual(record.totalCents, EXPECTED_TOTAL);

      const read = await app.inject({ method: 'GET', url: `/orders/${record.id}` });
      assert.deepStrictEqual(read.statusCode, 200);
      assert.deepStrictEqual(read.json(), record);
    } finally {
      await app.stop();
      await fake.stop();
    }
  });

  it('answers 400 for a zero quantity before billing is called, and for an unknown SKU from billing', async () => {
    const fake = await startFakeBilling();
    const app = await createTestApp({
      app: await createApp(),
      overrides: [overrideCapability(CAPABILITIES.SERVICE_DISCOVERY, fakeDiscovery(fake.baseUrl))],
    });
    try {
      const zeroQuantity = await app.inject({
        method: 'POST',
        url: '/orders',
        body: { items: [{ sku: 'widget', quantity: 0 }] },
      });
      assert.deepStrictEqual(zeroQuantity.statusCode, 400);
      // The schema's rfc9457 answer (an `errors` extension), not billing's: the
      // call never reached billing.
      const zeroQuantityProblem = zeroQuantity.json<{ errors?: unknown[] }>();
      assert.ok(Array.isArray(zeroQuantityProblem.errors));

      const unknownSku = await app.inject({
        method: 'POST',
        url: '/orders',
        body: { items: [{ sku: 'nope', quantity: 1 }] },
      });
      assert.deepStrictEqual(unknownSku.statusCode, 400);
      // Billing's `InvalidArgument`, remapped by the module to its own 400.
      const unknownSkuProblem = unknownSku.json<{ detail?: string }>();
      assert.deepStrictEqual(unknownSkuProblem.detail, 'billing rejected the request.');
    } finally {
      await app.stop();
      await fake.stop();
    }
  });

  it('answers 503 without upstream detail when discovery cannot resolve billing, or billing is unavailable', async () => {
    const fake = await startFakeBilling();
    const app = await createTestApp({
      app: await createApp(),
      overrides: [overrideCapability(CAPABILITIES.SERVICE_DISCOVERY, fakeDiscovery(null))],
    });
    const reachable = await createTestApp({
      app: await createApp(),
      overrides: [overrideCapability(CAPABILITIES.SERVICE_DISCOVERY, fakeDiscovery(fake.baseUrl))],
    });
    try {
      const unresolved = await app.inject({
        method: 'POST',
        url: '/orders',
        body: { items: [...ITEMS] },
      });
      assert.deepStrictEqual(unresolved.statusCode, 503);
      const unresolvedProblem = unresolved.json<{ detail?: string }>();
      assert.deepStrictEqual(unresolvedProblem.detail, 'billing is unavailable.');

      fake.setUnavailable(true);
      const unavailable = await reachable.inject({
        method: 'POST',
        url: '/orders',
        body: { items: [...ITEMS] },
      });
      assert.deepStrictEqual(unavailable.statusCode, 503);
      const body = unavailable.body ?? '';
      // The mapping's own message, not the fake's — no upstream detail.
      const unavailableProblem = unavailable.json<{ detail?: string }>();
      assert.deepStrictEqual(unavailableProblem.detail, 'billing is unavailable.');
      assert.ok(!body.includes('the fake billing is off'));
    } finally {
      await app.stop();
      await reachable.stop();
      await fake.stop();
    }
  });
});
