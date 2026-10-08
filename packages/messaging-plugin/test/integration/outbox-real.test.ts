/**
 * The outbox relay against REAL backends (M107 §3.13, §6): real PostgreSQL
 * (Drizzle over `npm:pg`, the committed DDL fixture) under a real kernel
 * application, relaying to a REAL RabbitMQ 4 and to REAL Redis Streams.
 *
 * Each transport proves, end to end through `MessagingPlugin({ outbox })`:
 *
 * - a business row and an outbox row written through ONE real unit of work
 *   commit together, and the SCHEDULED relay (the real `SchedulerPlugin`)
 *   delivers the event to a subscriber with the envelope id as its
 *   deduplication id; a rolled-back transaction leaves neither row and
 *   publishes nothing;
 * - one ordering key's rows arrive in write order;
 * - the crash rows of §3.13: a process that dies after publishing the second
 *   of four keyed rows (its `markSent` never returns) leaves row 1 `sent`; a
 *   NEW process over the same table publishes row 2 AGAIN — the same envelope
 *   id, the duplicate the promise allows — then rows 3 and 4 in order.
 *
 * Guarded with `ignore:` on the variables (never an early return, M70c):
 * `OUTBOX_POSTGRES_URL` + `RABBITMQ_URL`, and `OUTBOX_POSTGRES_URL` +
 * `REDIS_URL`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IMessageBroker,
  IOutboxStore,
  IServiceRegistry,
  MessageMetadata,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createDatabaseOutboxStore, DatabasePlugin } from '@setu-ts/database-plugin';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
import {
  drizzleOutboxAdapter,
  postgresOutboxSchema,
} from '../../../database-plugin/test/fixtures/outbox-postgres.ts';
import type { PostgresOutboxSchema } from '../../../database-plugin/test/fixtures/outbox-postgres.ts';

import { defineIntegrationEvent, MessagingPlugin } from '../../src/index.ts';
import type {
  IntegrationEventDefinition,
  IOutbox,
  MessagingPluginOptions,
  OutboxRelayOptions,
} from '../../src/index.ts';
import { FaultStore } from '../fixtures/outbox.ts';

const postgresUrl = Deno.env.get('OUTBOX_POSTGRES_URL');
const rabbitUrl = Deno.env.get('RABBITMQ_URL');
const redisUrl = Deno.env.get('REDIS_URL');

/** One event shape: an ordering key and a sequence number. */
interface Placed {
  readonly key?: string;
  readonly n: number;
}

/** A per-run definition: a unique topic, keyed by `data.key`. */
function definitionFor(transport: string): IntegrationEventDefinition<Placed> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  return defineIntegrationEvent<Placed>({
    type: 'orders.placed',
    version: 1,
    topic: `m107.${transport}.${suffix}.orders.v1`,
    parse: (value) => value as Placed,
    orderingKey: (envelope) => envelope.data.key,
  });
}

/** Polls a predicate until true or the deadline, without a fixed sleep. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Lets a scheduled relay run before an absence is asserted. */
function settle(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One delivered event as a subscriber saw it. */
interface Delivered {
  readonly id: string;
  readonly n: number;
  readonly metadata: MessageMetadata | undefined;
}

/** A transport the suite runs against. */
interface Transport {
  readonly name: string;
  readonly messaging: () => Record<string, unknown>;
  /** The deduplication id as this transport delivers it. */
  readonly deduplicationId: (metadata: MessageMetadata | undefined) => string | undefined;
}

const transports: readonly (Transport & { readonly ignore: boolean })[] = [
  {
    name: 'RabbitMQ',
    ignore: postgresUrl === undefined || rabbitUrl === undefined,
    messaging: () => ({ broker: 'rabbitmq', url: rabbitUrl! }),
    // RabbitMQ maps `deduplicationId` onto the AMQP `message-id` property.
    deduplicationId: (metadata) => metadata?.messageId,
  },
  {
    name: 'Redis Streams',
    ignore: postgresUrl === undefined || redisUrl === undefined,
    messaging: () => ({
      broker: 'redis-streams',
      url: redisUrl!,
      defaultQueue: `m107-${crypto.randomUUID().slice(0, 8)}`,
      pollIntervalMs: 10,
      blockSizeMs: 10,
    }),
    deduplicationId: (metadata) => metadata?.headers?.['x-setu-deduplication-id'],
  },
];

/** Builds one "process": runtime, optional scheduler, Drizzle over the schema, messaging + outbox. */
function processFor(
  pg: PostgresOutboxSchema,
  transport: Transport,
  opts: {
    readonly relay: OutboxRelayOptions;
    readonly store?: (services: IServiceRegistry) => IOutboxStore;
  },
): IKernelApplication {
  const scheduled = opts.relay.schedule !== false;
  return createApplication({
    plugins: [
      RuntimePlugin(),
      ...(scheduled ? [SchedulerPlugin()] : []),
      DatabasePlugin({ type: 'custom', adapter: drizzleOutboxAdapter(pg.pool) }),
      MessagingPlugin({
        ...transport.messaging(),
        outbox: { store: opts.store ?? createDatabaseOutboxStore(), relay: opts.relay },
      } as MessagingPluginOptions),
    ],
  });
}

/** Subscribes a recording consumer on the app's broker. */
async function consume(
  app: IKernelApplication,
  definition: IntegrationEventDefinition<Placed>,
  into: Delivered[],
): Promise<void> {
  const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
  await broker.subscribe(definition.topic, (message, metadata) => {
    const envelope = message as { id: string; data: Placed };
    into.push({ id: envelope.id, n: envelope.data.n, metadata });
  });
}

/** Every stored outbox row, by position. */
async function storedRows(app: IKernelApplication): Promise<Record<string, unknown>[]> {
  return await app.services.get<IDatabaseService>(CAPABILITIES.DATABASE)
    .getRepository<Record<string, unknown>, string>('Outbox')
    .findAll({ orderBy: { position: 'asc' } });
}

/** A short, fast relay budget so a hung call is abandoned quickly. */
const FAST_BUDGET: OutboxRelayOptions = {
  schedule: false,
  publishTimeoutMs: 3_000,
  storeTimeoutMs: 500,
  sweepDeadlineMs: 5_000,
};

for (const transport of transports) {
  describe(`outbox relay over real PostgreSQL → ${transport.name}`, {
    ignore: transport.ignore,
  }, () => {
    it('a business row and its event commit through one unit of work and the scheduled relay delivers it', async () => {
      const pg = await postgresOutboxSchema(postgresUrl!, true);
      const app = processFor(pg, transport, { relay: { intervalMs: 50 } });
      const definition = definitionFor(transport.name.replaceAll(' ', '-').toLowerCase());
      const delivered: Delivered[] = [];
      await app.start();
      try {
        await consume(app, definition, delivered);
        const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
        const outbox = app.services.get<IOutbox>(CAPABILITIES.OUTBOX);

        const id = await db.transaction(async (uow) => {
          await uow.getRepository('Order').create({ id: 'o-1', total: 42 });
          return await outbox.write(uow, definition, { n: 1 });
        });
        const rolledBack = await db.transaction(async (uow) => {
          await uow.getRepository('Order').create({ id: 'o-2', total: 7 });
          await outbox.write(uow, definition, { n: 2 });
          throw new Error('business rule');
        }).catch((error: unknown) => error);

        await waitFor(() => delivered.length >= 1, 'the relayed event');
        // Several relay intervals pass: the rolled-back event never appears.
        await settle(400);

        expect((rolledBack as Error).message).toBe('business rule');
        expect(delivered.map((d) => [d.id, d.n])).toEqual([[id, 1]]);
        expect(transport.deduplicationId(delivered[0]!.metadata)).toBe(id);
        const orders = await db.getRepository<{ id: string }>('Order').findAll();
        expect(orders.map((o) => o.id)).toEqual(['o-1']);
        const rows = await storedRows(app);
        expect(rows.map((r) => [r.id, r.status])).toEqual([[id, 'sent']]);
      } finally {
        await app.stop();
        await pg.dispose();
      }
    });

    it('one ordering key arrives in write order', async () => {
      const pg = await postgresOutboxSchema(postgresUrl!, true);
      const app = processFor(pg, transport, { relay: { schedule: false } });
      const definition = definitionFor(`${transport.name.replaceAll(' ', '-').toLowerCase()}-k`);
      const delivered: Delivered[] = [];
      await app.start();
      try {
        await consume(app, definition, delivered);
        const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
        const outbox = app.services.get<IOutbox>(CAPABILITIES.OUTBOX);
        for (let n = 1; n <= 6; n++) {
          await db.transaction((uow) => outbox.write(uow, definition, { key: 'K', n }));
        }
        const result = await outbox.sweep();

        expect(result.published).toBe(6);
        await waitFor(() => delivered.length === 6, 'six keyed events');
        expect(delivered.map((d) => d.n)).toEqual([1, 2, 3, 4, 5, 6]);
      } finally {
        await app.stop();
        await pg.dispose();
      }
    });

    it('a process dying after a publish: the next process republishes that row (same id), then the rest in order', async () => {
      const pg = await postgresOutboxSchema(postgresUrl!, true, 8);
      let marks = 0;
      // The first process's store: its SECOND markSent never returns — the
      // process dies between a successful publish and the status write.
      const dying = processFor(pg, transport, {
        relay: FAST_BUDGET,
        store: (services) => {
          const store = new FaultStore(createDatabaseOutboxStore()(services));
          store.faults.markSent = () => {
            marks += 1;
            return marks === 2 ? new Promise<void>(() => {}) : undefined;
          };
          return store;
        },
      });
      const fresh = processFor(pg, transport, { relay: FAST_BUDGET });
      const definition = definitionFor(`${transport.name.replaceAll(' ', '-').toLowerCase()}-c`);
      const delivered: Delivered[] = [];
      await dying.start();
      await fresh.start();
      try {
        await consume(fresh, definition, delivered);
        const db = dying.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
        const outbox = dying.services.get<IOutbox>(CAPABILITIES.OUTBOX);
        const ids: string[] = [];
        for (let n = 1; n <= 4; n++) {
          ids.push(await db.transaction((uow) => outbox.write(uow, definition, { key: 'K', n })));
        }

        const dyingSweep = outbox.sweep();
        await waitFor(() => delivered.length === 2, 'the two publishes before the crash');
        // The abandoned status write expires at storeTimeoutMs; the key is
        // blocked and the sweep ends, so rows 3 and 4 are never published here.
        expect((await dyingSweep).endedBy).toBe('store-failure');
        const afterCrash = await storedRows(dying);
        expect(afterCrash.map((r) => r.status)).toEqual(['sent', 'pending', 'pending', 'pending']);

        const restarted = await fresh.services.get<IOutbox>(CAPABILITIES.OUTBOX).sweep();
        expect(restarted.published).toBe(3);
        await waitFor(() => delivered.length === 5, 'the republished row and the rest');

        expect(delivered.map((d) => d.n)).toEqual([1, 2, 2, 3, 4]);
        // The duplicate carries ONE envelope id and one deduplication id.
        expect(delivered[1]!.id).toBe(ids[1]);
        expect(delivered[2]!.id).toBe(ids[1]);
        expect(transport.deduplicationId(delivered[1]!.metadata)).toBe(ids[1]);
        expect(transport.deduplicationId(delivered[2]!.metadata)).toBe(ids[1]);
        expect((await storedRows(fresh)).every((r) => r.status === 'sent')).toBe(true);
      } finally {
        await dying.stop();
        await fresh.stop();
        await pg.dispose();
      }
    });
  });
}
