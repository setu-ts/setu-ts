/**
 * E2E application test for DatabasePlugin.
 *
 * Uses createApplication() with a runtime-provider test plugin and
 * DatabasePlugin({ type: 'memory' }), registers routes exercising
 * CRUD and transaction-rollback isolation, then verifies via app.inject().
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type {
  HandlerResult,
  IPlugin,
  IPluginContext,
  IRequestContext,
  IRuntimeServices,
} from '@hono-enterprise/common';

import { createApplication } from '@hono-enterprise/kernel';
import { DatabasePlugin } from '../../src/plugin/database-plugin.ts';
import type { IDatabaseService, IUnitOfWork } from '../../src/interfaces/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** User entity shape used across routes. */
interface User {
  id: string;
  name: string;
  email: string;
}

/** Create a runtime plugin backed by the fake runtime. */
function createTestRuntimePlugin(): IPlugin {
  const runtime: IRuntimeServices = createFakeRuntime();
  return {
    name: 'test-runtime',
    version: '0.1.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, runtime);
    },
  };
}

/**
 * A plugin that registers database CRUD routes.
 * Depends on the database service being registered first.
 */
function createDatabaseRoutesPlugin(): IPlugin {
  return {
    name: 'database-routes',
    version: '0.1.0',
    dependencies: ['database'],
    register(ctx: IPluginContext) {
      // POST /users — create a user
      ctx.router.post('/users', (reqCtx: IRequestContext): Promise<HandlerResult> => {
        return (async (): Promise<HandlerResult> => {
          const body = await reqCtx.request.json<Partial<User>>();
          const db = reqCtx.services.get<IDatabaseService>('database');
          if (!db) {
            return reqCtx.response.status(500).json({ error: 'Database service not available' });
          }
          const repo = db.getRepository<User>('User');
          const user = await repo.create({
            name: body.name ?? '',
            email: body.email ?? '',
          });
          return reqCtx.response.status(201).json(user);
        })();
      });

      // GET /users/:id — read a user
      ctx.router.get('/users/:id', (reqCtx: IRequestContext): Promise<HandlerResult> => {
        return (async (): Promise<HandlerResult> => {
          const db = reqCtx.services.get<IDatabaseService>('database');
          if (!db) {
            return reqCtx.response.status(500).json({ error: 'Database service not available' });
          }
          const repo = db.getRepository<User>('User');
          const user = await repo.findById(reqCtx.params.id);
          if (!user) {
            return reqCtx.response.status(404).json({ error: 'User not found' });
          }
          return reqCtx.response.json(user);
        })();
      });

      // POST /users/tx-rollback — transaction that fails mid-way
      ctx.router.post('/users/tx-rollback', (reqCtx: IRequestContext): Promise<HandlerResult> => {
        return (async (): Promise<HandlerResult> => {
          const db = reqCtx.services.get<IDatabaseService>('database');
          if (!db) {
            return reqCtx.response.status(500).json({ error: 'Database service not available' });
          }
          try {
            await db.transaction(async (uow: IUnitOfWork) => {
              const repo = uow.getRepository<User>('User');
              await repo.create({ id: 'tx-a', name: 'UserA', email: 'a@test.com' });
              // Simulate failure mid-transaction.
              throw new Error('simulated mid-transaction failure');
            });
            return reqCtx.response.json({ ok: true });
          } catch (error) {
            return reqCtx.response.status(500).json({ error: String(error) });
          }
        })();
      });

      // POST /users/tx-commit — successful transaction
      ctx.router.post('/users/tx-commit', (reqCtx: IRequestContext): Promise<HandlerResult> => {
        return (async (): Promise<HandlerResult> => {
          const db = reqCtx.services.get<IDatabaseService>('database');
          if (!db) {
            return reqCtx.response.status(500).json({ error: 'Database service not available' });
          }
          try {
            const result = await db.transaction(async (uow: IUnitOfWork) => {
              const repo = uow.getRepository<User>('User');
              const user = await repo.create({
                id: 'tx-ok',
                name: 'Committed',
                email: 'ok@test.com',
              });
              return user;
            });
            return reqCtx.response.status(201).json(result);
          } catch (error) {
            return reqCtx.response.status(500).json({ error: String(error) });
          }
        })();
      });
    },
  };
}

describe('DatabasePlugin E2E — with real application', () => {
  it('creates a user via POST and reads it back via GET', async () => {
    const app = createApplication({
      plugins: [
        createTestRuntimePlugin(),
        DatabasePlugin({ type: 'memory' }),
        createDatabaseRoutesPlugin(),
      ],
    });

    await app.start();

    // POST — create user
    const createRes = await app.inject({
      method: 'POST',
      url: 'http://localhost/users',
      body: { name: 'Alice', email: 'alice@example.com' },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json<User>();
    expect(created.id).toBeDefined();
    expect(created.name).toBe('Alice');
    expect(created.email).toBe('alice@example.com');

    // GET — read back
    const getRes = await app.inject({
      method: 'GET',
      url: `http://localhost/users/${created.id}`,
    });
    expect(getRes.statusCode).toBe(200);
    const found = getRes.json<User>();
    expect(found.id).toBe(created.id);
    expect(found.name).toBe('Alice');

    await app.stop();
  });

  it('transaction rollback prevents partial writes from surviving', async () => {
    const app = createApplication({
      plugins: [
        createTestRuntimePlugin(),
        DatabasePlugin({ type: 'memory' }),
        createDatabaseRoutesPlugin(),
      ],
    });

    await app.start();

    // Trigger the failing transaction.
    const txRes = await app.inject({
      method: 'POST',
      url: 'http://localhost/users/tx-rollback',
      body: {},
    });
    expect(txRes.statusCode).toBe(500);
    expect(txRes.json<{ error: string }>().error).toContain('simulated mid-transaction failure');

    // Verify: the rolled-back user does NOT exist.
    const checkRes = await app.inject({
      method: 'GET',
      url: 'http://localhost/users/tx-a',
    });
    expect(checkRes.statusCode).toBe(404);

    await app.stop();
  });

  it('successful transaction commits and data is readable outside the transaction', async () => {
    const app = createApplication({
      plugins: [
        createTestRuntimePlugin(),
        DatabasePlugin({ type: 'memory' }),
        createDatabaseRoutesPlugin(),
      ],
    });

    await app.start();

    // Trigger the successful transaction.
    const txRes = await app.inject({
      method: 'POST',
      url: 'http://localhost/users/tx-commit',
      body: {},
    });
    expect(txRes.statusCode).toBe(201);
    const committed = txRes.json<User>();
    expect(committed.id).toBe('tx-ok');
    expect(committed.name).toBe('Committed');

    // Verify: the committed user IS readable outside the transaction.
    const checkRes = await app.inject({
      method: 'GET',
      url: 'http://localhost/users/tx-ok',
    });
    expect(checkRes.statusCode).toBe(200);
    const found = checkRes.json<User>();
    expect(found.id).toBe('tx-ok');
    expect(found.name).toBe('Committed');

    await app.stop();
  });
});
