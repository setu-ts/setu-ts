/**
 * `within` end to end on a REAL kernel application with the memory database
 * (M109b §3.3): the README handler answers `201` then a replayed `200` with ONE
 * business row, `422` and `409` reach the client through `errorHandler` from
 * the status hint, and a store error's message reaches neither the body nor a
 * log line.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  EntityKey,
  IIdempotencyService,
  ILogger,
  IPlugin,
  IPluginContext,
  ITransactionalIdempotencyStore,
} from '@setu-ts/common';
import { CAPABILITIES, DuplicateKeyError } from '@setu-ts/common';
import type { IDatabaseService, IUnitOfWork } from '@setu-ts/database-plugin';
import { createDatabaseIdempotencyStore, DatabasePlugin } from '@setu-ts/database-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { IdempotencyPlugin } from '../../src/index.ts';
import { fakeTransactionalStore } from '../fixtures/fake-transactional-store.ts';

/** A plugin providing a logger that records every line. */
function loggerPlugin(lines: { readonly message: string; readonly meta: unknown }[]): IPlugin {
  const logger = {
    level: 'info',
    debug: () => {},
    info: () => {},
    warn: (message: string, meta: unknown) => void lines.push({ message, meta }),
    error: (message: string, meta: unknown) => void lines.push({ message, meta }),
  } as unknown as ILogger;
  return {
    name: 'tier-c-test-logger',
    version: '1.0.0',
    provides: [CAPABILITIES.LOGGER],
    register(ctx: IPluginContext): void {
      ctx.services.register(CAPABILITIES.LOGGER, logger);
    },
  };
}

/** A plugin capturing the services the route and the assertions need. */
function capturePlugin(captured: {
  idempotency?: IIdempotencyService;
  database?: IDatabaseService;
}): IPlugin {
  return {
    name: 'tier-c-test-capture',
    version: '1.0.0',
    register(ctx: IPluginContext): void {
      captured.idempotency = ctx.services.get<IIdempotencyService>(CAPABILITIES.IDEMPOTENCY);
      captured.database = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    },
  };
}

/** The order route: `within` around one business row. */
function ordersRoutePlugin(captured: { idempotency?: IIdempotencyService }): IPlugin {
  return {
    name: 'tier-c-test-orders',
    version: '1.0.0',
    register(ctx: IPluginContext): void {
      ctx.middleware.add(errorHandler());
      ctx.router.post('/orders', async (c) => {
        const key = c.request.headers.get('Idempotency-Key') ?? '';
        const scope = c.request.headers.get('X-Scope') ?? 't1:u1';
        const body = await c.request.json<{ id: string; name: string }>();
        const outcome = await captured.idempotency!.within<{ id: string }, IUnitOfWork>(
          { key, namespace: 'orders.create', scope, fingerprint: body },
          async (uow) => {
            await uow.getRepository<Record<string, unknown>, EntityKey>('Orders').create({
              id: body.id,
              name: body.name,
            });
            return { id: body.id };
          },
        );
        return c.response.status(outcome.replayed ? 200 : 201).json(outcome.value);
      });
    },
  };
}

/** Builds the application over the given tier-C store. */
async function buildApp(store?: ITransactionalIdempotencyStore, logger?: IPlugin) {
  const captured: { idempotency?: IIdempotencyService; database?: IDatabaseService } = {};
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      ...(logger === undefined ? [] : [logger]),
      DatabasePlugin({ type: 'memory' }),
      IdempotencyPlugin({
        transactional: {
          store: store ?? createDatabaseIdempotencyStore(),
          purge: { schedule: false },
        },
      }),
      capturePlugin(captured),
      ordersRoutePlugin(captured),
    ],
  });
  await app.start();
  return { app, captured };
}

/** A POST to the orders route. */
function post(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  key: string,
  body: Record<string, unknown>,
  scope = 't1:u1',
) {
  return app.inject({
    method: 'POST',
    url: 'http://localhost/orders',
    headers: { 'Idempotency-Key': key, 'X-Scope': scope, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('within on a real kernel (M109b §3.3)', () => {
  it('returns equal Date-bearing JSON values on the first call and replay', async () => {
    const { app, captured } = await buildApp();
    try {
      let calls = 0;
      const options = { key: 'date-result', namespace: 'orders.create', scope: 't1:u1' };
      const first = await captured.idempotency!.within<unknown, IUnitOfWork>(
        options,
        async (uow) => {
          calls++;
          await uow.getRepository('Orders').create({ id: 'dated-order', name: 'Ada' });
          return { id: 'dated-order', createdAt: new Date(0) };
        },
      );
      const replay = await captured.idempotency!.within(options, () => {
        calls++;
        return Promise.resolve('unexpected');
      });
      expect(first.value).toEqual({ id: 'dated-order', createdAt: '1970-01-01T00:00:00.000Z' });
      expect(first.value).toEqual(replay.value);
      expect([first.replayed, replay.replayed]).toEqual([false, true]);
      expect(calls).toBe(1);
      expect(await captured.database!.getRepository('Orders').count()).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('answers 201 then a replayed 200, with one business row', async () => {
    const { app, captured } = await buildApp();
    try {
      const first = await post(app, 'k1', { id: 'o-1', name: 'Ada' });
      expect(first.statusCode).toBe(201);
      expect(first.json<{ id: string }>().id).toBe('o-1');

      const second = await post(app, 'k1', { id: 'o-1', name: 'Ada' });
      expect(second.statusCode).toBe(200);
      expect(second.json<{ id: string }>().id).toBe('o-1');

      const rows = await captured.database!.getRepository<Record<string, unknown>, EntityKey>(
        'Orders',
      ).findAll();
      expect(rows).toHaveLength(1);
    } finally {
      await app.stop();
    }
  });

  it('answers 422 for a different fingerprint under one key, through errorHandler', async () => {
    const { app } = await buildApp();
    try {
      await post(app, 'k2', { id: 'o-1', name: 'Ada' });
      const mismatch = await post(app, 'k2', { id: 'o-2', name: 'Grace' });
      expect(mismatch.statusCode).toBe(422);
    } finally {
      await app.stop();
    }
  });

  it('answers 409 for a concurrent duplicate, through errorHandler', async () => {
    const store = fakeTransactionalStore({
      run: () => Promise.reject(new DuplicateKeyError('duplicate')),
    });
    const { app } = await buildApp(store);
    try {
      const conflict = await post(app, 'k3', { id: 'o-1', name: 'Ada' });
      expect(conflict.statusCode).toBe(409);
    } finally {
      await app.stop();
    }
  });

  it('leaks a store failure message into neither the body nor a log line', async () => {
    const lines: { readonly message: string; readonly meta: unknown }[] = [];
    const store = fakeTransactionalStore({
      run: () => Promise.reject(new Error('SECRET bound parameter')),
    });
    const { app } = await buildApp(store, loggerPlugin(lines));
    try {
      const failed = await post(app, 'k4', { id: 'o-1', name: 'Ada' });
      expect(failed.statusCode).toBe(503);
      expect(failed.body ?? '').not.toContain('SECRET');
      expect(JSON.stringify(lines)).not.toContain('SECRET');
    } finally {
      await app.stop();
    }
  });
});
