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

describe('Prisma conditional translation', () => {
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
    const source = createPrismaDataSource(client, 'User');
    await expect(source.updateWhere!('a', { name: 'old' }, { name: 'new' })).rejects.toBe(error);
    await expect(source.deleteWhere!('a', { name: 'old' })).rejects.toBe(error);
  });
});
