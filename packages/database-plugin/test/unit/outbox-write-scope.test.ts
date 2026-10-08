/**
 * `IUnitOfWork` must assign to `common`'s `IOutboxWriteScope` (M107 §3.1), or
 * a caller cannot hand the outbox the unit of work its own `transaction(...)`
 * gave it. Narrowing the scope's `create` parameter, or widening
 * `IOutboxWriteScope` with a member the unit of work lacks, turns the
 * assignment below into a `deno check` error.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IOutboxWriteScope } from '@setu-ts/common';
import type { IUnitOfWork } from '../../src/index.ts';

describe('IUnitOfWork as the outbox write scope', () => {
  it('IUnitOfWork assigns to IOutboxWriteScope', async () => {
    const created: unknown[] = [];
    // The fixture is built loosely: only its DECLARED type matters, because the
    // assertion below is the assignment of an `IUnitOfWork`-typed value.
    const repository = {
      create: (data: unknown) => {
        created.push(data);
        return Promise.resolve(data);
      },
    };
    const uow = { getRepository: () => repository } as unknown as IUnitOfWork;
    // The static assertion: this line fails `deno check` if the shapes drift.
    const scope: IOutboxWriteScope = uow;

    await scope.getRepository('Outbox').create({ id: 'e1' });
    expect(created).toEqual([{ id: 'e1' }]);
  });
});
