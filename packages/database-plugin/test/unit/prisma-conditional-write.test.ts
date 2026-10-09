import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createPrismaDataSource } from '../../src/adapters/prisma/prisma-adapter.ts';
import { createFakePrismaClient } from '../fixtures/fake-prisma-client.ts';

describe('Prisma conditional translation', () => {
  it('conjoins scalar and compound keys without replacing them', async () => {
    for (const composite of [false, true]) {
      const client = createFakePrismaClient();
      const source = createPrismaDataSource(
        client,
        'User',
        'postgresql',
        composite ? ['id', 'role'] : ['id'],
        composite ? 'id_role' : undefined,
      );
      await source.create({ id: 'a', role: 'owner', name: 'old' });
      const id = composite ? { id: 'a', role: 'owner' } : 'a';
      expect(await source.updateWhere!(id, { name: 'old' }, { name: 'new' })).toMatchObject({
        name: 'new',
      });
      const keyWhere = composite ? { id_role: { id: 'a', role: 'owner' } } : { id: 'a' };
      expect(client.recordedCalls.at(-1)?.args.where).toEqual({
        ...keyWhere,
        AND: [{ name: 'old' }],
      });
      expect(await source.deleteWhere!(id, { name: 'new' })).toBe(true);
      expect(client.recordedCalls.at(-1)?.args.where).toEqual({
        ...keyWhere,
        AND: [{ name: 'new' }],
      });
    }
  });
  it('refuses operator and compound-field names before calling the delegate', async () => {
    const client = createFakePrismaClient();
    const source = createPrismaDataSource(client, 'User', 'postgresql', ['id', 'role'], 'id_role');
    for (const field of ['AND', 'OR', 'NOT', 'id_role']) {
      await expect(source.updateWhere!({ id: 'a', role: 'owner' }, { [field]: 1 }, { name: 'bad' }))
        .rejects.toThrow(/operators/);
      await expect(source.deleteWhere!({ id: 'a', role: 'owner' }, { [field]: 1 })).rejects.toThrow(
        /operators/,
      );
    }
    expect(client.recordedCalls).toEqual([]);
  });
  it('propagates delegate errors other than P2025', async () => {
    const client = createFakePrismaClient();
    const error = new Error('driver fault');
    client.user.update = () => Promise.reject(error);
    client.user.delete = () => Promise.reject(error);
    const source = createPrismaDataSource(client, 'User');
    await expect(source.updateWhere!('a', { name: 'old' }, { name: 'new' })).rejects.toBe(error);
    await expect(source.deleteWhere!('a', { name: 'old' })).rejects.toBe(error);
  });
});
