import { describe, it, expect } from 'vitest';
import { createDatabaseAgentRunStore } from '../../src/index.ts';
import { CAPABILITIES } from '@setu-ts/common';
import { MockServiceRegistry } from '@setu-ts/testing';
import { agentRunPostgres } from '../fixtures/agent-run-postgres.ts';
import type { AgentRunRow } from '@setu-ts/common';
describe.skipIf(!process.env['AGENT_RUNS_PG_URL'])('agent run PostgreSQL store', () => {
  it('commits counters, fences stale holders and purges children through Drizzle', async () => {
    const h = await agentRunPostgres(process.env['AGENT_RUNS_PG_URL']!);
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
});
