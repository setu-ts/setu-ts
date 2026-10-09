/**
 * The inbox wired through a REAL kernel application (M108 §3.2, §3.6, §3.8,
 * §3.11): `createApplication` with the real `SchedulerPlugin`, the real memory
 * `DatabasePlugin` and its inbox bridge, and the default in-memory broker.
 *
 * Every business write goes through the unit of work the inbox hands the
 * handler, and every claim is read back through the database.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IInboxStore,
  IMessageBroker,
  IPlugin,
  IPluginContext,
  IServiceRegistry,
} from '@setu-ts/common';
import { CAPABILITIES, INBOX_RECORD_KIND } from '@setu-ts/common';
import {
  createDatabaseInboxStore,
  DatabasePlugin,
  InboxStoreUnavailableError,
} from '@setu-ts/database-plugin';
import type { IDatabaseService, IUnitOfWork } from '@setu-ts/database-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';

import {
  InboxPurgeUnscheduledError,
  InboxStoreVerifyTimeoutError,
  MessagingPlugin,
  onIntegrationEvent,
} from '../../src/index.ts';
import type { IInbox, InboxOptions, MessagingPluginOptions } from '../../src/index.ts';
import type { SubscriptionEntry } from '../../src/index.ts';
import { envelope, type Hired, hired } from '../fixtures/inbox.ts';

/** Polls a predicate until true or the deadline, without a fixed sleep. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Lets dispatch work run before an absence is asserted. */
function settle(ms = 60): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const apps: IKernelApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

/** Builds and remembers an app: runtime, scheduler (unless omitted), memory database, messaging. */
function buildApp(opts: {
  inbox?: Partial<InboxOptions>;
  subscriptions?: SubscriptionEntry[];
  scheduler?: boolean;
  before?: IPlugin[];
}): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      ...(opts.scheduler === false ? [] : [SchedulerPlugin()]),
      DatabasePlugin({ type: 'memory' }),
      ...(opts.before ?? []),
      MessagingPlugin({
        inbox: { store: createDatabaseInboxStore(), ...opts.inbox },
        subscriptions: opts.subscriptions ?? [],
      } as MessagingPluginOptions),
    ],
  });
  apps.push(app);
  return app;
}

/** A handler that writes one `Person` row through the inbox's unit of work. */
function writingHandler(calls: string[], fail?: () => boolean) {
  return async (payload: Hired, _e: unknown, _m: unknown, uow: IUnitOfWork) => {
    calls.push(payload.personId);
    await uow.getRepository<Record<string, unknown>>('Person').create({ id: payload.personId });
    if (fail?.()) throw new Error('handler failed after its write');
  };
}

function people(app: IKernelApplication): Promise<Record<string, unknown>[]> {
  return app.services.get<IDatabaseService>(CAPABILITIES.DATABASE)
    .getRepository<Record<string, unknown>>('Person').findAll();
}

function inboxRows(app: IKernelApplication): Promise<Record<string, unknown>[]> {
  return app.services.get<IDatabaseService>(CAPABILITIES.DATABASE)
    .getRepository<Record<string, unknown>>('Inbox').findAll();
}

function publish(app: IKernelApplication, id: string, data?: unknown): Promise<void> {
  return app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING)
    .publish(hired.topic, envelope(id, data));
}

describe('inbox through a real kernel app', () => {
  it('skips a duplicate delivery; the business row and marker are written once', async () => {
    const calls: string[] = [];
    const app = buildApp({
      subscriptions: [
        onIntegrationEvent(hired, writingHandler(calls), { inbox: { consumer: 'payroll' } }),
      ],
    });
    await app.start();

    await publish(app, 'e-1');
    await waitFor(() => calls.length === 1, 'first delivery');
    await publish(app, 'e-1');
    await settle();

    expect(calls).toEqual(['p-1']);
    expect(await people(app)).toHaveLength(1);
    const rows = await inboxRows(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: INBOX_RECORD_KIND,
      consumer: 'payroll',
      status: 'processed',
      envelopeId: 'e-1',
    });
  });

  it('two consumer names each process the same event once', async () => {
    const payroll: string[] = [];
    const audit: string[] = [];
    const app = buildApp({
      subscriptions: [
        onIntegrationEvent(hired, (p) => {
          payroll.push(p.personId);
        }, { inbox: { consumer: 'payroll' } }),
        onIntegrationEvent(hired, (p) => {
          audit.push(p.personId);
        }, { inbox: { consumer: 'audit' } }),
      ],
    });
    await app.start();

    await publish(app, 'e-1');
    await waitFor(() => payroll.length === 1 && audit.length === 1, 'both consumers');
    await publish(app, 'e-1');
    await settle();

    expect([payroll, audit]).toEqual([['p-1'], ['p-1']]);
    expect(await inboxRows(app)).toHaveLength(2);
  });

  it('a failing handler rolls back its write AND the marker; the next delivery succeeds', async () => {
    const calls: string[] = [];
    let failures = 1;
    const app = buildApp({
      subscriptions: [
        onIntegrationEvent(hired, writingHandler(calls, () => failures-- > 0), {
          inbox: { consumer: 'payroll' },
        }),
      ],
    });
    await app.start();

    await publish(app, 'e-1');
    await waitFor(() => calls.length === 1, 'first attempt');
    await settle();
    expect(await people(app)).toEqual([]);
    expect(await inboxRows(app)).toEqual([]);

    // The in-memory broker does not redeliver: the second delivery stands in for it.
    await publish(app, 'e-1');
    await waitFor(() => calls.length === 2, 'second attempt');
    await settle();
    expect(await people(app)).toHaveLength(1);
    expect((await inboxRows(app)).map((row) => row.status)).toEqual(['processed']);
  });

  it('parks after maxAttempts, lists it, and release retry lets it run again', async () => {
    let fail = true;
    const calls: string[] = [];
    const app = buildApp({
      inbox: { maxAttempts: 2 },
      subscriptions: [
        onIntegrationEvent(hired, writingHandler(calls, () => fail), {
          inbox: { consumer: 'payroll' },
        }),
      ],
    });
    await app.start();
    const inbox = app.services.get<IInbox>(CAPABILITIES.INBOX);

    await publish(app, 'e-1');
    await waitFor(() => calls.length === 1, 'attempt 1');
    await publish(app, 'e-1');
    await waitFor(() => calls.length === 2, 'attempt 2');
    await settle();
    const [parked] = await inbox.parked();
    expect(parked).toMatchObject({ consumer: 'payroll', envelopeId: 'e-1', attempts: 2 });

    // Parked: a redelivery is skipped.
    await publish(app, 'e-1');
    await settle();
    expect(calls).toHaveLength(2);

    fail = false;
    const released = await inbox.release(parked!.rowId, 'retry');
    expect(released).toEqual({ topic: hired.topic, envelope: envelope('e-1') });
    await app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING)
      .publish(released.topic, released.envelope);
    await waitFor(() => calls.length === 3, 'retried delivery');
    await settle();
    expect(await people(app)).toHaveLength(1);
    expect(await inbox.parked()).toEqual([]);
  });

  it('the scheduled purge removes markers older than retainMs and keeps parked ones', async () => {
    const app = buildApp({ inbox: { retainMs: 60_000, purge: { intervalMs: 20 } } });
    await app.start();
    const repo = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE)
      .getRepository<Record<string, unknown>>('Inbox');
    const row = (id: string, status: string) => ({
      id,
      kind: INBOX_RECORD_KIND,
      consumer: 'payroll',
      topic: hired.topic,
      status,
      attempts: 0,
      updatedAt: 1,
      envelopeId: null,
      lastError: null,
      envelope: null,
    });
    await repo.create(row('a'.repeat(64), 'processed'));
    await repo.create(row('b'.repeat(64), 'parked'));
    await settle(150);
    expect((await repo.findAll()).map((r) => r.status)).toEqual(['parked']);
  });

  it('refuses start() without a scheduler unless the purge is unscheduled', async () => {
    await expect(buildApp({ scheduler: false }).start()).rejects.toBeInstanceOf(
      InboxPurgeUnscheduledError,
    );
    const manual = buildApp({ scheduler: false, inbox: { purge: { schedule: false } } });
    await manual.start();
    expect(await manual.services.get<IInbox>(CAPABILITIES.INBOX).purge()).toBe(0);
  });

  it('refuses start() when the store is refused or never answers verify()', async () => {
    const refused = createApplication({
      plugins: [
        RuntimePlugin(),
        SchedulerPlugin(),
        DatabasePlugin({ type: 'memory' }),
        MessagingPlugin({
          inbox: {
            store: (services: IServiceRegistry) => {
              const store = createDatabaseInboxStore()(services);
              return {
                ...bound(store),
                verify: () =>
                  Promise.reject(new InboxStoreUnavailableError('Inbox', 'entity-unavailable')),
              };
            },
          },
        }),
      ],
    });
    apps.push(refused);
    await expect(refused.start()).rejects.toBeInstanceOf(InboxStoreUnavailableError);

    const hung = buildApp({
      inbox: {
        storeTimeoutMs: 30,
        store: { ...bound(fakeVerifyStore()), verify: () => new Promise<void>(() => {}) },
      },
    });
    await expect(hung.start()).rejects.toBeInstanceOf(InboxStoreVerifyTimeoutError);
  });

  it('accepts a store instance, and a store whose verify is slow is verified before subscribing', async () => {
    const calls: string[] = [];
    let verified = false;
    const app = buildApp({
      inbox: {
        store: (services: IServiceRegistry) => {
          const store = createDatabaseInboxStore()(services);
          return {
            ...bound(store),
            verify: async () => {
              await settle(40);
              await store.verify();
              verified = true;
            },
          };
        },
      },
      subscriptions: [
        onIntegrationEvent(hired, (p) => {
          calls.push(p.personId);
        }, { inbox: { consumer: 'payroll' } }),
      ],
    });
    await app.start();
    expect(verified).toBe(true);
    await publish(app, 'e-1');
    await waitFor(() => calls.length === 1, 'delivery');
  });

  it('a delivery made during stop() still runs, because the inbox closes after the broker', async () => {
    const calls: string[] = [];
    const holder: { app?: IKernelApplication } = {};
    // Registered BEFORE the messaging plugin, so its `onShutdown` runs AFTER
    // messaging's (shutdown hooks run in reverse) — the window an inbox closed
    // in `onShutdown` would refuse.
    const publisher: IPlugin = {
      name: 'shutdown-publisher',
      version: '0.0.0',
      register(ctx: IPluginContext) {
        ctx.lifecycle.onShutdown(async () => {
          await publish(holder.app!, 'e-stop');
          await waitFor(() => calls.length === 1, 'delivery during shutdown');
        });
      },
    };
    const app = buildApp({
      subscriptions: [
        onIntegrationEvent(hired, writingHandler(calls), { inbox: { consumer: 'payroll' } }),
      ],
      before: [publisher],
    });
    holder.app = app;
    await app.start();
    await app.stop();
    expect(calls).toEqual(['p-1']);
  });
});

/** Every method of a store, bound, so a spread copy still works. */
function bound(store: IInboxStore): IInboxStore {
  return {
    find: (id) => store.find(id),
    run: (marker, work) => store.run(marker, work),
    recordFailure: (ids, update) => store.recordFailure(ids, update),
    park: (marker) => store.park(marker),
    parked: (limit) => store.parked(limit),
    release: (ids, action, now) => store.release(ids, action, now),
    stats: () => store.stats(),
    purge: (before, limit) => store.purge(before, limit),
    verify: () => store.verify(),
  };
}

/** A store that only needs to exist for a verify() test. */
function fakeVerifyStore(): IInboxStore {
  const reject = () => Promise.reject(new Error('unused'));
  return {
    find: reject,
    run: reject,
    recordFailure: reject,
    park: reject,
    parked: reject,
    release: reject,
    stats: reject,
    purge: reject,
    verify: () => Promise.resolve(),
  };
}
