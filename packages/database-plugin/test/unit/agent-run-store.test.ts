import { describe, it, expect, vi } from 'vitest';
import {
  CAPABILITIES,
  AgentRunLeaseLostError,
  AgentRunStoreUnavailableError,
} from '@setu-ts/common';
import { MockServiceRegistry } from '@setu-ts/testing';
import {
  DatabaseAgentRunStore,
  UnsupportedQueryFeatureError,
  createDatabaseAgentRunStore,
} from '../../src/index.ts';
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
    toolTimeoutKey: '',
    toolTimeouts: 0,
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
  it('round-trips timeout keys and counts through the factory and rejects malformed fields', async () => {
    const db = await memoryService();
    const registry = new MockServiceRegistry();
    registry.register(CAPABILITIES.DATABASE, db);
    const store = await createDatabaseAgentRunStore()(registry);
    try {
      await store.create(row());
      expect(await store.get('run')).toMatchObject({ toolTimeoutKey: '', toolTimeouts: 0 });
      await store.update('run', { leaseVersion: 1 }, { toolTimeoutKey: 'hash', toolTimeouts: 2 });
      expect(await store.get('run')).toMatchObject({ toolTimeoutKey: 'hash', toolTimeouts: 2 });
      const repo = db.getRepository('AgentRun');
      await repo.update('run', { toolTimeoutKey: 5 });
      await expect(store.get('run')).rejects.toThrow();
      await repo.update('run', { toolTimeoutKey: 'hash', toolTimeouts: -1 });
      await expect(store.get('run')).rejects.toThrow();
      const read = vi
        .spyOn(repo, 'findById')
        .mockResolvedValue({ ...row(), toolTimeouts: 2n } as never);
      expect((await store.get('run'))?.toolTimeouts).toBe(2);
      read.mockRestore();
    } finally {
      await db.close();
    }
  });
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
    // More children than one page are all removed before the parent (audit F5).
    await runs.create({ ...row(), id: 'many', status: 'completed', entryCount: 0.5, updatedAt: 0 });
    const entries = db.getRepository<Record<string, unknown>>('AgentRunEntry');
    for (let i = 0; i < 205; i++)
      await entries.create({ ...entry(), id: `many.${i}`, runId: 'many', leaseVersion: 0 });
    expect(await store.terminal(10 ** 15, 3)).toEqual([]);
    expect(await entries.findAll({ where: { runId: 'many' } })).toEqual([]);
    expect(await runs.findById('many')).toBeNull();
    // A page that deletes nothing keeps the parent for the next sweep.
    await runs.create({
      ...row(),
      id: 'stuck',
      status: 'completed',
      entryCount: 0.5,
      updatedAt: 0,
    });
    for (let i = 0; i < 100; i++)
      await entries.create({ ...entry(), id: `stuck.${i}`, runId: 'stuck', leaseVersion: 0 });
    const refuse = vi.spyOn(entries, 'deleteWhere').mockResolvedValue(false);
    expect(await store.terminal(10 ** 15, 3)).toEqual([]);
    expect(await runs.findById('stuck')).not.toBeNull();
    refuse.mockRestore();
    const missing = entries.deleteWhere;
    Object.defineProperty(entries, 'deleteWhere', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(await store.terminal(10 ** 15, 3)).toEqual([]);
    expect(await runs.findById('stuck')).not.toBeNull();
    entries.deleteWhere = missing!;
    expect(await store.terminal(10 ** 15, 3)).toEqual([]);
    expect(await runs.findById('stuck')).toBeNull();
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
  it('replaces an orphan whose lease version a driver returns as a bigint', async () => {
    const db = await memoryService();
    const store = new DatabaseAgentRunStore(db);
    await store.create(row());
    const entries = db.getRepository<Record<string, unknown>>('AgentRunEntry');
    await entries.create({ ...entry(), leaseVersion: 0 });
    // Holder 1 meets holder 0's orphan, read back the way a bigint driver returns it.
    await store.update('run', { leaseVersion: 0 }, { leaseVersion: 1 });
    const read = vi
      .spyOn(entries, 'findById')
      .mockResolvedValueOnce({ ...entry(), leaseVersion: 0n } as never);
    const held = await store.appendEntry({ ...row(), leaseVersion: 1 }, entry());
    expect(held.entryCount).toBe(1);
    expect(read).toHaveBeenCalled();
    await db.close();
  });
  it('skips approvals whose run is unreadable or uncommitted and pages past them', async () => {
    const db = await memoryService();
    const store = new DatabaseAgentRunStore(db);
    const approvals = db.getRepository<Record<string, unknown>>('AgentRunApproval');
    const runs = db.getRepository<Record<string, unknown>>('AgentRun');
    // An approval whose run row is malformed, one that was never committed,
    // and one that is: with a limit of 1 the committed one is still found.
    await runs.create({ ...row(), id: 'bad', entryCount: 0.5 });
    await approvals.create({ ...approval(), id: 'a1', runId: 'bad', deadline: 1, leaseVersion: 0 });
    await store.create({ ...row(), id: 'loose' });
    await approvals.create({
      ...approval(),
      id: 'a2',
      runId: 'loose',
      deadline: 2,
      leaseVersion: 0,
    });
    await store.create({ ...row(), id: 'good', approvalIds: ['a3'] });
    await approvals.create({
      ...approval(),
      id: 'a3',
      runId: 'good',
      deadline: 3,
      leaseVersion: 0,
    });
    expect((await store.expired(10, 1)).map((a) => a.id)).toEqual(['a3']);
    // The cursor sits on a3 (unexpired here, no sweep runs): the next call
    // reaches the end and the one after wraps to the start.
    expect(await store.expired(10, 5)).toEqual([]);
    expect((await store.expired(10, 5)).map((a) => a.id)).toEqual(['a3']);
    // Any other store fault still reaches the sweep.
    vi.spyOn(store, 'get').mockRejectedValueOnce(new Error('store down'));
    await expect(store.expired(10, 5)).rejects.toThrow('store down');
    await db.close();
  });
  it('resumes the expiry scan across calls so skipped approvals cannot starve a later one', async () => {
    const db = await memoryService();
    const store = new DatabaseAgentRunStore(db);
    const approvals = db.getRepository<Record<string, unknown>>('AgentRunApproval');
    // Five uncommitted approvals ahead of a committed one: more than the four
    // pages one call reads at a limit of 1.
    await store.create({ ...row(), id: 'loose' });
    for (let i = 1; i <= 5; i++)
      await approvals.create({
        ...approval(),
        id: `s${i}`,
        runId: 'loose',
        deadline: i,
        leaseVersion: 0,
      });
    await store.create({ ...row(), id: 'good', approvalIds: ['late', 'later'] });
    await approvals.create({
      ...approval(),
      id: 'late',
      runId: 'good',
      deadline: 6,
      leaseVersion: 0,
    });
    await approvals.create({
      ...approval(),
      id: 'later',
      runId: 'good',
      deadline: 7,
      leaseVersion: 0,
    });
    expect(await store.expired(10, 1)).toEqual([]);
    expect((await store.expired(10, 1)).map((a) => a.id)).toEqual(['late']);
    // The sweep expires what a call returned, so that approval leaves the
    // pending set; the cursor is keyed on (deadline, id), so nothing shifts
    // and the next call still finds the one after it.
    await store.decide('late', { status: 'expired' });
    expect((await store.expired(10, 1)).map((a) => a.id)).toEqual(['later']);
    // The next call finds the end of the pending set and resets; the one
    // after starts over from the first approval.
    expect(await store.expired(10, 5)).toEqual([]);
    expect((await store.expired(10, 5)).map((a) => a.id)).toEqual(['later']);
    await db.close();
  });
  it('does not skip an approval when one before the scan position leaves the pending set', async () => {
    const db = await memoryService();
    const store = new DatabaseAgentRunStore(db);
    const approvals = db.getRepository<Record<string, unknown>>('AgentRunApproval');
    await store.create({ ...row(), id: 'loose' });
    for (let i = 1; i <= 4; i++)
      await approvals.create({
        ...approval(),
        id: `x${i}`,
        runId: 'loose',
        deadline: i,
        leaseVersion: 0,
      });
    await store.create({ ...row(), id: 'good', approvalIds: ['c5'] });
    await approvals.create({
      ...approval(),
      id: 'c5',
      runId: 'good',
      deadline: 5,
      leaseVersion: 0,
    });
    // One call reads four pages of skipped approvals and stops before c5.
    expect(await store.expired(10, 1)).toEqual([]);
    // An approval the scan already passed leaves the pending set; a position
    // counted from the start would now step over c5.
    await store.decide('x1', { status: 'denied' });
    expect((await store.expired(10, 1)).map((a) => a.id)).toEqual(['c5']);
    await db.close();
  });
  it('refuses at startup an adapter that cannot serve the sweep queries', async () => {
    const db = await memoryService();
    const store = new DatabaseAgentRunStore(db);
    await store.verify();
    for (const entity of ['AgentRunApproval', 'AgentRun']) {
      const repo = db.getRepository<Record<string, unknown>>(entity);
      // As DynamoDB answers an order on more than its one sort key.
      const refuse = vi
        .spyOn(repo, 'findAll')
        .mockRejectedValueOnce(new UnsupportedQueryFeatureError('orderBy', 'dynamodb', 'refused'));
      await expect(store.verify()).rejects.toMatchObject({
        name: 'AgentRunStoreUnavailableError',
        reason: 'query-unsupported',
      });
      refuse.mockRestore();
    }
    // The terminal query is the last one run against runs: the earlier ones
    // succeed and only it is refused.
    const runs = db.getRepository<Record<string, unknown>>('AgentRun');
    const findAll = runs.findAll.bind(runs);
    let calls = 0;
    const terminal = vi
      .spyOn(runs, 'findAll')
      .mockImplementation((query) =>
        ++calls === 4
          ? Promise.reject(new UnsupportedQueryFeatureError('orderBy', 'dynamodb', 'refused'))
          : findAll(query),
      );
    await expect(store.verify()).rejects.toMatchObject({ reason: 'query-unsupported' });
    expect(calls).toBe(4);
    terminal.mockRestore();
    // Any store error of its own keeps its reason.
    vi.spyOn(runs, 'findAll').mockRejectedValueOnce(
      new AgentRunStoreUnavailableError('invalid-row'),
    );
    await expect(store.verify()).rejects.toMatchObject({ reason: 'invalid-row' });
    await db.close();
  });
  it('verifies without changing anything: no quarantine, purge or cursor movement', async () => {
    const db = await memoryService();
    const store = new DatabaseAgentRunStore(db);
    const runs = db.getRepository<Record<string, unknown>>('AgentRun');
    await runs.create({ ...row(), id: 'bad-ready', status: 'ready', entryCount: 0.5 });
    // Below the probe's retention bound, so the old probe would have purged it.
    await runs.create({
      ...row(),
      id: 'bad-done',
      status: 'completed',
      entryCount: 0.5,
      updatedAt: -1,
    });
    await runs.create({ ...row(), id: 'wait-1', status: 'waiting' });
    await runs.create({ ...row(), id: 'wait-2', status: 'waiting' });
    await store.verify();
    expect((await runs.findById('bad-ready'))?.status).toBe('ready');
    expect(await runs.findById('bad-done')).not.toBeNull();
    // The waiting scan still starts at its first page.
    const waitingIds = async () =>
      (await store.resumable(100, 1)).map((r) => r.id).filter((id) => id.startsWith('wait'));
    expect(await waitingIds()).toEqual(['wait-1']);
    expect(await waitingIds()).toEqual(['wait-2']);
    // The sweep itself still takes the malformed ready run out of its queries.
    expect((await runs.findById('bad-ready'))?.status).toBe('failed');
    await db.close();
  });
  it('keeps the waiting cursor when a quarantine write fails', async () => {
    const db = await memoryService();
    const store = new DatabaseAgentRunStore(db);
    const runs = db.getRepository<Record<string, unknown>>('AgentRun');
    await runs.create({ ...row(), id: 'w1', status: 'waiting', entryCount: 0.5 });
    await runs.create({ ...row(), id: 'w2', status: 'waiting' });
    await runs.create({ ...row(), id: 'w3', status: 'waiting' });
    const write = vi.spyOn(runs, 'updateWhere').mockRejectedValueOnce(new Error('store down'));
    await expect(store.resumable(100, 2)).rejects.toThrow('store down');
    write.mockRestore();
    // The same page again: w1 is quarantined now, w2 is returned.
    expect((await store.resumable(100, 2)).map((r) => r.id)).toEqual(['w2']);
    expect((await runs.findById('w1'))?.status).toBe('failed');
    await db.close();
  });
});
