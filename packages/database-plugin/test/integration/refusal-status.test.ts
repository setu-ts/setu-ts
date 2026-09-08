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
import type {
  HandlerResult,
  IDatabaseAdapter,
  IDataSource,
  IRequestContext,
} from '@setu-ts/common';
import { type ErrorFormat, errorHandler } from '@setu-ts/exceptions';

import { DatabasePlugin, type IBigtableClient, MemoryAdapter } from '../../src/index.ts';
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

/**
 * Builds a Bigtable client whose commit RPC loses its acknowledgement after a
 * buffered write. The numeric gRPC code is deliberately retained: the
 * transaction service must still mask it because a commit outcome is unknown.
 */
function commitAcknowledgementLostBigtableClient(): IBigtableClient {
  const client = createFakeBigtableClient(new FakeBigtableStore());
  return {
    instance: (instanceId) => {
      const instance = client.instance(instanceId);
      return {
        table: (tableId) => {
          const table = instance.table(tableId);
          return {
            readRows: (options) => table.readRows(options),
            row: () => ({
              conditionalMutate: () => Promise.reject({ code: 10, details: 'ABORTED' }),
            }),
          };
        },
      };
    },
    close: () => client.close(),
  };
}

/** Builds a memory-backed app through either its built-in or custom arm. */
function bootMemoryApp(
  format: ErrorFormat = 'rfc9457',
  adapterArm: 'memory' | 'custom' = 'memory',
) {
  const database = adapterArm === 'memory'
    ? DatabasePlugin({ type: 'memory' })
    : DatabasePlugin({ type: 'custom', adapter: new MemoryAdapter() });
  const app = createApplication({ plugins: [RuntimePlugin(), database] });
  app.middleware.add(errorHandler({ format }), { priority: 10, name: 'errors' });
  app.router.get('/q', {
    handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      return ctx.response.json(await db.query('SELECT 1'));
    },
  });
  app.router.get('/m', {
    handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      await db.migrate();
      return ctx.response.json({});
    },
  });
  return app;
}

describe('query refusals answer 501 through a real application', () => {
  it('answers the default memory adapter raw-query refusal with a safe 501', async () => {
    const app = bootMemoryApp();
    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/q' });

    expect(response.statusCode).toBe(501);
    const body = response.json<{ status: number; title: string; detail: string }>();
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Not Implemented',
      status: 501,
      detail: "Raw queries are not supported by the 'memory' database adapter.",
      instance: '/q',
    });
    expect(JSON.stringify(body)).not.toContain(
      'The memory adapter does not support raw SQL queries.',
    );

    await app.stop();
  });

  it('serializes the framework-wide migration refusal exactly in every built-in format', async () => {
    const detail = 'Programmatic migrations are not supported by the current database adapters.';
    const cases: readonly { format: ErrorFormat; contentType: string; body: string }[] = [
      {
        format: 'default',
        contentType: 'application/json; charset=utf-8',
        body: `{"statusCode":501,"message":"Not Implemented","details":{"detail":"${detail}"}}`,
      },
      {
        format: 'rfc9457',
        contentType: 'application/problem+json',
        body:
          `{"type":"about:blank","title":"Not Implemented","status":501,"detail":"${detail}","instance":"/m"}`,
      },
      {
        format: 'rfc7807',
        contentType: 'application/problem+json',
        body:
          `{"type":"https://setu-ts.dev/errors/501","title":"Not Implemented","status":501,"detail":"${detail}","instance":"/m"}`,
      },
    ];

    for (const { format, contentType, body } of cases) {
      const app = bootMemoryApp(format);
      await app.start();

      const response = await app.inject({ method: 'GET', url: 'http://localhost/m' });

      expect(response.statusCode, format).toBe(501);
      expect(response.headers.get('content-type'), format).toBe(contentType);
      expect(response.body, format).toBe(body);

      await app.stop();
    }
  });

  it('keeps the same raw-query refusal through the custom MemoryAdapter arm', async () => {
    const app = bootMemoryApp('rfc9457', 'custom');
    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/q' });

    expect(response.statusCode).toBe(501);
    const body = response.json<{ detail: string }>();
    expect(body.detail).toBe("Raw queries are not supported by the 'memory' database adapter.");
    expect(JSON.stringify(body)).not.toContain(
      'The memory adapter does not support raw SQL queries.',
    );

    await app.stop();
  });

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

  it('leaves a MISCONFIGURATION masked, not answered 501', async () => {
    // M89b code review, Qodo finding 3. `UnsupportedQueryFeatureError` is
    // shared by caller-caused query refusals and by CONFIGURATION refusals,
    // and branding its constructor unconditionally made a blank
    // `columnFamily` — a value the developer wrote — answer every request
    // `501 "Query feature 'mapping' is not supported by the 'bigtable'
    // database adapter."` That is a lie twice over: the deployment is
    // misconfigured and no query feature is missing. Measured, then fixed by
    // branding only the caller-caused `feature` values.
    const adapter = new BigtableAdapter({
      client: createFakeBigtableClient(new FakeBigtableStore()),
      instance: 'test-instance',
      tables: { Event: { table: 'events', columnFamily: '   ' } },
    });
    const app = createApplication({
      plugins: [RuntimePlugin(), DatabasePlugin({ type: 'custom', adapter })],
    });
    app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 10, name: 'errors' });
    app.router.get('/events', {
      handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
        const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
        return ctx.response.json(await db.getRepository('Event').findAll({}));
      },
    });
    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/events' });

    expect(response.statusCode).toBe(500);
    const body = response.json<{ status: number; detail: string }>();
    expect(body.status).toBe(500);
    expect(body.detail).toBe('Internal Server Error');
    // And the configuration diagnostic stays out of the body.
    expect(JSON.stringify(body)).not.toContain('columnFamily');

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

// ---------------------------------------------------------------------------
// M90f (X38-1/X35-2): driver conditions reach the client as their classified
// status. The stub adapter drives the REAL DatabaseService interception sites
// (the `wrapDataSource` wrappers, the `beginTransaction()` acquisition, the
// transaction catch, `query()`) — the same path a driver failure takes — and
// the guarded live suites (`real-*.test.ts`) prove the drivers emit the
// signals these stubs imitate.
// ---------------------------------------------------------------------------

/** The measured X38-1 cause chain: drizzle's wrapper, then the pg error. */
function drizzleSerializationFailure(): Error {
  return new Error(
    'Failed query: update "account" set "balance" = $1 where "id" = $2 -- [400, 7]',
    {
      cause: {
        code: '40001',
        message: 'could not serialize access due to concurrent update',
      },
    },
  );
}

function refusingDataSource(rejection: unknown): IDataSource {
  return {
    findAll: () => Promise.reject(rejection),
    findById: () => Promise.reject(rejection),
    create: () => Promise.reject(rejection),
    update: () => Promise.reject(rejection),
    delete: () => Promise.reject(rejection),
    count: () => Promise.reject(rejection),
  };
}

interface StubAdapterOptions {
  source?: IDataSource;
  beginRejection?: unknown;
  rawRejection?: unknown;
  rollbackRejection?: unknown;
}

function stubAdapter(options: StubAdapterOptions): IDatabaseAdapter {
  const source: IDataSource = options.source ?? refusingDataSource(new Error('not reached'));
  return {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    isReady: () => true,
    createDataSource: () => source,
    beginTransaction: () =>
      options.beginRejection === undefined
        // The in-transaction conflict case: the acquisition SUCCEEDS so the
        // work runs and hits the refusing data source; commit/rollback are
        // inert — the framework rolls back in the same catch that classifies.
        ? Promise.resolve({
          commit: () => Promise.resolve(),
          rollback: () =>
            options.rollbackRejection === undefined
              ? Promise.resolve()
              : Promise.reject(options.rollbackRejection),
          createDataSource: () => source,
        })
        : Promise.reject(options.beginRejection),
    rawQuery: <T>(_sql: string, _params?: unknown[]): Promise<T[]> =>
      options.rawRejection === undefined
        ? Promise.reject(new Error('not reached'))
        : Promise.reject(options.rawRejection),
  };
}

function bootStubApp(adapter: IDatabaseAdapter): ReturnType<typeof createApplication> {
  const app = createApplication({
    plugins: [RuntimePlugin(), DatabasePlugin({ type: 'custom', adapter })],
  });
  app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 10, name: 'errors' });
  app.router.get('/transfer', {
    handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const repo = db.getRepository<Record<string, unknown>>('Account');
      return ctx.response.json(await repo.findAll({ where: { id: 7 } }));
    },
  });
  app.router.get('/raw', {
    handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      return ctx.response.json(await db.query('SELECT * FROM account'));
    },
  });
  app.router.post('/tx', {
    handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      // The work itself conflicts INSIDE the transaction: the scoped
      // repository classifies, `transaction()` rethrows verbatim.
      await db.transaction(async (uow) => {
        await uow.getRepository('Account').findAll({ where: { id: 7 } });
      });
      return ctx.response.json({});
    },
  });
  app.router.post('/pool', {
    handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      await db.transaction(async () => {});
      return ctx.response.json({});
    },
  });
  return app;
}

describe('driver conditions answer their classified status (X38-1/X35-2)', () => {
  it('answers a SQLSTATE 40001 from a real cause chain with 409, field by field', async () => {
    const app = bootStubApp(
      stubAdapter({ source: refusingDataSource(drizzleSerializationFailure()) }),
    );
    await app.start();
    try {
      const response = await app.inject({ method: 'GET', url: 'http://localhost/transfer' });
      expect(response.statusCode).toBe(409);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      expect(response.json()).toEqual({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail:
          'The write conflicted with a concurrent transaction and was rolled back. It is safe to retry.',
        instance: '/transfer',
      });
    } finally {
      await app.stop();
    }
  });

  it('the 409 body carries neither the statement text nor a bound parameter', async () => {
    // §3.7: the wrapper's `cause` keeps the driver diagnostic reachable for
    // the log; the body keeps it out. The stub's message deliberately quotes
    // the failing statement and its values.
    const app = bootStubApp(
      stubAdapter({ source: refusingDataSource(drizzleSerializationFailure()) }),
    );
    await app.start();
    try {
      const response = await app.inject({ method: 'GET', url: 'http://localhost/transfer' });
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toContain('Failed query');
      expect(serialized).not.toContain('balance');
      expect(serialized).not.toContain('account');
      expect(serialized).not.toContain('concurrent update');
    } finally {
      await app.stop();
    }
  });

  it('a conflict inside a transaction answers 409 even when rollback fails', async () => {
    // The scoped repository classifies; `transaction()`'s catch passes the
    // package-owned error through untouched. Re-wrapping there would put the
    // first wrapper into the caller's cause chain.
    const app = bootStubApp(
      stubAdapter({
        source: refusingDataSource(drizzleSerializationFailure()),
        rollbackRejection: new Error('connection lost during rollback'),
      }),
    );
    await app.start();
    try {
      const response = await app.inject({ method: 'POST', url: 'http://localhost/tx' });
      expect(response.statusCode).toBe(409);
      const body = response.json<{ detail: string }>();
      expect(body.detail)
        .toBe(
          'The write conflicted with a concurrent transaction and was rolled back. It is safe to retry.',
        );
    } finally {
      await app.stop();
    }
  });

  it('answers a raw-query conflict with 409 at the query() site', async () => {
    const app = bootStubApp(stubAdapter({ rawRejection: drizzleSerializationFailure() }));
    await app.start();
    try {
      const response = await app.inject({ method: 'GET', url: 'http://localhost/raw' });
      expect(response.statusCode).toBe(409);
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toContain('SELECT');
    } finally {
      await app.stop();
    }
  });

  it('masks a commit failure whose outcome is unknown', async () => {
    // A lost commit acknowledgement can follow a successful write. Even a
    // recognizable Bigtable gRPC code must not advertise the retry-safe
    // contract. This uses the built-in Bigtable arm so code 10 reaches the
    // classifier-enabled path rather than the unclassified custom arm.
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DatabasePlugin({
          type: 'bigtable',
          options: {
            client: commitAcknowledgementLostBigtableClient(),
            instance: 'test-instance',
            tables: {
              Event: {
                table: 'events',
                rowKey: { fields: ['tenantId', 'eventId'], separator: '#' },
                columnFamily: 'cf',
              },
            },
          },
        }),
      ],
    });
    app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 10, name: 'errors' });
    app.router.post('/commit-only', {
      handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
        const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
        await db.transaction(async (uow) => {
          await uow.getRepository('Event').create({ tenantId: 't1', eventId: 'e1' });
        });
        return ctx.response.json({});
      },
    });
    await app.start();
    try {
      const response = await app.inject({ method: 'POST', url: 'http://localhost/commit-only' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'Internal Server Error',
        instance: '/commit-only',
      });
      // The driver `details` text stays out of the body.
      expect(JSON.stringify(response.json())).not.toContain('ABORTED');
    } finally {
      await app.stop();
    }
  });

  it('answers a pool-acquisition timeout with 503 and no Retry-After', async () => {
    // X35-2: the acquisition sits OUTSIDE the transaction's try, so the
    // refusal is classified at the acquisition itself. And per C1, no hinted
    // answer carries `Retry-After`: the hint channel has no header, and the
    // framework holds no honest value for a pool's horizon.
    const app = bootStubApp(
      stubAdapter({ beginRejection: new Error('timeout exceeded when trying to connect') }),
    );
    await app.start();
    try {
      const response = await app.inject({ method: 'POST', url: 'http://localhost/pool' });
      expect(response.statusCode).toBe(503);
      expect(response.headers.get('retry-after')).toBe(null);
      expect(response.json()).toEqual({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: 'The database is temporarily unavailable. The request was not applied.',
        instance: '/pool',
      });
      // The driver's own words stay out of the body (they reached the log).
      expect(JSON.stringify(response.json())).not.toContain('timeout exceeded');
    } finally {
      await app.stop();
    }
  });
});
