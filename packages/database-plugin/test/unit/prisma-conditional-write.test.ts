import { describe, expect, it } from 'vitest';
import { createPrismaDataSource } from '../../src/adapters/prisma/prisma-adapter.ts';
import { createFakePrismaClient } from '../fixtures/fake-prisma-client.ts';
import { PrismaAdapter } from '../../src/adapters/prisma/prisma-adapter.ts';
import { DatabaseService } from '../../src/services/database-service.ts';
import {
  httpStatusHintOf,
  InvalidFieldValueError,
  UnknownPayloadFieldError,
} from '@setu-ts/common';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';

describe('Prisma conditional translation', () => {
  for (const provider of [
    'postgresql',
    'postgres',
    'mysql',
    'sqlserver',
    'cockroachdb',
    'sqlite',
    'unknown',
  ] as const) {
    it(`selects the conditional strategy once for ${provider}`, async () => {
      const client = createFakePrismaClient({ activeProvider: provider });
      const adapter = new PrismaAdapter({ prismaClient: client, transactionTimeout: 4567 });
      await adapter.connect();
      const source = adapter.createDataSource('User');
      await source.create({ id: 'a', name: 'old' });
      client._activeProvider = 'changed-after-connect';
      expect(await source.updateWhere!('a', { name: 'old' }, { name: 'new' })).toEqual({
        id: 'a',
        name: 'new',
      });
      expect(await source.updateWhere!('a', { name: 'old' }, { name: 'bad' })).toBeNull();
      expect(await source.deleteWhere!('missing', { name: 'new' })).toBe(false);
      expect(await source.deleteWhere!('a', { name: 'new' })).toBe(true);
      const single = provider === 'postgresql' || provider === 'postgres';
      expect(client.recordedCalls.some((call) => call.action === 'updateMany')).toBe(!single);
      if (!single) expect(client.transactionOptions).toEqual({ maxWait: 2000, timeout: 4567 });
      await adapter.disconnect();
    });
  }
  it('uses the transaction delegate for read-back, without opening a nested transaction', async () => {
    const root = createFakePrismaClient({ activeProvider: 'mysql' });
    const tx = createFakePrismaClient({ activeProvider: 'mysql' });
    const run = root.$transaction;
    let transactions = 0;
    root.$transaction = async (callback, options) => {
      transactions += 1;
      return await run(() => callback(tx), options);
    };
    const adapter = new PrismaAdapter({ prismaClient: root });
    await adapter.connect();
    await tx.user.create({ data: { id: 'a', name: 'old' } });
    expect(
      await adapter.createDataSource('User').updateWhere!('a', { name: 'old' }, { name: 'new' }),
    ).toEqual({ id: 'a', name: 'new' });
    expect(root.recordedCalls).toEqual([]);
    const handle = await adapter.beginTransaction();
    expect(await handle.createDataSource('User').deleteWhere!('a', { name: 'new' })).toBe(true);
    await handle.commit();
    expect(transactions).toBe(2);
    await adapter.disconnect();
  });
  it('reads back the row the write matched, even if the caller changes its key object meanwhile', async () => {
    const client = createFakePrismaClient({ activeProvider: 'mysql' });
    const adapter = new PrismaAdapter({ prismaClient: client });
    await adapter.connect();
    const source = adapter.createDataSource('User');
    await source.create({ id: 'a', name: 'old' });
    await source.create({ id: 'b', name: 'other' });
    const key: Record<string, string> = { id: 'a' };
    const updateMany = client.user.updateMany;
    client.user.updateMany = async (args) => {
      const result = await updateMany(args);
      key['id'] = 'b';
      return result;
    };
    expect(await source.updateWhere!(key, { name: 'old' }, { name: 'new' })).toEqual({
      id: 'a',
      name: 'new',
    });
    await adapter.disconnect();
  });
  it('refuses an empty keyColumns at construction, with or without compositeKeyName', () => {
    const client = createFakePrismaClient({ activeProvider: 'mysql' });
    const make = (): PrismaAdapter =>
      new PrismaAdapter({ prismaClient: client, entities: { User: { keyColumns: [] } } });
    expect(make).toThrow(UnsupportedQueryFeatureError);
    expect(make).toThrow(/'User'.*entities\.User\.keyColumns/);
  });
  it('refuses compositeKeyName without keyColumns at construction, naming the fix', () => {
    const client = createFakePrismaClient({ activeProvider: 'mysql' });
    for (const keyColumns of [undefined, []]) {
      const make = (): PrismaAdapter =>
        new PrismaAdapter({
          prismaClient: client,
          entities: {
            Compound: {
              compositeKeyName: 'tenantId_id',
              ...(keyColumns === undefined ? {} : { keyColumns }),
            },
          },
        });
      expect(make).toThrow(UnsupportedQueryFeatureError);
      expect(make).toThrow(/'Compound'.*entities\.Compound\.keyColumns/);
    }
    expect(
      () =>
        new PrismaAdapter({
          prismaClient: client,
          entities: {
            Compound: { compositeKeyName: 'tenantId_id', keyColumns: ['tenantId', 'id'] },
          },
        }),
    ).not.toThrow();
  });
  it('reads the key once, so a getter cannot steer the read-back to another row', async () => {
    const client = createFakePrismaClient({ activeProvider: 'mysql' });
    const adapter = new PrismaAdapter({ prismaClient: client });
    await adapter.connect();
    const source = adapter.createDataSource('User');
    await source.create({ id: 'a', name: 'old' });
    await source.create({ id: 'b', name: 'other' });
    let reads = 0;
    const key = {
      get id(): string {
        reads += 1;
        return reads === 1 ? 'a' : 'b';
      },
    };
    expect(await source.updateWhere!(key, { name: 'old' }, { name: 'new' })).toEqual({
      id: 'a',
      name: 'new',
    });
    await adapter.disconnect();
  });
  for (const operation of ['updateWhere', 'deleteWhere'] as const) {
    it(`rolls back ${operation} if configured key columns match multiple rows`, async () => {
      const client = createFakePrismaClient({ activeProvider: 'mysql' });
      const adapter = new PrismaAdapter({
        prismaClient: client,
        entities: { User: { keyColumns: ['role'] } },
      });
      await adapter.connect();
      const source = adapter.createDataSource('User');
      await source.create({ id: 'a', role: 'owner', name: 'old' });
      await source.create({ id: 'b', role: 'owner', name: 'old' });
      const result =
        operation === 'updateWhere'
          ? source.updateWhere!('owner', { name: 'old' }, { name: 'bad' })
          : source.deleteWhere!('owner', { name: 'old' });
      await expect(result).rejects.toThrow(/matched 2 rows.*keyColumns/);
      expect([...client.stores.user!.records.values()].map((row) => row.name)).toEqual([
        'old',
        'old',
      ]);
      await adapter.disconnect();
    });
  }
  for (const unknownField of [false, true]) {
    it(`maps conditional ${unknownField ? 'unknown fields' : 'invalid values'} to 400 through the service`, async () => {
      const client = createFakePrismaClient();
      const error = Object.assign(
        new Error(
          unknownField
            ? 'Unknown argument `surprise`. Payload: private-canary-value'
            : 'Argument `age`: Invalid value provided. Expected Int, provided String. private-canary-value',
        ),
        {
          name: 'PrismaClientValidationError',
        },
      );
      client.user.update = () => Promise.reject(error);
      client.user.delete = () => Promise.reject(error);
      client.user.updateMany = () => Promise.reject(error);
      client.user.deleteMany = () => Promise.reject(error);
      const adapter = new PrismaAdapter({ prismaClient: client });
      await adapter.connect();
      try {
        const source = adapter.createDataSource('User');
        // A direct call bypasses the service, so the data source names the
        // refusal itself: Prisma's rendered query never leaves in a message.
        for (const write of [
          () => source.updateWhere!('a', { name: 'old' }, { name: 'new' }),
          () => source.deleteWhere!('a', { name: 'old' }),
        ]) {
          const direct: unknown = await write().catch((caught: unknown) => caught);
          expect(direct).toBeInstanceOf(
            unknownField ? UnknownPayloadFieldError : InvalidFieldValueError,
          );
          expect((direct as Error).message).not.toContain('private-canary-value');
          expect(((direct as Error).cause as Error).message).not.toContain('private-canary-value');
        }
        const service = new DatabaseService(
          adapter,
          (entity) => adapter.createDataSource(entity),
          'prisma',
        );
        const exercise = async (
          repo: ReturnType<DatabaseService['getRepository']>,
        ): Promise<void> => {
          for (const write of [
            () => repo.updateWhere!('a', { name: 'old' }, { name: 'new' }),
            () => repo.deleteWhere!('a', { name: 'old' }),
          ]) {
            const mapped: unknown = await write().catch((caught: unknown) => caught);
            expect(mapped).toBeInstanceOf(
              unknownField ? UnknownPayloadFieldError : InvalidFieldValueError,
            );
            expect(httpStatusHintOf(mapped)).toEqual({
              status: 400,
              title: 'Bad Request',
              detail: unknownField
                ? 'The request names a field this resource does not have.'
                : 'A supplied value does not fit the type of its field.',
            });
            expect((mapped as Error).cause).not.toBe(error);
            expect((mapped as Error).cause).toMatchObject({
              name: 'PrismaClientValidationError',
              message: 'Prisma refused the input (PrismaClientValidationError).',
            });
          }
        };
        await exercise(service.getRepository('User'));
        await service.transaction((uow) => exercise(uow.getRepository('User')));
      } finally {
        await adapter.disconnect();
      }
    });
  }
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
      await expect(
        source.updateWhere!({ id: 'a', role: 'owner' }, { [field]: 1 }, { name: 'bad' }),
      ).rejects.toThrow(/operators/);
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
    client.user.updateMany = () => Promise.reject(error);
    client.user.deleteMany = () => Promise.reject(error);
    const source = createPrismaDataSource(client, 'User');
    await expect(source.updateWhere!('a', { name: 'old' }, { name: 'new' })).rejects.toBe(error);
    await expect(source.deleteWhere!('a', { name: 'old' })).rejects.toBe(error);
  });
});
