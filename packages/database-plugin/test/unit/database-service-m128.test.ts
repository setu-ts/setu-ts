/* eslint-disable require-await -- fakes implement Promise-returning interface methods */
/**
 * `DatabaseService` behaviour added by M128: errors the caller's own
 * transaction work raises are returned as themselves (V11-5, plan §3.3), and
 * outer-scope repositories are built once per entity (X94-3, plan §3.4).
 *
 * @module
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { IAdapterTransaction, IDatabaseAdapter } from '@setu-ts/common';
import { DatabaseService } from '../../src/services/database-service.ts';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import { DatabaseUnavailableError, SerializationConflictError } from '../../src/errors.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';

describe('DatabaseService.transaction — the work owns its errors (V11-5)', () => {
  let adapter: MemoryAdapter;
  let service: DatabaseService;

  beforeEach(async () => {
    adapter = new MemoryAdapter();
    await adapter.connect();
    service = new DatabaseService(
      adapter as unknown as IDatabaseAdapter,
      (entity) => adapter.createDataSource(entity),
      'memory',
    );
  });

  it('rejects with the very error the work threw, even one carrying ECONNREFUSED', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), {
      code: 'ECONNREFUSED',
    });
    const fetchFailed = new TypeError('fetch failed', { cause: refused });
    for (const thrown of [refused, fetchFailed]) {
      const rejection = await service
        .transaction(async () => {
          throw thrown;
        })
        .catch((error: unknown) => error);
      expect(rejection).toBe(thrown);
      expect(rejection).not.toBeInstanceOf(DatabaseUnavailableError);
    }
  });

  it('does not turn a work-raised SQLSTATE 40001 into a conflict', async () => {
    const thrown = Object.assign(new Error('not from a repository'), { code: '40001' });
    await expect(
      service.transaction(async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
  });

  it('still classifies a driver error raised by a repository inside the work', async () => {
    const begin = adapter.beginTransaction.bind(adapter);
    adapter.beginTransaction = async (options): Promise<IAdapterTransaction> => {
      const txn = await begin(options);
      return {
        ...txn,
        commit: () => txn.commit(),
        rollback: () => txn.rollback(),
        createDataSource: (entity: string): DataSource => ({
          ...txn.createDataSource(entity),
          findById: () => Promise.reject(Object.assign(new Error('serialize'), { code: '40001' })),
        }),
      };
    };
    await expect(
      service.transaction(async (uow) => {
        await uow.getRepository('User').findById('1');
      }),
    ).rejects.toBeInstanceOf(SerializationConflictError);
  });

  it('scrubs the bound values of a native Drizzle error the work threw', async () => {
    const native = Object.assign(new Error('Failed query: select $1\nparams: s3cret'), {
      query: 'select $1',
      params: ['s3cret'],
    });
    const rejection = await service
      .transaction(async () => {
        throw native;
      })
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('Failed query: select $1');
    expect(JSON.stringify(rejection)).not.toContain('s3cret');
  });
});

describe('DatabaseService.getRepository — one repository per entity (X94-3)', () => {
  let adapter: MemoryAdapter;
  let built: string[];

  const serviceWith = (
    factory: (entity: string) => DataSource,
    options?: { logQueries: boolean },
  ): DatabaseService =>
    new DatabaseService(
      adapter as unknown as IDatabaseAdapter,
      (entity) => {
        built.push(entity);
        return factory(entity);
      },
      'memory',
      options,
      { debug: () => {} },
    );

  beforeEach(async () => {
    adapter = new MemoryAdapter();
    await adapter.connect();
    built = [];
  });

  it('returns the same instance per entity and builds its source once', async () => {
    const service = serviceWith((entity) => adapter.createDataSource(entity));
    const first = service.getRepository('User');
    expect(service.getRepository('User')).toBe(first);
    expect(service.getRepository('Post')).not.toBe(first);
    expect(built).toEqual(['User', 'Post']);
    await first.create({ id: 'u1', name: 'Alice' });
    expect(await service.getRepository('User').findById('u1')).toMatchObject({ name: 'Alice' });
  });

  it('refuses after close, and close does not leave a cached repository reachable', async () => {
    const service = serviceWith((entity) => adapter.createDataSource(entity));
    service.getRepository('User');
    await service.close();
    expect(() => service.getRepository('User')).toThrow('DatabaseService is closed');
    expect(built).toEqual(['User']);
  });

  it('caches nothing when building the source throws', () => {
    let fail = true;
    const service = serviceWith((entity) => {
      if (fail) throw new Error('no table');
      return adapter.createDataSource(entity);
    });
    expect(() => service.getRepository('User')).toThrow('no table');
    fail = false;
    const repository = service.getRepository('User');
    expect(service.getRepository('User')).toBe(repository);
    expect(built).toEqual(['User', 'User']);
  });

  it('builds a fresh repository per call for an access-path source while logging', () => {
    const reporting = (entity: string): DataSource =>
      ({
        ...adapter.createDataSource(entity),
        getLastAccessPath: () => undefined,
      }) as DataSource;
    const logging = serviceWith(reporting, { logQueries: true });
    expect(logging.getRepository('User')).not.toBe(logging.getRepository('User'));
    const quiet = serviceWith(reporting, { logQueries: false });
    expect(quiet.getRepository('User')).toBe(quiet.getRepository('User'));
  });

  it('never shares a transaction-scoped repository', async () => {
    const service = serviceWith((entity) => adapter.createDataSource(entity));
    const seen: unknown[] = [];
    for (let run = 0; run < 2; run++) {
      await service.transaction(async (uow) => {
        seen.push(uow.getRepository('User'));
      });
    }
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).not.toBe(service.getRepository('User'));
  });
});
