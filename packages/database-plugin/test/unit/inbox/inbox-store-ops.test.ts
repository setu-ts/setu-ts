/**
 * Every port method of the inbox bridge (M108 §3.10), including each missing
 * and wrong-status branch and the read-then-write races.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { EntityKey } from '@setu-ts/common';
import { DuplicateKeyError } from '@setu-ts/common';
import type { IDatabaseService, IRepository } from '../../../src/interfaces/index.ts';
import { DatabaseInboxStore } from '../../../src/inbox/database-inbox-store.ts';
import {
  allRows,
  ENTITY,
  idsFor,
  marker,
  memoryService,
  storeOver,
} from '../../fixtures/inbox-store.ts';

const update = { consumer: 'payroll', topic: 'people.hired.v1', lastError: 'boom', now: 50 };

/** A service whose repository `create` runs `before` first, then the real create. */
function interceptCreate(
  inner: IDatabaseService,
  before: (data: Record<string, unknown>) => Promise<void>,
): IDatabaseService {
  return {
    ...inner,
    getRepository: <E, Id extends EntityKey = string>(entity: string) => {
      const repo = inner.getRepository<E, Id>(entity) as IRepository<E, Id>;
      return {
        ...repo,
        findById: (id: Id) => repo.findById(id),
        update: (id: Id, data: Partial<E>) => repo.update(id, data),
        create: async (data: Partial<E>) => {
          await before(data as Record<string, unknown>);
          return repo.create(data);
        },
      } as IRepository<E, Id>;
    },
  };
}

describe('DatabaseInboxStore operations', () => {
  it('find treats an unknown id as missing', async () => {
    expect(await storeOver(await memoryService()).find('nope')).toBeUndefined();
  });

  it('run creates the marker before the work, inside one transaction', async () => {
    const service = await memoryService();
    const store = storeOver(service);
    await store.run(marker('a'), async (scope) => {
      const uow = scope as { getRepository(e: string): IRepository<Record<string, unknown>> };
      const seen = await uow.getRepository(ENTITY).findById(idsFor('a').marker);
      expect(seen?.status).toBe('processed');
      await uow.getRepository('Business').create({ id: 'b1' });
    });
    expect(await service.getRepository('Business').findById('b1')).not.toBeNull();
  });

  it('run rolls back the marker AND the business row when the work rejects', async () => {
    const service = await memoryService();
    const store = storeOver(service);
    await expect(
      store.run(marker('a'), async (scope) => {
        const uow = scope as { getRepository(e: string): IRepository<Record<string, unknown>> };
        await uow.getRepository('Business').create({ id: 'b1' });
        throw new Error('handler failed');
      }),
    ).rejects.toThrow('handler failed');
    expect(await store.find(idsFor('a').marker)).toBeUndefined();
    expect(await service.getRepository('Business').findById('b1')).toBeNull();
  });

  it('run rejects a duplicate marker with DuplicateKeyError', async () => {
    const store = storeOver(await memoryService());
    await store.run(marker('a'), () => Promise.resolve());
    await expect(store.run(marker('a'), () => Promise.resolve())).rejects.toBeInstanceOf(
      DuplicateKeyError,
    );
  });

  it('recordFailure creates, then increments, the attempts row and never a marker', async () => {
    const service = await memoryService();
    const store = storeOver(service);
    const ids = idsFor('a');
    expect(await store.recordFailure(ids, { ...update, envelopeId: 'e-1' })).toBe(1);
    expect(await store.recordFailure(ids, { ...update, lastError: 'again', now: 60 })).toBe(2);
    const rows = await allRows(service);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: ids.attempts,
      status: 'attempting',
      attempts: 2,
      lastError: 'again',
      updatedAt: 60,
      envelopeId: 'e-1',
    });
  });

  it('recordFailure treats a non-integer stored count as zero', async () => {
    const service = await memoryService();
    const ids = idsFor('a');
    await service.getRepository(ENTITY).create({
      ...marker('a', { status: 'attempting' }),
      id: ids.attempts,
      attempts: 'garbage',
      envelopeId: null,
      lastError: null,
      envelope: null,
    });
    expect(await storeOver(service).recordFailure(ids, update)).toBe(1);
  });

  it('recordFailure increments when a concurrent failure created the row first', async () => {
    const inner = await memoryService();
    const ids = idsFor('a');
    let raced = false;
    const service = interceptCreate(inner, async () => {
      if (raced) return;
      raced = true;
      // Another failure's create lands between this call's read and its create.
      await storeOver(inner).recordFailure(ids, update);
    });
    expect(await storeOver(service).recordFailure(ids, update)).toBe(2);
  });

  it('recordFailure rethrows a create failure that no concurrent writer explains', async () => {
    const inner = await memoryService();
    const service = interceptCreate(inner, () => Promise.reject(new Error('disk full')));
    await expect(storeOver(service).recordFailure(idsFor('a'), update)).rejects.toThrow(
      'disk full',
    );
  });

  it('park reports exists for a present marker and rethrows an unexplained failure', async () => {
    const inner = await memoryService();
    const store = storeOver(inner);
    await store.run(marker('a'), () => Promise.resolve());
    expect(await store.park(marker('a', { status: 'parked' }))).toBe('exists');

    const failing = storeOver(interceptCreate(inner, () => Promise.reject(new Error('nope'))));
    await expect(failing.park(marker('b', { status: 'parked' }))).rejects.toThrow('nope');
  });

  it('parked lists parked markers only, without envelopes, up to the limit', async () => {
    const store = storeOver(await memoryService());
    await store.run(marker('a'), () => Promise.resolve());
    for (const label of ['b', 'c', 'd']) {
      await store.park(marker(label, { status: 'parked', envelope: '{"id":"x"}' }));
    }
    const listed = await store.parked(2);
    expect(listed).toHaveLength(2);
    for (const row of listed) {
      expect(row.status).toBe('parked');
      expect('envelope' in row).toBe(false);
    }
  });

  it('release retry deletes the marker and the attempts row, answering the record', async () => {
    const service = await memoryService();
    const store = storeOver(service);
    const ids = idsFor('a');
    await store.recordFailure(ids, update);
    const parked = marker('a', { status: 'parked', attempts: 1, envelope: '{"id":"e"}' });
    await store.park(parked);

    expect(await store.release(ids, 'retry', 99)).toEqual({ outcome: 'applied', record: parked });
    expect(await allRows(service)).toEqual([]);
  });

  it('release discard keeps a discarded marker without its envelope', async () => {
    const service = await memoryService();
    const store = storeOver(service);
    const ids = idsFor('a');
    await store.recordFailure(ids, update);
    await store.park(marker('a', { status: 'parked', envelope: '{"id":"e"}' }));

    const outcome = await store.release(ids, 'discard', 99);
    expect(outcome.outcome).toBe('applied');
    const rows = await allRows(service);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'discarded', envelope: null, updatedAt: 99 });
    // Redeliveries stay skipped: the marker is still found.
    expect((await store.find(ids.marker))?.status).toBe('discarded');
  });

  it('release refuses a marker that is not parked, and a missing one', async () => {
    const store = storeOver(await memoryService());
    await store.run(marker('a'), () => Promise.resolve());
    expect(await store.release(idsFor('a'), 'retry', 1)).toEqual({
      outcome: 'not-parked',
      status: 'processed',
    });
    expect(await store.release(idsFor('z'), 'discard', 1)).toEqual({ outcome: 'missing' });
  });

  it('release retry reports missing when a concurrent release deleted the marker', async () => {
    const inner = await memoryService();
    const store = storeOver(inner);
    await store.park(marker('a', { status: 'parked' }));
    const service: IDatabaseService = {
      ...inner,
      getRepository: <E, Id extends EntityKey = string>(entity: string) => {
        const repo = inner.getRepository<E, Id>(entity);
        return {
          ...repo,
          findById: (id: Id) => repo.findById(id),
          delete: () => Promise.resolve(false),
        };
      },
    };
    expect(
      await new DatabaseInboxStore(service, ENTITY, () => 'x').release(idsFor('a'), 'retry', 1),
    )
      .toEqual({ outcome: 'missing' });
  });

  it('purge deletes processed, discarded and attempting rows older than the bound', async () => {
    const service = await memoryService();
    const store = storeOver(service);
    await store.run(marker('a', { updatedAt: 10 }), () => Promise.resolve());
    await store.run(marker('b', { updatedAt: 500 }), () => Promise.resolve());
    await store.recordFailure(idsFor('c'), { ...update, now: 10 });
    await store.park(marker('d', { status: 'parked', updatedAt: 10 }));
    await store.park(marker('e', { status: 'parked', updatedAt: 10 }));
    await store.release(idsFor('e'), 'discard', 10);

    expect(await store.purge(100, 10)).toBe(3);
    const left = (await allRows(service)).map((row) => row.id).sort();
    expect(left).toEqual([idsFor('b').marker, idsFor('d').marker].sort());
  });

  it('purge honours the per-status limit', async () => {
    const store = storeOver(await memoryService());
    for (const label of ['a', 'b', 'c']) {
      await store.run(marker(label, { updatedAt: 1 }), () => Promise.resolve());
    }
    expect(await store.purge(100, 2)).toBe(2);
  });

  it('every method rejects rather than throwing synchronously when the service throws', async () => {
    const inner = await memoryService();
    const broken: IDatabaseService = {
      ...inner,
      getRepository: () => {
        throw new Error('closed');
      },
      transaction: () => Promise.reject(new Error('closed')),
    };
    const store = new DatabaseInboxStore(broken, ENTITY, () => 'x');
    const ids = idsFor('a');
    const calls: Promise<unknown>[] = [
      store.find(ids.marker),
      store.recordFailure(ids, update),
      store.park(marker('a')),
      store.parked(1),
      store.release(ids, 'retry', 1),
      store.stats(),
      store.purge(1, 1),
      store.run(marker('a'), () => Promise.resolve()),
    ];
    for (const call of calls) await expect(call).rejects.toThrow('closed');
  });
});
