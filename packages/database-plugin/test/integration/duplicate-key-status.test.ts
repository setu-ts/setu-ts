/**
 * A duplicate key answers `409 Conflict`, through a real kernel application.
 *
 * Before `DuplicateKeyError`, every backend's unique violation reached
 * `errorHandler` as a plain `Error` and was answered as a masked `500`,
 * measured on the memory adapter, PostgreSQL through Drizzle, MongoDB and
 * DynamoDB Local. The driver-shaped rejections here are the measured ones;
 * the guarded live suites prove the drivers still emit them.
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
import { DatabasePlugin } from '../../src/index.ts';
import type { IDatabaseService } from '../../src/index.ts';

/** PostgreSQL's unique violation as drizzle surfaces it: SQLSTATE one level down. */
function drizzleUniqueViolation(): Error {
  return new Error('Failed query: insert into "accounts" ("id", "email") values ($1, $2)', {
    cause: Object.assign(
      new Error('duplicate key value violates unique constraint "accounts_email_key"'),
      { code: '23505', detail: 'Key (email)=(ada@example.com) already exists.' },
    ),
  });
}

/** A data source whose create rejects with `rejection`; nothing else is reached. */
function refusingCreate(rejection: unknown): IDataSource {
  const unreached = () => Promise.reject(new Error('not reached'));
  return {
    findAll: unreached,
    findById: unreached,
    create: () => Promise.reject(rejection),
    update: unreached,
    delete: unreached,
    count: unreached,
  };
}

/** An adapter whose transaction commit rejects with `commitRejection`. */
function stubAdapter(source: IDataSource, commitRejection?: unknown): IDatabaseAdapter {
  return {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    isReady: () => true,
    createDataSource: () => source,
    beginTransaction: () =>
      Promise.resolve({
        commit: () =>
          commitRejection === undefined ? Promise.resolve() : Promise.reject(commitRejection),
        rollback: () => Promise.resolve(),
        createDataSource: () => source,
      }),
    rawQuery: () => Promise.reject(new Error('not reached')),
  };
}

function boot(plugin: ReturnType<typeof DatabasePlugin>, format: ErrorFormat = 'rfc9457') {
  const app = createApplication({ plugins: [RuntimePlugin(), plugin] });
  app.middleware.add(errorHandler({ format }), { priority: 10, name: 'errors' });
  app.router.post('/accounts', {
    handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const body = await ctx.request.json() as Record<string, unknown>;
      return ctx.response.status(201).json(await db.getRepository('Account').create(body));
    },
  });
  app.router.post('/commit', {
    handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      await db.transaction(async () => {});
      return ctx.response.json({});
    },
  });
  return app;
}

const DETAIL =
  'A record with the same unique key already exists. The conflicting write was rejected.';

describe('a duplicate key answers 409 Conflict', () => {
  it('maps PostgreSQL 23505 to a Problem Details 409, field by field', async () => {
    const app = boot(DatabasePlugin({
      type: 'custom',
      adapter: stubAdapter(refusingCreate(drizzleUniqueViolation())),
    }));
    await app.start();
    try {
      const response = await app.inject({
        method: 'POST',
        url: 'http://localhost/accounts',
        body: { id: 'a2', email: 'ada@example.com' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: DETAIL,
        instance: '/accounts',
      });
      // Neither the duplicated value nor the statement reaches the client.
      expect(response.body).not.toContain('ada@example.com');
      expect(response.body).not.toContain('insert into');
    } finally {
      await app.stop();
    }
  });

  it('answers 409 under the default error format too', async () => {
    const app = boot(
      DatabasePlugin({
        type: 'custom',
        adapter: stubAdapter(refusingCreate(drizzleUniqueViolation())),
      }),
      'default',
    );
    await app.start();
    try {
      const response = await app.inject({
        method: 'POST',
        url: 'http://localhost/accounts',
        body: { id: 'a2' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        statusCode: 409,
        message: 'Conflict',
        details: { detail: DETAIL },
      });
    } finally {
      await app.stop();
    }
  });

  it('answers 409 for the memory adapter, which raises the error itself', async () => {
    const app = boot(DatabasePlugin({ type: 'memory' }));
    await app.start();
    try {
      const first = await app.inject({
        method: 'POST',
        url: 'http://localhost/accounts',
        body: { id: 'a1' },
      });
      expect(first.statusCode).toBe(201);
      const second = await app.inject({
        method: 'POST',
        url: 'http://localhost/accounts',
        body: { id: 'a1' },
      });
      expect(second.statusCode).toBe(409);
      expect((second.json() as { detail: string }).detail).toBe(DETAIL);
    } finally {
      await app.stop();
    }
  });

  it('maps a duplicate refused at commit (D1 batch, measured message) to 409', async () => {
    const d1Refusal = new Error(
      'D1_ERROR: UNIQUE constraint failed: accounts.id: SQLITE_CONSTRAINT ' +
        '(extended: SQLITE_CONSTRAINT_PRIMARYKEY)',
    );
    const app = boot(DatabasePlugin({
      type: 'custom',
      adapter: stubAdapter(refusingCreate(new Error('not reached')), d1Refusal),
    }));
    await app.start();
    try {
      const response = await app.inject({ method: 'POST', url: 'http://localhost/commit' });
      expect(response.statusCode).toBe(409);
      expect((response.json() as { detail: string }).detail).toBe(DETAIL);
    } finally {
      await app.stop();
    }
  });

  it('still masks any OTHER commit rejection, whose outcome may be unknown', async () => {
    // A retryable class is not advertised at commit: a lost acknowledgement
    // can follow a write the server applied. Only a duplicate is mapped there.
    const serialization = Object.assign(new Error('could not serialize access'), {
      code: '40001',
    });
    const app = boot(DatabasePlugin({
      type: 'custom',
      adapter: stubAdapter(refusingCreate(new Error('not reached')), serialization),
    }));
    await app.start();
    try {
      const response = await app.inject({ method: 'POST', url: 'http://localhost/commit' });
      expect(response.statusCode).toBe(500);
    } finally {
      await app.stop();
    }
  });
});
