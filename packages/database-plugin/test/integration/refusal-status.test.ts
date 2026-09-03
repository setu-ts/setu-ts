/**
 * X19-1 end to end: a documented query refusal reaches the client as `501`
 * with its own sentence, not as a masked `500 Internal Server Error`.
 *
 * Driven through a REAL `createApplication` with a REAL adapter over an
 * injected client — no emulator. That matters: the refusal has to survive the
 * whole path (adapter → repository → handler → pipeline → `errorHandler`), and
 * the defect lived in the last step, so a test that asserted the thrown error
 * in isolation would have passed with the symptom in place.
 *
 * This is the shape a developer meets when SWITCHING BACKENDS, which is the
 * portable contract's whole promise: an application that works on Mongo used
 * to answer `500` on every ordered endpoint under Dynamo, and the response
 * said the server was broken.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { HandlerResult, IRequestContext } from '@setu-ts/common';
import { errorHandler } from '@setu-ts/exceptions';

import { DatabasePlugin } from '../../src/index.ts';
import type { IDatabaseService } from '../../src/index.ts';
import { DynamoAdapter } from '../../src/adapters/dynamo/dynamo-adapter.ts';
import { BigtableAdapter } from '../../src/adapters/bigtable/bigtable-adapter.ts';
import type { IDynamoClient } from '../../src/adapters/dynamo/dynamo-client-types.ts';
import { createFakeBigtableClient, FakeBigtableStore } from '../fixtures/fake-bigtable-client.ts';

/** A client whose commands are never reached: every case refuses at translation. */
function idleDynamoClient(): IDynamoClient {
  return {
    query: () => Promise.resolve({}),
    scan: () => Promise.resolve({}),
    getItem: () => Promise.resolve({}),
    putItem: () => Promise.resolve({}),
    updateItem: () => Promise.resolve({}),
    deleteItem: () => Promise.resolve({}),
    transactWriteItems: () => Promise.resolve({}),
    destroy: () => {},
  };
}

/** Builds a Dynamo-backed app whose `/orders` route asks for a non-key sort. */
function bootDynamoApp() {
  const adapter = new DynamoAdapter({
    client: idleDynamoClient(),
    entities: { Order: { table: 'orders', partitionKey: 'tenantId', sortKey: 'createdAt' } },
  });
  const app = createApplication({
    plugins: [RuntimePlugin(), DatabasePlugin({ type: 'custom', adapter })],
  });
  app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 10, name: 'errors' });
  app.router.get('/orders', {
    handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const repo = db.getRepository<Record<string, unknown>>('Order');
      // DynamoDB serves `orderBy` only on the resolved access path's sort key;
      // `status` is neither, so the adapter refuses by name rather than
      // forwarding a parameter the SDK silently discards.
      return ctx.response.json(
        await repo.findAll({ where: { tenantId: 't1' }, orderBy: { status: 'asc' } }),
      );
    },
  });
  return app;
}

/** Builds a Bigtable-backed app whose `/events` route asks for a row offset. */
function bootBigtableApp() {
  const adapter = new BigtableAdapter({
    client: createFakeBigtableClient(new FakeBigtableStore()),
    instance: 'test-instance',
    tables: {
      Event: {
        table: 'events',
        rowKey: { fields: ['tenantId', 'eventId'], separator: '#' },
        columnFamily: 'cf',
      },
    },
  });
  const app = createApplication({
    plugins: [RuntimePlugin(), DatabasePlugin({ type: 'custom', adapter })],
  });
  app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 10, name: 'errors' });
  app.router.get('/events', {
    handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const repo = db.getRepository<Record<string, unknown>>('Event');
      // Bigtable has no row offset, and discarding scanned rows would read and
      // bill them, so a non-zero `offset` is refused by name.
      return ctx.response.json(await repo.findAll({ offset: 10, limit: 5 }));
    },
  });
  return app;
}

describe('query refusals answer 501 through a real application', () => {
  it('answers a Dynamo non-key orderBy with 501 and the adapter named', async () => {
    const app = bootDynamoApp();
    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/orders' });

    // Before M89b: 500 with `detail: 'Internal Server Error'`, the actionable
    // message reachable only in the log.
    expect(response.statusCode).toBe(501);
    const body = response.json<{ status: number; title: string; detail: string }>();
    expect(body.status).toBe(501);
    expect(body.title).toBe('Not Implemented');
    expect(body.detail).toBe(
      "Query feature 'orderBy' is not supported by the 'dynamodb' database adapter.",
    );

    await app.stop();
  });

  it('answers a Bigtable offset with 501 and the adapter named', async () => {
    // A second backend, because the fix must be a property of the error class
    // rather than of one adapter's throw site.
    const app = bootBigtableApp();
    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/events' });

    expect(response.statusCode).toBe(501);
    const body = response.json<{ status: number; detail: string }>();
    expect(body.detail).toBe(
      "Query feature 'offset' is not supported by the 'bigtable' database adapter.",
    );

    await app.stop();
  });

  it('discloses no diagnostic detail in the body', async () => {
    // The refusal message names the entity, the requested field and the
    // orderable one — useful to an operator, and not something to volunteer to
    // an unauthenticated caller. The served sentence is the hint's, not the
    // error's, and X12-3 is the reason that distinction is enforced.
    const app = bootDynamoApp();
    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/orders' });
    const serialized = JSON.stringify(response.json());

    expect(serialized).not.toContain('Order');
    expect(serialized).not.toContain('createdAt');
    expect(serialized).not.toContain('sort key');

    await app.stop();
  });

  it('leaves an ordinary 500 masked in the same application', async () => {
    // The control: the exemption is for hinted errors only, so a genuine
    // fault on a neighbouring route still answers a masked 500.
    const app = bootDynamoApp();
    app.router.get('/boom', {
      handler: (): HandlerResult => {
        throw new Error("SELECT * FROM users WHERE ssn = $1 -- ['SECRET-123']");
      },
    });
    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/boom' });

    expect(response.statusCode).toBe(500);
    const serialized = JSON.stringify(response.json());
    expect(serialized).not.toContain('SECRET');

    await app.stop();
  });
});
