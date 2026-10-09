/**
 * The consumer inbox against REAL backends (M108 §3.6, §3.13, §6): real
 * PostgreSQL (Drizzle over `npm:pg`, the committed DDL fixture) under a real
 * kernel application, consuming from a REAL RabbitMQ 4 and from REAL Redis
 * Streams.
 *
 * Each transport proves, through `onIntegrationEvent(..., { inbox })`:
 *
 * - a duplicate delivery is acknowledged without running the handler, and the
 *   business row and the marker are written once;
 * - a handler failure rolls back its business row AND the marker, the broker
 *   redelivers, and the redelivery succeeds;
 * - two consumer names each process the same event once;
 * - end to end with M107: an outbox row the relay publishes TWICE (the crash
 *   shape — the row is still `pending` after its first publish) is handled
 *   once.
 *
 * Guarded with `ignore:` on the variables (never an early return, M70c):
 * `OUTBOX_POSTGRES_URL` + `RABBITMQ_URL`, and `OUTBOX_POSTGRES_URL` +
 * `REDIS_URL`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMessageBroker } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import {
  createDatabaseInboxStore,
  createDatabaseOutboxStore,
  DatabasePlugin,
} from '@setu-ts/database-plugin';
import type { IDatabaseService, IUnitOfWork } from '@setu-ts/database-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
import {
  drizzleInboxAdapter,
  postgresInboxSchema,
} from '../../../database-plugin/test/fixtures/inbox-postgres.ts';
import type { PostgresInboxSchema } from '../../../database-plugin/test/fixtures/inbox-postgres.ts';

import { defineIntegrationEvent, MessagingPlugin, onIntegrationEvent } from '../../src/index.ts';
import type {
  IntegrationEventDefinition,
  IOutbox,
  MessagingPluginOptions,
  SubscriptionEntry,
} from '../../src/index.ts';

const postgresUrl = Deno.env.get('OUTBOX_POSTGRES_URL');
const rabbitUrl = Deno.env.get('RABBITMQ_URL');
const redisUrl = Deno.env.get('REDIS_URL');

/** The event every case publishes. */
interface Hired {
  readonly personId: string;
}

/** A per-run definition on a unique topic. */
function definitionFor(transport: string): IntegrationEventDefinition<Hired> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  return defineIntegrationEvent<Hired>({
    type: 'people.hired',
    version: 1,
    topic: `m108.${transport}.${suffix}.people.v1`,
    parse: (value) => value as Hired,
  });
}

/** A consumer name unique to the run, so a durable queue never outlives its test. */
function consumerName(label: string): string {
  return `m108-${label}-${crypto.randomUUID().slice(0, 8)}`;
}

/** An envelope as a producer would publish it. */
function envelopeOf(id: string, personId: string): Record<string, unknown> {
  return {
    id,
    type: 'people.hired',
    version: 1,
    occurredAt: '2026-10-09T00:00:00Z',
    data: { personId },
  };
}

/** Polls a predicate until true or the deadline, without a fixed sleep. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Lets the broker deliver before an absence is asserted. */
function settle(ms = 400): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Transport {
  readonly name: string;
  readonly ignore: boolean;
  readonly messaging: () => Record<string, unknown>;
}

const transports: readonly Transport[] = [
  {
    name: 'RabbitMQ',
    ignore: postgresUrl === undefined || rabbitUrl === undefined,
    messaging: () => ({
      broker: 'rabbitmq',
      url: rabbitUrl!,
      consumerRetry: { maxAttempts: 5, delaysMs: [100] },
    }),
  },
  {
    name: 'Redis Streams',
    ignore: postgresUrl === undefined || redisUrl === undefined,
    messaging: () => ({
      broker: 'redis-streams',
      url: redisUrl!,
      pollIntervalMs: 10,
      blockSizeMs: 10,
      reclaimIntervalMs: 20,
      consumerRetry: { maxAttempts: 5, delaysMs: [150] },
    }),
  },
];

/** One process: runtime, scheduler, Drizzle over the schema, messaging + inbox + outbox. */
function processFor(
  pg: PostgresInboxSchema,
  transport: Transport,
  subscriptions: SubscriptionEntry[],
): IKernelApplication {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      SchedulerPlugin(),
      DatabasePlugin({ type: 'custom', adapter: drizzleInboxAdapter(pg.pool) }),
      MessagingPlugin({
        ...transport.messaging(),
        inbox: { store: createDatabaseInboxStore() },
        outbox: { store: createDatabaseOutboxStore(), relay: { schedule: false } },
        subscriptions,
      } as MessagingPluginOptions),
    ],
  });
}

/** A handler writing one `Person` row through the inbox's unit of work. */
function writer(calls: string[], fail: () => boolean = () => false) {
  return async (payload: Hired, _e: unknown, _m: unknown, uow: IUnitOfWork) => {
    calls.push(payload.personId);
    await uow.getRepository<Record<string, unknown>>('Person')
      .create({ id: payload.personId, name: 'Ada' });
    if (fail()) throw new Error('handler failed after its write');
  };
}

function rows(app: IKernelApplication, entity: string): Promise<Record<string, unknown>[]> {
  return app.services.get<IDatabaseService>(CAPABILITIES.DATABASE)
    .getRepository<Record<string, unknown>>(entity).findAll();
}

function publish(app: IKernelApplication, topic: string, envelope: unknown): Promise<void> {
  return app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING).publish(topic, envelope);
}

for (const transport of transports) {
  describe(`consumer inbox over real PostgreSQL ← ${transport.name}`, {
    ignore: transport.ignore,
  }, () => {
    const label = transport.name.replaceAll(' ', '-').toLowerCase();

    it('acknowledges a duplicate delivery without running the handler', async () => {
      const pg = await postgresInboxSchema(postgresUrl!);
      const definition = definitionFor(label);
      const calls: string[] = [];
      const app = processFor(pg, transport, [
        onIntegrationEvent(definition, writer(calls), {
          inbox: { consumer: consumerName('dup') },
        }),
      ]);
      await app.start();
      try {
        await publish(app, definition.topic, envelopeOf('e-1', 'p-1'));
        await waitFor(() => calls.length === 1, 'first delivery');
        await publish(app, definition.topic, envelopeOf('e-1', 'p-1'));
        await settle();
        expect(calls).toEqual(['p-1']);
        expect(await rows(app, 'Person')).toHaveLength(1);
        expect((await rows(app, 'Inbox')).map((row) => row.status)).toEqual(['processed']);
      } finally {
        await app.stop();
        await pg.dispose();
      }
    });

    it('a handler failure rolls back both rows, and the redelivery succeeds', async () => {
      const pg = await postgresInboxSchema(postgresUrl!);
      const definition = definitionFor(label);
      const calls: string[] = [];
      let failures = 1;
      const app = processFor(pg, transport, [
        onIntegrationEvent(definition, writer(calls, () => failures-- > 0), {
          inbox: { consumer: consumerName('retry') },
        }),
      ]);
      await app.start();
      try {
        await publish(app, definition.topic, envelopeOf('e-1', 'p-1'));
        // The broker redelivers on its own — no second publish.
        await waitFor(() => calls.length === 2, 'the broker redelivery');
        await waitFor(async () => (await rows(app, 'Inbox')).length === 1, 'the marker');
        expect(await rows(app, 'Person')).toHaveLength(1);
        await settle();
        expect(calls).toEqual(['p-1', 'p-1']);
      } finally {
        await app.stop();
        await pg.dispose();
      }
    });

    it('two consumer names each process the same event once', async () => {
      const pg = await postgresInboxSchema(postgresUrl!);
      const definition = definitionFor(label);
      const payroll: string[] = [];
      const audit: string[] = [];
      const app = processFor(pg, transport, [
        onIntegrationEvent(definition, (p) => {
          payroll.push(p.personId);
        }, { inbox: { consumer: consumerName('payroll') } }),
        onIntegrationEvent(definition, (p) => {
          audit.push(p.personId);
        }, { inbox: { consumer: consumerName('audit') } }),
      ]);
      await app.start();
      try {
        await publish(app, definition.topic, envelopeOf('e-1', 'p-1'));
        await waitFor(() => payroll.length === 1 && audit.length === 1, 'both consumers');
        await publish(app, definition.topic, envelopeOf('e-1', 'p-1'));
        await settle();
        expect([payroll, audit]).toEqual([['p-1'], ['p-1']]);
        expect(await rows(app, 'Inbox')).toHaveLength(2);
      } finally {
        await app.stop();
        await pg.dispose();
      }
    });

    it('end to end with the outbox: a row relayed twice is handled once', async () => {
      const pg = await postgresInboxSchema(postgresUrl!);
      const definition = definitionFor(label);
      const calls: string[] = [];
      const app = processFor(pg, transport, [
        onIntegrationEvent(definition, writer(calls), {
          inbox: { consumer: consumerName('e2e') },
        }),
      ]);
      await app.start();
      try {
        const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
        const outbox = app.services.get<IOutbox>(CAPABILITIES.OUTBOX);
        await db.transaction((uow) => outbox.write(uow, definition, { personId: 'p-1' }));
        expect((await outbox.sweep()).published).toBe(1);
        await waitFor(() => calls.length === 1, 'the first relay');

        // The §3.13 crash shape: the relay published, and its `markSent` never
        // landed, so the row is still pending and the next sweep sends it again.
        await pg.pool.query(
          "UPDATE setu_outbox SET status = 'pending', settled_at = NULL, sent_by = NULL",
        );
        expect((await outbox.sweep()).published).toBe(1);
        await settle();
        expect(calls).toEqual(['p-1']);
        expect(await rows(app, 'Person')).toHaveLength(1);
      } finally {
        await app.stop();
        await pg.dispose();
      }
    });
  });
}
