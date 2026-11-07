/* eslint-disable require-await -- fakes implement Promise-returning interface methods */
/**
 * `updateVersioned` / `deleteVersioned` (M128, plan §3.5) against a recording
 * fake: every refusal happens before any repository call, and the miss is
 * resolved by one read.
 *
 * @module
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { httpStatusHintOf } from '@setu-ts/common';
import type { ITenantRepository, WritePrecondition } from '@setu-ts/common';
import {
  deleteVersioned,
  updateVersioned,
  type VersionedWritable,
} from '../../src/repositories/versioned-write.ts';
import {
  EntityNotFoundError,
  UnsupportedQueryFeatureError,
  VersionConflictError,
} from '../../src/errors.ts';
import type { IRepository, IUnitOfWork } from '../../src/interfaces/index.ts';

interface Article {
  id: string;
  title: string;
  version: number;
}

/** A repository fake that records each call and answers from one stored row. */
function recordingRepo(stored: Article | null) {
  const calls: unknown[][] = [];
  let row = stored;
  return {
    calls,
    async updateWhere(
      id: string,
      where: WritePrecondition,
      data: Readonly<Partial<Article>>,
    ): Promise<Article | null> {
      calls.push(['updateWhere', id, where, data]);
      if (row === null || Object.entries(where).some(([k, v]) => row![k as keyof Article] !== v)) {
        return null;
      }
      row = { ...row, ...data };
      return row;
    },
    async deleteWhere(id: string, where: WritePrecondition): Promise<boolean> {
      calls.push(['deleteWhere', id, where]);
      if (row === null || Object.entries(where).some(([k, v]) => row![k as keyof Article] !== v)) {
        return false;
      }
      row = null;
      return true;
    },
    async findById(id: string): Promise<Article | null> {
      calls.push(['findById', id]);
      return row;
    },
  };
}

describe('updateVersioned', () => {
  it('writes the next version under a version precondition and returns the row', async () => {
    const repo = recordingRepo({ id: 'a', title: 'old', version: 3 });
    await expect(updateVersioned(repo, 'a', 3, { title: 'new' })).resolves.toEqual({
      id: 'a',
      title: 'new',
      version: 4,
    });
    expect(repo.calls).toEqual([
      ['updateWhere', 'a', { version: 3 }, { title: 'new', version: 4 }],
    ]);
  });

  it('reports a conflict when the row exists at another version, carrying only the entity', async () => {
    const repo = recordingRepo({ id: 'a', title: 'old', version: 5 });
    const error = await updateVersioned(
      repo,
      'a',
      3,
      { title: 'new' },
      { entity: 'Article' },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VersionConflictError);
    expect((error as VersionConflictError).entity).toBe('Article');
    expect((error as Error).message).toBe(
      "The 'Article' record is no longer at the expected version.",
    );
    expect(repo.calls.map((call) => call[0])).toEqual(['updateWhere', 'findById']);
  });

  it('reports not found when the row is absent', async () => {
    const error = await updateVersioned(recordingRepo(null), 'a', 0, { title: 'x' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EntityNotFoundError);
    expect((error as EntityNotFoundError).entity).toBeUndefined();
    expect((error as Error).message).toBe('The record does not exist.');
  });

  it('uses a custom version field', async () => {
    const repo = recordingRepo(null);
    const custom = {
      ...repo,
      updateWhere: (id: string, where: WritePrecondition, data: Readonly<Partial<Article>>) =>
        repo.updateWhere(id, where, data).then(() => ({ id, title: 't', version: 0 })),
    };
    await updateVersioned(custom, 'a', 7, { title: 't' }, { field: 'lockVersion' });
    expect(repo.calls[0]).toEqual([
      'updateWhere',
      'a',
      { lockVersion: 7 },
      { title: 't', lockVersion: 8 },
    ]);
  });

  it('refuses before any I/O', async () => {
    for (const [version, data, options] of [
      [-1, { title: 'x' }, undefined],
      [1.5, { title: 'x' }, undefined],
      [Number.NaN, { title: 'x' }, undefined],
      [Number.MAX_SAFE_INTEGER, { title: 'x' }, undefined],
      [1, { title: 'x', version: 9 }, undefined],
    ] as const) {
      const repo = recordingRepo({ id: 'a', title: 'old', version: 1 });
      await expect(
        updateVersioned(repo, 'a', version, data as Partial<Article>, options),
      ).rejects.toMatchObject({ feature: 'write-precondition' });
      expect(repo.calls).toEqual([]);
    }
  });

  it('refuses an empty version field as a configuration fault, unbranded (audit O7)', async () => {
    const repo = recordingRepo({ id: 'a', title: 'old', version: 1 });
    for (const attempt of [
      () => updateVersioned(repo, 'a', 1, { title: 'x' }, { field: '' }),
      () => deleteVersioned(repo, 'a', 1, { field: '' }),
    ]) {
      const error = await attempt().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect(httpStatusHintOf(error)).toBeUndefined();
    }
    expect(repo.calls).toEqual([]);
  });

  it('refuses a repository without updateWhere with conditional-write (501)', async () => {
    const reads: string[] = [];
    const error = await updateVersioned<Article, string>(
      { findById: (id: string) => (reads.push(id), Promise.resolve(null)) },
      'a',
      1,
      {},
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedQueryFeatureError);
    expect(error).toMatchObject({ feature: 'conditional-write' });
    expect(reads).toEqual([]);
  });

  it('passes a repository-raised conditional-write refusal through unchanged', async () => {
    const refusal = new UnsupportedQueryFeatureError('conditional-write', 'memory', 'buffered');
    const repo = { ...recordingRepo(null), updateWhere: () => Promise.reject(refusal) };
    await expect(updateVersioned(repo, 'a', 1, { title: 'x' })).rejects.toBe(refusal);
  });
});

describe('deleteVersioned', () => {
  it('deletes under a version precondition', async () => {
    const repo = recordingRepo({ id: 'a', title: 'old', version: 2 });
    await expect(deleteVersioned(repo, 'a', 2)).resolves.toBeUndefined();
    expect(repo.calls).toEqual([['deleteWhere', 'a', { version: 2 }]]);
  });

  it('tells conflict from not found, and refuses before I/O', async () => {
    await expect(
      deleteVersioned(recordingRepo({ id: 'a', title: 'o', version: 3 }), 'a', 2, {
        entity: 'Article',
      }),
    ).rejects.toMatchObject({ name: 'VersionConflictError', entity: 'Article' });
    await expect(deleteVersioned(recordingRepo(null), 'a', 2)).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
    const repo = recordingRepo(null);
    await expect(deleteVersioned(repo, 'a', -2)).rejects.toMatchObject({
      feature: 'write-precondition',
    });
    await expect(
      deleteVersioned({ findById: () => Promise.resolve(null) }, 'a', 1),
    ).rejects.toMatchObject({ feature: 'conditional-write' });
    expect(repo.calls).toEqual([]);
  });
});

describe('the structural types accept every repository kind', () => {
  it('IRepository, a unit-of-work repository and ITenantRepository type-check', () => {
    expectTypeOf<IRepository<Article, string>>().toMatchTypeOf<
      VersionedWritable<Article, string>
    >();
    expectTypeOf<ReturnType<IUnitOfWork['getRepository']>>().toMatchTypeOf<
      VersionedWritable<unknown, string>
    >();
    expectTypeOf<ITenantRepository<Article, string>>().toMatchTypeOf<
      VersionedWritable<Article, string>
    >();
    const repo = {} as IRepository<Article, string>;
    const tenant = {} as ITenantRepository<Article, string>;
    // Compile-only: these calls are never made.
    const calls = (): unknown => [
      updateVersioned(repo, 'a', 1, { title: 'n' }),
      updateVersioned(tenant, 'a', 1, { title: 'n' }),
      // @ts-expect-error an unknown field is not part of the entity
      updateVersioned(repo, 'a', 1, { nope: 1 }),
    ];
    expect(typeof calls).toBe('function');
  });
});
