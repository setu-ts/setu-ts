/**
 * V9-21 end to end: the operator `release` refusals of the inbox and the
 * outbox reach the client as their own status with their own sentence —
 * 400, 404 and 409 — not as a masked `500 Internal Server Error`.
 *
 * Driven through a REAL `createApplication` with the real memory
 * `DatabasePlugin`, the plugin's own inbox and outbox bridges, and the real
 * `errorHandler` in `rfc9457` format. The row id goes in the request BODY,
 * because `rfc9457` derives `instance` from the request path; the test
 * asserts the id and any stored status are ABSENT from the body, and a
 * genuine fault on a neighbouring route still answers a masked 500.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import type { HandlerResult, IRequestContext } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import {
  createDatabaseInboxStore,
  createDatabaseOutboxStore,
  DatabasePlugin,
} from '@setu-ts/database-plugin';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { MessagingPlugin } from '../../src/index.ts';
import type { IInbox, IOutbox } from '../../src/index.ts';
import { orderPlaced } from '../fixtures/outbox.ts';

/** A well-formed 64-hex marker id naming no stored row. */
const ABSENT = 'f'.repeat(64);
/** The id of the stored, not-parked inbox row. */
const PROCESSED = 'a'.repeat(64);

/** Boots the app: runtime, memory database, the plugin's inbox and outbox. */
function bootApp(): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DatabasePlugin({ type: 'memory' }),
      MessagingPlugin({
        inbox: { store: createDatabaseInboxStore(), purge: { schedule: false } },
        outbox: { store: createDatabaseOutboxStore(), relay: { schedule: false } },
      }),
    ],
  });
  app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 10, name: 'errors' });
  app.router.post('/inbox-release', async (ctx: IRequestContext): Promise<HandlerResult> => {
    const { id } = await ctx.request.json<{ id: string }>();
    const inbox = ctx.services.get<IInbox>(CAPABILITIES.INBOX);
    await inbox.release(id, 'retry');
    return ctx.response.json({ released: id });
  });
  app.router.post('/outbox-release', async (ctx: IRequestContext): Promise<HandlerResult> => {
    const { id } = await ctx.request.json<{ id: string }>();
    const outbox = ctx.services.get<IOutbox>(CAPABILITIES.OUTBOX);
    await outbox.release(id, 'retry');
    return ctx.response.json({ released: id });
  });
  app.router.get('/boom', {
    handler: (): HandlerResult => {
      throw new Error(`release row ${'x'.repeat(64)}`);
    },
  });
  return app;
}

/** The `Inbox` entity, for the one row the test plants. */
function inboxRepo(app: IKernelApplication) {
  return app.services
    .get<IDatabaseService>(CAPABILITIES.DATABASE)
    .getRepository<Record<string, unknown>, string>('Inbox');
}

/** Writes one outbox row through the service in its own transaction. */
function writeOutboxRow(app: IKernelApplication, n: number): Promise<string> {
  const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
  const outbox = app.services.get<IOutbox>(CAPABILITIES.OUTBOX);
  return db.transaction((uow) => outbox.write(uow, orderPlaced, { n }));
}

describe('operator release refusals answer their own status through errorHandler', () => {
  it('answers a malformed inbox row id with 400, field by field', async () => {
    const app = bootApp();
    await app.start();
    try {
      const response = await app.inject({
        method: 'POST',
        url: 'http://localhost/inbox-release',
        body: { id: 'nope' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      expect(response.json()).toEqual({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'The inbox row id is malformed.',
        instance: '/inbox-release',
      });
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toContain('message');
      expect(serialized).not.toContain('nope');
    } finally {
      await app.stop();
    }
  });

  it('answers a missing inbox row with 404 and no row text in the body', async () => {
    const app = bootApp();
    await app.start();
    try {
      const response = await app.inject({
        method: 'POST',
        url: 'http://localhost/inbox-release',
        body: { id: ABSENT },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'No inbox row has that id.',
        instance: '/inbox-release',
      });
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toContain(ABSENT);
    } finally {
      await app.stop();
    }
  });

  it('answers a not-parked inbox row with 409 and no stored status in the body', async () => {
    const app = bootApp();
    await app.start();
    try {
      await inboxRepo(app).create({
        id: PROCESSED,
        kind: 'setu-inbox',
        consumer: 'payroll',
        topic: 'people.hired.v1',
        status: 'processed',
        attempts: 3,
        updatedAt: 5,
      });
      const response = await app.inject({
        method: 'POST',
        url: 'http://localhost/inbox-release',
        body: { id: PROCESSED },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'The inbox row is not parked, so it cannot be released.',
        instance: '/inbox-release',
      });
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toContain(PROCESSED);
      expect(serialized).not.toContain('processed');
    } finally {
      await app.stop();
    }
  });

  it('answers a malformed outbox row id with 400, string and non-string', async () => {
    const app = bootApp();
    await app.start();
    try {
      for (const id of ['', 5]) {
        const response = await app.inject({
          method: 'POST',
          url: 'http://localhost/outbox-release',
          body: { id },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'The outbox row id is malformed.',
          instance: '/outbox-release',
        });
      }
    } finally {
      await app.stop();
    }
  });

  it('answers a missing outbox row with 404 and no row text in the body', async () => {
    const app = bootApp();
    await app.start();
    try {
      const response = await app.inject({
        method: 'POST',
        url: 'http://localhost/outbox-release',
        body: { id: ABSENT },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'No outbox row has that id.',
        instance: '/outbox-release',
      });
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toContain(ABSENT);
    } finally {
      await app.stop();
    }
  });

  it('answers a not-failed outbox row with 409 and no stored status in the body', async () => {
    const app = bootApp();
    await app.start();
    try {
      const row = await writeOutboxRow(app, 1); // a pending row
      const response = await app.inject({
        method: 'POST',
        url: 'http://localhost/outbox-release',
        body: { id: row },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'The outbox row is not failed, so it cannot be released.',
        instance: '/outbox-release',
      });
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toContain(row);
      expect(serialized).not.toContain('pending');
    } finally {
      await app.stop();
    }
  });

  it('still answers a genuine fault with a masked 500', async () => {
    const app = bootApp();
    await app.start();
    try {
      const response = await app.inject({ method: 'GET', url: 'http://localhost/boom' });
      expect(response.statusCode).toBe(500);
      const serialized = JSON.stringify(response.json());
      expect(response.json()).toMatchObject({ status: 500, detail: 'Internal Server Error' });
      expect(serialized).not.toContain('x'.repeat(64));
    } finally {
      await app.stop();
    }
  });
});
