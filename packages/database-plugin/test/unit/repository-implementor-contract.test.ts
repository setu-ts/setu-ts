/**
 * The hand-written `IRepository` implementor (M90h §3.2).
 *
 * X26-2: `IRepository.findPage` became REQUIRED in 0.2.0 without a CHANGELOG
 * entry, while its sibling `findOne` addition was announced twice. The
 * implementor that breaks first in the real world is a hand-written test
 * double — exactly where the finding surfaced (17 errors to 3 after the
 * decorator migration, one of the survivors being the missing `findPage`).
 *
 * The tripwire is the fixture itself: `test/fixtures/repository-implementor.ts`
 * is type-checked by `deno task check` (which covers `test/`), so adding a
 * REQUIRED member to `IRepository` without updating the fixture fails the gate
 * at the moment it happens — no reviewer has to notice, and the convention
 * that depends on remembering cannot fail the way this one did.
 *
 * This file drives the fixture's behaviour so the fixture is not dead weight:
 * a tripwire that type-checks but does nothing would be deleted as such.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { InMemoryRowRepository } from '../fixtures/repository-implementor.ts';

describe('hand-written IRepository implementor (X26-2 tripwire)', () => {
  it('satisfies the full required surface', async () => {
    const repo = new InMemoryRowRepository();
    const row = await repo.create({ name: 'alpha' });

    expect(await repo.findById(row.id)).toEqual(row);
    expect(await repo.exists(row.id)).toBe(true);
    expect(await repo.findOne()).toEqual(row);
    expect(await repo.findAll()).toEqual([row]);
    expect(await repo.count()).toBe(1);
  });

  it('answers findPage, the member X26-2 found announced nowhere', async () => {
    const repo = new InMemoryRowRepository();
    await repo.create({ name: 'alpha' });
    await repo.create({ name: 'beta' });

    const page = await repo.findPage({ limit: 1 });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.name).toBe('alpha');
    expect(page.nextCursor).toBeNull();
  });

  it('refuses an update of a missing row', async () => {
    const repo = new InMemoryRowRepository();
    await expect(repo.update('missing', { name: 'x' })).rejects.toThrow('Row not found');
  });
});
