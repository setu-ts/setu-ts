/**
 * Conformance of every shipped adapter to the promoted `IDatabaseAdapter`
 * port (M52c).
 *
 * The assignments below are the point of the file: before the promotion the
 * plugin reached each adapter's data-source factory by **casting to the
 * concrete class**, which is exactly what made the adapter switch closed and a
 * backend in another package impossible. If any of these needed a cast, the
 * promotion would not have achieved anything.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDatabaseAdapter, IDataSource } from '@hono-enterprise/common';

import { DrizzleAdapter, MemoryAdapter, PrismaAdapter } from '../../src/index.ts';

describe('the promoted IDatabaseAdapter port', () => {
  it('is satisfied by MemoryAdapter with no cast', () => {
    const adapter: IDatabaseAdapter = new MemoryAdapter();
    expect(typeof adapter.createDataSource).toBe('function');
    expect(typeof adapter.rawQuery).toBe('function');
  });

  it('is satisfied by PrismaAdapter with no cast', () => {
    const adapter: IDatabaseAdapter = new PrismaAdapter();
    expect(typeof adapter.createDataSource).toBe('function');
  });

  it('is satisfied by DrizzleAdapter with no cast', () => {
    const adapter: IDatabaseAdapter = new DrizzleAdapter();
    expect(typeof adapter.createDataSource).toBe('function');
  });

  it('returns a data source honoring IDataSource from the memory adapter', async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();

    const source: IDataSource = adapter.createDataSource('User');
    const created = await source.create({ id: 'u1', name: 'ada' });

    expect(created).toMatchObject({ id: 'u1', name: 'ada' });
    expect(await source.findById('u1')).toMatchObject({ name: 'ada' });
    expect(await source.count({})).toBe(1);
  });

  it('honors a non-default primary key on the memory adapter', async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();

    const source = adapter.createDataSource('User', 'user_id');
    await source.create({ user_id: 'u1', name: 'ada' });

    expect(await source.findById('u1')).toMatchObject({ name: 'ada' });
  });
});

describe('the deprecated createDataSourceForEntity aliases', () => {
  it('still work, delegating to createDataSource (AI_GUIDELINES §9.2)', async () => {
    const prisma = new PrismaAdapter({
      prismaClient: {
        $connect: () => Promise.resolve(),
        $disconnect: () => Promise.resolve(),
        $transaction: () => Promise.resolve(),
        user: { count: () => Promise.resolve(0) },
      },
    });
    await prisma.connect();

    // Same underlying implementation reached through the published old name.
    expect(await prisma.createDataSourceForEntity('User').count({})).toBe(0);
  });
});
