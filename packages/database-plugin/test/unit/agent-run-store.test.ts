import { describe, it, expect, vi } from 'vitest';
import { CAPABILITIES, AgentRunLeaseLostError } from '@setu-ts/common';
import { MockServiceRegistry } from '@setu-ts/testing';
import { DatabaseAgentRunStore, createDatabaseAgentRunStore } from '../../src/index.ts';
import { memoryService } from '../fixtures/outbox-store.ts';
import type { AgentRunRow, AgentRunEntryRow, AgentRunApprovalRow } from '@setu-ts/common';
function row(): AgentRunRow {
  return {
    id: 'run',
    tenantId: 'tenant',
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
    cancelRequested: false,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  };
}
function entry(): AgentRunEntryRow {
  return {
    id: 'run.000000000000',
    runId: 'run',
    tenantId: 'tenant',
    seq: 0,
    kind: 'model',
    messages: [],
    finishReason: 'stop',
    usage: {},
    toolCallId: null,

    stepChunkStart: null,
  };
}
function approval(): AgentRunApprovalRow {
  return {
    id: 'approval',
    runId: 'run',
    tenantId: 'tenant',
    seq: 0,
    toolCallId: 'c',
    toolName: 't',
    input: {},
    status: 'pending',
    deadline: 5,
    decidedBy: null,
    decidedAt: null,
    reason: null,
  };
}
describe('database agent run store', () => {
  it('purges in bounded batches and retains the parent when child cleanup fails', async () => {
    const db = await memoryService();
    const store = new DatabaseAgentRunStore(db);
    try {
      await store.create(row());
      let current = await store.appendEntry(row(), entry());
      current = (await store.update('run', { leaseVersion: 1 }, { status: 'completed' }))!;
      const children = db.getRepository<Record<string, unknown>>('AgentRunEntry');
      const deletion = vi
        .spyOn(children, 'deleteWhere')
        .mockRejectedValueOnce(new Error('transient'));
      await expect(store.purge(current, 1)).rejects.toThrow('transient');
      expect(await store.get('run')).not.toBeNull();
      deletion.mockResolvedValueOnce(false);
      expect(await store.purge(current, 1)).toBe(false);
      deletion.mockRestore();
      expect(await store.purge(current, 1)).toBe(true);
      await store.create({ ...row(), status: 'completed' });
      expect(await store.purge({ ...row(), status: 'completed', leaseVersion: 99 })).toBe(false);
      expect(await store.purge({ ...row(), status: 'failed' })).toBe(false);
      const original = children.deleteWhere;
      Object.defineProperty(children, 'deleteWhere', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      await expect(store.purge({ ...row(), status: 'completed' })).rejects.toThrow();
      children.deleteWhere = original!;
    } finally {
      await db.close();
    }
  });
  it('hides uncommitted approval children and fences their visibility commit', async () => {
    const db = await memoryService();
    const store = new DatabaseAgentRunStore(db);
    try {
      await store.create(row());
      await db.getRepository('AgentRunApproval').create({ ...approval(), leaseVersion: 0 });
      expect(await store.approvals('run')).toEqual([]);
      expect(await store.expired(10, 10)).toEqual([]);
      const updated = await store.createApproval(row(), approval());
      expect(updated.approvalIds).toEqual(['approval']);
      expect(await store.approvals('run')).toHaveLength(1);
      const update = vi.spyOn(store, 'update').mockResolvedValueOnce(null);
      await expect(
        store.createApproval(updated, { ...approval(), id: 'orphan2' }),
      ).rejects.toThrow();
      update.mockRestore();
      expect((await store.approvals('run')).map((a) => a.id)).toEqual(['approval']);
      await store.update('run', { leaseVersion: 1 }, { status: 'waiting' });
      expect(await store.resumable(10, 1)).toHaveLength(1);
      expect(await store.resumable(10, 1)).toEqual([]);
      expect(await store.resumable(10, 1)).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
  it('implements every method over memory with committed counters and single decisions', async () => {
    const db = await memoryService();
    const registry = new MockServiceRegistry();
    registry.register(CAPABILITIES.DATABASE, db);
    registry.register('database.named', db);
    const store = await createDatabaseAgentRunStore()(registry);
    await store.verify();
    await store.create(row());
    expect(await store.get('missing')).toBeNull();
    let current = await store.appendEntry(row(), entry());
    expect(await store.entries(current)).toHaveLength(1);
    expect(await store.entries(row())).toEqual([]);
    current = await store.appendChunks(current, {
      id: 'run.000000000000',
      runId: 'run',
      tenantId: 'tenant',
      seq: 0,
      leaseVersion: current.leaseVersion,
      chunks: [{ type: 'start' }],
    });
    expect(await store.chunks(current, 0)).toMatchObject([{ leaseVersion: current.leaseVersion }]);
    expect(await store.chunks(current, 1)).toEqual([]);
    await store.createApproval(current, approval());
    expect(await store.expired(6, 1)).toHaveLength(1);
    expect(await store.approvals('run')).toHaveLength(1);
    expect(await store.decide('approval', { status: 'approved' })).toMatchObject({
      status: 'approved',
    });
    expect(await store.decide('approval', { status: 'denied' })).toBeNull();
    expect(await store.resumable(11, 1)).toHaveLength(1);
    expect(await store.terminal(11, 1)).toEqual([]);
    expect(await store.purge(current)).toBe(false);
    current = (await store.update('run', { leaseVersion: 1 }, { status: 'completed' }))!;
    expect(await store.terminal(11, 1)).toHaveLength(1);
    expect(await store.purge(current)).toBe(true);
    expect(await store.purge(current)).toBe(false);
    expect(await store.approvals('run')).toEqual([]);
    expect(await store.get('run')).toBeNull();
    await (
      await createDatabaseAgentRunStore({ database: 'named', entities: { run: 'Custom' } })(
        registry,
      )
    ).verify();
    expect(() => createDatabaseAgentRunStore({ entities: { run: '' } })).toThrow();
    expect(() => createDatabaseAgentRunStore({ database: 'invalid/name' })).toThrow();
    await db.close();
  });
  it('refuses stale writes, replaces an orphan, skips malformed counters and normalizes bigint', async () => {
    const db = await memoryService();
    const store = new DatabaseAgentRunStore(db);
    await store.create(row());
    await db.getRepository('AgentRunEntry').create({ ...entry(), leaseVersion: 0 });
    const held = await store.appendEntry(row(), entry());
    expect(held.entryCount).toBe(1);
    await store.update('run', { leaseVersion: 1 }, { leaseVersion: 2 });
    await expect(
      store.appendEntry(held, { ...entry(), seq: 1, id: 'next' }),
    ).rejects.toBeInstanceOf(AgentRunLeaseLostError);
    await db.getRepository('AgentRun').update('run', { entryCount: 0.5 });
    expect(await store.resumable(100, 10)).toEqual([]);
    await expect(store.get('run')).rejects.toThrow();
    const read = vi
      .spyOn(db.getRepository('AgentRun'), 'findById')
      .mockResolvedValue({ ...row(), leaseVersion: 1n } as never);
    expect((await store.get('run'))?.leaseVersion).toBe(1);
    read.mockRestore();
    await db.close();
  });
  it('reports missing/throwing native writes and conditional append failures', async () => {
    const db = await memoryService();
    const repo = db.getRepository<Record<string, unknown>>('AgentRun');
    const store = new DatabaseAgentRunStore(db);
    const update = vi.spyOn(repo, 'updateWhere').mockRejectedValue(new Error('unsupported'));
    await expect(store.verify()).rejects.toMatchObject({
      reason: 'conditional-writes-unsupported',
    });
    update.mockRestore();
    const original = repo.updateWhere;
    Object.defineProperty(repo, 'updateWhere', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    await expect(store.verify()).rejects.toThrow();
    await expect(store.update('x', { leaseVersion: 0 }, { error: 'x' })).rejects.toThrow();
    repo.updateWhere = original!;
    // Every child entity is probed too, not only the run (review L4).
    for (const child of ['AgentRunEntry', 'AgentRunChunks', 'AgentRunApproval']) {
      const childRepo = db.getRepository<Record<string, unknown>>(child);
      const probe = vi
        .spyOn(childRepo, 'deleteWhere')
        .mockRejectedValueOnce(new Error('no such table'));
      await expect(store.verify()).rejects.toMatchObject({
        reason: 'conditional-writes-unsupported',
      });
      probe.mockRestore();
      const remove = childRepo.deleteWhere;
      Object.defineProperty(childRepo, 'deleteWhere', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      await expect(store.verify()).rejects.toMatchObject({
        reason: 'conditional-writes-unsupported',
      });
      childRepo.deleteWhere = remove!;
    }
    await store.verify();
    await store.create(row());
    vi.spyOn(store, 'update').mockResolvedValue(null);
    await expect(store.appendEntry(row(), entry())).rejects.toBeInstanceOf(AgentRunLeaseLostError);
    await db.close();
  });
  it('takes ill-formed rows out of the sweep queries so a full batch cannot starve them (audit F3)', async () => {
    const db = await memoryService();
    const store = new DatabaseAgentRunStore(db);
    const runs = db.getRepository<Record<string, unknown>>('AgentRun');
    for (let i = 0; i < 3; i++)
      await runs.create({
        ...row(),
        id: `bad${i}`,
        status: 'ready',
        entryCount: 0.5,
        updatedAt: 0,
      });
    await store.create({ ...row(), id: 'good', status: 'ready', updatedAt: 5 });
    // A batch filled by ill-formed rows yields nothing this sweep...
    expect(await store.resumable(100, 3)).toEqual([]);
    expect((await runs.findById('bad0'))?.status).toBe('failed');
    expect((await runs.findById('bad0'))?.error).toBe('invalid-row');
    // ...and the next sweep reaches the valid run.
    expect((await store.resumable(100, 3)).map((r) => r.id)).toEqual(['good']);
    // Past retention, the quarantined rows are deleted with their children.
    await db.getRepository('AgentRunEntry').create({ ...entry(), runId: 'bad0', leaseVersion: 0 });
    expect(await store.terminal(10 ** 15, 3)).toEqual([]);
    expect(await runs.findById('bad0')).toBeNull();
    expect(await db.getRepository('AgentRunEntry').findAll({ where: { runId: 'bad0' } })).toEqual(
      [],
    );
    // A row without a string id or status is skipped, not written.
    await runs.create({ ...row(), id: 'odd', status: 'ready', entryCount: 0.5 });
    const read = vi
      .spyOn(runs, 'findAll')
      .mockResolvedValueOnce([{ id: 7, status: 'ready' }])
      .mockResolvedValueOnce([]);
    expect(await store.resumable(100, 3)).toEqual([]);
    read.mockRestore();
    await db.close();
  });
});
