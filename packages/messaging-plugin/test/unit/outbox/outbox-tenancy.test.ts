/**
 * Database-per-tenant `stores` (M107 §3.10): `write` and `release` select the
 * store by the caller's tenant id and reject `OutboxUnknownTenantError` for a
 * missing or unknown one; the relay sweeps every store in rotating order
 * within ONE budget; `purge` covers every store.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { OutboxUnknownTenantError } from '../../../src/outbox/errors.ts';
import { resolveOutboxOptions } from '../../../src/outbox/options.ts';
import { OutboxService } from '../../../src/outbox/outbox-service.ts';
import {
  edit,
  FakeOutboxBroker,
  memoryOutbox,
  orderPlaced,
  outboxClock,
  rows,
} from '../../fixtures/outbox.ts';

async function perTenant(relay: { publishLimit?: number } = {}) {
  const acme = await memoryOutbox();
  const globex = await memoryOutbox();
  const clock = outboxClock();
  const broker = new FakeOutboxBroker();
  const service = new OutboxService({
    runtime: clock.runtime,
    broker,
    options: resolveOutboxOptions({
      stores: { acme: acme.store, globex: globex.store },
      relay,
      retainSentMs: 0,
    }),
  });
  service.activate({
    kind: 'per-tenant',
    stores: new Map([['acme', acme.store], ['globex', globex.store]]),
  });
  const write = (tenant: { db: typeof acme.db }, n: number, tenantId?: string) =>
    tenant.db.transaction((uow) =>
      service.write(uow, orderPlaced, { n }, tenantId === undefined ? {} : { tenantId })
    );
  return { acme, globex, service, broker, write, clock };
}

describe('per-tenant stores', () => {
  it('write selects the tenant store and records the tenant', async () => {
    const t = await perTenant();
    await t.write(t.acme, 1, 'acme');
    await t.write(t.globex, 2, 'globex');
    expect((await rows(t.acme.db)).map((r) => r.tenantId)).toEqual(['acme']);
    expect((await rows(t.globex.db)).map((r) => r.tenantId)).toEqual(['globex']);
    expect(t.acme.store.count('append')).toBe(1);
    expect(t.globex.store.count('append')).toBe(1);
  });

  it('rejects a missing or unknown tenant without writing', async () => {
    const t = await perTenant();
    await expect(t.write(t.acme, 1)).rejects.toBeInstanceOf(OutboxUnknownTenantError);
    await expect(t.write(t.acme, 1, 'initech')).rejects.toBeInstanceOf(OutboxUnknownTenantError);
    await expect(t.service.release('x', 'retry')).rejects.toBeInstanceOf(OutboxUnknownTenantError);
    expect(await rows(t.acme.db)).toEqual([]);
  });

  it('release selects the tenant store', async () => {
    const t = await perTenant();
    const id = await t.write(t.globex, 1, 'globex');
    await edit(t.globex.db, id, { status: 'failed' });
    await t.service.release(id, 'discard', { tenantId: 'globex' });
    expect(t.globex.store.count('release')).toBe(1);
    expect(t.acme.store.count('release')).toBe(0);
  });

  it('sweeps every store, rotating which goes first, within one budget', async () => {
    const t = await perTenant({ publishLimit: 1 });
    await t.write(t.acme, 1, 'acme');
    await t.write(t.acme, 2, 'acme');
    await t.write(t.globex, 3, 'globex');
    await t.write(t.globex, 4, 'globex');
    await t.service.sweep(); // acme first
    await t.service.sweep(); // globex first
    expect(t.broker.sequence()).toEqual([1, 3]);
    for (let n = 0; n < 4; n++) await t.service.sweep();
    expect(t.broker.sequence().sort()).toEqual([1, 2, 3, 4]);
  });

  it('a sweep that completes every lap visits both stores', async () => {
    const t = await perTenant();
    await t.write(t.acme, 1, 'acme');
    await t.write(t.globex, 2, 'globex');
    const result = await t.service.sweep();
    expect(result.endedBy).toBe('complete');
    expect(t.broker.sequence()).toEqual([1, 2]);
  });

  it('purge covers every store', async () => {
    const t = await perTenant();
    const a = await t.write(t.acme, 1, 'acme');
    const g = await t.write(t.globex, 2, 'globex');
    await edit(t.acme.db, a, { status: 'discarded', settledAt: 1 });
    await edit(t.globex.db, g, { status: 'discarded', settledAt: 1 });
    expect(await t.service.purge()).toBe(2);
  });
});
