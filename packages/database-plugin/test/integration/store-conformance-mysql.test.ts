/** MYSQL_URL, like POSTGRES_URL, selects a shared backend: these proofs run in isolation. */
import { describe, expect, it } from 'vitest';
import type { AgentRunRow } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { MockServiceRegistry } from '@setu-ts/testing';
import { createDatabaseAgentRunStore, createDatabaseGrantSource } from '../../src/index.ts';
import { DatabaseOutboxStore } from '../../src/outbox/database-outbox-store.ts';
import { DatabaseInboxStore } from '../../src/inbox/database-inbox-store.ts';
import { DatabaseIdempotencyStore } from '../../src/idempotency/database-idempotency-store.ts';
import { DatabaseTenantDataStore } from '../../src/tenancy/database-tenant-data-store.ts';
import { describeOutboxStoreContract } from '../fixtures/outbox-store-contract.ts';
import { describeInboxStoreContract } from '../fixtures/inbox-store-contract.ts';
import { claim } from '../fixtures/idempotency-store.ts';
import { marker } from '../fixtures/inbox-store.ts';
import { mysqlHarness } from '../fixtures/mysql-harness.ts';

const skipMysql = !process.env['MYSQL_URL'];
for (const type of ['prisma', 'drizzle'] as const) {
  describeOutboxStoreContract(
    `real MySQL ${type}`,
    async () => {
      const h = await mysqlHarness(type);
      return {
        store: new DatabaseOutboxStore(h.database, 'Outbox'),
        inTransaction: (work) => h.database.transaction((uow) => work(uow)),
        dispose: h.dispose,
      };
    },
    skipMysql,
  );
  describeInboxStoreContract(
    `real MySQL ${type}`,
    async () => {
      const h = await mysqlHarness(type);
      return {
        store: new DatabaseInboxStore(h.database, 'Inbox', () => crypto.randomUUID()),
        dispose: h.dispose,
      };
    },
    skipMysql,
  );
  describe(`real MySQL ${type} stores`, { skip: skipMysql }, () => {
    it('commits counters, fences stale holders and purges children through Drizzle', async () => {
      const h = await mysqlHarness(type);
      try {
        const services = new MockServiceRegistry();
        services.register(CAPABILITIES.DATABASE, h.database);
        const store = await createDatabaseAgentRunStore()(services);
        await store.verify();
        const row: AgentRunRow = {
          id: 'run',
          tenantId: '',
          principalId: null,
          definition: 'demo',
          version: '1',
          status: 'running',
          input: [],
          leaseOwner: 'A',
          leaseVersion: 1,
          leaseUntil: 10,
          entryCount: 0,
          approvalIds: [],
          chunkCount: 0,
          stepChunkStart: 0,
          toolTimeoutKey: '',
          toolTimeouts: 0,
          cancelRequested: false,
          error: null,
          createdAt: 1,
          updatedAt: 1,
        };
        await store.create(row);
        expect(await store.get('run')).toMatchObject({ toolTimeoutKey: '', toolTimeouts: 0 });
        await store.update('run', { leaseVersion: 1 }, { toolTimeoutKey: 'hash', toolTimeouts: 2 });
        expect(await store.get('run')).toMatchObject({ toolTimeoutKey: 'hash', toolTimeouts: 2 });
        const updated = await store.appendChunks(row, {
          id: 'run.000000000000',
          runId: 'run',
          tenantId: '',
          seq: 0,
          leaseVersion: row.leaseVersion,
          chunks: [{ type: 'start' }],
        });
        // The writer's epoch round-trips through the bigint column as a number.
        expect(await store.chunks(updated, 0)).toMatchObject([{ leaseVersion: row.leaseVersion }]);
        expect(await store.chunks(row, 0)).toEqual([]);
        await store.update('run', { leaseVersion: 1 }, { leaseVersion: 2, status: 'completed' });
        await expect(
          store.appendChunks(updated, {
            id: 'stale',
            runId: 'run',
            tenantId: '',
            seq: 1,
            leaseVersion: 1,
            chunks: [],
          }),
        ).rejects.toThrow();
        expect(await store.purge((await store.get('run'))!)).toBe(true);
      } finally {
        await h.dispose();
      }
    });
    it('commits one idempotency begin among six and reads its own result', async () => {
      const h = await mysqlHarness(type);
      try {
        const store = new DatabaseIdempotencyStore(h.database, 'Idempotency', () =>
          crypto.randomUUID(),
        );
        await store.verify();
        const attempts = await Promise.allSettled(
          Array.from({ length: 6 }, () =>
            store.run(claim('race'), () => Promise.resolve({ value: 'winner', result: 'encoded' })),
          ),
        );
        expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
        expect(attempts.filter((entry) => entry.status === 'rejected')).toHaveLength(5);
        expect(await store.find(claim('race').id)).toMatchObject({
          result: 'encoded',
          createdAt: 1000,
          expiresAt: 2000,
        });
      } finally {
        await h.dispose();
      }
    });
    it('records one inbox envelope among two consumers', async () => {
      const h = await mysqlHarness(type);
      try {
        const store = new DatabaseInboxStore(h.database, 'Inbox', () => crypto.randomUUID());
        const outcomes = await Promise.allSettled(
          [0, 1].map(() => store.run(marker('race'), () => Promise.resolve('winner'))),
        );
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
        expect((await store.find(marker('race').id))?.status).toBe('processed');
      } finally {
        await h.dispose();
      }
    });
    it('rejects cross-tenant changes, reads grants, and reports a concurrent revoke only once', async () => {
      const h = await mysqlHarness(type);
      try {
        const repo = h.database.getRepository<Record<string, unknown>>('Row');
        await repo.create({
          id: 'tenant',
          tenant_id: 'b',
          name: 'secret',
          version: 1,
          balance: 100,
        });
        const store = new DatabaseTenantDataStore(h.database);
        expect(await store.update('a', 'Row', 'tenant', { name: 'bad' })).toBeNull();
        expect(await store.delete('a', 'Row', 'tenant')).toBe(false);
        expect(await repo.findById('tenant')).toMatchObject({ name: 'secret', tenant_id: 'b' });
        const grants = h.database.getRepository('Grant');
        await grants.create({
          id: 'grant',
          subject: 'user',
          role: 'reader',
          scopeType: 'tenant',
          scopeId: 'a',
        });
        const services = new MockServiceRegistry();
        services.register(CAPABILITIES.DATABASE, h.database);
        const source = createDatabaseGrantSource({ entity: 'Grant' })(services);
        expect(
          await source.grantsFor(
            { id: 'user' },
            { kind: 'chain', scopes: [{ type: 'tenant', id: 'a' }] },
            new AbortController().signal,
          ),
        ).toEqual([{ role: 'reader', scope: { type: 'tenant', id: 'a' } }]);
        expect(
          (
            await Promise.all([0, 1].map(() => grants.deleteWhere!('grant', { subject: 'user' })))
          ).filter(Boolean),
        ).toHaveLength(1);
        expect(
          await source.grantsFor(
            { id: 'user' },
            { kind: 'chain', scopes: [{ type: 'tenant', id: 'a' }] },
            new AbortController().signal,
          ),
        ).toEqual([]);
      } finally {
        await h.dispose();
      }
    });
    it('verifies the agent-run sweep queries on MySQL', async () => {
      const h = await mysqlHarness(type);
      try {
        const services = new MockServiceRegistry();
        services.register(CAPABILITIES.DATABASE, h.database);
        await (await createDatabaseAgentRunStore()(services)).verify();
      } finally {
        await h.dispose();
      }
    });
  });
}
